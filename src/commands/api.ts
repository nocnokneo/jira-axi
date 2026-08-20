import { AxiError } from "axi-sdk-js";

import { BIN } from "../bin-name.js";
import type { Noun, Output, Subcommand } from "../command.js";
import { truncate } from "../format.js";
import { bool, list, str } from "../flags.js";
import { readTextFile } from "../input.js";

/**
 * Raw REST access.
 *
 * Every AXI needs a hatch for the endpoints it does not wrap, but the output
 * still has to obey the token budget: a single verbose field in an arbitrary
 * response can otherwise flood the agent's context, so long strings are capped
 * and deep structures are flattened before encoding.
 */

const MAX_STRING = 600;
const MAX_ARRAY = 50;
const MAX_DEPTH = 4;

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

const apiSubcommand: Subcommand = {
  name: "call",
  summary: "Call any Jira Cloud REST endpoint",
  args: "<path> [flags]",
  positionals: { name: "<path>", min: 1, max: 1 },
  flags: {
    method: {
      type: "string",
      short: "-X",
      placeholder: "<verb>",
      default: "GET",
      describe: "HTTP method: GET, POST, PUT, or DELETE",
    },
    field: {
      type: "string",
      short: "-f",
      repeatable: true,
      placeholder: "<key=value>",
      describe: "JSON body field; values that parse as JSON are sent as JSON",
    },
    query: {
      type: "string",
      short: "-q",
      repeatable: true,
      placeholder: "<key=value>",
      describe: "Query string parameter",
    },
    "body-file": {
      type: "string",
      placeholder: "<path>",
      describe: "Send this file as the JSON body, or `-` for stdin",
    },
    raw: { type: "boolean", describe: "Print the response as JSON instead of TOON" },
  },
  notes: [
    "Paths may be given with or without a leading slash; both `/rest/api/3/myself` and `rest/api/3/myself` work",
    "Long strings are truncated so one verbose field cannot flood the response; use --raw for verbatim JSON",
  ],
  examples: [
    `${BIN} api /rest/api/3/myself`,
    `${BIN} api /rest/api/3/project/search -q maxResults=5`,
    `${BIN} api /rest/api/3/issue/ACME-1/watchers -X POST`,
  ],
  async run(parsed, context) {
    const rawPath = (parsed.positionals[0] as string).trim();
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

    const method = (str(parsed, "method") ?? "GET").toUpperCase();
    if (!METHODS.has(method)) {
      throw new AxiError(`--method must be GET, POST, PUT, or DELETE, got \`${method}\``, "VALIDATION_ERROR", [
        `${BIN} api ${path} -X GET`,
      ]);
    }

    const query: Record<string, string> = {};
    for (const entry of list(parsed, "query")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) {
        throw new AxiError(`--query must be key=value, got \`${entry}\``, "VALIDATION_ERROR", [
          `${BIN} api ${path} -q maxResults=10`,
        ]);
      }
      query[entry.slice(0, eq)] = entry.slice(eq + 1);
    }

    const fieldEntries = list(parsed, "field");
    const bodyFile = str(parsed, "body-file");
    if (fieldEntries.length > 0 && bodyFile !== undefined) {
      throw new AxiError("--field and --body-file cannot be combined", "VALIDATION_ERROR", [
        "Pass either --field key=value or --body-file <path>",
      ]);
    }

    let body: unknown;
    if (bodyFile !== undefined) {
      const raw = readTextFile(bodyFile);
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AxiError(`${bodyFile} is not valid JSON`, "VALIDATION_ERROR", [
          "The body file must contain a JSON object",
        ]);
      }
    } else if (fieldEntries.length > 0) {
      const object: Record<string, unknown> = {};
      for (const entry of fieldEntries) {
        const eq = entry.indexOf("=");
        if (eq <= 0) {
          throw new AxiError(`--field must be key=value, got \`${entry}\``, "VALIDATION_ERROR", [
            `${BIN} api ${path} -X POST -f name=value`,
          ]);
        }
        object[entry.slice(0, eq)] = coerce(entry.slice(eq + 1));
      }
      body = object;
    }

    const response = await context.client().request<unknown>(path, {
      method: method as "GET" | "POST" | "PUT" | "DELETE",
      query,
      body,
      notFound: `no Jira endpoint at ${path}`,
      suggestions: ["Check the path against the Jira Cloud platform REST API v3 reference"],
    });

    if (response === undefined) {
      return { api: `${method} ${path} succeeded with no response body` };
    }

    if (bool(parsed, "raw")) {
      // Returned as a string so the JSON is written verbatim rather than being
      // TOON-encoded with its newlines escaped.
      return JSON.stringify(response, null, 2);
    }

    const shaped = shape(response, 0);
    return isRecord(shaped) ? (shaped as Output) : ({ response: shaped } as Output);
  },
};

function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cap strings, arrays, and nesting depth so an arbitrary response stays bounded. */
function shape(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    const result = truncate(value, MAX_STRING);
    return result.truncated ? `${result.text} (truncated, ${result.total} chars)` : result.text;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return `[${value.length} items]`;
    }
    const items = value.slice(0, MAX_ARRAY).map((item) => shape(item, depth + 1));
    if (value.length > MAX_ARRAY) {
      items.push(`... ${value.length - MAX_ARRAY} more of ${value.length}`);
    }
    return items;
  }

  if (isRecord(value)) {
    if (depth >= MAX_DEPTH) {
      return `{${Object.keys(value).length} keys}`;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // `self`, `avatarUrls`, and `expand` are pure overhead for an agent.
      if (key === "self" || key === "avatarUrls" || key === "expand" || key === "iconUrl") {
        continue;
      }
      out[key] = shape(item, depth + 1);
    }
    return out;
  }

  return value ?? "null";
}

export const apiNoun: Noun = {
  name: "api",
  summary: "Raw Jira Cloud REST access for endpoints the other commands do not wrap",
  default: "call",
  implicit: (first) => ({ subcommand: "call", args: [first] }),
  subcommands: [apiSubcommand],
};
