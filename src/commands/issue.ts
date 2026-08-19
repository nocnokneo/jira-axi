import { AxiError } from "axi-sdk-js";

import { adfToText, textToAdf } from "../adf.js";
import { BIN } from "../bin-name.js";
import type { Noun, Output, RunContext, Subcommand } from "../command.js";
import {
  countLine,
  formatSeconds,
  issueRow,
  isDone,
  previewField,
  relativeAge,
  resolveFields,
  shortTimestamp,
  statusCategory,
  statusLabel,
  suggest,
  truncate,
  userLabel,
  type JiraComment,
  type JiraIssue,
  type JiraIssueLink,
  type JiraTransition,
  type JiraWorklog,
} from "../format.js";
import { bool, list, num, requireStr, str, type FlagSpec, type ParsedArgs } from "../flags.js";
import {
  jiraDateTimestamp,
  parseFieldAssignments,
  resolveText,
  validateDate,
  validateDuration,
} from "../input.js";
import {
  allOf,
  approximateCount,
  getIssue,
  getTransitions,
  paginate,
  resolveAccount,
  searchIssues,
  UNASSIGNED,
} from "../jira.js";
import { buildJql, isIssueKey, normalizeIssueKey, normalizeProjectKey, normalizeState } from "../jql.js";

/* ------------------------------------------------------------------ */
/* Shared flags                                                        */
/* ------------------------------------------------------------------ */

const FILTER_FLAGS: FlagSpec = {
  project: { type: "string", short: "-p", placeholder: "<key>", describe: "Restrict to one project" },
  assignee: {
    type: "string",
    short: "-a",
    placeholder: "<user>",
    describe: "Assignee: @me, an email, a display name, an account id, or `none`",
  },
  reporter: { type: "string", placeholder: "<user>", describe: "Reporter, same forms as --assignee" },
  state: {
    type: "string",
    placeholder: "<open|closed|all>",
    default: "open",
    describe: "Filter by status category",
  },
  status: {
    type: "string",
    repeatable: true,
    placeholder: "<name>",
    describe: "Exact status name; overrides --state",
  },
  type: { type: "string", short: "-t", repeatable: true, placeholder: "<name>", describe: "Issue type" },
  label: { type: "string", short: "-l", repeatable: true, placeholder: "<label>", describe: "Label" },
  priority: { type: "string", repeatable: true, placeholder: "<name>", describe: "Priority name" },
  component: { type: "string", repeatable: true, placeholder: "<name>", describe: "Component name" },
  "fix-version": { type: "string", repeatable: true, placeholder: "<name>", describe: "Fix version" },
  parent: { type: "string", placeholder: "<key>", describe: "Parent issue or epic key" },
  sprint: {
    type: "string",
    placeholder: "<current|id|name>",
    describe: "Sprint: `current` for open sprints, `future`, an id, or a name",
  },
  text: { type: "string", placeholder: "<words>", describe: "Full-text search across summary and description" },
  updated: { type: "string", placeholder: "<age|date>", describe: "Updated since, e.g. 7d or 2026-08-01" },
  created: { type: "string", placeholder: "<age|date>", describe: "Created since, e.g. 30d or 2026-07-01" },
  jql: { type: "string", placeholder: "<jql>", describe: "Extra JQL ANDed with the other filters" },
  "order-by": {
    type: "string",
    placeholder: "<clause>",
    default: "updated DESC",
    describe: "JQL ORDER BY clause",
  },
  limit: { type: "number", placeholder: "<n>", default: 30, describe: "Maximum issues to return" },
  fields: {
    type: "string",
    repeatable: true,
    placeholder: "<names>",
    describe: "Extra columns; also accepts custom field ids",
  },
  count: { type: "boolean", describe: "Report only the number of matching issues" },
};

/** Fields `issue view` always asks for. */
const VIEW_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "issuetype",
  "labels",
  "created",
  "updated",
  "duedate",
  "resolution",
  "resolutiondate",
  "parent",
  "subtasks",
  "project",
  "components",
  "fixVersions",
  "description",
  "issuelinks",
  "attachment",
  "watches",
  "timespent",
  "aggregatetimespent",
  "timeestimate",
];

function browseUrl(context: RunContext, key: string): string {
  return `${context.config().site}/browse/${key}`;
}

/* ------------------------------------------------------------------ */
/* issue list                                                          */
/* ------------------------------------------------------------------ */

/** Resolve user-ish filter values to account ids where JQL needs them. */
async function resolveFilterUser(
  context: RunContext,
  value: string | undefined,
  project: string | undefined,
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined;
  }
  const lowered = value.trim().toLowerCase();
  if (["@me", "me", "none", "unassigned", "null", "currentuser()"].includes(lowered)) {
    return value;
  }
  // Jira Cloud hides email addresses by default, so `assignee = "a@b.com"` often
  // matches nothing. Resolving to an account id first keeps the filter honest.
  const resolved = await resolveAccount(context.client(), value, { project });
  return resolved === UNASSIGNED ? "none" : resolved;
}

function filtersFromArgs(parsed: ParsedArgs): {
  project: string | undefined;
  state: ReturnType<typeof normalizeState>;
} {
  const project = str(parsed, "project");
  return {
    project: project ? normalizeProjectKey(project) : undefined,
    state: normalizeState(str(parsed, "state")),
  };
}

const listSubcommand: Subcommand = {
  name: "list",
  summary: "List issues matching filters",
  args: "[flags]",
  flags: FILTER_FLAGS,
  notes: [
    "Defaults to open issues (statusCategory != Done); pass --state all to include closed ones",
    "`count` is Jira's approximate total for the query and can lag very recent writes",
  ],
  examples: [
    `${BIN} issue list -p ACME`,
    `${BIN} issue list -a @me --state all --limit 50`,
    `${BIN} issue list -p ACME --sprint current --fields type,priority`,
    `${BIN} issue list --jql "labels = regression AND priority = High"`,
  ],
  async run(parsed, context) {
    const { project, state } = filtersFromArgs(parsed);
    const limit = num(parsed, "limit", 30);
    if (limit < 1) {
      throw new AxiError("--limit must be at least 1", "VALIDATION_ERROR", ["--limit 30"]);
    }

    const assignee = await resolveFilterUser(context, str(parsed, "assignee"), project);
    const reporter = await resolveFilterUser(context, str(parsed, "reporter"), project);

    const jql = buildJql({
      project,
      assignee,
      reporter,
      state,
      status: list(parsed, "status"),
      type: list(parsed, "type"),
      label: list(parsed, "label"),
      priority: list(parsed, "priority"),
      component: list(parsed, "component"),
      fixVersion: list(parsed, "fix-version"),
      parent: str(parsed, "parent"),
      sprint: str(parsed, "sprint"),
      text: str(parsed, "text"),
      updated: str(parsed, "updated"),
      created: str(parsed, "created"),
      jql: str(parsed, "jql"),
      orderBy: str(parsed, "order-by"),
    });

    if (bool(parsed, "count")) {
      const total = await approximateCount(context.client(), jql);
      return {
        jql,
        count: total ?? "unavailable",
        help: [`${BIN} issue list ${project ? `-p ${project} ` : ""}--limit ${Math.min(total ?? 30, 100)}`],
      };
    }

    const { api, extras } = resolveFields(list(parsed, "fields"));
    const [result, total] = await allOf([
      searchIssues(context.client(), jql, { fields: api, limit }),
      approximateCount(context.client(), jql),
    ]);

    return renderIssueList(context, result.issues, extras, {
      jql,
      total,
      limit,
      project,
      state,
    });
  },
};

function renderIssueList(
  context: RunContext,
  issues: JiraIssue[],
  extras: string[],
  meta: {
    jql: string;
    total: number | undefined;
    limit: number;
    project?: string | undefined;
    state?: string;
  },
): Output {
  if (issues.length === 0) {
    // Principle 5: an empty result is the answer, so say so with context rather
    // than emitting a bare empty array the agent will re-query to confirm.
    const scope = [meta.state && meta.state !== "all" ? meta.state : undefined, "issues"]
      .filter(Boolean)
      .join(" ");
    return {
      issues: `0 ${scope} match this query`,
      jql: meta.jql,
      help: [
        meta.state !== "all" ? `${BIN} issue list --state all` : `${BIN} issue list --limit 100`,
        `${BIN} search "<jql>" to query Jira directly`,
      ],
    };
  }

  const out: Output = {
    jql: meta.jql,
    count: countLine(issues.length, meta.total),
    issues: issues.map((issue) => issueRow(issue, extras, context.now)),
  };

  const help: string[] = [`${BIN} issue view ${issues[0]?.key ?? "<key>"}`];
  if (meta.total !== undefined && meta.total > issues.length) {
    help.push(suggest(`${BIN} issue list --limit ${Math.min(meta.total, 100)}`, `for more of the ${meta.total} matches`));
  }
  help.push(`${BIN} issue transition <key> --to "<status>"`);
  out.help = help;

  return out;
}

/* ------------------------------------------------------------------ */
/* issue view                                                          */
/* ------------------------------------------------------------------ */

const COMMENT_PREVIEW_CHARS = 320;

const viewSubcommand: Subcommand = {
  name: "view",
  summary: "Show one issue with its status, relationships, and newest comments",
  args: "<key> [flags]",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    full: { type: "boolean", describe: "Print the complete description and comment bodies" },
    comments: {
      type: "number",
      placeholder: "<n>",
      default: 3,
      describe: "Newest comments to include inline; 0 to omit",
    },
    fields: {
      type: "string",
      repeatable: true,
      placeholder: "<names>",
      describe: "Extra fields to include, including custom field ids",
    },
  },
  examples: [`${BIN} issue view ACME-42`, `${BIN} issue view ACME-42 --full --comments 10`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const full = bool(parsed, "full");
    const commentCount = Math.max(0, num(parsed, "comments", 3));
    const { extras } = resolveFields(list(parsed, "fields"));

    const client = context.client();

    // Comments live behind their own endpoint so a long-running issue does not
    // drag its entire history into this response. They are also secondary: if
    // only the comment call fails, the issue is still worth rendering.
    const [issue, comments] = await allOf([
      getIssue(client, key, { fields: [...VIEW_FIELDS, ...extras], expand: ["transitions"] }),
      commentCount > 0
        ? fetchComments(client, key, commentCount).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const fields = issue.fields ?? {};
    const out: Output = {};
    const issueOut: Output = {
      key: issue.key ?? key,
      summary: fields.summary ?? "",
      type: fields.issuetype?.name ?? "unknown",
      status: statusLabel(fields.status),
      assignee: userLabel(fields.assignee),
    };

    const category = statusCategory(fields.status);
    if (category && category !== "done") {
      issueOut.category = category;
    }
    if (fields.resolution?.name) {
      issueOut.resolution = fields.resolution.name;
    }
    issueOut.reporter = userLabel(fields.reporter);
    issueOut.priority = fields.priority?.name ?? "none";
    issueOut.project = fields.project?.key ?? "unknown";

    if ((fields.labels ?? []).length > 0) {
      issueOut.labels = (fields.labels ?? []).join(" ");
    }
    if ((fields.components ?? []).length > 0) {
      issueOut.components = (fields.components ?? []).map((c) => c.name).join(" ");
    }
    if ((fields.fixVersions ?? []).length > 0) {
      issueOut.fix_versions = (fields.fixVersions ?? []).map((v) => v.name).join(" ");
    }
    if (fields.parent?.key) {
      issueOut.parent = `${fields.parent.key} (${fields.parent.fields?.summary ?? "unknown"})`;
    }
    if (fields.duedate) {
      issueOut.due = fields.duedate;
    }

    issueOut.created = shortTimestamp(fields.created) ?? "unknown";
    issueOut.updated = relativeAge(fields.updated, context.now) ?? "unknown";

    // Principle 4: cheap derived summaries that would otherwise each cost the
    // agent a follow-up call.
    const subtasks = fields.subtasks ?? [];
    if (subtasks.length > 0) {
      const done = subtasks.filter((task) => isDone(task.fields?.status)).length;
      issueOut.subtasks = `${done}/${subtasks.length} done`;
    }
    const links = fields.issuelinks ?? [];
    if (links.length > 0) {
      issueOut.links = links.length;
    }
    if (comments) {
      issueOut.comments = comments.total;
    }
    const attachments = fields.attachment ?? [];
    if (attachments.length > 0) {
      issueOut.attachments = attachments.length;
    }
    const logged = formatSeconds(fields.aggregatetimespent ?? fields.timespent ?? undefined);
    if (logged) {
      issueOut.time_spent = logged;
    }
    const remaining = formatSeconds(fields.timeestimate ?? undefined);
    if (remaining) {
      issueOut.estimate_remaining = remaining;
    }
    if (fields.watches?.watchCount) {
      issueOut.watchers = fields.watches.watchCount;
    }

    for (const extra of extras) {
      const row = issueRow(issue, [extra], context.now);
      issueOut[extra] = row[extra];
    }

    const transitions = (issue.transitions ?? []).filter((t) => t.isAvailable !== false);
    if (transitions.length > 0) {
      issueOut.transitions = transitions.map((t) => t.to?.name ?? t.name ?? "unknown").join(", ");
    }

    issueOut.url = browseUrl(context, issue.key ?? key);

    const description = previewField(fields.description, full);
    if (description) {
      issueOut.description = description.value;
    } else {
      issueOut.description = "none";
    }

    out.issue = issueOut;

    if (subtasks.length > 0) {
      out.subtasks = subtasks.map((task) => ({
        key: task.key ?? "unknown",
        summary: task.fields?.summary ?? "",
        status: statusLabel(task.fields?.status),
      }));
    }

    if (links.length > 0) {
      out.links = links.map((link) => describeLink(link));
    }

    if (comments && comments.comments.length > 0) {
      out.recent_comments = comments.comments.map((comment) => ({
        author: userLabel(comment.author),
        age: relativeAge(comment.created, context.now) ?? "unknown",
        body: full
          ? (previewField(comment.body, true)?.value ?? "")
          : truncate(previewField(comment.body, true)?.value ?? "", COMMENT_PREVIEW_CHARS).text,
      }));
    }

    const help: string[] = [];
    // Principle 3: offer the escape hatch only when content was actually cut.
    if (description?.truncated) {
      help.push(
        suggest(
          `${BIN} issue view ${issue.key} --full`,
          `for the complete description (${description.total} chars total)`,
        ),
      );
    }
    if (comments && comments.total > comments.comments.length) {
      help.push(suggest(`${BIN} issue comments ${issue.key} --limit ${comments.total}`, `for all ${comments.total} comments`));
    }
    if (transitions.length > 0) {
      help.push(`${BIN} issue transition ${issue.key} --to "${transitions[0]?.to?.name ?? "<status>"}"`);
    }
    help.push(`${BIN} issue comment ${issue.key} --body "..."`);
    out.help = help;

    return out;
  },
};

function describeLink(link: JiraIssueLink): Output {
  // Report the relation using the description Jira pairs with the slot it
  // actually returned, so the phrase matches what the Jira UI shows.
  const other = link.outwardIssue ?? link.inwardIssue;
  const relation = link.outwardIssue ? link.type?.outward : link.type?.inward;

  return {
    relation: relation ?? link.type?.name ?? "relates to",
    key: other?.key ?? "unknown",
    summary: other?.fields?.summary ?? "",
    status: statusLabel(other?.fields?.status),
  };
}

interface CommentPage {
  total: number;
  comments: JiraComment[];
}

async function fetchComments(
  client: ReturnType<RunContext["client"]>,
  key: string,
  limit: number,
): Promise<CommentPage> {
  const response = await client.request<{ total?: number; comments?: JiraComment[] }>(
    `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
    {
      query: { orderBy: "-created", maxResults: limit },
      notFound: `issue ${key} not found`,
    },
  );

  return {
    total: response?.total ?? response?.comments?.length ?? 0,
    comments: response?.comments ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* issue create                                                        */
/* ------------------------------------------------------------------ */

const createSubcommand: Subcommand = {
  name: "create",
  summary: "Create an issue",
  args: "[flags]",
  flags: {
    project: { type: "string", short: "-p", placeholder: "<key>", describe: "Project key (required)" },
    summary: { type: "string", short: "-s", placeholder: "<text>", describe: "Issue summary (required)" },
    type: {
      type: "string",
      short: "-t",
      placeholder: "<name>",
      default: "Task",
      describe: "Issue type name",
    },
    description: { type: "string", placeholder: "<markdown>", describe: "Description; Markdown is converted to ADF" },
    "description-file": {
      type: "string",
      placeholder: "<path>",
      describe: "Read the description from a file, or `-` for stdin",
    },
    assignee: { type: "string", short: "-a", placeholder: "<user>", describe: "Assignee: @me, email, name, or account id" },
    priority: { type: "string", placeholder: "<name>", describe: "Priority name" },
    label: { type: "string", short: "-l", repeatable: true, placeholder: "<label>", describe: "Label to add" },
    parent: { type: "string", placeholder: "<key>", describe: "Parent issue or epic key" },
    due: { type: "string", placeholder: "<YYYY-MM-DD>", describe: "Due date" },
    component: { type: "string", repeatable: true, placeholder: "<name>", describe: "Component name" },
    "fix-version": { type: "string", repeatable: true, placeholder: "<name>", describe: "Fix version name" },
    field: {
      type: "string",
      repeatable: true,
      placeholder: "<id=value>",
      describe: "Set any other field, e.g. customfield_10016=5",
    },
  },
  notes: ["Find custom field ids with `jira-axi field list --query \"<name>\"`"],
  examples: [
    `${BIN} issue create -p ACME -s "Login times out on Safari"`,
    `${BIN} issue create -p ACME -t Bug -s "Crash on save" --description-file report.md -a @me`,
    `${BIN} issue create -p ACME -s "Spike: caching" --parent ACME-3 --field customfield_10016=5`,
  ],
  async run(parsed, context) {
    const project = normalizeProjectKey(requireStr(parsed, "project", "issue create"));
    const summary = requireStr(parsed, "summary", "issue create");
    const type = str(parsed, "type") ?? "Task";
    const description = resolveText(parsed, {
      flag: "description",
      fileFlag: "description-file",
      command: "issue create",
    });

    const client = context.client();
    const fields: Record<string, unknown> = {
      project: { key: project },
      issuetype: { name: type },
      summary,
    };

    if (description !== undefined) {
      fields.description = textToAdf(description);
    }

    const assignee = str(parsed, "assignee");
    if (assignee !== undefined) {
      const resolved = await resolveAccount(client, assignee, { project });
      fields.assignee = resolved === UNASSIGNED ? null : { accountId: resolved };
    }

    const priority = str(parsed, "priority");
    if (priority !== undefined) {
      fields.priority = { name: priority };
    }

    const labels = list(parsed, "label");
    if (labels.length > 0) {
      fields.labels = labels;
    }

    const parent = str(parsed, "parent");
    if (parent !== undefined) {
      fields.parent = { key: normalizeIssueKey(parent) };
    }

    const due = str(parsed, "due");
    if (due !== undefined) {
      fields.duedate = validateDate("due", due);
    }

    const components = list(parsed, "component");
    if (components.length > 0) {
      fields.components = components.map((name) => ({ name }));
    }

    const fixVersions = list(parsed, "fix-version");
    if (fixVersions.length > 0) {
      fields.fixVersions = fixVersions.map((name) => ({ name }));
    }

    Object.assign(fields, parseFieldAssignments(list(parsed, "field")));

    const created = await client.request<{ key?: string }>("/rest/api/3/issue", {
      method: "POST",
      body: { fields },
      suggestions: [
        `Check the type exists in ${project}: ${BIN} project view ${project}`,
        `Custom fields may be required on create; ${BIN} field list --query "<name>"`,
      ],
    });

    const key = created?.key;
    if (!key) {
      throw new AxiError("Jira accepted the request but returned no issue key", "API_ERROR", []);
    }

    return {
      created: {
        key,
        summary,
        type,
        project,
        assignee: assignee ?? "unassigned",
        url: browseUrl(context, key),
      },
      help: [
        `${BIN} issue view ${key}`,
        `${BIN} issue transition ${key} --to "<status>"`,
        `${BIN} issue comment ${key} --body "..."`,
      ],
    };
  },
};

/* ------------------------------------------------------------------ */
/* issue edit                                                          */
/* ------------------------------------------------------------------ */

const editSubcommand: Subcommand = {
  name: "edit",
  summary: "Change fields on an existing issue",
  args: "<key> [flags]",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    summary: { type: "string", short: "-s", placeholder: "<text>", describe: "New summary" },
    description: { type: "string", placeholder: "<markdown>", describe: "Replace the description" },
    "description-file": {
      type: "string",
      placeholder: "<path>",
      describe: "Read the new description from a file, or `-` for stdin",
    },
    assignee: { type: "string", short: "-a", placeholder: "<user>", describe: "Reassign the issue" },
    unassign: { type: "boolean", describe: "Clear the assignee" },
    priority: { type: "string", placeholder: "<name>", describe: "New priority" },
    "add-label": { type: "string", repeatable: true, placeholder: "<label>", describe: "Label to add" },
    "remove-label": { type: "string", repeatable: true, placeholder: "<label>", describe: "Label to remove" },
    parent: { type: "string", placeholder: "<key>", describe: "New parent issue or epic" },
    due: { type: "string", placeholder: "<YYYY-MM-DD>", describe: "New due date" },
    field: {
      type: "string",
      repeatable: true,
      placeholder: "<id=value>",
      describe: "Set any other field, e.g. customfield_10016=5",
    },
  },
  notes: ["Reports a no-op and exits 0 when every requested value already matches"],
  examples: [
    `${BIN} issue edit ACME-42 -s "Login times out on Safari 17"`,
    `${BIN} issue edit ACME-42 --add-label regression --add-label safari`,
    `${BIN} issue edit ACME-42 --priority High --due 2026-09-30`,
  ],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const client = context.client();

    if (parsed.flags.assignee !== undefined && bool(parsed, "unassign")) {
      throw new AxiError("--assignee and --unassign cannot be combined", "VALIDATION_ERROR", [
        "Pass either --assignee <user> or --unassign",
      ]);
    }

    const description = resolveText(parsed, {
      flag: "description",
      fileFlag: "description-file",
      command: "issue edit",
    });
    const summary = str(parsed, "summary");
    const priority = str(parsed, "priority");
    // Validate every syntactic input up front. Principle 6 requires validation
    // before any dependency call, so a bad date reports a usage error (exit 2)
    // rather than whatever the issue lookup happens to return first.
    const rawParent = str(parsed, "parent");
    const parent = rawParent === undefined ? undefined : normalizeIssueKey(rawParent);
    const rawDue = str(parsed, "due");
    const due = rawDue === undefined ? undefined : validateDate("due", rawDue);
    const addLabels = list(parsed, "add-label");
    const removeLabels = list(parsed, "remove-label");
    const extraFields = parseFieldAssignments(list(parsed, "field"));
    const assignee = str(parsed, "assignee");
    const unassign = bool(parsed, "unassign");

    const requested =
      summary !== undefined ||
      description !== undefined ||
      priority !== undefined ||
      parent !== undefined ||
      due !== undefined ||
      addLabels.length > 0 ||
      removeLabels.length > 0 ||
      assignee !== undefined ||
      unassign ||
      Object.keys(extraFields).length > 0;

    if (!requested) {
      throw new AxiError("issue edit needs at least one field to change", "VALIDATION_ERROR", [
        `${BIN} issue edit ${key} -s "<summary>"`,
        `${BIN} issue edit ${key} --help for every editable field`,
      ]);
    }

    // Read current values first so an edit that changes nothing reports a no-op
    // instead of a write (principle 6: idempotent mutations).
    const current = await getIssue(client, key, {
      fields: ["summary", "description", "assignee", "priority", "labels", "duedate", "parent", "project"],
    });
    const fields = current.fields ?? {};
    const project = fields.project?.key;

    const changes: string[] = [];
    const set: Record<string, unknown> = {};

    if (summary !== undefined && summary !== fields.summary) {
      set.summary = summary;
      changes.push("summary");
    }

    if (description !== undefined) {
      if (adfToText(fields.description).trim() !== description.trim()) {
        set.description = textToAdf(description);
        changes.push("description");
      }
    }

    if (priority !== undefined && priority.toLowerCase() !== (fields.priority?.name ?? "").toLowerCase()) {
      set.priority = { name: priority };
      changes.push("priority");
    }

    if (parent !== undefined && parent !== fields.parent?.key) {
      set.parent = { key: parent };
      changes.push("parent");
    }

    if (due !== undefined && due !== (fields.duedate ?? undefined)) {
      set.duedate = due;
      changes.push("due");
    }

    if (assignee !== undefined || unassign) {
      const resolved = unassign ? UNASSIGNED : await resolveAccount(client, assignee as string, { project });
      const currentId = fields.assignee?.accountId;
      const targetId = resolved === UNASSIGNED ? undefined : resolved;
      if (currentId !== targetId) {
        set.assignee = targetId === undefined ? null : { accountId: targetId };
        changes.push("assignee");
      }
    }

    const currentLabels = fields.labels ?? [];
    const nextLabels = new Set(currentLabels);
    for (const label of addLabels) {
      nextLabels.add(label);
    }
    for (const label of removeLabels) {
      nextLabels.delete(label);
    }
    if (
      (addLabels.length > 0 || removeLabels.length > 0) &&
      (nextLabels.size !== currentLabels.length || currentLabels.some((label) => !nextLabels.has(label)))
    ) {
      set.labels = [...nextLabels];
      changes.push("labels");
    }

    // Custom fields have no reliable comparison, so always send them.
    for (const [name, value] of Object.entries(extraFields)) {
      set[name] = value;
      changes.push(name);
    }

    if (changes.length === 0) {
      return {
        edit: `${key} already matches the requested values (no-op)`,
        help: [`${BIN} issue view ${key}`],
      };
    }

    await client.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { fields: set },
      notFound: `issue ${key} not found`,
      suggestions: [`${BIN} issue view ${key} to see the current values`],
    });

    return {
      edited: { key, changed: changes.join(", "), url: browseUrl(context, key) },
      help: [`${BIN} issue view ${key}`],
    };
  },
};

/* ------------------------------------------------------------------ */
/* transitions                                                         */
/* ------------------------------------------------------------------ */

const transitionsSubcommand: Subcommand = {
  name: "transitions",
  summary: "List the status transitions available on an issue",
  args: "<key>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {},
  examples: [`${BIN} issue transitions ACME-42`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const client = context.client();
    const [issue, transitions] = await allOf([
      getIssue(client, key, { fields: ["status"] }),
      getTransitions(client, key),
    ]);

    const currentStatus = statusLabel(issue.fields?.status);

    if (transitions.length === 0) {
      return {
        transitions: `0 transitions available from ${currentStatus}`,
        status: currentStatus,
        help: [`The workflow may restrict transitions for ${context.config().email}`],
      };
    }

    return {
      status: currentStatus,
      transitions: transitions.map((transition) => ({
        to: transition.to?.name ?? "unknown",
        via: transition.name ?? "unknown",
        category: transition.to?.statusCategory?.key ?? "unknown",
      })),
      help: [`${BIN} issue transition ${key} --to "${transitions[0]?.to?.name ?? "<status>"}"`],
    };
  },
};

function matchTransition(transitions: JiraTransition[], target: string): JiraTransition | undefined {
  const lowered = target.trim().toLowerCase();
  return (
    transitions.find((t) => (t.to?.name ?? "").toLowerCase() === lowered) ??
    transitions.find((t) => (t.name ?? "").toLowerCase() === lowered) ??
    transitions.find((t) => t.id === target.trim())
  );
}

function transitionNotFound(key: string, target: string, transitions: JiraTransition[]): AxiError {
  return new AxiError(`no transition to \`${target}\` is available on ${key}`, "VALIDATION_ERROR", [
    transitions.length > 0
      ? `available: ${transitions.map((t) => t.to?.name ?? t.name).join(", ")}`
      : "this issue has no available transitions",
    `${BIN} issue transitions ${key}`,
  ]);
}

const transitionSubcommand: Subcommand = {
  name: "transition",
  summary: "Move an issue to another status",
  args: "<key> --to <status>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    to: { type: "string", placeholder: "<status>", describe: "Target status name, transition name, or id" },
    comment: { type: "string", placeholder: "<text>", describe: "Comment to add with the transition" },
  },
  notes: ["Reports a no-op and exits 0 when the issue is already in the target status"],
  examples: [
    `${BIN} issue transition ACME-42 --to "In Progress"`,
    `${BIN} issue transition ACME-42 --to Done --comment "Shipped in 2.4.0"`,
  ],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const target = requireStr(parsed, "to", "issue transition");
    const client = context.client();

    const [issue, transitions] = await allOf([
      getIssue(client, key, { fields: ["status"] }),
      getTransitions(client, key),
    ]);

    const currentStatus = statusLabel(issue.fields?.status);
    if (currentStatus.toLowerCase() === target.trim().toLowerCase()) {
      return {
        transition: `${key} is already in ${currentStatus} (no-op)`,
        help: [`${BIN} issue view ${key}`],
      };
    }

    const transition = matchTransition(transitions, target);
    if (!transition?.id) {
      throw transitionNotFound(key, target, transitions);
    }

    return applyTransition(context, key, currentStatus, transition, str(parsed, "comment"));
  },
};

async function applyTransition(
  context: RunContext,
  key: string,
  from: string,
  transition: JiraTransition,
  comment: string | undefined,
): Promise<Output> {
  const body: Record<string, unknown> = { transition: { id: transition.id } };
  if (comment !== undefined) {
    body.update = { comment: [{ add: { body: textToAdf(comment) } }] };
  }

  await context.client().request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: "POST",
    body,
    notFound: `issue ${key} not found`,
    suggestions: [`${BIN} issue transitions ${key} to list valid targets`],
  });

  const to = transition.to?.name ?? transition.name ?? "unknown";
  const out: Output = {
    transitioned: { key, from, to, url: browseUrl(context, key) },
  };
  if (transition.name && transition.name !== to) {
    (out.transitioned as Output).via = transition.name;
  }
  out.help = [`${BIN} issue view ${key}`];
  return out;
}

/** Transition helper shared by `close` and `reopen`. */
async function transitionToCategory(
  context: RunContext,
  key: string,
  category: "done" | "new",
  preferredNames: string[],
  comment: string | undefined,
  label: string,
): Promise<Output> {
  const client = context.client();
  const [issue, transitions] = await allOf([
    getIssue(client, key, { fields: ["status"] }),
    getTransitions(client, key),
  ]);

  const currentStatus = statusLabel(issue.fields?.status);
  const currentCategory = statusCategory(issue.fields?.status);

  if (category === "done" && currentCategory === "done") {
    return {
      [label]: `${key} is already ${currentStatus} (no-op)`,
      help: [`${BIN} issue view ${key}`],
    };
  }
  if (category === "new" && currentCategory !== "done") {
    return {
      [label]: `${key} is not resolved; it is ${currentStatus} (no-op)`,
      help: [`${BIN} issue view ${key}`],
    };
  }

  const candidates = transitions.filter((t) => t.to?.statusCategory?.key === category);

  if (candidates.length === 0) {
    throw new AxiError(`no ${label} transition is available on ${key}`, "VALIDATION_ERROR", [
      transitions.length > 0
        ? `available: ${transitions.map((t) => t.to?.name ?? t.name).join(", ")}`
        : "this issue has no available transitions",
      `${BIN} issue transition ${key} --to "<status>"`,
    ]);
  }

  // Several statuses can share a category (Done vs Won't Do). Prefer a
  // conventional name, and refuse to guess when the choice is genuinely
  // ambiguous rather than resolving an issue the wrong way.
  const preferred = candidates.find((t) =>
    preferredNames.includes((t.to?.name ?? "").toLowerCase()),
  );
  const chosen = preferred ?? (candidates.length === 1 ? candidates[0] : undefined);

  if (!chosen) {
    throw new AxiError(
      `${key} has ${candidates.length} ${label} statuses; pick one explicitly`,
      "VALIDATION_ERROR",
      [
        `candidates: ${candidates.map((t) => t.to?.name).join(", ")}`,
        `${BIN} issue transition ${key} --to "${candidates[0]?.to?.name ?? "<status>"}"`,
      ],
    );
  }

  return applyTransition(context, key, currentStatus, chosen, comment);
}

const closeSubcommand: Subcommand = {
  name: "close",
  summary: "Transition an issue into a Done status",
  args: "<key> [flags]",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    comment: { type: "string", placeholder: "<text>", describe: "Comment to add with the transition" },
  },
  notes: [
    "Picks the Done-category status named Done, Closed, Resolved, or Complete; when several exist and none matches, it lists them instead of guessing",
  ],
  examples: [`${BIN} issue close ACME-42`, `${BIN} issue close ACME-42 --comment "Fixed in 2.4.0"`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    return transitionToCategory(
      context,
      key,
      "done",
      ["done", "closed", "resolved", "complete", "completed"],
      str(parsed, "comment"),
      "close",
    );
  },
};

const reopenSubcommand: Subcommand = {
  name: "reopen",
  summary: "Transition a resolved issue back into an open status",
  args: "<key> [flags]",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    comment: { type: "string", placeholder: "<text>", describe: "Comment to add with the transition" },
  },
  examples: [`${BIN} issue reopen ACME-42`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    return transitionToCategory(
      context,
      key,
      "new",
      ["to do", "open", "reopened", "backlog", "new"],
      str(parsed, "comment"),
      "reopen",
    );
  },
};

/* ------------------------------------------------------------------ */
/* assign                                                              */
/* ------------------------------------------------------------------ */

const assignSubcommand: Subcommand = {
  name: "assign",
  summary: "Set or clear an issue's assignee",
  args: "<key> --to <user>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    to: {
      type: "string",
      placeholder: "<user>",
      describe: "Assignee: @me, an email, a display name, or an account id",
    },
    unassign: { type: "boolean", describe: "Clear the assignee" },
  },
  notes: ["Reports a no-op and exits 0 when the issue already has that assignee"],
  examples: [
    `${BIN} issue assign ACME-42 --to @me`,
    `${BIN} issue assign ACME-42 --to "Alice Chen"`,
    `${BIN} issue assign ACME-42 --unassign`,
  ],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const to = str(parsed, "to");
    const unassign = bool(parsed, "unassign");

    if (to === undefined && !unassign) {
      throw new AxiError("--to or --unassign is required", "VALIDATION_ERROR", [
        `${BIN} issue assign ${key} --to @me`,
        `${BIN} issue assign ${key} --unassign`,
      ]);
    }
    if (to !== undefined && unassign) {
      throw new AxiError("--to and --unassign cannot be combined", "VALIDATION_ERROR", [
        "Pass either --to <user> or --unassign",
      ]);
    }

    const client = context.client();
    const current = await getIssue(client, key, { fields: ["assignee", "project"] });
    const project = current.fields?.project?.key;

    const resolved = unassign ? UNASSIGNED : await resolveAccount(client, to as string, { project });
    const targetId = resolved === UNASSIGNED ? undefined : resolved;
    const currentId = current.fields?.assignee?.accountId;

    if (currentId === targetId) {
      const label = targetId === undefined ? "unassigned" : userLabel(current.fields?.assignee);
      return {
        assign: `${key} is already ${label} (no-op)`,
        help: [`${BIN} issue view ${key}`],
      };
    }

    await client.request(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
      method: "PUT",
      body: { accountId: targetId ?? null },
      notFound: `issue ${key} not found`,
      suggestions: [`${BIN} user search "<name>" to find an assignable account`],
    });

    return {
      assigned: {
        key,
        from: userLabel(current.fields?.assignee),
        to: targetId === undefined ? "unassigned" : (to as string),
        url: browseUrl(context, key),
      },
      help: [`${BIN} issue view ${key}`],
    };
  },
};

/* ------------------------------------------------------------------ */
/* comments                                                            */
/* ------------------------------------------------------------------ */

const commentSubcommand: Subcommand = {
  name: "comment",
  summary: "Add a comment to an issue",
  args: "<key> --body <text>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    body: { type: "string", short: "-b", placeholder: "<markdown>", describe: "Comment text; Markdown becomes ADF" },
    "body-file": {
      type: "string",
      placeholder: "<path>",
      describe: "Read the comment from a file, or `-` for stdin",
    },
  },
  examples: [
    `${BIN} issue comment ACME-42 --body "Reproduced on Safari 17.4"`,
    `cat notes.md | ${BIN} issue comment ACME-42 --body-file -`,
  ],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const body = resolveText(parsed, {
      flag: "body",
      fileFlag: "body-file",
      command: `issue comment ${key}`,
      required: true,
    }) as string;

    const created = await context.client().request<JiraComment>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      {
        method: "POST",
        body: { body: textToAdf(body) },
        notFound: `issue ${key} not found`,
      },
    );

    return {
      commented: {
        key,
        id: created?.id ?? "unknown",
        chars: body.length,
        url: browseUrl(context, key),
      },
      help: [`${BIN} issue comments ${key}`],
    };
  },
};

const commentsSubcommand: Subcommand = {
  name: "comments",
  summary: "List an issue's comments, newest first",
  args: "<key> [flags]",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    limit: { type: "number", placeholder: "<n>", default: 10, describe: "Maximum comments to return" },
    full: { type: "boolean", describe: "Print complete comment bodies" },
  },
  examples: [`${BIN} issue comments ACME-42`, `${BIN} issue comments ACME-42 --limit 50 --full`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const limit = Math.max(1, num(parsed, "limit", 10));
    const full = bool(parsed, "full");

    const page = await fetchComments(context.client(), key, limit);

    if (page.comments.length === 0) {
      return {
        comments: `0 comments on ${key}`,
        help: [`${BIN} issue comment ${key} --body "..."`],
      };
    }

    const out: Output = {
      count: countLine(page.comments.length, page.total),
      comments: page.comments.map((comment) => ({
        author: userLabel(comment.author),
        age: relativeAge(comment.created, context.now) ?? "unknown",
        body: full
          ? (previewField(comment.body, true)?.value ?? "")
          : truncate(previewField(comment.body, true)?.value ?? "", COMMENT_PREVIEW_CHARS).text,
      })),
    };

    const help: string[] = [];
    if (page.total > page.comments.length) {
      help.push(suggest(`${BIN} issue comments ${key} --limit ${page.total}`, `for all ${page.total} comments`));
    }
    if (!full) {
      help.push(suggest(`${BIN} issue comments ${key} --full`, "for complete comment bodies"));
    }
    help.push(`${BIN} issue comment ${key} --body "..."`);
    out.help = help;

    return out;
  },
};

/* ------------------------------------------------------------------ */
/* links                                                               */
/* ------------------------------------------------------------------ */

interface LinkType {
  id?: string;
  name?: string;
  inward?: string;
  outward?: string;
}

/**
 * Match `--type` against a link type's name or either of its directional
 * descriptions, and report which side the phrase came from.
 *
 * Atlassian states that `inwardIssue`/`outwardIssue` carry no API-level
 * direction meaning — the semantics exist only at the UI layer — so this maps
 * the phrase the user gave to the correspondingly named slot and then verifies
 * the result by reading the link back.
 */
function matchLinkType(
  types: LinkType[],
  requested: string,
): { type: LinkType; side: "inward" | "outward" } | undefined {
  const lowered = requested.trim().toLowerCase();

  for (const type of types) {
    if ((type.outward ?? "").toLowerCase() === lowered) {
      return { type, side: "outward" };
    }
  }
  for (const type of types) {
    if ((type.inward ?? "").toLowerCase() === lowered) {
      return { type, side: "inward" };
    }
  }
  for (const type of types) {
    if ((type.name ?? "").toLowerCase() === lowered) {
      // A bare type name reads as the outward phrase ("Blocks" -> "blocks").
      return { type, side: "outward" };
    }
  }
  return undefined;
}

const linkSubcommand: Subcommand = {
  name: "link",
  summary: "Link two issues",
  args: "<key> --type <relation> --to <key>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    type: {
      type: "string",
      placeholder: "<relation>",
      describe: 'Relation from <key> to --to, e.g. "blocks", "is blocked by", "relates to"',
    },
    to: { type: "string", placeholder: "<key>", describe: "The other issue" },
    comment: { type: "string", placeholder: "<text>", describe: "Comment to add alongside the link" },
  },
  notes: [
    "--type is matched against each link type's name and its two directional descriptions",
    "The created link is read back and reported using the relation Jira itself returns",
  ],
  examples: [
    `${BIN} issue link ACME-42 --type blocks --to ACME-9`,
    `${BIN} issue link ACME-42 --type "is blocked by" --to ACME-9`,
    `${BIN} issue link ACME-42 --type "relates to" --to ACME-7`,
  ],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const requestedType = requireStr(parsed, "type", "issue link");
    const other = normalizeIssueKey(requireStr(parsed, "to", "issue link"));
    const client = context.client();

    if (key === other) {
      throw new AxiError("an issue cannot be linked to itself", "VALIDATION_ERROR", [
        `${BIN} issue link ${key} --type blocks --to <other-key>`,
      ]);
    }

    const response = await client.request<{ issueLinkTypes?: LinkType[] }>("/rest/api/3/issueLinkType");
    const types = response?.issueLinkTypes ?? [];
    const matched = matchLinkType(types, requestedType);

    if (!matched) {
      const phrases = types
        .flatMap((type) => [type.outward, type.inward])
        .filter((phrase): phrase is string => Boolean(phrase));
      throw new AxiError(`unknown link relation \`${requestedType}\``, "VALIDATION_ERROR", [
        `available relations: ${phrases.join(", ")}`,
        `${BIN} issue link ${key} --type "${phrases[0] ?? "relates to"}" --to ${other}`,
      ]);
    }

    // Existing identical link -> no-op, so re-running a link step is safe.
    const existing = await getIssue(client, key, { fields: ["issuelinks"] });
    const already = (existing.fields?.issuelinks ?? []).find((link) => {
      const target = (link.outwardIssue ?? link.inwardIssue)?.key;
      const phrase = link.outwardIssue ? link.type?.outward : link.type?.inward;
      return (
        target === other &&
        link.type?.name === matched.type.name &&
        (phrase ?? "").toLowerCase() === (matched.type[matched.side] ?? "").toLowerCase()
      );
    });

    if (already) {
      return {
        link: `${key} already ${matched.type[matched.side] ?? matched.type.name} ${other} (no-op)`,
        help: [`${BIN} issue view ${key}`],
      };
    }

    const body: Record<string, unknown> = {
      type: { name: matched.type.name },
      [matched.side === "outward" ? "outwardIssue" : "inwardIssue"]: { key },
      [matched.side === "outward" ? "inwardIssue" : "outwardIssue"]: { key: other },
    };
    const comment = str(parsed, "comment");
    if (comment !== undefined) {
      body.comment = { body: textToAdf(comment) };
    }

    await client.request("/rest/api/3/issueLink", {
      method: "POST",
      body,
      suggestions: [`${BIN} issue view ${key} to inspect existing links`],
    });

    // Read the link back and describe it the way Jira does, so the reported
    // direction is observed rather than assumed.
    const after = await getIssue(client, key, { fields: ["issuelinks"] });
    const created = (after.fields?.issuelinks ?? []).find(
      (link) => (link.outwardIssue ?? link.inwardIssue)?.key === other && link.type?.name === matched.type.name,
    );
    const actual = created ? describeLink(created) : undefined;

    const out: Output = {
      linked: {
        key,
        relation: (actual?.relation as string) ?? matched.type[matched.side] ?? matched.type.name ?? "linked",
        to: other,
        url: browseUrl(context, key),
      },
    };

    const help: string[] = [];
    const actualRelation = (actual?.relation as string | undefined)?.toLowerCase();
    const askedRelation = (matched.type[matched.side] ?? "").toLowerCase();
    if (actualRelation && askedRelation && actualRelation !== askedRelation) {
      // Never report a direction we did not observe: surface the difference
      // instead of quietly claiming the requested one.
      help.push(
        `Jira recorded this as "${key} ${actualRelation} ${other}", not "${askedRelation}"; use --type "${actualRelation}" to state it directly`,
      );
    }
    help.push(`${BIN} issue view ${key}`);
    out.help = help;

    return out;
  },
};

const unlinkSubcommand: Subcommand = {
  name: "unlink",
  summary: "Remove a link between two issues",
  args: "<key> --to <key>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    to: { type: "string", placeholder: "<key>", describe: "The other issue in the link" },
    type: { type: "string", placeholder: "<relation>", describe: "Only remove links of this relation" },
  },
  notes: ["Reports a no-op and exits 0 when no such link exists"],
  examples: [`${BIN} issue unlink ACME-42 --to ACME-9`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const other = normalizeIssueKey(requireStr(parsed, "to", "issue unlink"));
    const relation = str(parsed, "type")?.trim().toLowerCase();
    const client = context.client();

    const issue = await getIssue(client, key, { fields: ["issuelinks"] });
    const matches = (issue.fields?.issuelinks ?? []).filter((link) => {
      if ((link.outwardIssue ?? link.inwardIssue)?.key !== other) {
        return false;
      }
      if (!relation) {
        return true;
      }
      const phrase = link.outwardIssue ? link.type?.outward : link.type?.inward;
      return (phrase ?? "").toLowerCase() === relation || (link.type?.name ?? "").toLowerCase() === relation;
    });

    if (matches.length === 0) {
      return {
        unlink: `${key} has no ${relation ? `\`${relation}\` ` : ""}link to ${other} (no-op)`,
        help: [`${BIN} issue view ${key}`],
      };
    }

    for (const link of matches) {
      if (!link.id) {
        continue;
      }
      await client.request(`/rest/api/3/issueLink/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
        notFound: `link ${link.id} no longer exists`,
      });
    }

    return {
      unlinked: { key, to: other, removed: matches.length },
      help: [`${BIN} issue view ${key}`],
    };
  },
};

/* ------------------------------------------------------------------ */
/* worklog                                                             */
/* ------------------------------------------------------------------ */

const worklogSubcommand: Subcommand = {
  name: "worklog",
  summary: "Log time against an issue",
  args: "<key> --time <duration>",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    time: { type: "string", placeholder: "<duration>", describe: "Time spent, e.g. 90m or \"1d 4h\"" },
    comment: { type: "string", placeholder: "<text>", describe: "What the time was spent on" },
    started: {
      type: "string",
      placeholder: "<YYYY-MM-DD>",
      describe: "When the work started; defaults to now",
    },
  },
  examples: [
    `${BIN} issue worklog ACME-42 --time 90m --comment "Traced the timeout"`,
    `${BIN} issue worklog ACME-42 --time "1d 2h" --started 2026-08-18`,
  ],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const time = validateDuration("time", requireStr(parsed, "time", "issue worklog"));
    const comment = str(parsed, "comment");
    const started = str(parsed, "started");

    const body: Record<string, unknown> = { timeSpent: time };
    if (comment !== undefined) {
      body.comment = textToAdf(comment);
    }
    if (started !== undefined) {
      body.started = jiraDateTimestamp(validateDate("started", started));
    }

    const created = await context.client().request<JiraWorklog>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`,
      {
        method: "POST",
        body,
        notFound: `issue ${key} not found`,
        suggestions: ["Time tracking may be disabled for this project"],
      },
    );

    return {
      logged: {
        key,
        time: created?.timeSpent ?? time,
        id: created?.id ?? "unknown",
      },
      help: [`${BIN} issue worklogs ${key}`],
    };
  },
};

const worklogsSubcommand: Subcommand = {
  name: "worklogs",
  summary: "List time logged against an issue",
  args: "<key> [flags]",
  positionals: { name: "<key>", min: 1, max: 1 },
  flags: {
    limit: { type: "number", placeholder: "<n>", default: 20, describe: "Maximum entries to return" },
  },
  examples: [`${BIN} issue worklogs ACME-42`],
  async run(parsed, context) {
    const key = normalizeIssueKey(parsed.positionals[0] as string);
    const limit = Math.max(1, num(parsed, "limit", 20));

    const page = await paginate<JiraWorklog>(
      context.client(),
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`,
      { limit, key: "worklogs" },
    );

    if (page.values.length === 0) {
      return {
        worklogs: `0 worklog entries on ${key}`,
        help: [`${BIN} issue worklog ${key} --time 90m`],
      };
    }

    const totalSeconds = page.values.reduce((sum, entry) => sum + (entry.timeSpentSeconds ?? 0), 0);

    return {
      count: countLine(page.values.length, page.total),
      total_time: formatSeconds(totalSeconds) ?? "0m",
      worklogs: page.values.map((entry) => ({
        author: userLabel(entry.author),
        time: entry.timeSpent ?? formatSeconds(entry.timeSpentSeconds) ?? "unknown",
        started: shortTimestamp(entry.started) ?? "unknown",
        comment: truncate(previewField(entry.comment, true)?.value ?? "", 120).text || "none",
      })),
      help: [`${BIN} issue worklog ${key} --time 90m`],
    };
  },
};

/* ------------------------------------------------------------------ */

export const issueNoun: Noun = {
  name: "issue",
  summary: "Issues — list, view, create, edit, transition, assign, comment, link, log time",
  default: "list",
  // `jira-axi issue ACME-1` is a view, not an unknown subcommand.
  implicit: (first) => (isIssueKey(first) ? { subcommand: "view", args: [first] } : undefined),
  subcommands: [
    listSubcommand,
    viewSubcommand,
    createSubcommand,
    editSubcommand,
    transitionSubcommand,
    transitionsSubcommand,
    closeSubcommand,
    reopenSubcommand,
    assignSubcommand,
    commentSubcommand,
    commentsSubcommand,
    linkSubcommand,
    unlinkSubcommand,
    worklogSubcommand,
    worklogsSubcommand,
  ],
};
