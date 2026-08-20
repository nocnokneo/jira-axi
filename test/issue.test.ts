import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adf, baseStub, issue, MYSELF, runCli, StubJira } from "./helpers/stub-jira.js";

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

describe("issue list", () => {
  it("builds a bounded JQL query, reports the total, and shows four columns", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({
      body: { issues: [issue("ACME-1"), issue("ACME-2")], isLast: true },
    }));
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 340 } }));

    const result = await cli(["issue", "list", "-p", "ACME"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.jql).toBe('project = "ACME" AND statusCategory != Done ORDER BY updated DESC');
    expect(result.data.count).toBe("2 of 340 total");
    // Principle 2: four columns by default, no more.
    expect(result.stdout).toContain("issues[2]{key,summary,status,assignee}:");
    expect(result.data.issues).toMatchObject([
      { key: "ACME-1", summary: "Summary for ACME-1", status: "To Do", assignee: "Alice Chen" },
      { key: "ACME-2" },
    ]);
    // Principle 9: a list suggests viewing one of its rows.
    expect(result.data.help).toContain("jira-axi issue view ACME-1");
  });

  it("requests the fields it renders, since /search/jql returns ids only by default", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({ body: { issues: [issue("ACME-1")], isLast: true } }));

    await cli(["issue", "list", "-p", "ACME"]);

    const [request] = stub.requestsFor("POST", "/search/jql");
    const fields = (request?.body as { fields?: string[] }).fields ?? [];
    expect(fields).toContain("summary");
    expect(fields).toContain("status");
    expect(fields).toContain("assignee");
  });

  it("states an empty result definitively instead of printing an empty array", async () => {
    const result = await cli(["issue", "list", "-p", "ACME"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("issues: 0 open issues match this query");
    expect(result.stdout).toContain("--state all");
  });

  it("resolves an assignee email to an account id before querying", async () => {
    stub.on("GET", "/rest/api/3/user/assignable/search", () => ({
      body: [{ accountId: "acct-alice", displayName: "Alice Chen", emailAddress: "alice@acme.com" }],
    }));
    stub.on("POST", "/rest/api/3/search/jql", () => ({ body: { issues: [issue("ACME-1")], isLast: true } }));

    const result = await cli(["issue", "list", "-p", "ACME", "-a", "alice@acme.com"]);

    // Jira Cloud hides email addresses, so `assignee = "alice@acme.com"` would
    // match nothing.
    expect(result.data.jql).toContain('assignee = "acct-alice"');
  });

  it("passes @me straight through as currentUser()", async () => {
    await cli(["issue", "list", "-a", "@me"]);
    const [request] = stub.requestsFor("POST", "/search/jql");
    expect((request?.body as { jql?: string }).jql).toContain("assignee = currentUser()");
    expect(stub.requestsFor("GET", "/user/search")).toHaveLength(0);
  });

  it("reports only the count with --count", async () => {
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 17 } }));

    const result = await cli(["issue", "list", "-p", "ACME", "--count"]);

    expect(result.stdout).toContain("count: 17");
    expect(stub.requestsFor("POST", "/search/jql")).toHaveLength(0);
  });

  it("rejects an unknown flag before making any request", async () => {
    const result = await cli(["issue", "list", "--stat", "closed"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("error: unknown flag --stat for `issue list`");
    expect(result.stdout).toContain("--project");
    expect(stub.requests).toHaveLength(0);
  });

  it("keeps working when the count endpoint fails", async () => {
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ status: 500, body: {} }));
    stub.on("POST", "/rest/api/3/search/jql", () => ({ body: { issues: [issue("ACME-1")], isLast: true } }));

    const result = await cli(["issue", "list", "-p", "ACME"]);

    // The count is a convenience on top of a successful search; losing it must
    // not turn working output into an error.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("count: showing 1");
  });
});

describe("issue view", () => {
  function viewStub(overrides: Record<string, unknown> = {}, transitions: unknown[] = []): void {
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({
      body: { ...issue("ACME-42", overrides), transitions },
    }));
    stub.on("GET", "/rest/api/3/issue/ACME-42/comment", () => ({ body: { total: 0, comments: [] } }));
  }

  it("bundles the aggregates that would otherwise each cost a round trip", async () => {
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({
      body: {
        ...issue("ACME-42", {
          fields: {
            description: adf("A description."),
            subtasks: [
              { key: "ACME-43", fields: { summary: "sub a", status: { name: "Done", statusCategory: { key: "done" } } } },
              { key: "ACME-44", fields: { summary: "sub b", status: { name: "To Do", statusCategory: { key: "new" } } } },
            ],
            issuelinks: [
              {
                id: "1",
                type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
                outwardIssue: { key: "ACME-9", fields: { summary: "other", status: { name: "To Do" } } },
              },
            ],
            attachment: [{ filename: "log.txt" }],
            aggregatetimespent: 16_200,
            watches: { watchCount: 3 },
          },
        }),
        transitions: [
          { id: "11", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
          { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
        ],
      },
    }));
    stub.on("GET", "/rest/api/3/issue/ACME-42/comment", () => ({
      body: {
        total: 7,
        comments: [
          { id: "c1", author: { displayName: "Bob Ray" }, body: adf("Looks fine."), created: "2026-08-18T09:00:00.000+0000" },
        ],
      },
    }));

    const result = await cli(["issue", "view", "ACME-42"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.issue).toMatchObject({
      key: "ACME-42",
      subtasks: "1/2 done",
      links: 1,
      comments: 7,
      attachments: 1,
      time_spent: "4.5h",
      watchers: 3,
      updated: "3d",
      // Available transitions inline mean no lookup before `issue transition`.
      transitions: "In Progress, Done",
    });
    expect(result.stdout).toContain("subtasks[2]{key,summary,status}:");
    expect(result.stdout).toContain("recent_comments[1]{author,age,body}:");
    // 7 comments exist but only 1 was shown, so say how to see them all.
    expect((result.data.help as string[]).join(" ")).toContain("--limit 7");
  });

  it("describes a link with the relation Jira itself returned", async () => {
    viewStub({
      fields: {
        issuelinks: [
          {
            id: "1",
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            inwardIssue: { key: "ACME-9", fields: { summary: "other", status: { name: "To Do" } } },
          },
        ],
      },
    });

    const result = await cli(["issue", "view", "ACME-42"]);
    expect(result.stdout).toContain("is blocked by,ACME-9");
  });

  it("truncates a long description and offers --full with the total size", async () => {
    viewStub({ fields: { description: adf("z".repeat(3000)) } });

    const result = await cli(["issue", "view", "ACME-42"]);

    // The suggestion fences the command so it stays runnable verbatim.
    expect((result.data.help as string[])[0]).toBe(
      "Run `jira-axi issue view ACME-42 --full` for the complete description (3000 chars total)",
    );
  });

  it("prints the whole description with --full and no hint", async () => {
    viewStub({ fields: { description: adf("z".repeat(3000)) } });

    const result = await cli(["issue", "view", "ACME-42", "--full"]);

    expect(result.stdout).not.toContain("truncated");
    expect(result.stdout).toContain("z".repeat(3000));
  });

  it("still renders the issue when only the comment endpoint fails", async () => {
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({ body: issue("ACME-42") }));
    stub.on("GET", "/rest/api/3/issue/ACME-42/comment", () => ({ status: 500, body: {} }));

    const result = await cli(["issue", "view", "ACME-42"]);

    // Comments are secondary; losing them must not lose the issue.
    expect(result.exitCode).toBe(0);
    expect(result.data.issue).toMatchObject({ key: "ACME-42" });
    expect((result.data.issue as Record<string, unknown>).comments).toBeUndefined();
  });

  it("reports the issue failure, not a sibling request's, when the issue is gone", async () => {
    // Both requests 404. Promise.all would leave the comment rejection
    // unhandled, which Node treats as fatal by default.
    const result = await cli(["issue", "view", "ACME-999"]);

    expect(result.exitCode).toBe(1);
    expect(result.data.error).toBe("issue ACME-999 not found");
  });

  it("renders relative ages against the injected clock, not the wall clock", async () => {
    // The clock has to reach command handlers, not just the home view, or any
    // relative age in output is both untestable and time-dependent.
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({
      body: issue("ACME-42", { fields: { updated: "2026-08-16T09:00:00.000+0000" } }),
    }));
    stub.on("GET", "/rest/api/3/issue/ACME-42/comment", () => ({ body: { total: 0, comments: [] } }));

    const result = await cli(["issue", "view", "ACME-42"]);
    expect((result.data.issue as Record<string, unknown>).updated).toBe("3d");

    const later = await runCli(["issue", "view", "ACME-42"], {
      site: stub.url,
      now: new Date("2026-09-16T09:00:00.000Z"),
    });
    expect((later.data.issue as Record<string, unknown>).updated).toBe("1mo");
  });

  it("skips the comment request when --comments 0 is passed", async () => {
    viewStub();
    await cli(["issue", "view", "ACME-42", "--comments", "0"]);
    expect(stub.requestsFor("GET", "/comment")).toHaveLength(0);
  });

  it("treats a bare issue key as a view", async () => {
    viewStub();
    const result = await cli(["issue", "ACME-42"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("key: ACME-42");
  });

  it("reports a missing issue as NOT_FOUND with exit 1", async () => {
    const result = await cli(["issue", "view", "ACME-999"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("error: issue ACME-999 not found");
    expect(result.stdout).toContain("code: NOT_FOUND");
  });

  it("rejects a malformed key without calling the API", async () => {
    const result = await cli(["issue", "view", "not-a-key-at-all"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("is not a Jira issue key");
    expect(stub.requests).toHaveLength(0);
  });
});

describe("issue create", () => {
  it("converts a Markdown description to ADF and returns the new key", async () => {
    stub.on("POST", "/rest/api/3/issue", () => ({ body: { key: "ACME-77", id: "1" } }));

    const result = await cli([
      "issue",
      "create",
      "-p",
      "acme",
      "-t",
      "Bug",
      "-s",
      "Crash on save",
      "--description",
      "Steps:\n\n- one\n- two",
      "-l",
      "regression",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("key: ACME-77");

    const [request] = stub.requestsFor("POST", "/rest/api/3/issue");
    const fields = (request?.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ key: "ACME" });
    expect(fields.issuetype).toEqual({ name: "Bug" });
    expect(fields.labels).toEqual(["regression"]);

    const description = fields.description as { type: string; content: Array<{ type: string }> };
    expect(description.type).toBe("doc");
    expect(description.content.map((node) => node.type)).toEqual(["paragraph", "bulletList"]);
  });

  it("reports a missing required flag as a usage error before any request", async () => {
    const result = await cli(["issue", "create", "-p", "ACME"]);

    expect(result.exitCode).toBe(2);
    expect(result.data.error).toBe("--summary is required");
    expect(stub.requests).toHaveLength(0);
  });

  it("sets a custom field through the --field escape hatch", async () => {
    stub.on("POST", "/rest/api/3/issue", () => ({ body: { key: "ACME-78" } }));

    await cli([
      "issue",
      "create",
      "-p",
      "ACME",
      "-s",
      "Spike",
      "--field",
      "customfield_10016=5",
      "--field",
      'customfield_10001={"value":"Team A"}',
    ]);

    const fields = (stub.requestsFor("POST", "/rest/api/3/issue")[0]?.body as {
      fields: Record<string, unknown>;
    }).fields;
    expect(fields.customfield_10016).toBe(5);
    expect(fields.customfield_10001).toEqual({ value: "Team A" });
  });

  it("translates a Jira field validation error without leaking the payload", async () => {
    stub.on("POST", "/rest/api/3/issue", () => ({
      status: 400,
      body: { errorMessages: [], errors: { issuetype: "valid issue type is required" } },
    }));

    const result = await cli(["issue", "create", "-p", "ACME", "-s", "x", "-t", "Nonsense"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("issuetype: valid issue type is required");
    expect(result.stdout).toContain("jira-axi project view ACME");
  });
});

describe("issue edit", () => {
  function editStub(fields: Record<string, unknown>): void {
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({ body: issue("ACME-42", { fields }) }));
    stub.on("PUT", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({ status: 204 }));
  }

  it("reports a no-op and writes nothing when the value already matches", async () => {
    editStub({ summary: "Already right" });

    const result = await cli(["issue", "edit", "ACME-42", "-s", "Already right"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already matches the requested values (no-op)");
    expect(stub.requestsFor("PUT", "/rest/api/3/issue/ACME-42")).toHaveLength(0);
  });

  it("computes the label set from the current labels", async () => {
    editStub({ labels: ["existing", "stale"] });

    const result = await cli([
      "issue",
      "edit",
      "ACME-42",
      "--add-label",
      "fresh",
      "--remove-label",
      "stale",
    ]);

    expect(result.exitCode).toBe(0);
    const body = stub.requestsFor("PUT", "/rest/api/3/issue/ACME-42")[0]?.body as {
      fields: { labels: string[] };
    };
    expect(body.fields.labels).toEqual(["existing", "fresh"]);
    expect(result.stdout).toContain("changed: labels");
  });

  it("treats adding a label the issue already has as a no-op", async () => {
    editStub({ labels: ["existing"] });

    const result = await cli(["issue", "edit", "ACME-42", "--add-label", "existing"]);

    expect(result.stdout).toContain("(no-op)");
    expect(stub.requestsFor("PUT", "/rest/api/3/issue/ACME-42")).toHaveLength(0);
  });

  it("requires at least one field to change", async () => {
    const result = await cli(["issue", "edit", "ACME-42"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("needs at least one field to change");
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses --assignee together with --unassign", async () => {
    const result = await cli(["issue", "edit", "ACME-42", "-a", "@me", "--unassign"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--assignee and --unassign cannot be combined");
  });

  it("validates a due date before calling the API", async () => {
    const result = await cli(["issue", "edit", "ACME-42", "--due", "next friday"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--due must be a YYYY-MM-DD date");
    expect(stub.requests).toHaveLength(0);
  });
});

describe("issue transition", () => {
  function transitionStub(status: string, transitions: unknown[]): void {
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({
      body: issue("ACME-42", {
        fields: {
          status: {
            name: status,
            statusCategory: { key: status === "Done" ? "done" : "new" },
          },
        },
      }),
    }));
    stub.on("GET", "/rest/api/3/issue/ACME-42/transitions", () => ({ body: { transitions } }));
    stub.on("POST", "/rest/api/3/issue/ACME-42/transitions", () => ({ status: 204 }));
  }

  it("moves the issue and reports both ends of the change", async () => {
    transitionStub("To Do", [
      { id: "11", name: "Start Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
    ]);

    const result = await cli(["issue", "transition", "ACME-42", "--to", "In Progress"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("from: To Do");
    expect(result.stdout).toContain("to: In Progress");
    expect(result.stdout).toContain("via: Start Progress");

    const body = stub.requestsFor("POST", "/transitions")[0]?.body as { transition: { id: string } };
    expect(body.transition.id).toBe("11");
  });

  it("is idempotent when the issue is already in the target status", async () => {
    transitionStub("In Progress", []);

    const result = await cli(["issue", "transition", "ACME-42", "--to", "in progress"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already in In Progress (no-op)");
    expect(stub.requestsFor("POST", "/transitions")).toHaveLength(0);
  });

  it("lists the available targets when the requested one does not exist", async () => {
    transitionStub("To Do", [
      { id: "11", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
    ]);

    const result = await cli(["issue", "transition", "ACME-42", "--to", "Shipped"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("no transition to `Shipped` is available on ACME-42");
    expect(result.stdout).toContain("available: In Progress");
  });

  it("attaches a comment to the transition when asked", async () => {
    transitionStub("To Do", [{ id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } }]);

    await cli(["issue", "transition", "ACME-42", "--to", "Done", "--comment", "Shipped in 2.4.0"]);

    const body = stub.requestsFor("POST", "/transitions")[0]?.body as {
      update?: { comment?: Array<{ add: { body: { type: string } } }> };
    };
    expect(body.update?.comment?.[0]?.add.body.type).toBe("doc");
  });

  it("close picks the conventional Done status", async () => {
    transitionStub("To Do", [
      { id: "21", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } },
      { id: "22", name: "Drop", to: { name: "Won't Do", statusCategory: { key: "done" } } },
    ]);

    const result = await cli(["issue", "close", "ACME-42"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("to: Done");
  });

  it("close refuses to guess between two unconventional Done statuses", async () => {
    transitionStub("To Do", [
      { id: "22", name: "Drop", to: { name: "Won't Do", statusCategory: { key: "done" } } },
      { id: "23", name: "Dupe", to: { name: "Duplicate", statusCategory: { key: "done" } } },
    ]);

    const result = await cli(["issue", "close", "ACME-42"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("2 close statuses");
    expect(result.stdout).toContain("Won't Do, Duplicate");
    expect(stub.requestsFor("POST", "/transitions")).toHaveLength(0);
  });

  it("close is a no-op on an already resolved issue", async () => {
    transitionStub("Done", []);

    const result = await cli(["issue", "close", "ACME-42"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already Done (no-op)");
  });
});

describe("issue assign", () => {
  function assignStub(assignee: unknown): void {
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({
      body: issue("ACME-42", { fields: { assignee } }),
    }));
    stub.on("PUT", "/rest/api/3/issue/ACME-42/assignee", () => ({ status: 204 }));
  }

  it("resolves @me to the current account", async () => {
    assignStub({ accountId: "acct-alice", displayName: "Alice Chen" });

    const result = await cli(["issue", "assign", "ACME-42", "--to", "@me"]);

    expect(result.exitCode).toBe(0);
    const body = stub.requestsFor("PUT", "/assignee")[0]?.body as { accountId: string };
    expect(body.accountId).toBe(MYSELF.accountId);
  });

  it("is idempotent when the assignee is unchanged", async () => {
    assignStub({ accountId: MYSELF.accountId, displayName: "Test User" });

    const result = await cli(["issue", "assign", "ACME-42", "--to", "@me"]);

    expect(result.stdout).toContain("already Test User (no-op)");
    expect(stub.requestsFor("PUT", "/assignee")).toHaveLength(0);
  });

  it("clears the assignee with --unassign", async () => {
    assignStub({ accountId: "acct-alice", displayName: "Alice Chen" });

    const result = await cli(["issue", "assign", "ACME-42", "--unassign"]);

    expect(result.exitCode).toBe(0);
    const body = stub.requestsFor("PUT", "/assignee")[0]?.body as { accountId: string | null };
    expect(body.accountId).toBeNull();
  });

  it("is idempotent when already unassigned", async () => {
    assignStub(null);

    const result = await cli(["issue", "assign", "ACME-42", "--unassign"]);

    expect(result.stdout).toContain("already unassigned (no-op)");
    expect(stub.requestsFor("PUT", "/assignee")).toHaveLength(0);
  });

  it("reports an ambiguous name with the candidate account ids", async () => {
    assignStub(null);
    stub.on("GET", "/rest/api/3/user/assignable/search", () => ({
      body: [
        { accountId: "acct-1", displayName: "Alex Kim" },
        { accountId: "acct-2", displayName: "Alex Moore" },
      ],
    }));

    const result = await cli(["issue", "assign", "ACME-42", "--to", "Alex"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("matches 2 Jira users");
    expect(result.stdout).toContain("acct-1");
  });

  it("reports no match with a way to search", async () => {
    assignStub(null);
    stub.on("GET", "/rest/api/3/user/assignable/search", () => ({ body: [] }));
    stub.on("GET", "/rest/api/3/user/search", () => ({ body: [] }));

    const result = await cli(["issue", "assign", "ACME-42", "--to", "ghost@acme.com"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("no Jira user matches `ghost@acme.com`");
    expect(result.stdout).toContain("jira-axi user search");
  });

  it("requires --to or --unassign", async () => {
    const result = await cli(["issue", "assign", "ACME-42"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--to or --unassign is required");
  });
});

describe("issue comment", () => {
  it("posts a comment as ADF", async () => {
    stub.on("POST", "/rest/api/3/issue/ACME-42/comment", () => ({ body: { id: "c9" } }));

    const result = await cli(["issue", "comment", "ACME-42", "--body", "Reproduced on Safari"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id: c9");

    const body = stub.requestsFor("POST", "/comment")[0]?.body as { body: { type: string } };
    expect(body.body.type).toBe("doc");
  });

  it("requires body text and names both ways to supply it", async () => {
    const result = await cli(["issue", "comment", "ACME-42"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--body or --body-file is required");
    expect(result.stdout).toContain("--body-file");
  });

  it("refuses --body together with --body-file", async () => {
    const result = await cli(["issue", "comment", "ACME-42", "--body", "x", "--body-file", "y.md"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--body and --body-file cannot be combined");
  });

  it("reports a missing body file without a stack trace", async () => {
    const result = await cli(["issue", "comment", "ACME-42", "--body-file", "/nope/missing.md"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("file not found: /nope/missing.md");
    expect(result.stdout).not.toContain("ENOENT");
  });
});

describe("issue link", () => {
  const LINK_TYPES = {
    issueLinkTypes: [
      { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
    ],
  };

  it("creates the link and reports the relation Jira read back", async () => {
    stub.on("GET", "/rest/api/3/issueLinkType", () => ({ body: LINK_TYPES }));
    stub.on("POST", "/rest/api/3/issueLink", () => ({ status: 201 }));

    let call = 0;
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => {
      call += 1;
      return {
        body: issue("ACME-42", {
          fields: {
            issuelinks:
              call === 1
                ? []
                : [
                    {
                      id: "1",
                      type: LINK_TYPES.issueLinkTypes[0],
                      outwardIssue: { key: "ACME-9", fields: { summary: "other", status: { name: "To Do" } } },
                    },
                  ],
          },
        }),
      };
    });

    const result = await cli(["issue", "link", "ACME-42", "--type", "blocks", "--to", "ACME-9"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("relation: blocks");
    expect(result.stdout).toContain("to: ACME-9");
  });

  it("flags a mismatch instead of claiming the requested direction", async () => {
    stub.on("GET", "/rest/api/3/issueLinkType", () => ({ body: LINK_TYPES }));
    stub.on("POST", "/rest/api/3/issueLink", () => ({ status: 201 }));

    let call = 0;
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => {
      call += 1;
      return {
        body: issue("ACME-42", {
          fields: {
            issuelinks:
              call === 1
                ? []
                : [
                    {
                      id: "1",
                      type: LINK_TYPES.issueLinkTypes[0],
                      // Jira ended up recording the opposite direction.
                      inwardIssue: { key: "ACME-9", fields: { summary: "other", status: { name: "To Do" } } },
                    },
                  ],
          },
        }),
      };
    });

    const result = await cli(["issue", "link", "ACME-42", "--type", "blocks", "--to", "ACME-9"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.linked).toMatchObject({ relation: "is blocked by", to: "ACME-9" });
    expect((result.data.help as string[]).join(" ")).toContain(
      'Jira recorded this as "ACME-42 is blocked by ACME-9"',
    );
  });

  it("lists the valid relations for an unknown one", async () => {
    stub.on("GET", "/rest/api/3/issueLinkType", () => ({ body: LINK_TYPES }));

    const result = await cli(["issue", "link", "ACME-42", "--type", "supersedes", "--to", "ACME-9"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("unknown link relation `supersedes`");
    expect(result.stdout).toContain("is blocked by");
  });

  it("is a no-op when the same link already exists", async () => {
    stub.on("GET", "/rest/api/3/issueLinkType", () => ({ body: LINK_TYPES }));
    stub.on("GET", /^\/rest\/api\/3\/issue\/ACME-42$/, () => ({
      body: issue("ACME-42", {
        fields: {
          issuelinks: [
            {
              id: "1",
              type: LINK_TYPES.issueLinkTypes[0],
              outwardIssue: { key: "ACME-9", fields: { summary: "other", status: { name: "To Do" } } },
            },
          ],
        },
      }),
    }));

    const result = await cli(["issue", "link", "ACME-42", "--type", "blocks", "--to", "ACME-9"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(no-op)");
    expect(stub.requestsFor("POST", "/issueLink")).toHaveLength(0);
  });

  it("refuses to link an issue to itself", async () => {
    const result = await cli(["issue", "link", "ACME-42", "--type", "blocks", "--to", "ACME-42"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("cannot be linked to itself");
  });
});

describe("issue worklog", () => {
  it("logs time and validates the duration format", async () => {
    stub.on("POST", "/rest/api/3/issue/ACME-42/worklog", () => ({
      body: { id: "w1", timeSpent: "1h 30m" },
    }));

    const result = await cli(["issue", "worklog", "ACME-42", "--time", "90m"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("time: 1h 30m");

    const bad = await cli(["issue", "worklog", "ACME-42", "--time", "a while"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain("--time must be a Jira duration");
  });
});
