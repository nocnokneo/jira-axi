import { AxiError } from "axi-sdk-js";

/**
 * JQL construction.
 *
 * Every value that reaches a JQL string goes through `jqlString()`. Summaries,
 * labels, and status names routinely contain quotes and backslashes, and an
 * unescaped one does not just break the query — it silently changes what the
 * query matches, which is exactly the class of wrong-but-plausible output AXI
 * principle 6 exists to prevent.
 */

export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Jira issue key, e.g. `ACME-123`.
 *
 * The project part needs at least two characters because that is Jira's own
 * minimum; accepting `A-1` only moved the rejection from a local usage error to
 * a round trip that fails.
 */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

export function normalizeIssueKey(value: string): string {
  const trimmed = value.trim();
  if (!isIssueKey(trimmed)) {
    throw new AxiError(`\`${value}\` is not a Jira issue key`, "VALIDATION_ERROR", [
      "An issue key looks like `ACME-123`",
    ]);
  }
  return trimmed.toUpperCase();
}

/** Project key, e.g. `ACME`. Two characters minimum, as Jira requires. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]+$/;

export function normalizeProjectKey(value: string): string {
  const trimmed = value.trim();
  if (!PROJECT_KEY.test(trimmed)) {
    throw new AxiError(`\`${value}\` is not a project key`, "VALIDATION_ERROR", [
      "A project key looks like `ACME`",
    ]);
  }
  return trimmed.toUpperCase();
}

export type IssueState = "open" | "closed" | "all";

export function normalizeState(value: string | undefined): IssueState {
  const state = (value ?? "open").toLowerCase();
  if (state === "open" || state === "closed" || state === "all") {
    return state;
  }
  throw new AxiError(`--state must be open, closed, or all, got \`${value}\``, "VALIDATION_ERROR", [
    "--state open   (statusCategory != Done)",
    "--state closed (statusCategory = Done)",
    "--state all",
  ]);
}

/**
 * A relative age like `-7d` or `7d`, or an absolute `2026-08-01`. Jira accepts
 * both, but only the leading-minus form as a relative offset.
 */
export function normalizeDateExpression(flag: string, value: string): string {
  const trimmed = value.trim();
  if (/^-?\d+[mhdwMy]$/.test(trimmed)) {
    return trimmed.startsWith("-") ? jqlString(trimmed) : jqlString(`-${trimmed}`);
  }
  if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(trimmed)) {
    return jqlString(trimmed);
  }
  throw new AxiError(`--${flag} must be a relative age or a date, got \`${value}\``, "VALIDATION_ERROR", [
    `--${flag} 7d       (within the last 7 days)`,
    `--${flag} 2026-08-01`,
  ]);
}

export interface IssueFilters {
  project?: string;
  assignee?: string;
  reporter?: string;
  state?: IssueState;
  status?: string[];
  type?: string[];
  label?: string[];
  priority?: string[];
  component?: string[];
  fixVersion?: string[];
  parent?: string;
  sprint?: string;
  text?: string;
  updated?: string;
  created?: string;
  /** Raw JQL merged in with AND. */
  jql?: string;
  orderBy?: string;
}

function inClause(field: string, values: string[]): string {
  if (values.length === 1) {
    return `${field} = ${jqlString(values[0] as string)}`;
  }
  return `${field} in (${values.map((value) => jqlString(value)).join(", ")})`;
}

/**
 * Resolve an assignee-ish value to a JQL term. `@me`/`me` become
 * `currentUser()`, `none`/`unassigned` become a null check, and anything else is
 * matched as an account id or email.
 */
function userClause(field: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "@me" || normalized === "me" || normalized === "currentuser()") {
    return `${field} = currentUser()`;
  }
  if (normalized === "none" || normalized === "unassigned" || normalized === "null") {
    return `${field} is EMPTY`;
  }
  return `${field} = ${jqlString(value.trim())}`;
}

/** Compose filters into one bounded JQL query with a deterministic ORDER BY. */
export function buildJql(filters: IssueFilters): string {
  const clauses: string[] = [];

  if (filters.project) {
    clauses.push(`project = ${jqlString(normalizeProjectKey(filters.project))}`);
  }
  if (filters.assignee) {
    clauses.push(userClause("assignee", filters.assignee));
  }
  if (filters.reporter) {
    clauses.push(userClause("reporter", filters.reporter));
  }

  if (filters.status && filters.status.length > 0) {
    clauses.push(inClause("status", filters.status));
  } else if (filters.state === "open") {
    clauses.push("statusCategory != Done");
  } else if (filters.state === "closed") {
    clauses.push("statusCategory = Done");
  }

  if (filters.type && filters.type.length > 0) {
    clauses.push(inClause("issuetype", filters.type));
  }
  if (filters.label && filters.label.length > 0) {
    clauses.push(inClause("labels", filters.label));
  }
  if (filters.priority && filters.priority.length > 0) {
    clauses.push(inClause("priority", filters.priority));
  }
  if (filters.component && filters.component.length > 0) {
    clauses.push(inClause("component", filters.component));
  }
  if (filters.fixVersion && filters.fixVersion.length > 0) {
    clauses.push(inClause("fixVersion", filters.fixVersion));
  }
  if (filters.parent) {
    clauses.push(`parent = ${jqlString(normalizeIssueKey(filters.parent))}`);
  }

  if (filters.sprint) {
    const sprint = filters.sprint.trim();
    if (sprint.toLowerCase() === "current" || sprint.toLowerCase() === "open") {
      clauses.push("sprint in openSprints()");
    } else if (sprint.toLowerCase() === "future") {
      clauses.push("sprint in futureSprints()");
    } else if (/^\d+$/.test(sprint)) {
      clauses.push(`sprint = ${sprint}`);
    } else {
      clauses.push(`sprint = ${jqlString(sprint)}`);
    }
  }

  if (filters.text) {
    clauses.push(`text ~ ${jqlString(filters.text)}`);
  }
  if (filters.updated) {
    clauses.push(`updated >= ${normalizeDateExpression("updated", filters.updated)}`);
  }
  if (filters.created) {
    clauses.push(`created >= ${normalizeDateExpression("created", filters.created)}`);
  }
  if (filters.jql) {
    clauses.push(`(${filters.jql})`);
  }

  // `/rest/api/3/search/jql` rejects unbounded queries, so fall back to a
  // restriction rather than sending a bare ORDER BY.
  const where = clauses.length > 0 ? clauses.join(" AND ") : "statusCategory != Done";
  const orderBy = filters.orderBy?.trim() || "updated DESC";

  return `${where} ORDER BY ${orderBy}`;
}
