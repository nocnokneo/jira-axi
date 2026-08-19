import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { baseStub, issue, MYSELF, runCli, StubJira } from "./helpers/stub-jira.js";

const NOW = new Date("2026-08-19T09:00:00.000Z");

let stub: StubJira;

async function cli(argv: string[]) {
  return runCli(argv, { site: stub.url, now: NOW });
}

beforeEach(async () => {
  stub = await baseStub();
});

afterEach(async () => {
  await stub.stop();
});

describe("search", () => {
  it("runs a positional JQL query", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({ body: { issues: [issue("ACME-1")], isLast: true } }));
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 9 } }));

    const result = await cli(["search", "project = ACME AND status = 'In Review'"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.jql).toBe("project = ACME AND status = 'In Review'");
    expect(result.data.count).toBe("1 of 9 total");
    expect((result.data.help as string[]).join(" ")).toContain("--limit 9");
  });

  it("passes the query through verbatim, without wrapping it in filters", async () => {
    await cli(["search", "assignee = currentUser() ORDER BY created ASC"]);
    const body = stub.requestsFor("POST", "/search/jql")[0]?.body as { jql: string };
    expect(body.jql).toBe("assignee = currentUser() ORDER BY created ASC");
  });

  it("states an empty result definitively", async () => {
    const result = await cli(["search", "project = EMPTY"]);
    expect(result.data.issues).toBe("0 issues match this query");
  });

  it("surfaces a JQL syntax error from Jira with the query attached", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({
      status: 400,
      body: { errorMessages: ["Error in the JQL Query: expecting operator"], errors: {} },
    }));

    const result = await cli(["search", "project == ACME"]);

    expect(result.exitCode).toBe(1);
    expect(result.data.error).toContain("expecting operator");
    expect((result.data.help as string[]).join(" ")).toContain("project == ACME");
  });

  it("reports the count alone with --count", async () => {
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 42 } }));
    const result = await cli(["search", "labels = regression", "--count"]);
    expect(result.data.count).toBe(42);
    expect(stub.requestsFor("POST", "/search/jql")).toHaveLength(0);
  });
});

describe("project", () => {
  it("lists projects with a four-column schema", async () => {
    stub.on("GET", "/rest/api/3/project/search", () => ({
      body: {
        total: 2,
        isLast: true,
        values: [
          { key: "ACME", name: "Acme", style: "classic", lead: { displayName: "Alice Chen" } },
          { key: "BETA", name: "Beta", projectTypeKey: "software", lead: { displayName: "Bob Ray" } },
        ],
      },
    }));

    const result = await cli(["project", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.count).toBe("2 of 2 total");
    expect(result.data.projects).toMatchObject([
      { key: "ACME", name: "Acme", type: "classic", lead: "Alice Chen" },
      { key: "BETA", type: "software" },
    ]);
  });

  it("reports an empty project list definitively", async () => {
    stub.on("GET", "/rest/api/3/project/search", () => ({ body: { total: 0, isLast: true, values: [] } }));
    const result = await cli(["project", "list", "-q", "nope"]);
    expect(result.data.projects).toBe("0 projects match `nope`");
  });

  it("bundles issue types, statuses, and the open count into a view", async () => {
    stub.on("GET", "/rest/api/3/project/ACME", () => ({
      body: { key: "ACME", name: "Acme", style: "classic", lead: { displayName: "Alice Chen" } },
    }));
    stub.on("GET", "/rest/api/3/project/ACME/statuses", () => ({
      body: [
        { name: "Task", subtask: false, statuses: [{ name: "To Do" }, { name: "Done" }] },
        { name: "Bug", subtask: false, statuses: [{ name: "Open" }] },
      ],
    }));
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 12 } }));

    const result = await cli(["project", "view", "acme"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.project).toMatchObject({ key: "ACME", open_issues: 12 });
    expect(result.data.issue_types).toMatchObject([
      { name: "Task", subtask: false, statuses: "To Do, Done" },
      { name: "Bug" },
    ]);
    // The create example names a type that actually exists in this project.
    expect((result.data.help as string[]).join(" ")).toContain("-t Task");
  });

  it("treats an uppercase key as a view but a mistyped subcommand as an error", async () => {
    stub.on("GET", "/rest/api/3/project/ACME", () => ({ body: { key: "ACME", name: "Acme" } }));
    stub.on("GET", "/rest/api/3/project/ACME/statuses", () => ({ body: [] }));

    const view = await cli(["project", "ACME"]);
    expect(view.exitCode).toBe(0);
    expect(view.data.project).toMatchObject({ key: "ACME" });

    const typo = await cli(["project", "lst"]);
    expect(typo.exitCode).toBe(2);
    expect(typo.data.error).toContain("unknown subcommand `lst`");
    expect((typo.data.help as string[])[0]).toContain("list, view");
  });
});

describe("board and sprint", () => {
  it("lists boards", async () => {
    stub.on("GET", "/rest/agile/1.0/board", () => ({
      body: {
        total: 1,
        isLast: true,
        values: [{ id: 12, name: "ACME Scrum", type: "scrum", location: { projectKey: "ACME" } }],
      },
    }));

    const result = await cli(["board", "list", "-p", "ACME"]);

    expect(result.data.boards).toMatchObject([{ id: 12, name: "ACME Scrum", type: "scrum", project: "ACME" }]);
    expect((result.data.help as string[]).join(" ")).toContain("sprint list --board 12");
  });

  it("explains an empty board list rather than looking broken", async () => {
    stub.on("GET", "/rest/agile/1.0/board", () => ({ body: { total: 0, isLast: true, values: [] } }));

    const result = await cli(["board", "list", "-p", "ACME"]);

    expect(result.data.boards).toBe("0 boards for project ACME");
    expect((result.data.help as string[]).join(" ")).toContain("Jira Software");
  });

  it("computes sprint progress and a status breakdown", async () => {
    stub.on("GET", "/rest/agile/1.0/sprint/34", () => ({
      body: {
        id: 34,
        name: "Sprint 14",
        state: "active",
        startDate: "2026-08-10T09:00:00.000Z",
        endDate: "2026-08-24T09:00:00.000Z",
        goal: "Ship search",
      },
    }));
    stub.on("GET", "/rest/agile/1.0/sprint/34/issue", () => ({
      body: {
        total: 3,
        isLast: true,
        issues: [
          issue("ACME-1", { fields: { status: { name: "Done", statusCategory: { key: "done" } } } }),
          issue("ACME-2", { fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }),
          issue("ACME-3", { fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }),
        ],
      },
    }));

    const result = await cli(["sprint", "view", "34"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.sprint).toMatchObject({
      id: 34,
      name: "Sprint 14",
      state: "active",
      starts: "2026-08-10",
      ends: "2026-08-24",
      goal: "Ship search",
      progress: "1/3 done",
      by_status: "Done: 1, In Progress: 2",
    });
  });

  it("moves issues into a sprint and rejects a non-numeric id", async () => {
    stub.on("POST", "/rest/agile/1.0/sprint/34/issue", () => ({ status: 204 }));

    const result = await cli(["sprint", "add", "34", "-i", "ACME-1", "-i", "acme-2"]);
    expect(result.exitCode).toBe(0);
    const body = stub.requestsFor("POST", "/sprint/34/issue")[0]?.body as { issues: string[] };
    expect(body.issues).toEqual(["ACME-1", "ACME-2"]);

    const bad = await cli(["sprint", "add", "abc", "-i", "ACME-1"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.data.error).toContain("sprint id must be a number");
  });

  it("requires --issue for sprint add", async () => {
    const result = await cli(["sprint", "add", "34"]);
    expect(result.exitCode).toBe(2);
    expect(result.data.error).toBe("--issue is required");
  });

  it("shows the noun help when sprint is invoked bare, since list needs a board", async () => {
    const result = await cli(["sprint"]);
    expect(result.exitCode).toBe(0);
    expect(result.data.command).toBe("sprint");
    expect(result.data.subcommands).toMatchObject({ list: expect.any(String), view: expect.any(String) });
  });
});

describe("user and field", () => {
  it("shows the authenticated account", async () => {
    const result = await cli(["user", "me"]);
    expect(result.data.user).toMatchObject({
      name: MYSELF.displayName,
      email: MYSELF.emailAddress,
      account_id: MYSELF.accountId,
    });
  });

  it("defaults the bare user command to me", async () => {
    const result = await cli(["user"]);
    expect(result.data.user).toMatchObject({ account_id: MYSELF.accountId });
  });

  it("searches users and marks a hidden email", async () => {
    stub.on("GET", "/rest/api/3/user/search", () => ({
      body: [
        { accountId: "acct-1", displayName: "Alice Chen", emailAddress: "alice@acme.com", active: true },
        { accountId: "acct-2", displayName: "Alex Moore", active: true },
      ],
    }));

    const result = await cli(["user", "search", "al"]);

    expect(result.data.users).toMatchObject([
      { name: "Alice Chen", email: "alice@acme.com", account_id: "acct-1", active: true },
      { name: "Alex Moore", email: "hidden" },
    ]);
  });

  it("explains an empty user search", async () => {
    stub.on("GET", "/rest/api/3/user/search", () => ({ body: [] }));
    const result = await cli(["user", "search", "ghost"]);
    expect(result.data.users).toBe("0 users match `ghost`");
    expect((result.data.help as string[]).join(" ")).toContain("display name");
  });

  it("filters fields by name and reports ids usable with --field", async () => {
    stub.on("GET", "/rest/api/3/field", () => ({
      body: [
        { id: "summary", name: "Summary", schema: { type: "string" } },
        { id: "customfield_10016", name: "Story Points", custom: true, schema: { type: "number" } },
      ],
    }));

    const result = await cli(["field", "list", "-q", "story"]);

    expect(result.data.fields).toMatchObject([
      { id: "customfield_10016", name: "Story Points", type: "number", custom: true },
    ]);
    expect((result.data.help as string[]).join(" ")).toContain("customfield_10016=<value>");
  });

  it("looks up one field by id and errors clearly when absent", async () => {
    stub.on("GET", "/rest/api/3/field", () => ({
      body: [{ id: "customfield_10016", name: "Story Points", custom: true, schema: { type: "number", custom: "float" } }],
    }));

    const found = await cli(["field", "view", "customfield_10016"]);
    expect(found.data.field).toMatchObject({ id: "customfield_10016", custom_type: "float" });

    const missing = await cli(["field", "view", "customfield_99999"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.data.error).toContain("no field matches");
  });
});

describe("api", () => {
  it("calls an arbitrary endpoint and strips noisy keys", async () => {
    stub.on("GET", "/rest/api/3/myself", () => ({
      body: {
        accountId: "acct-1",
        displayName: "Test User",
        self: "https://acme.atlassian.net/rest/api/3/myself",
        avatarUrls: { "48x48": "https://x.test/a.png" },
      },
    }));

    const result = await cli(["api", "/rest/api/3/myself"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.accountId).toBe("acct-1");
    expect(result.data.self).toBeUndefined();
    expect(result.data.avatarUrls).toBeUndefined();
  });

  it("accepts a path without a leading slash", async () => {
    await cli(["api", "rest/api/3/myself"]);
    expect(stub.requestsFor("GET", "/rest/api/3/myself")).toHaveLength(1);
  });

  it("sends query parameters and a JSON body built from --field", async () => {
    stub.on("POST", "/rest/api/3/thing", () => ({ body: { ok: true } }));

    await cli(["api", "/rest/api/3/thing", "-X", "POST", "-f", "count=3", "-f", "name=x", "-q", "expand=all"]);

    const request = stub.requestsFor("POST", "/rest/api/3/thing")[0];
    expect(request?.body).toEqual({ count: 3, name: "x" });
    expect(request?.query.get("expand")).toBe("all");
  });

  it("truncates a long string so one field cannot flood the output", async () => {
    stub.on("GET", "/rest/api/3/big", () => ({ body: { text: "q".repeat(5000) } }));

    const result = await cli(["api", "/rest/api/3/big"]);

    expect(result.stdout).toContain("truncated, 5000 chars");
    expect(result.stdout.length).toBeLessThan(2000);
  });

  it("prints verbatim JSON with --raw", async () => {
    stub.on("GET", "/rest/api/3/thing", () => ({ body: { a: 1, nested: { b: 2 } } }));

    const result = await cli(["api", "/rest/api/3/thing", "--raw"]);

    expect(JSON.parse(result.stdout)).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("rejects an invalid method and a malformed --field", async () => {
    const method = await cli(["api", "/x", "-X", "PATCH"]);
    expect(method.exitCode).toBe(2);
    expect(method.data.error).toContain("--method must be GET, POST, PUT, or DELETE");

    const field = await cli(["api", "/x", "-X", "POST", "-f", "novalue"]);
    expect(field.exitCode).toBe(2);
    expect(field.data.error).toContain("--field must be key=value");
  });
});

describe("auth", () => {
  it("verifies the credentials it reports", async () => {
    const result = await cli(["auth", "status"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.auth).toMatchObject({
      status: "ok",
      user: MYSELF.displayName,
      email: "tester@example.com",
      source: "env",
    });
  });

  it("reports failed credentials with the login command", async () => {
    stub.on("GET", "/rest/api/3/myself", () => ({ status: 401, body: {} }));

    const result = await cli(["auth", "status"]);

    expect(result.data.auth).toMatchObject({ status: "failed" });
    expect((result.data.help as string[]).join(" ")).toContain("auth login");
  });

  it("stores an account, verifying it first", async () => {
    const result = await cli([
      "auth",
      "login",
      "--site",
      stub.url,
      "--email",
      "tester@example.com",
      "--token",
      "t",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.data.login).toMatchObject({ email: "tester@example.com", verified: true, default: true });
    expect(stub.requestsFor("GET", "/rest/api/3/myself")).toHaveLength(1);
  });

  it("refuses to store credentials the site rejects", async () => {
    stub.on("GET", "/rest/api/3/myself", () => ({ status: 401, body: {} }));

    const result = await cli([
      "auth",
      "login",
      "--site",
      stub.url,
      "--email",
      "tester@example.com",
      "--token",
      "bad",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.data.error).toContain("authentication failed");
  });

  it("reports a no-op when logging out with nothing stored", async () => {
    const result = await cli(["auth", "logout"]);
    expect(result.exitCode).toBe(0);
    expect(result.data.logout).toContain("(no-op)");
  });

  it("reports an empty account list with both ways to configure one", async () => {
    const result = await cli(["auth", "list"]);
    expect(result.data.accounts).toBe("0 accounts stored");
    expect((result.data.help as string[]).join(" ")).toContain("JIRA_API_TOKEN");
  });
});
