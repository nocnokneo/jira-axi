import { describe, expect, it } from "vitest";

import { buildJql, isIssueKey, jqlString, normalizeIssueKey, normalizeProjectKey, normalizeState } from "../src/jql.js";

describe("jqlString", () => {
  it("quotes a plain value", () => {
    expect(jqlString("In Review")).toBe('"In Review"');
  });

  it("escapes embedded quotes and backslashes", () => {
    // An unescaped quote would not just break the query, it would silently
    // change what it matches.
    expect(jqlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(jqlString("back\\slash")).toBe('"back\\\\slash"');
  });
});

describe("key normalization", () => {
  it("recognises and upper-cases issue keys", () => {
    expect(isIssueKey("ACME-1")).toBe(true);
    expect(isIssueKey("acme-1")).toBe(true);
    expect(isIssueKey("ACME")).toBe(false);
    expect(isIssueKey("ACME-")).toBe(false);
    expect(isIssueKey("1-ACME")).toBe(false);
    expect(normalizeIssueKey("acme-12")).toBe("ACME-12");
  });

  it("rejects a non-key with an explanatory error", () => {
    expect(() => normalizeIssueKey("not a key")).toThrow(/is not a Jira issue key/);
  });

  it("normalizes project keys", () => {
    expect(normalizeProjectKey("acme")).toBe("ACME");
    expect(() => normalizeProjectKey("ACME-1")).toThrow(/is not a project key/);
  });
});

describe("normalizeState", () => {
  it("defaults to open and accepts the three valid values", () => {
    expect(normalizeState(undefined)).toBe("open");
    expect(normalizeState("OPEN")).toBe("open");
    expect(normalizeState("closed")).toBe("closed");
    expect(normalizeState("all")).toBe("all");
  });

  it("rejects anything else and lists the valid values", () => {
    expect(() => normalizeState("done")).toThrow(/--state must be open, closed, or all/);
  });
});

describe("buildJql", () => {
  it("stays bounded when no filters are given", () => {
    // `/search/jql` rejects an unbounded query, so a bare ORDER BY is never sent.
    expect(buildJql({})).toBe("statusCategory != Done ORDER BY updated DESC");
  });

  it("maps state to a status category", () => {
    expect(buildJql({ state: "open" })).toContain("statusCategory != Done");
    expect(buildJql({ state: "closed" })).toContain("statusCategory = Done");
    expect(buildJql({ state: "all" })).toBe("statusCategory != Done ORDER BY updated DESC");
  });

  it("lets an explicit status override state", () => {
    const jql = buildJql({ state: "open", status: ["In Review"] });
    expect(jql).toContain('status = "In Review"');
    expect(jql).not.toContain("statusCategory");
  });

  it("uses an IN clause for several values", () => {
    expect(buildJql({ status: ["To Do", "In Progress"] })).toContain(
      'status in ("To Do", "In Progress")',
    );
  });

  it("translates @me and unassigned into JQL functions", () => {
    expect(buildJql({ assignee: "@me" })).toContain("assignee = currentUser()");
    expect(buildJql({ assignee: "me" })).toContain("assignee = currentUser()");
    expect(buildJql({ assignee: "none" })).toContain("assignee is EMPTY");
    expect(buildJql({ assignee: "unassigned" })).toContain("assignee is EMPTY");
    expect(buildJql({ assignee: "acct-123" })).toContain('assignee = "acct-123"');
  });

  it("handles sprint keywords, ids, and names", () => {
    expect(buildJql({ sprint: "current" })).toContain("sprint in openSprints()");
    expect(buildJql({ sprint: "future" })).toContain("sprint in futureSprints()");
    expect(buildJql({ sprint: "42" })).toContain("sprint = 42");
    expect(buildJql({ sprint: "Sprint 14" })).toContain('sprint = "Sprint 14"');
  });

  it("normalizes relative and absolute date expressions", () => {
    expect(buildJql({ updated: "7d" })).toContain('updated >= "-7d"');
    expect(buildJql({ updated: "-7d" })).toContain('updated >= "-7d"');
    expect(buildJql({ created: "2026-08-01" })).toContain('created >= "2026-08-01"');
  });

  it("rejects an unparseable date expression", () => {
    expect(() => buildJql({ updated: "last tuesday" })).toThrow(/--updated must be a relative age or a date/);
  });

  it("parenthesizes extra JQL so operator precedence cannot change the meaning", () => {
    const jql = buildJql({ project: "ACME", jql: "labels = a OR labels = b" });
    expect(jql).toContain('project = "ACME" AND (labels = a OR labels = b)');
  });

  it("joins every filter with AND and applies the order clause", () => {
    const jql = buildJql({
      project: "acme",
      assignee: "@me",
      state: "open",
      type: ["Bug"],
      label: ["regression"],
      priority: ["High"],
      parent: "acme-3",
      text: "timeout",
      orderBy: "created ASC",
    });

    expect(jql).toBe(
      [
        'project = "ACME"',
        "assignee = currentUser()",
        "statusCategory != Done",
        'issuetype = "Bug"',
        'labels = "regression"',
        'priority = "High"',
        'parent = "ACME-3"',
        'text ~ "timeout"',
      ].join(" AND ") + " ORDER BY created ASC",
    );
  });

  it("escapes filter values that contain quotes", () => {
    expect(buildJql({ text: 'a "quoted" phrase' })).toContain('text ~ "a \\"quoted\\" phrase"');
  });
});
