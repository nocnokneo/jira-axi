import { AxiError } from "axi-sdk-js";

import { BIN } from "./bin-name.js";
import { JiraClient } from "./client.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { GLOBAL_FLAGS, parseArgs, str, type FlagSpec, type ParsedArgs, type PositionalSpec } from "./flags.js";

/**
 * Command dispatch and help.
 *
 * Two AXI principles shape this layer. Principle 10 wants concise *per
 * subcommand* help, so each subcommand owns its own flag set, usage line, and
 * examples. Principle 6 wants unknown flags rejected against that same set —
 * which is why the flag spec lives next to the handler rather than in one
 * CLI-wide table.
 */

export type Output = Record<string, unknown>;

/**
 * A command may return a plain string when it owns its own formatting — the SDK
 * writes strings through verbatim instead of TOON-encoding them.
 */
export type Renderable = Output | string;

export interface RunContext {
  /** Resolve credentials and build a client. Lazy so `--help` never needs auth. */
  client: () => JiraClient;
  config: () => ResolvedConfig;
  now: Date;
}

export interface Subcommand {
  name: string;
  summary: string;
  /** Argument portion of the usage line, e.g. `<key> [flags]`. */
  args?: string;
  positionals?: PositionalSpec;
  flags: FlagSpec;
  examples: string[];
  /** Extra notes rendered in `--help`. */
  notes?: string[];
  run: (parsed: ParsedArgs, context: RunContext) => Promise<Renderable> | Renderable;
}

export interface Noun {
  name: string;
  summary: string;
  subcommands: Subcommand[];
  /** Subcommand used when the noun is invoked bare (principle 8). */
  default?: string;
  /**
   * Reinterpret a first argument that is not a subcommand name — used so
   * `jira-axi issue ABC-1` means `issue view ABC-1`.
   */
  implicit?: (first: string) => { subcommand: string; args: string[] } | undefined;
}

function flagDisplay(name: string, spec: FlagSpec): string {
  const def = spec[name];
  if (!def) {
    return `--${name}`;
  }
  const alias = def.short ? `, ${def.short}` : "";
  const placeholder = def.type === "boolean" ? "" : ` ${def.placeholder ?? "<value>"}`;
  return `--${name}${alias}${placeholder}`;
}

function flagHelp(spec: FlagSpec): Output {
  const out: Output = {};
  for (const name of Object.keys(spec).sort()) {
    const def = spec[name];
    if (!def) {
      continue;
    }
    let describe = def.describe;
    if (def.default !== undefined) {
      describe += ` (default: ${String(def.default)})`;
    }
    if (def.repeatable) {
      describe += " (repeatable)";
    }
    out[flagDisplay(name, spec)] = describe;
  }
  return out;
}

export function subcommandHelp(noun: string, sub: Subcommand): Output {
  const label = `${noun} ${sub.name}`;
  const out: Output = {
    command: label,
    description: sub.summary,
    usage: `${BIN} ${label}${sub.args ? ` ${sub.args}` : ""}`,
    flags: flagHelp({ ...sub.flags, ...GLOBAL_FLAGS }),
  };
  if (sub.notes && sub.notes.length > 0) {
    out.notes = sub.notes;
  }
  out.examples = sub.examples;
  return out;
}

export function nounHelp(noun: Noun): Output {
  const subcommands: Output = {};
  for (const sub of noun.subcommands) {
    subcommands[sub.name] = sub.summary;
  }

  const out: Output = {
    command: noun.name,
    description: noun.summary,
    usage: `${BIN} ${noun.name} <subcommand> [flags]`,
    subcommands,
  };
  if (noun.default) {
    out.default = `\`${BIN} ${noun.name}\` runs \`${noun.name} ${noun.default}\``;
  }
  out.help = [`Run \`${BIN} ${noun.name} <subcommand> --help\` for flags and examples`];
  return out;
}

function unknownSubcommand(noun: Noun, given: string): AxiError {
  const names = noun.subcommands.map((sub) => sub.name).join(", ");
  return new AxiError(`unknown subcommand \`${given}\` for \`${noun.name}\``, "VALIDATION_ERROR", [
    `valid subcommands for \`${noun.name}\`: ${names}`,
    `Run \`${BIN} ${noun.name} --help\` for a summary of each`,
  ]);
}

/** Build the SDK command handler for one noun. */
export function nounHandler(
  noun: Noun,
  /** Injectable clock, so relative ages in output are deterministic under test. */
  now?: Date,
): (args: string[]) => Promise<Renderable> {
  const byName = new Map(noun.subcommands.map((sub) => [sub.name, sub]));

  return async (args: string[]): Promise<Renderable> => {
    const first = args[0];

    // Bare `--help`, or `--help` before any subcommand, describes the noun.
    if (first === undefined || first === "--help") {
      if (first === undefined && noun.default) {
        return dispatch(noun, byName.get(noun.default) as Subcommand, [], now);
      }
      return nounHelp(noun);
    }

    let sub = byName.get(first);
    let rest = args.slice(1);

    if (!sub) {
      if (first.startsWith("-")) {
        // `jira-axi issue -p ACME` — flags with no subcommand run the default.
        if (!noun.default) {
          throw new AxiError(`\`${noun.name}\` requires a subcommand`, "VALIDATION_ERROR", [
            `valid subcommands for \`${noun.name}\`: ${noun.subcommands.map((s) => s.name).join(", ")}`,
            `Run \`${BIN} ${noun.name} --help\` for a summary of each`,
          ]);
        }
        sub = byName.get(noun.default) as Subcommand;
        rest = args;
      } else {
        const implicit = noun.implicit?.(first);
        if (implicit) {
          sub = byName.get(implicit.subcommand);
          rest = [...implicit.args, ...args.slice(1)];
        }
        if (!sub) {
          throw unknownSubcommand(noun, first);
        }
      }
    }

    if (rest.includes("--help")) {
      return subcommandHelp(noun.name, sub);
    }

    return dispatch(noun, sub, rest, now);
  };
}

async function dispatch(
  noun: Noun,
  sub: Subcommand,
  args: string[],
  now?: Date,
): Promise<Renderable> {
  const parsed = parseArgs(args, {
    command: `${noun.name} ${sub.name}`,
    spec: sub.flags,
    positionals: sub.positionals,
  });

  const context = makeContext(parsed, now);
  return sub.run(parsed, context);
}

export function makeContext(parsed: ParsedArgs, now: Date = new Date()): RunContext {
  let cached: ResolvedConfig | undefined;
  let client: JiraClient | undefined;

  const config = (): ResolvedConfig => {
    if (!cached) {
      cached = resolveConfig({ site: str(parsed, "site"), account: str(parsed, "account") });
    }
    return cached;
  };

  return {
    config,
    client: () => {
      if (!client) {
        client = new JiraClient(config());
      }
      return client;
    },
    now,
  };
}
