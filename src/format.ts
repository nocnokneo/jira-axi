import { adfToText } from "./adf.js";

/**
 * Output shaping for TOON stdout.
 *
 * Two AXI principles drive everything here: principle 2 (minimal default
 * schemas — a list row is 4 fields, not 15) and principle 3 (truncate long text
 * with a size hint and a `--full` escape hatch rather than omitting it).
 */

/** Default preview length for long text. Covers most descriptions in full. */
export const PREVIEW_CHARS = 900;

export interface Truncated {
  text: string;
  truncated: boolean;
  total: number;
}

export function truncate(input: string, limit = PREVIEW_CHARS): Truncated {
  const text = input.replace(/[ \t]+$/gm, "").trim();
  if (text.length <= limit) {
    return { text, truncated: false, total: text.length };
  }

  // Prefer a paragraph or sentence boundary near the limit so the preview does
  // not end mid-word.
  const window = text.slice(0, limit);
  const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
  const cut = boundary > limit * 0.6 ? boundary : limit;

  return {
    text: `${text.slice(0, cut).trimEnd()}...`,
    truncated: true,
    total: text.length,
  };
}

/**
 * Render a long field as either the value itself or a preview.
 * `full` bypasses truncation entirely.
 */
export function previewField(
  raw: unknown,
  full: boolean,
  limit = PREVIEW_CHARS,
): { value: string; truncated: boolean; total: number } | undefined {
  const text = adfToText(raw);
  if (text.trim().length === 0) {
    return undefined;
  }
  if (full) {
    return { value: text, truncated: false, total: text.length };
  }

  const result = truncate(text, limit);
  return { value: result.text, truncated: result.truncated, total: result.total };
}

/**
 * A next-step suggestion that carries explanatory prose (AXI principle 9).
 *
 * The command is fenced so it stays unambiguous: an agent that copied
 * `jira-axi issue list --limit 100 for all 137 matches` verbatim would hit an
 * unexpected-positional error on the trailing words.
 */
export function suggest(command: string, note?: string): string {
  return note === undefined ? command : `Run \`${command}\` ${note}`;
}

/** Compact relative age, e.g. `3d`, `4h`, `2mo`. */
export function relativeAge(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) {
    return undefined;
  }
  const then = new Date(iso);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) {
    return undefined;
  }

  const seconds = Math.max(0, Math.round((now.getTime() - ms) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  if (days < 31) {
    return `${days}d`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.round(months / 12)}y`;
}

/** Trim Jira's offset-bearing timestamps to minute precision. */
export function shortTimestamp(iso: string | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return iso;
  }
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/* ------------------------------------------------------------------ */
/* Jira response shapes                                                */
/* ------------------------------------------------------------------ */

export interface JiraUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
}

export interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string; name?: string };
}

export interface JiraIssueFields {
  summary?: string;
  status?: JiraStatus;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  creator?: JiraUser | null;
  issuetype?: { name?: string; subtask?: boolean };
  priority?: { name?: string } | null;
  labels?: string[];
  created?: string;
  updated?: string;
  duedate?: string | null;
  resolutiondate?: string | null;
  resolution?: { name?: string } | null;
  description?: unknown;
  environment?: unknown;
  parent?: { key?: string; fields?: { summary?: string; status?: JiraStatus } };
  subtasks?: Array<{ key?: string; fields?: { summary?: string; status?: JiraStatus } }>;
  project?: { key?: string; name?: string };
  components?: Array<{ name?: string }>;
  fixVersions?: Array<{ name?: string }>;
  versions?: Array<{ name?: string }>;
  timeoriginalestimate?: number | null;
  timeestimate?: number | null;
  timespent?: number | null;
  aggregatetimespent?: number | null;
  watches?: { watchCount?: number; isWatching?: boolean };
  votes?: { votes?: number };
  attachment?: Array<{ filename?: string; size?: number; created?: string }>;
  comment?: { total?: number; comments?: JiraComment[] };
  issuelinks?: JiraIssueLink[];
  worklog?: { total?: number; worklogs?: JiraWorklog[] };
  [key: string]: unknown;
}

export interface JiraIssue {
  id?: string;
  key?: string;
  fields?: JiraIssueFields;
  transitions?: JiraTransition[];
  renderedFields?: Record<string, unknown>;
}

export interface JiraComment {
  id?: string;
  author?: JiraUser;
  body?: unknown;
  created?: string;
  updated?: string;
}

export interface JiraWorklog {
  id?: string;
  author?: JiraUser;
  comment?: unknown;
  timeSpent?: string;
  timeSpentSeconds?: number;
  started?: string;
}

export interface JiraIssueLink {
  id?: string;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string; fields?: { summary?: string; status?: JiraStatus } };
  outwardIssue?: { key?: string; fields?: { summary?: string; status?: JiraStatus } };
}

export interface JiraTransition {
  id?: string;
  name?: string;
  to?: JiraStatus;
  isAvailable?: boolean;
}

export function userLabel(user: JiraUser | null | undefined): string {
  if (!user) {
    return "unassigned";
  }
  return user.displayName ?? user.emailAddress ?? user.accountId ?? "unknown";
}

export function statusLabel(status: JiraStatus | undefined): string {
  return status?.name ?? "unknown";
}

/** `done` | `indeterminate` | `new` — Jira's coarse status grouping. */
export function statusCategory(status: JiraStatus | undefined): string | undefined {
  return status?.statusCategory?.key;
}

export function isDone(status: JiraStatus | undefined): boolean {
  return statusCategory(status) === "done";
}

/** Fields requested from the API for list output plus any `--fields` extras. */
export const LIST_API_FIELDS = ["summary", "status", "assignee", "updated", "issuetype", "priority"];

/**
 * Extra columns an agent can opt into with `--fields`, mapped to the API field
 * they need. Custom field ids (`customfield_10016`) pass straight through.
 */
export const EXTRA_FIELDS: Record<string, { api: string[]; render: (issue: JiraIssue, now: Date) => unknown }> =
  {
    type: { api: ["issuetype"], render: (i) => i.fields?.issuetype?.name ?? "unknown" },
    priority: { api: ["priority"], render: (i) => i.fields?.priority?.name ?? "none" },
    updated: { api: ["updated"], render: (i, now) => relativeAge(i.fields?.updated, now) ?? "unknown" },
    created: { api: ["created"], render: (i, now) => relativeAge(i.fields?.created, now) ?? "unknown" },
    reporter: { api: ["reporter"], render: (i) => userLabel(i.fields?.reporter) },
    labels: { api: ["labels"], render: (i) => (i.fields?.labels ?? []).join(" ") || "none" },
    parent: { api: ["parent"], render: (i) => i.fields?.parent?.key ?? "none" },
    project: { api: ["project"], render: (i) => i.fields?.project?.key ?? "unknown" },
    due: { api: ["duedate"], render: (i) => i.fields?.duedate ?? "none" },
    resolution: { api: ["resolution"], render: (i) => i.fields?.resolution?.name ?? "unresolved" },
    components: { api: ["components"], render: (i) => (i.fields?.components ?? []).map((c) => c.name).join(" ") || "none" },
    fixversion: {
      api: ["fixVersions"],
      render: (i) => (i.fields?.fixVersions ?? []).map((v) => v.name).join(" ") || "none",
    },
    timespent: {
      api: ["timespent"],
      render: (i) => formatSeconds(i.fields?.timespent ?? undefined) ?? "none",
    },
    estimate: {
      api: ["timeestimate"],
      render: (i) => formatSeconds(i.fields?.timeestimate ?? undefined) ?? "none",
    },
    status: { api: ["status"], render: (i) => statusLabel(i.fields?.status) },
    summary: { api: ["summary"], render: (i) => i.fields?.summary ?? "" },
    assignee: { api: ["assignee"], render: (i) => userLabel(i.fields?.assignee) },
  };

export function formatSeconds(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const hours = seconds / 3600;
  if (hours < 1) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (hours < 8) {
    return `${round1(hours)}h`;
  }
  return `${round1(hours / 8)}d`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Default list row: key, summary, status, assignee. Four fields is the AXI
 * budget for a collection — everything else is opt-in via `--fields`.
 */
export function issueRow(
  issue: JiraIssue,
  extras: string[],
  now: Date = new Date(),
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    key: issue.key ?? "unknown",
    summary: issue.fields?.summary ?? "",
    status: statusLabel(issue.fields?.status),
    assignee: userLabel(issue.fields?.assignee),
  };

  for (const extra of extras) {
    const known = EXTRA_FIELDS[extra];
    if (known) {
      row[extra] = known.render(issue, now);
      continue;
    }
    // Unrecognized names are treated as raw API field ids (custom fields).
    row[extra] = simplifyValue(issue.fields?.[extra]);
  }

  return row;
}

/** Collapse an arbitrary Jira field value into something worth one TOON cell. */
export function simplifyValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return "none";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => simplifyValue(item)).join(" ") || "none";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "value", "displayName", "key", "id"]) {
      const candidate = record[key];
      if (typeof candidate === "string" || typeof candidate === "number") {
        return candidate;
      }
    }
    return "object";
  }
  return String(value);
}

/**
 * Resolve `--fields` into the API field list to request and the extra output
 * columns to render.
 */
export function resolveFields(requested: string[]): { api: string[]; extras: string[] } {
  const extras: string[] = [];
  const api = new Set(LIST_API_FIELDS);

  for (const entry of requested.flatMap((value) => value.split(","))) {
    const name = entry.trim();
    if (name.length === 0) {
      continue;
    }
    const known = EXTRA_FIELDS[name];
    if (known) {
      for (const field of known.api) {
        api.add(field);
      }
    } else {
      api.add(name);
    }
    if (!extras.includes(name)) {
      extras.push(name);
    }
  }

  return { api: [...api], extras };
}

/**
 * `count: 12 of 340 total` (principle 4) — an agent that cannot see the total
 * paginates to find it.
 */
export function countLine(shown: number, total: number | undefined): string {
  if (total === undefined || total < shown) {
    // Jira's count endpoint is approximate and its index lags fresh writes, so a
    // total below the page we are showing is wrong; say what we know instead.
    return `showing ${shown}`;
  }
  return shown === total ? `${shown} of ${shown} total` : `${shown} of ${total} total`;
}
