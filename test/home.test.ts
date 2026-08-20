import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentBranch, issueKeyFromBranch } from "../src/home.js";
import { baseStub, issue, MYSELF, runCli, StubJira } from "./helpers/stub-jira.js";

const NOW = new Date("2026-08-19T09:00:00.000Z");

let stub: StubJira;

beforeEach(async () => {
  stub = await baseStub();
});

afterEach(async () => {
  await stub.stop();
});

describe("issueKeyFromBranch", () => {
  it("finds a key anywhere in a branch name", () => {
    expect(issueKeyFromBranch("ACME-42")).toBe("ACME-42");
    expect(issueKeyFromBranch("feature/ACME-42-timeout")).toBe("ACME-42");
    expect(issueKeyFromBranch("fix/acme-7")).toBe("ACME-7");
    expect(issueKeyFromBranch("tbraun/ACME-9_retry")).toBe("ACME-9");
  });

  it("ignores branch names that carry no key", () => {
    expect(issueKeyFromBranch("main")).toBeUndefined();
    // A dotted version is a release branch, not issue RELEASE-2.
    expect(issueKeyFromBranch("release-2.4.0")).toBeUndefined();
    expect(issueKeyFromBranch("v1.2.3")).toBeUndefined();
    expect(issueKeyFromBranch(undefined)).toBeUndefined();
    expect(issueKeyFromBranch("")).toBeUndefined();
  });
});

describe("currentBranch", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jira-axi-git-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads HEAD from a .git directory", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/ACME-42\n");
    expect(currentBranch(dir)).toBe("feature/ACME-42");
  });

  it("walks up from a subdirectory", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(currentBranch(nested)).toBe("main");
  });

  it("follows a worktree .git file to the real gitdir", () => {
    const real = join(dir, "realgit");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "HEAD"), "ref: refs/heads/ACME-7\n");
    writeFileSync(join(dir, ".git"), `gitdir: ${real}\n`);
    expect(currentBranch(dir)).toBe("ACME-7");
  });

  it("returns undefined on a detached HEAD or outside a repository", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "a1b2c3d4e5f6\n");
    expect(currentBranch(dir)).toBeUndefined();
  });
});

describe("home view", () => {
  it("returns setup guidance and exit 0 when unconfigured", async () => {
    // The session hook runs this on every conversation, so an unconfigured
    // machine must not print an error into each one.
    const result = await runCli([], { now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.data.setup).toBe("no Jira credentials configured");
    expect((result.data.help as string[]).join(" ")).toContain("auth login");
    expect(result.data.config_file).toBeDefined();
  });

  it("identifies the tool and shows assigned issues", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({
      body: { issues: [issue("ACME-1"), issue("ACME-2")], isLast: true },
    }));
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 12 } }));

    const result = await runCli([], { site: stub.url, now: NOW });

    expect(result.exitCode).toBe(0);
    // Principle 10: the home view discloses the executable and a description.
    expect(result.data.bin).toBeDefined();
    expect(result.data.description).toContain("Jira Cloud");
    expect(result.data.user).toContain(MYSELF.displayName);
    expect(result.data.count).toBe("2 of 12 total");
    expect(result.data.assigned).toMatchObject([{ key: "ACME-1" }, { key: "ACME-2" }]);
    expect((result.data.help as string[]).join(" ")).toContain("--limit 12");
  });

  it("queries only the current user's open issues", async () => {
    await runCli([], { site: stub.url, now: NOW });
    const body = stub.requestsFor("POST", "/search/jql")[0]?.body as { jql: string; maxResults: number };
    expect(body.jql).toContain("assignee = currentUser()");
    expect(body.jql).toContain("statusCategory != Done");
    // Loads on every session, so the page stays small.
    expect(body.maxResults).toBeLessThanOrEqual(8);
  });

  it("states an empty queue definitively", async () => {
    const result = await runCli([], { site: stub.url, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.data.assigned).toBe("0 open issues are assigned to you");
    expect((result.data.help as string[]).join(" ")).toContain("project list");
  });

  it("stays usable when the site cannot be reached", async () => {
    const unreachable = "http://127.0.0.1:1";
    const result = await runCli([], { site: unreachable, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.data.assigned).toContain("could not be read");
    expect((result.data.help as string[]).join(" ")).toContain("auth status");
  });
});
