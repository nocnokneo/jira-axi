import { AxiError } from "axi-sdk-js";

import { BIN } from "./bin-name.js";

/**
 * Flag parsing with fail-loud validation (AXI principle 6).
 *
 * A silently dropped flag is worse than an error: the agent gets output it
 * believes was filtered and proceeds on wrong data. Every command declares its
 * own flag set, and anything outside that set is rejected by name before any
 * network call happens.
 */

export type FlagType = "string" | "boolean" | "number";

export interface FlagDef {
  type: FlagType;
  /** Single-dash alias, e.g. `-p`. */
  short?: string;
  /** Accept the flag more than once; the parsed value is an array. */
  repeatable?: boolean;
  /** Value placeholder used in help output, e.g. `<key>`. */
  placeholder?: string;
  /** Default shown in help. Parsing does not apply it; commands do. */
  default?: string | number | boolean;
  describe: string;
}

export type FlagSpec = Record<string, FlagDef>;

export interface PositionalSpec {
  name: string;
  min?: number;
  max?: number;
}

/**
 * Flags accepted on every command. `--help` is handled before parsing, and the
 * credential selectors have to work everywhere because they choose *which* Jira
 * site a command talks to.
 */
export const GLOBAL_FLAGS: FlagSpec = {
  site: {
    type: "string",
    placeholder: "<site>",
    describe: "Jira Cloud site (acme, acme.atlassian.net, or a full https URL)",
  },
  account: {
    type: "string",
    placeholder: "<name>",
    describe: "Named account from the jira-axi config file",
  },
};

/**
 * Flags that used to exist under a different name. A rename gets a targeted
 * hint instead of the generic flag list so the agent self-corrects in one step.
 */
export const RENAMED_FLAGS: Record<string, string> = {
  status: "state",
  user: "assignee",
  "max-results": "limit",
  body: "description",
  key: "project",
};

export interface ParsedArgs {
  flags: Record<string, string | number | boolean | string[] | undefined>;
  positionals: string[];
}

function formatFlagList(spec: FlagSpec): string {
  const names = Object.keys(spec)
    .sort()
    .map((name) => `--${name}`);
  return `${names.join(", ")} (--help always allowed)`;
}

function usageError(message: string, suggestions: string[]): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

function unknownFlagError(flag: string, command: string, spec: FlagSpec): AxiError {
  const bare = flag.replace(/^--?/, "").split("=")[0] ?? "";
  const renamedTo = RENAMED_FLAGS[bare];

  if (renamedTo && spec[renamedTo]) {
    return usageError(`unknown flag ${flag} for \`${command}\``, [
      `--${bare} was renamed; use --${renamedTo} instead`,
      `${BIN} ${command} --${renamedTo} ${spec[renamedTo]?.placeholder ?? "<value>"}`,
    ]);
  }

  return usageError(`unknown flag ${flag} for \`${command}\``, [
    `valid flags for \`${command}\`: ${formatFlagList(spec)}`,
    `Run \`${BIN} ${command} --help\` for the full reference`,
  ]);
}

/**
 * Map a short token to its long flag name. `FlagDef.short` is declared with its
 * dash (`-p`) because that is how it reads in help output, while the parser has
 * already stripped it, so compare without.
 */
function resolveShort(short: string, spec: FlagSpec): string | undefined {
  for (const [name, def] of Object.entries(spec)) {
    if (def.short !== undefined && def.short.replace(/^-+/, "") === short) {
      return name;
    }
  }
  return undefined;
}

function coerceNumber(name: string, raw: string, command: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw usageError(`--${name} must be a number, got \`${raw}\``, [
      `Run \`${BIN} ${command} --help\` for the full reference`,
    ]);
  }
  return value;
}

export interface ParseOptions {
  /** Command label used in errors and help hints, e.g. `issue list`. */
  command: string;
  spec: FlagSpec;
  positionals?: PositionalSpec;
}

export function parseArgs(args: string[], options: ParseOptions): ParsedArgs {
  const spec: FlagSpec = { ...GLOBAL_FLAGS, ...options.spec };
  const { command } = options;

  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;

    if (token === "--help") {
      // Callers handle help before parsing; tolerate it here so a stray
      // `--help` never reads as an unknown flag.
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    let name: string;
    let inlineValue: string | undefined;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        name = body.slice(0, eq);
        inlineValue = body.slice(eq + 1);
      } else {
        name = body;
      }
    } else {
      const body = token.slice(1);
      const eq = body.indexOf("=");
      const shortName = eq >= 0 ? body.slice(0, eq) : body;
      if (eq >= 0) {
        inlineValue = body.slice(eq + 1);
      }
      const resolved = resolveShort(shortName, spec);
      if (!resolved) {
        throw unknownFlagError(`-${shortName}`, command, spec);
      }
      name = resolved;
    }

    const def = spec[name];
    if (!def) {
      throw unknownFlagError(`--${name}`, command, spec);
    }

    if (def.type === "boolean") {
      if (inlineValue !== undefined) {
        throw usageError(`--${name} is a switch and takes no value`, [
          `Pass \`--${name}\` on its own`,
        ]);
      }
      flags[name] = true;
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = args[index + 1];
      // A following token that looks like a flag is never consumed as a value —
      // that is how `--summary --assignee bob` becomes an error instead of a
      // summary literally named "--assignee".
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        throw usageError(`--${name} requires a value`, [
          `${BIN} ${command} --${name} ${def.placeholder ?? "<value>"}`,
        ]);
      }
      raw = next;
      index += 1;
    }

    if (raw.length === 0) {
      throw usageError(`--${name} was passed an empty value`, [
        `${BIN} ${command} --${name} ${def.placeholder ?? "<value>"}`,
      ]);
    }

    if (def.repeatable) {
      const existing = (flags[name] as string[] | undefined) ?? [];
      existing.push(raw);
      flags[name] = existing;
      continue;
    }

    if (flags[name] !== undefined) {
      throw usageError(`--${name} was passed more than once`, [
        `--${name} accepts a single value`,
      ]);
    }

    flags[name] = def.type === "number" ? coerceNumber(name, raw, command) : raw;
  }

  const positionalSpec = options.positionals;
  const min = positionalSpec?.min ?? 0;
  const max = positionalSpec?.max ?? (positionalSpec ? Number.POSITIVE_INFINITY : 0);

  if (positionals.length < min) {
    const label = positionalSpec?.name ?? "argument";
    throw usageError(`${label} is required`, [
      `${BIN} ${command} ${positionalSpec?.name ?? "<value>"}`,
      `Run \`${BIN} ${command} --help\` for the full reference`,
    ]);
  }

  if (positionals.length > max) {
    const extra = positionals.slice(max).join(", ");
    throw usageError(
      max === 0
        ? `\`${command}\` takes no positional arguments, got \`${extra}\``
        : `\`${command}\` takes at most ${max} positional argument${max === 1 ? "" : "s"}, got \`${extra}\``,
      [`Run \`${BIN} ${command} --help\` for the full reference`],
    );
  }

  return { flags, positionals };
}

/** Typed accessors. Each throws a usage error rather than coercing silently. */

export function str(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function num(parsed: ParsedArgs, name: string, fallback: number): number {
  const value = parsed.flags[name];
  return typeof value === "number" ? value : fallback;
}

export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function list(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags[name];
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

export function requireStr(parsed: ParsedArgs, name: string, command: string): string {
  const value = str(parsed, name);
  if (value === undefined) {
    throw usageError(`--${name} is required`, [
      `Run \`${BIN} ${command} --help\` for the full reference`,
    ]);
  }
  return value;
}

/** Reject two flags that cannot be combined. */
export function exclusive(parsed: ParsedArgs, a: string, b: string): void {
  if (parsed.flags[a] !== undefined && parsed.flags[b] !== undefined) {
    throw usageError(`--${a} and --${b} cannot be combined`, [
      `Pass either --${a} or --${b}, not both`,
    ]);
  }
}
