import { AxiError } from "axi-sdk-js";

import { BIN } from "../bin-name.js";
import type { Noun, Subcommand } from "../command.js";
import { suggest, userLabel } from "../format.js";
import { num, str } from "../flags.js";
import { getMyself, searchUsers } from "../jira.js";
import { normalizeProjectKey } from "../jql.js";

const meSubcommand: Subcommand = {
  name: "me",
  summary: "Show the authenticated account",
  args: "",
  flags: {},
  examples: [`${BIN} user me`],
  async run(_parsed, context) {
    const me = await getMyself(context.client());
    return {
      user: {
        name: me.displayName ?? "unknown",
        email: me.emailAddress ?? "hidden",
        account_id: me.accountId ?? "unknown",
        site: context.config().host,
      },
      help: [`${BIN} issue list -a @me`],
    };
  },
};

const searchSubcommand: Subcommand = {
  name: "search",
  summary: "Find users by name or email",
  args: '"<query>" [flags]',
  positionals: { name: '"<query>"', min: 1, max: 1 },
  flags: {
    project: {
      type: "string",
      short: "-p",
      placeholder: "<key>",
      describe: "Only users who can be assigned issues in this project",
    },
    limit: { type: "number", placeholder: "<n>", default: 20, describe: "Maximum users to return" },
  },
  notes: [
    "Jira Cloud hides email addresses unless a user made theirs public, so a display name often matches when an email does not",
  ],
  examples: [`${BIN} user search alice`, `${BIN} user search "Alice Chen" -p ACME`],
  async run(parsed, context) {
    const query = parsed.positionals[0] as string;
    const limit = Math.max(1, num(parsed, "limit", 20));
    const project = str(parsed, "project");

    const users = await searchUsers(
      context.client(),
      query,
      project ? normalizeProjectKey(project) : undefined,
    );

    if (users.length === 0) {
      return {
        users: `0 users match \`${query}\``,
        help: [
          "Try a partial display name; email search only works for public addresses",
          project ? `${BIN} user search "${query}"` : `${BIN} user me`,
        ],
      };
    }

    const shown = users.slice(0, limit);

    return {
      count: shown.length === users.length ? `${shown.length}` : `${shown.length} of ${users.length}`,
      users: shown.map((user) => ({
        name: userLabel(user),
        email: user.emailAddress ?? "hidden",
        account_id: user.accountId ?? "unknown",
        active: user.active !== false,
      })),
      help: [`${BIN} issue assign <key> --to ${shown[0]?.accountId ?? "<account-id>"}`],
    };
  },
};

export const userNoun: Noun = {
  name: "user",
  summary: "Users — show the current account and look up others",
  default: "me",
  subcommands: [meSubcommand, searchSubcommand],
};

/* ------------------------------------------------------------------ */
/* field                                                              */
/* ------------------------------------------------------------------ */

interface JiraField {
  id?: string;
  key?: string;
  name?: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string };
}

const fieldListSubcommand: Subcommand = {
  name: "list",
  summary: "List issue fields and their ids",
  args: "[flags]",
  flags: {
    query: { type: "string", short: "-q", placeholder: "<text>", describe: "Match field name" },
    custom: { type: "boolean", describe: "Only custom fields" },
    limit: { type: "number", placeholder: "<n>", default: 100, describe: "Maximum fields to return" },
  },
  notes: [
    "Use the id with `--field <id>=<value>` on `issue create` and `issue edit`, or with `--fields <id>` on list commands",
  ],
  examples: [
    `${BIN} field list -q "story points"`,
    `${BIN} field list --custom`,
  ],
  async run(parsed, context) {
    const query = str(parsed, "query")?.toLowerCase();
    const customOnly = parsed.flags.custom === true;
    const limit = Math.max(1, num(parsed, "limit", 100));

    // `/field` returns every field in one unpaginated response, so filter here.
    const all = (await context.client().request<JiraField[]>("/rest/api/3/field")) ?? [];
    const filtered = all.filter((field) => {
      if (customOnly && field.custom !== true) {
        return false;
      }
      if (query && !(field.name ?? "").toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return {
        fields: query ? `0 fields match \`${query}\`` : "0 fields returned",
        help: [`${BIN} field list`],
      };
    }

    const shown = filtered.slice(0, limit);
    const out: Record<string, unknown> = {
      count: shown.length === filtered.length ? `${shown.length}` : `${shown.length} of ${filtered.length}`,
      fields: shown.map((field) => ({
        id: field.id ?? field.key ?? "unknown",
        name: field.name ?? "",
        type: field.schema?.type ?? "unknown",
        custom: field.custom === true,
      })),
    };

    const help: string[] = [];
    if (shown.length < filtered.length) {
      help.push(suggest(`${BIN} field list --limit ${filtered.length}`, `for all ${filtered.length} matches`));
    }
    help.push(`${BIN} issue edit <key> --field ${shown[0]?.id ?? "<id>"}=<value>`);
    out.help = help;

    return out;
  },
};

const fieldViewSubcommand: Subcommand = {
  name: "view",
  summary: "Show one field by id or exact name",
  args: "<id|name>",
  positionals: { name: "<id|name>", min: 1, max: 1 },
  flags: {},
  examples: [`${BIN} field view customfield_10016`],
  async run(parsed, context) {
    const needle = parsed.positionals[0] as string;
    const all = (await context.client().request<JiraField[]>("/rest/api/3/field")) ?? [];
    const lowered = needle.toLowerCase();
    const match =
      all.find((field) => field.id === needle || field.key === needle) ??
      all.find((field) => (field.name ?? "").toLowerCase() === lowered);

    if (!match) {
      throw new AxiError(`no field matches \`${needle}\``, "NOT_FOUND", [
        `${BIN} field list -q "${needle}"`,
      ]);
    }

    return {
      field: {
        id: match.id ?? match.key ?? "unknown",
        name: match.name ?? "",
        type: match.schema?.type ?? "unknown",
        custom: match.custom === true,
        custom_type: match.schema?.custom ?? "none",
      },
      help: [`${BIN} issue edit <key> --field ${match.id ?? "<id>"}=<value>`],
    };
  },
};

export const fieldNoun: Noun = {
  name: "field",
  summary: "Fields — find the ids needed for custom field reads and writes",
  default: "list",
  subcommands: [fieldListSubcommand, fieldViewSubcommand],
};
