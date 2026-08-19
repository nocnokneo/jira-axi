import { readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { BIN } from "./bin-name.js";
import { exclusive, str, type ParsedArgs } from "./flags.js";

/**
 * Text input for long fields.
 *
 * Reading stdin is opt-in via a literal `-` path rather than "read stdin when
 * nothing else was passed". An agent harness often leaves stdin as an open pipe
 * that never closes, and an implicit read there hangs the command forever —
 * which principle 6's no-interactive-prompts rule rules out.
 */

export function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AxiError(`could not read stdin: ${detail}`, "VALIDATION_ERROR", [
      "Pipe content in, e.g. `cat notes.md | jira-axi issue comment ABC-1 --body-file -`",
    ]);
  }
}

export function readTextFile(path: string): string {
  if (path === "-") {
    return readStdinSync();
  }

  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      throw new AxiError(`file not found: ${path}`, "VALIDATION_ERROR", [
        "Pass a path that exists, or `-` to read stdin",
      ]);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new AxiError(`could not read ${path}: ${detail}`, "VALIDATION_ERROR", []);
  }
}

export interface TextInputOptions {
  /** Inline flag name, e.g. `description`. */
  flag: string;
  /** File flag name, e.g. `description-file`. */
  fileFlag: string;
  command: string;
  required?: boolean;
}

/**
 * Resolve a long text field from either its inline flag or its `-file` variant.
 * Returns `undefined` when neither was passed and the field is optional.
 */
export function resolveText(parsed: ParsedArgs, options: TextInputOptions): string | undefined {
  exclusive(parsed, options.flag, options.fileFlag);

  const inline = str(parsed, options.flag);
  if (inline !== undefined) {
    return inline;
  }

  const path = str(parsed, options.fileFlag);
  if (path !== undefined) {
    return readTextFile(path);
  }

  if (options.required) {
    throw new AxiError(`--${options.flag} or --${options.fileFlag} is required`, "VALIDATION_ERROR", [
      `${BIN} ${options.command} --${options.flag} "..."`,
      `${BIN} ${options.command} --${options.fileFlag} <path>   (use \`-\` for stdin)`,
    ]);
  }

  return undefined;
}

/** Jira duration string, e.g. `2h`, `1d 4h`, `30m`. */
const DURATION = /^(\d+(\.\d+)?[wdhm]\s*)+$/i;

export function validateDuration(flag: string, value: string): string {
  const trimmed = value.trim();
  if (!DURATION.test(trimmed)) {
    throw new AxiError(`--${flag} must be a Jira duration, got \`${value}\``, "VALIDATION_ERROR", [
      `--${flag} 90m`,
      `--${flag} "1d 4h"`,
      "Units: w (weeks), d (days), h (hours), m (minutes)",
    ]);
  }
  return trimmed;
}

export function validateDate(flag: string, value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new AxiError(`--${flag} must be a YYYY-MM-DD date, got \`${value}\``, "VALIDATION_ERROR", [
      `--${flag} 2026-09-30`,
    ]);
  }
  if (!Number.isFinite(new Date(`${trimmed}T00:00:00Z`).getTime())) {
    throw new AxiError(`--${flag} is not a real date: \`${value}\``, "VALIDATION_ERROR", []);
  }
  return trimmed;
}

/**
 * Parse a repeatable `--field key=value` escape hatch into a Jira fields object.
 * Values that parse as JSON are used as-is so an agent can set object-shaped
 * custom fields; everything else stays a string.
 */
export function parseFieldAssignments(entries: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new AxiError(`--field must be key=value, got \`${entry}\``, "VALIDATION_ERROR", [
        "--field customfield_10016=5",
        '--field customfield_10001=\'{"value":"Team A"}\'',
        `${BIN} field list --query "story points"   to find a custom field id`,
      ]);
    }

    const key = entry.slice(0, eq).trim();
    const raw = entry.slice(eq + 1);
    if (key.length === 0) {
      throw new AxiError(`--field is missing a name: \`${entry}\``, "VALIDATION_ERROR", []);
    }

    fields[key] = coerceFieldValue(raw);
  }

  return fields;
}

function coerceFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new AxiError(`--field value is not valid JSON: \`${raw}\``, "VALIDATION_ERROR", [
        'Quote it for the shell, e.g. --field customfield_10001=\'{"value":"Team A"}\'',
      ]);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  if (trimmed === "null") {
    return null;
  }
  return raw;
}
