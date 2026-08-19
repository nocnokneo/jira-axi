import { BIN } from "../bin-name.js";
import type { Noun, Output, Subcommand } from "../command.js";
import { countLine, userLabel, type JiraUser } from "../format.js";
import { num, str } from "../flags.js";
import { allOf, approximateCount, paginate } from "../jira.js";
import { jqlString, normalizeProjectKey } from "../jql.js";

interface JiraProject {
  id?: string;
  key?: string;
  name?: string;
  projectTypeKey?: string;
  lead?: JiraUser;
  simplified?: boolean;
  style?: string;
  issueTypes?: Array<{ name?: string; subtask?: boolean }>;
  description?: string;
}

const listSubcommand: Subcommand = {
  name: "list",
  summary: "List projects you can see",
  args: "[flags]",
  flags: {
    query: { type: "string", short: "-q", placeholder: "<text>", describe: "Match project name or key" },
    limit: { type: "number", placeholder: "<n>", default: 100, describe: "Maximum projects to return" },
  },
  examples: [`${BIN} project list`, `${BIN} project list -q platform`],
  async run(parsed, context) {
    // Most sites have well under 100 projects, so one call usually answers the
    // question outright (principle 2: pick a default limit that avoids a second
    // round trip).
    const limit = Math.max(1, num(parsed, "limit", 100));
    const query = str(parsed, "query");

    const page = await paginate<JiraProject>(context.client(), "/rest/api/3/project/search", {
      limit,
      query: { query, orderBy: "key" },
    });

    if (page.values.length === 0) {
      return {
        projects: query ? `0 projects match \`${query}\`` : "0 projects are visible to this account",
        help: [query ? `${BIN} project list` : `${BIN} auth status`],
      };
    }

    return {
      count: countLine(page.values.length, page.total),
      projects: page.values.map((project) => ({
        key: project.key ?? "unknown",
        name: project.name ?? "",
        type: project.style ?? project.projectTypeKey ?? "unknown",
        lead: userLabel(project.lead),
      })),
      help: [
        `${BIN} project view ${page.values[0]?.key ?? "<key>"}`,
        `${BIN} issue list -p ${page.values[0]?.key ?? "<key>"}`,
      ],
    };
  },
};

interface StatusesResponse {
  name?: string;
  subtask?: boolean;
  statuses?: Array<{ name?: string; statusCategory?: { key?: string } }>;
}

const viewSubcommand: Subcommand = {
  name: "view",
  summary: "Show a project with its issue types, workflow statuses, and open issue count",
  args: "<key>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {},
  examples: [`${BIN} project view ACME`],
  async run(parsed, context) {
    const key = normalizeProjectKey(parsed.positionals[0] as string);
    const client = context.client();

    // Issue types and statuses are what an agent needs before it can create or
    // transition anything here, and the open count tells it whether the project
    // is active — all three bundled so `create` does not need a discovery pass.
    const [project, statuses, openCount] = await allOf([
      client.request<JiraProject>(`/rest/api/3/project/${encodeURIComponent(key)}`, {
        notFound: `project ${key} not found`,
        suggestions: [`${BIN} project list`],
      }),
      client.request<StatusesResponse[]>(`/rest/api/3/project/${encodeURIComponent(key)}/statuses`, {
        allow404: true,
      }),
      approximateCount(client, `project = ${jqlString(key)} AND statusCategory != Done`),
    ]);

    const types = statuses ?? [];
    const out: Output = {
      project: {
        key: project?.key ?? key,
        name: project?.name ?? "",
        type: project?.style ?? project?.projectTypeKey ?? "unknown",
        lead: userLabel(project?.lead),
        open_issues: openCount ?? "unavailable",
        url: `${context.config().site}/browse/${project?.key ?? key}`,
      },
    };

    if (types.length > 0) {
      out.issue_types = types.map((type) => ({
        name: type.name ?? "unknown",
        subtask: type.subtask === true,
        statuses: (type.statuses ?? []).map((status) => status.name).join(", "),
      }));
    }

    out.help = [
      `${BIN} issue list -p ${key}`,
      `${BIN} issue create -p ${key} -t ${types[0]?.name ?? "Task"} -s "<summary>"`,
      `${BIN} board list -p ${key}`,
    ];

    return out;
  },
};

export const projectNoun: Noun = {
  name: "project",
  summary: "Projects — list and inspect issue types, statuses, and activity",
  default: "list",
  // `jira-axi project ACME` is a view. Restricted to the uppercase form so a
  // mistyped subcommand (`project lst`) still reports an unknown subcommand
  // rather than looking up a project named "LST".
  implicit: (first) => (/^[A-Z][A-Z0-9_]+$/.test(first) ? { subcommand: "view", args: [first] } : undefined),
  subcommands: [listSubcommand, viewSubcommand],
};
