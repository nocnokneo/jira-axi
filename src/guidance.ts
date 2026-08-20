import { encode } from "@toon-format/toon";

import { BIN } from "./bin-name.js";

/**
 * Single source of truth for the tool's own documentation.
 *
 * The top-level `--help` block, the home view's guidance, and the generated
 * Agent Skill are all built from these constants so they cannot drift apart
 * (principle 7: generate `SKILL.md` from the same content the CLI prints).
 */

export const DESCRIPTION = "Jira Cloud issues, sprints, and projects for the current account";

export const COMMANDS: Array<[string, string]> = [
  ["issue", "Issues — list, view, create, edit, transition, assign, comment, link, log time"],
  ["search", "Search issues with raw JQL"],
  ["project", "Projects — list and inspect issue types, statuses, and activity"],
  ["board", "Boards — list and inspect Jira Software boards"],
  ["sprint", "Sprints — list, inspect progress, and move issues in"],
  ["user", "Users — show the current account and look up others"],
  ["field", "Fields — find the ids needed for custom field reads and writes"],
  ["api", "Raw Jira Cloud REST access"],
  ["auth", "Credentials — check, store, list, and remove accounts"],
  ["setup", "Install optional agent session integrations"],
  ["update", "Upgrade jira-axi to the latest published version"],
];

/**
 * Commands worth showing an agent before it has read any help, as
 * intent -> command. Keyed rather than a flat list because TOON renders an
 * object as a readable block and a string array as one inline row.
 */
export const QUICK_START: Array<[string, string]> = [
  ["your open issues", BIN],
  ["open issues in a project", `${BIN} issue list -p ACME`],
  ["everything assigned to you", `${BIN} issue list -a @me --state all`],
  ["detail, relationships, comments", `${BIN} issue view ACME-42`],
  ["create an issue", `${BIN} issue create -p ACME -s "<summary>"`],
  ["change status", `${BIN} issue transition ACME-42 --to "In Progress"`],
  ["comment", `${BIN} issue comment ACME-42 --body "..."`],
  ["reassign", `${BIN} issue assign ACME-42 --to @me`],
  ["raw JQL", `${BIN} search "project = ACME AND labels = regression"`],
  ["sprint progress", `${BIN} sprint list --board 12`],
];

/** Just the commands from `QUICK_START`, for use as `help` suggestions. */
export function quickStartCommands(): string[] {
  return QUICK_START.map(([, command]) => command);
}

export const NOTES: string[] = [
  "Output is TOON. Errors go to stdout in the same shape; exit 0 = success, 1 = error, 2 = usage error",
  "Mutations are idempotent: transitioning to the current status, or an edit that changes nothing, reports a no-op and exits 0",
  "Long text is truncated with a size hint; pass --full to see all of it",
  "Unknown flags are rejected rather than ignored, and the error lists the valid flags for that subcommand",
  `Run \`${BIN} <command> --help\` for one command's flags and examples`,
];

export const AUTH_NOTES: string[] = [
  "Set JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN, or run `jira-axi auth login`",
  "JIRA_SITE accepts `acme`, `acme.atlassian.net`, or a full https URL",
  "Only Jira Cloud is supported; authentication is an Atlassian API token, not a password",
];

export const GLOBAL_FLAG_HELP: Array<[string, string]> = [
  ["--help", "Show help for any command"],
  ["-v, -V, --version", `Print the installed ${BIN} version`],
  ["--site <site>", "Target a specific Jira Cloud site"],
  ["--account <name>", "Use a named account from the config file"],
];

function record(entries: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    out[key] = value;
  }
  return out;
}

/** Rendered top-level `--help`. */
export function topLevelHelp(): string {
  return `${encode({
    bin: BIN,
    description: DESCRIPTION,
    usage: `${BIN} <command> [subcommand] [args] [flags]`,
    commands: record(COMMANDS),
    global_flags: record(GLOBAL_FLAG_HELP),
    examples: record(QUICK_START),
    auth: AUTH_NOTES,
    notes: NOTES,
  })}\n`;
}
