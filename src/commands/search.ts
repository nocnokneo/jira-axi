import { BIN } from "../bin-name.js";
import type { Noun, Subcommand } from "../command.js";
import { countLine, issueRow, resolveFields, suggest } from "../format.js";
import { bool, list, num } from "../flags.js";
import { allOf, approximateCount, searchIssues } from "../jira.js";

/**
 * Raw JQL access.
 *
 * `issue list` covers the common filters, but JQL has functions and operators no
 * flag set should try to mirror. This is the escape hatch that keeps the
 * filtered commands from having to grow indefinitely.
 */
const searchSubcommand: Subcommand = {
  name: "jql",
  summary: "Run a JQL query",
  args: '"<jql>" [flags]',
  positionals: { name: '"<jql>"', min: 1, max: 1 },
  flags: {
    limit: { type: "number", placeholder: "<n>", default: 30, describe: "Maximum issues to return" },
    fields: {
      type: "string",
      repeatable: true,
      placeholder: "<names>",
      describe: "Extra columns; also accepts custom field ids",
    },
    count: { type: "boolean", describe: "Report only the number of matching issues" },
  },
  notes: [
    "Jira requires a bounded query: include at least one restriction, not just an ORDER BY",
  ],
  examples: [
    `${BIN} search "project = ACME AND status = 'In Review'"`,
    `${BIN} search "assignee = currentUser() AND updated >= -3d ORDER BY updated DESC"`,
    `${BIN} search "labels = regression" --count`,
  ],
  async run(parsed, context) {
    const jql = parsed.positionals[0] as string;
    const limit = Math.max(1, num(parsed, "limit", 30));
    const client = context.client();

    if (bool(parsed, "count")) {
      const total = await approximateCount(client, jql);
      return {
        jql,
        count: total ?? "unavailable",
        help: [`${BIN} search "${jql}" --limit ${Math.min(total ?? 30, 100)}`],
      };
    }

    const { api, extras } = resolveFields(list(parsed, "fields"));
    const [result, total] = await allOf([
      searchIssues(client, jql, { fields: api, limit }),
      approximateCount(client, jql),
    ]);

    if (result.issues.length === 0) {
      return {
        issues: "0 issues match this query",
        jql,
        help: [
          `${BIN} search "<broader jql>"`,
          suggest(`${BIN} issue list --state all`, "for the flag-based equivalent"),
        ],
      };
    }

    const help: string[] = [`${BIN} issue view ${result.issues[0]?.key ?? "<key>"}`];
    if (total !== undefined && total > result.issues.length) {
      help.push(suggest(`${BIN} search "${jql}" --limit ${Math.min(total, 100)}`, `for more of the ${total} matches`));
    }

    return {
      jql,
      count: countLine(result.issues.length, total),
      issues: result.issues.map((issue) => issueRow(issue, extras, context.now)),
      help,
    };
  },
};

export const searchNoun: Noun = {
  name: "search",
  summary: "Search issues with raw JQL",
  default: "jql",
  // `search "project = ACME"` should not read the query as a subcommand name.
  implicit: (first) => ({ subcommand: "jql", args: [first] }),
  subcommands: [searchSubcommand],
};
