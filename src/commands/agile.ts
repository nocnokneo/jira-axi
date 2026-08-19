import { AxiError } from "axi-sdk-js";

import { BIN } from "../bin-name.js";
import type { Noun, Output, Subcommand } from "../command.js";
import { countLine, isDone, issueRow, resolveFields, statusLabel, suggest, type JiraIssue } from "../format.js";
import { list, num, requireStr, str } from "../flags.js";
import { allOf, paginate } from "../jira.js";
import { normalizeIssueKey, normalizeProjectKey } from "../jql.js";

/**
 * Jira Software boards and sprints.
 *
 * These live on the separate `/rest/agile/1.0` API rather than `/rest/api/3`,
 * and they are only present on Jira Software projects — a company-managed
 * business project has no boards at all, which the empty states call out.
 */

interface Board {
  id?: number;
  name?: string;
  type?: string;
  location?: { projectKey?: string; projectName?: string };
}

interface Sprint {
  id?: number;
  name?: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
  originBoardId?: number;
}

/* ------------------------------------------------------------------ */
/* board                                                               */
/* ------------------------------------------------------------------ */

const boardListSubcommand: Subcommand = {
  name: "list",
  summary: "List boards",
  args: "[flags]",
  flags: {
    project: { type: "string", short: "-p", placeholder: "<key>", describe: "Only boards for this project" },
    name: { type: "string", placeholder: "<text>", describe: "Match board name" },
    type: { type: "string", placeholder: "<scrum|kanban|simple>", describe: "Board type" },
    limit: { type: "number", placeholder: "<n>", default: 50, describe: "Maximum boards to return" },
  },
  examples: [`${BIN} board list`, `${BIN} board list -p ACME`],
  async run(parsed, context) {
    const limit = Math.max(1, num(parsed, "limit", 50));
    const project = str(parsed, "project");

    const page = await paginate<Board>(context.client(), "/rest/agile/1.0/board", {
      limit,
      query: {
        projectKeyOrId: project ? normalizeProjectKey(project) : undefined,
        name: str(parsed, "name"),
        type: str(parsed, "type"),
      },
    });

    if (page.values.length === 0) {
      return {
        boards: project
          ? `0 boards for project ${normalizeProjectKey(project)}`
          : "0 boards are visible to this account",
        help: [
          "Boards exist only on Jira Software projects",
          `${BIN} project list`,
        ],
      };
    }

    return {
      count: countLine(page.values.length, page.total),
      boards: page.values.map((board) => ({
        id: board.id ?? 0,
        name: board.name ?? "",
        type: board.type ?? "unknown",
        project: board.location?.projectKey ?? "unknown",
      })),
      help: [
        `${BIN} sprint list --board ${page.values[0]?.id ?? "<id>"}`,
        `${BIN} board view ${page.values[0]?.id ?? "<id>"}`,
      ],
    };
  },
};

const boardViewSubcommand: Subcommand = {
  name: "view",
  summary: "Show a board with its active sprint and column layout",
  args: "<id>",
  positionals: { name: "<id>", min: 1, max: 1 },
  flags: {},
  examples: [`${BIN} board view 12`],
  async run(parsed, context) {
    const id = parseId(parsed.positionals[0] as string, "board id");
    const client = context.client();

    const [board, configuration, sprints] = await allOf([
      client.request<Board>(`/rest/agile/1.0/board/${id}`, { notFound: `board ${id} not found` }),
      client.request<{ columnConfig?: { columns?: Array<{ name?: string }> }; estimation?: { field?: { displayName?: string } } }>(
        `/rest/agile/1.0/board/${id}/configuration`,
        { allow404: true },
      ),
      // Kanban boards have no sprints; a 400/404 here is expected, not an error.
      paginate<Sprint>(client, `/rest/agile/1.0/board/${id}/sprint`, {
        limit: 10,
        query: { state: "active,future" },
      }).catch(() => ({ values: [] as Sprint[], total: undefined, isLast: true })),
    ]);

    const active = sprints.values.filter((sprint) => sprint.state === "active");

    const out: Output = {
      board: {
        id: board?.id ?? id,
        name: board?.name ?? "",
        type: board?.type ?? "unknown",
        project: board?.location?.projectKey ?? "unknown",
      },
    };

    const columns = configuration?.columnConfig?.columns ?? [];
    if (columns.length > 0) {
      (out.board as Output).columns = columns.map((column) => column.name).join(" -> ");
    }
    if (configuration?.estimation?.field?.displayName) {
      (out.board as Output).estimation = configuration.estimation.field.displayName;
    }

    if (sprints.values.length > 0) {
      out.sprints = sprints.values.map((sprint) => sprintRow(sprint));
    }

    const help: string[] = [];
    if (active[0]?.id) {
      help.push(`${BIN} sprint view ${active[0].id}`);
    }
    help.push(`${BIN} sprint list --board ${board?.id ?? id} --state all`);
    help.push(`${BIN} issue list -p ${board?.location?.projectKey ?? "<key>"} --sprint current`);
    out.help = help;

    return out;
  },
};

export const boardNoun: Noun = {
  name: "board",
  summary: "Boards — list and inspect Jira Software boards",
  default: "list",
  implicit: (first) => (/^\d+$/.test(first) ? { subcommand: "view", args: [first] } : undefined),
  subcommands: [boardListSubcommand, boardViewSubcommand],
};

/* ------------------------------------------------------------------ */
/* sprint                                                             */
/* ------------------------------------------------------------------ */

function parseId(raw: string, label: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new AxiError(`${label} must be a number, got \`${raw}\``, "VALIDATION_ERROR", [
      `${BIN} board list to find board ids`,
    ]);
  }
  return Number(raw.trim());
}

function sprintRow(sprint: Sprint): Output {
  const row: Output = {
    id: sprint.id ?? 0,
    name: sprint.name ?? "",
    state: sprint.state ?? "unknown",
  };
  if (sprint.endDate) {
    row.ends = sprint.endDate.slice(0, 10);
  }
  return row;
}

const sprintListSubcommand: Subcommand = {
  name: "list",
  summary: "List a board's sprints",
  args: "--board <id> [flags]",
  flags: {
    board: { type: "string", short: "-b", placeholder: "<id>", describe: "Board id (required)" },
    state: {
      type: "string",
      placeholder: "<active|future|closed|all>",
      default: "active,future",
      describe: "Sprint states to include",
    },
    limit: { type: "number", placeholder: "<n>", default: 50, describe: "Maximum sprints to return" },
  },
  examples: [`${BIN} sprint list --board 12`, `${BIN} sprint list --board 12 --state closed`],
  async run(parsed, context) {
    const board = parseId(requireStr(parsed, "board", "sprint list"), "board id");
    const limit = Math.max(1, num(parsed, "limit", 50));
    const stateFlag = str(parsed, "state") ?? "active,future";
    const state = stateFlag === "all" ? undefined : stateFlag;

    const page = await paginate<Sprint>(context.client(), `/rest/agile/1.0/board/${board}/sprint`, {
      limit,
      query: { state },
    });

    if (page.values.length === 0) {
      return {
        sprints:
          stateFlag === "all"
            ? `0 sprints on board ${board}`
            : `0 ${stateFlag} sprints on board ${board}`,
        help: [
          `${BIN} sprint list --board ${board} --state all`,
          "Kanban boards have no sprints",
        ],
      };
    }

    const active = page.values.find((sprint) => sprint.state === "active");

    return {
      count: countLine(page.values.length, page.total),
      sprints: page.values.map((sprint) => sprintRow(sprint)),
      help: [
        `${BIN} sprint view ${active?.id ?? page.values[0]?.id ?? "<id>"}`,
        `${BIN} sprint add <id> --issue <key>`,
      ],
    };
  },
};

const sprintViewSubcommand: Subcommand = {
  name: "view",
  summary: "Show a sprint with its issues grouped by completion",
  args: "<id> [flags]",
  positionals: { name: "<id>", min: 1, max: 1 },
  flags: {
    limit: { type: "number", placeholder: "<n>", default: 50, describe: "Maximum issues to return" },
    fields: {
      type: "string",
      repeatable: true,
      placeholder: "<names>",
      describe: "Extra columns; also accepts custom field ids",
    },
  },
  examples: [`${BIN} sprint view 34`, `${BIN} sprint view 34 --fields type,priority`],
  async run(parsed, context) {
    const id = parseId(parsed.positionals[0] as string, "sprint id");
    const limit = Math.max(1, num(parsed, "limit", 50));
    const { api, extras } = resolveFields(list(parsed, "fields"));
    const client = context.client();

    const [sprint, issues] = await allOf([
      client.request<Sprint>(`/rest/agile/1.0/sprint/${id}`, { notFound: `sprint ${id} not found` }),
      paginate<JiraIssue>(client, `/rest/agile/1.0/sprint/${id}/issue`, {
        limit,
        key: "issues",
        query: { fields: api.join(",") },
      }),
    ]);

    const out: Output = {
      sprint: {
        id: sprint?.id ?? id,
        name: sprint?.name ?? "",
        state: sprint?.state ?? "unknown",
      },
    };
    if (sprint?.startDate) {
      (out.sprint as Output).starts = sprint.startDate.slice(0, 10);
    }
    if (sprint?.endDate) {
      (out.sprint as Output).ends = sprint.endDate.slice(0, 10);
    }
    if (sprint?.goal) {
      (out.sprint as Output).goal = sprint.goal;
    }

    if (issues.values.length === 0) {
      out.issues = `0 issues in sprint ${id}`;
      out.help = [`${BIN} sprint add ${id} --issue <key>`];
      return out;
    }

    // Principle 4: sprint progress is the question being asked, so compute it
    // here instead of making the agent tally statuses itself.
    const done = issues.values.filter((issue) => isDone(issue.fields?.status)).length;
    (out.sprint as Output).progress = `${done}/${issues.values.length} done`;

    const byStatus = new Map<string, number>();
    for (const issue of issues.values) {
      const status = statusLabel(issue.fields?.status);
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    }
    (out.sprint as Output).by_status = [...byStatus.entries()]
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ");

    out.count = countLine(issues.values.length, issues.total);
    out.issues = issues.values.map((issue) => issueRow(issue, extras, context.now));

    const help: string[] = [`${BIN} issue view ${issues.values[0]?.key ?? "<key>"}`];
    if (issues.total !== undefined && issues.total > issues.values.length) {
      help.push(suggest(`${BIN} sprint view ${id} --limit ${issues.total}`, `for all ${issues.total} issues`));
    }
    out.help = help;

    return out;
  },
};

const sprintAddSubcommand: Subcommand = {
  name: "add",
  summary: "Move issues into a sprint",
  args: "<id> --issue <key>",
  positionals: { name: "<id>", min: 1, max: 1 },
  flags: {
    issue: {
      type: "string",
      short: "-i",
      repeatable: true,
      placeholder: "<key>",
      describe: "Issue to move; repeat for several",
    },
  },
  notes: ["Jira accepts at most 50 issues per call"],
  examples: [`${BIN} sprint add 34 --issue ACME-42`, `${BIN} sprint add 34 -i ACME-42 -i ACME-43`],
  async run(parsed, context) {
    const id = parseId(parsed.positionals[0] as string, "sprint id");
    const keys = list(parsed, "issue").map((key) => normalizeIssueKey(key));

    if (keys.length === 0) {
      throw new AxiError("--issue is required", "VALIDATION_ERROR", [
        `${BIN} sprint add ${id} --issue ACME-42`,
      ]);
    }
    if (keys.length > 50) {
      throw new AxiError(`--issue accepts at most 50 keys, got ${keys.length}`, "VALIDATION_ERROR", [
        "Split the move into batches of 50",
      ]);
    }

    await context.client().request(`/rest/agile/1.0/sprint/${id}/issue`, {
      method: "POST",
      body: { issues: keys },
      notFound: `sprint ${id} not found`,
      suggestions: [`${BIN} sprint list --board <id>`],
    });

    return {
      moved: { sprint: id, issues: keys.join(" "), count: keys.length },
      help: [`${BIN} sprint view ${id}`],
    };
  },
};

export const sprintNoun: Noun = {
  name: "sprint",
  summary: "Sprints — list, inspect progress, and move issues in",
  implicit: (first) => (/^\d+$/.test(first) ? { subcommand: "view", args: [first] } : undefined),
  subcommands: [sprintListSubcommand, sprintViewSubcommand, sprintAddSubcommand],
};
