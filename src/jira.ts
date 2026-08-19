import { AxiError } from "axi-sdk-js";

import { BIN } from "./bin-name.js";
import type { JiraClient } from "./client.js";
import type { JiraIssue, JiraTransition, JiraUser } from "./format.js";
import { suggest, userLabel } from "./format.js";

/** Jira operations shared by more than one command. */

/**
 * `Promise.all` that never leaves a sibling rejection unhandled.
 *
 * Commands fire independent requests concurrently, and `Promise.all` rejects on
 * the first failure while the siblings keep running — their rejections then have
 * no handler. Node's default response to an unhandled rejection is to terminate,
 * which would tear the process down after a clean structured error had already
 * been written. This settles everything, then rethrows the first failure.
 */
export async function allOf<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

export interface SearchResult {
  issues: JiraIssue[];
  /** Approximate total matching the query, when Jira could give one. */
  total?: number;
  /** True when more pages exist beyond `issues`. */
  hasMore: boolean;
}

interface JqlSearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** Jira caps a single `/search/jql` page at 5000 issues. */
const MAX_PAGE = 5000;

/**
 * Search with `/rest/api/3/search/jql`, following `nextPageToken` until `limit`
 * issues are collected.
 *
 * Note this endpoint defaults to returning ids only — fields must be requested
 * explicitly, and omitting them yields rows with no summary or status.
 */
export async function searchIssues(
  client: JiraClient,
  jql: string,
  options: { fields: string[]; limit: number },
): Promise<SearchResult> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let hasMore = false;

  while (issues.length < options.limit) {
    const remaining = options.limit - issues.length;
    const response = await client.request<JqlSearchResponse>("/rest/api/3/search/jql", {
      method: "POST",
      body: {
        jql,
        fields: options.fields,
        maxResults: Math.min(remaining, MAX_PAGE),
        ...(nextPageToken ? { nextPageToken } : {}),
      },
      suggestions: [`The query was: ${jql}`],
    });

    const page = response?.issues ?? [];
    issues.push(...page);

    nextPageToken = response?.nextPageToken;
    if (!nextPageToken || page.length === 0) {
      hasMore = false;
      break;
    }
    // A token on the final requested page means results remain unfetched.
    hasMore = true;
  }

  return { issues: issues.slice(0, options.limit), hasMore };
}

/**
 * Approximate total for a JQL query (principle 4: give the agent "how many are
 * there?" so it does not paginate to find out).
 *
 * Deliberately non-fatal — the count is a convenience on top of an already
 * successful search, so a failure here must not turn working output into an
 * error.
 */
export async function approximateCount(client: JiraClient, jql: string): Promise<number | undefined> {
  try {
    const response = await client.request<{ count?: number }>("/rest/api/3/search/approximate-count", {
      method: "POST",
      body: { jql },
    });
    return typeof response?.count === "number" ? response.count : undefined;
  } catch {
    return undefined;
  }
}

export async function getIssue(
  client: JiraClient,
  key: string,
  options: { fields?: string[]; expand?: string[] } = {},
): Promise<JiraIssue> {
  const issue = await client.request<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
    query: {
      fields: options.fields && options.fields.length > 0 ? options.fields : undefined,
      expand: options.expand && options.expand.length > 0 ? options.expand.join(",") : undefined,
    },
    notFound: `issue ${key} not found`,
    suggestions: [
      suggest(`${BIN} issue list --text "<words from the summary>"`, "to search for it by summary"),
    ],
  });

  if (!issue) {
    throw new AxiError(`issue ${key} not found`, "NOT_FOUND", []);
  }
  return issue;
}

export async function getTransitions(client: JiraClient, key: string): Promise<JiraTransition[]> {
  const response = await client.request<{ transitions?: JiraTransition[] }>(
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    { notFound: `issue ${key} not found` },
  );
  return (response?.transitions ?? []).filter((transition) => transition.isAvailable !== false);
}

export async function getMyself(client: JiraClient): Promise<JiraUser> {
  const user = await client.request<JiraUser>("/rest/api/3/myself");
  return user ?? {};
}

/* ------------------------------------------------------------------ */
/* Account resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Atlassian account ids come in a legacy 24-hex form and a newer
 * `<realm>:<uuid>` form. Both are opaque, so recognize them and skip the
 * lookup rather than searching for a user literally named "712020:...".
 */
function looksLikeAccountId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value) || /^[a-z0-9]+:[0-9a-f-]{36}$/i.test(value);
}

export const UNASSIGNED = Symbol("unassigned");

export type AccountRef = string | typeof UNASSIGNED;

/**
 * Resolve `@me`, an email, an account id, or a display name to an account id.
 *
 * `project` narrows the search to users who can actually be assigned there,
 * which both matches Jira's own behaviour and avoids proposing a user who would
 * be rejected on write.
 */
export async function resolveAccount(
  client: JiraClient,
  value: string,
  options: { project?: string } = {},
): Promise<AccountRef> {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();

  if (lowered === "none" || lowered === "unassigned" || lowered === "null") {
    return UNASSIGNED;
  }

  if (lowered === "@me" || lowered === "me") {
    const me = await getMyself(client);
    if (!me.accountId) {
      throw new AxiError("could not resolve the current user", "API_ERROR", [`${BIN} auth status`]);
    }
    return me.accountId;
  }

  if (looksLikeAccountId(trimmed)) {
    return trimmed;
  }

  const candidates = await searchUsers(client, trimmed, options.project);

  if (candidates.length === 0) {
    throw new AxiError(`no Jira user matches \`${value}\``, "NOT_FOUND", [
      `${BIN} user search "${trimmed}"`,
      "Jira hides email addresses unless the user made them public; try a display name instead",
    ]);
  }

  if (candidates.length === 1) {
    return (candidates[0] as JiraUser).accountId as string;
  }

  // An exact email or display-name match disambiguates a crowded result set.
  const exact = candidates.filter(
    (user) =>
      user.emailAddress?.toLowerCase() === lowered || user.displayName?.toLowerCase() === lowered,
  );
  if (exact.length === 1) {
    return (exact[0] as JiraUser).accountId as string;
  }

  throw new AxiError(`\`${value}\` matches ${candidates.length} Jira users`, "VALIDATION_ERROR", [
    `candidates: ${candidates
      .slice(0, 5)
      .map((user) => `${userLabel(user)} (${user.accountId})`)
      .join("; ")}`,
    "Pass the account id instead of a name",
  ]);
}

export async function searchUsers(
  client: JiraClient,
  query: string,
  project?: string,
): Promise<JiraUser[]> {
  if (project) {
    const assignable = await client.request<JiraUser[]>("/rest/api/3/user/assignable/search", {
      query: { project, query, maxResults: 50 },
      allow404: true,
    });
    if (assignable && assignable.length > 0) {
      return assignable.filter((user) => user.accountId);
    }
  }

  const users = await client.request<JiraUser[]>("/rest/api/3/user/search", {
    query: { query, maxResults: 50 },
  });
  return (users ?? []).filter((user) => user.accountId);
}

/* ------------------------------------------------------------------ */
/* startAt pagination                                                   */
/* ------------------------------------------------------------------ */

export interface Page<T> {
  values: T[];
  total?: number;
  isLast: boolean;
}

/**
 * Fetch a `startAt`/`maxResults` paginated collection (projects, comments,
 * boards, sprints) up to `limit`.
 */
export async function paginate<T>(
  client: JiraClient,
  path: string,
  options: {
    limit: number;
    query?: Record<string, string | number | boolean | undefined>;
    /** Response key holding the array; Jira is inconsistent about this. */
    key?: string;
    pageSize?: number;
  },
): Promise<Page<T>> {
  const key = options.key ?? "values";
  const pageSize = options.pageSize ?? 100;
  const values: T[] = [];
  let startAt = 0;
  let total: number | undefined;
  let isLast = true;

  while (values.length < options.limit) {
    const response = await client.request<Record<string, unknown>>(path, {
      query: {
        ...options.query,
        startAt,
        maxResults: Math.min(pageSize, options.limit - values.length),
      },
    });

    if (!response) {
      break;
    }

    const chunk = Array.isArray(response[key]) ? (response[key] as T[]) : [];
    values.push(...chunk);

    if (typeof response.total === "number") {
      total = response.total;
    }

    const last = response.isLast === true || chunk.length === 0;
    if (last) {
      isLast = true;
      break;
    }

    startAt += chunk.length;
    isLast = total !== undefined ? values.length >= total : false;
    if (isLast) {
      break;
    }
  }

  return { values: values.slice(0, options.limit), total, isLast };
}
