import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { baseStub, runCli, StubJira } from "./helpers/stub-jira.js";

const ROOT = join(import.meta.dirname, "..");

let stub: StubJira;

beforeEach(async () => {
  stub = await baseStub();
});

afterEach(async () => {
  await stub.stop();
});

describe("top-level dispatch", () => {
  it("prints the tool reference for bare --help without needing credentials", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.data.commands).toMatchObject({
      issue: expect.any(String),
      search: expect.any(String),
      auth: expect.any(String),
    });
    expect(result.data.global_flags).toBeDefined();
    expect(result.data.examples).toBeDefined();
    expect(stub.requests).toHaveLength(0);
  });

  it("prints the version for -v, -V, and --version", async () => {
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string })
      .version;

    for (const flag of ["-v", "-V", "--version"]) {
      const result = await runCli([flag]);
      expect(result.stdout.trim()).toBe(version);
      expect(result.exitCode).toBe(0);
    }
  });

  it("rejects an unknown command with exit 2", async () => {
    const result = await runCli(["issues"]);

    expect(result.exitCode).toBe(2);
    expect(result.data.error).toContain("Unknown command: issues");
  });

  it("rejects a flag placed before the command", async () => {
    const result = await runCli(["--site", "acme", "issue", "list"]);

    expect(result.exitCode).toBe(2);
    expect(result.data.error).toContain("Flags must come after the command");
  });

  it("resolves --help per subcommand, not per command", async () => {
    const noun = await runCli(["issue", "--help"]);
    expect(noun.data.command).toBe("issue");
    expect(noun.data.subcommands).toMatchObject({ list: expect.any(String), view: expect.any(String) });

    const sub = await runCli(["issue", "list", "--help"]);
    expect(sub.data.command).toBe("issue list");
    expect(sub.data.usage).toContain("jira-axi issue list");
    expect(sub.data.examples).toBeDefined();

    const other = await runCli(["issue", "transition", "--help"]);
    expect(other.data.command).toBe("issue transition");
  });

  it("documents defaults, repeatability, and the global flags in subcommand help", async () => {
    const result = await runCli(["issue", "list", "--help"]);
    const flags = result.data.flags as Record<string, string>;

    expect(flags["--state <open|closed|all>"]).toContain("(default: open)");
    expect(flags["--label, -l <label>"]).toContain("(repeatable)");
    expect(flags["--site <site>"]).toBeDefined();
    expect(flags["--account <name>"]).toBeDefined();
  });

  it("serves help without credentials for every command", async () => {
    for (const command of ["issue", "search", "project", "board", "sprint", "user", "field", "api", "auth", "setup"]) {
      const result = await runCli([command, "--help"]);
      expect(result.exitCode, `${command} --help`).toBe(0);
      expect(result.data.command, `${command} --help`).toBe(command);
    }
    expect(stub.requests).toHaveLength(0);
  });

  it("reports missing credentials as an auth error on a command that needs them", async () => {
    const result = await runCli(["issue", "list"]);

    expect(result.exitCode).toBe(1);
    expect(result.data.error).toBe("no Jira credentials configured");
    expect(result.data.code).toBe("AUTH_ERROR");
    expect((result.data.help as string[]).join(" ")).toContain("auth login");
  });

  it("routes every error to stdout in the same structured shape", async () => {
    const usage = await runCli(["issue", "list", "--nope"], { site: stub.url });
    expect(usage.data.error).toBeDefined();
    expect(usage.data.code).toBe("VALIDATION_ERROR");
    expect(usage.data.help).toBeDefined();
    expect(usage.exitCode).toBe(2);
  });
});

describe("contextual suggestions", () => {
  /**
   * Principle 9 requires every suggestion to be a complete command. A line that
   * appends prose to a bare command is not runnable — this CLI would reject the
   * trailing words as unexpected positionals — so prose-bearing suggestions must
   * fence the command instead.
   */
  function assertRunnable(help: unknown, where: string): void {
    for (const line of (help ?? []) as string[]) {
      if (!line.startsWith("jira-axi")) {
        continue;
      }
      expect(line, `${where}: "${line}" is a bare command with trailing prose`).not.toMatch(
        /\s(for|to see|to get|for all|for more)\s/,
      );
    }
  }

  it("keeps bare-command suggestions free of trailing prose", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({
      body: {
        issues: [{ id: "1", key: "ACME-1", fields: { summary: "s", status: { name: "To Do" } } }],
        isLast: true,
      },
    }));
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 500 } }));

    const list = await runCli(["issue", "list", "-p", "ACME"], { site: stub.url });
    assertRunnable(list.data.help, "issue list");

    const search = await runCli(["search", "project = ACME"], { site: stub.url });
    assertRunnable(search.data.help, "search");

    const home = await runCli([], { site: stub.url });
    assertRunnable(home.data.help, "home");
  });

  it("fences a command that carries an explanation", async () => {
    stub.on("POST", "/rest/api/3/search/jql", () => ({
      body: {
        issues: [{ id: "1", key: "ACME-1", fields: { summary: "s", status: { name: "To Do" } } }],
        isLast: true,
      },
    }));
    stub.on("POST", "/rest/api/3/search/approximate-count", () => ({ body: { count: 500 } }));

    const result = await runCli(["issue", "list", "-p", "ACME"], { site: stub.url });
    const help = result.data.help as string[];

    expect(help.some((line) => line.startsWith("Run `jira-axi issue list --limit 100`"))).toBe(true);
  });
});

describe("published entry point", () => {
  it("answers --version from the built binary without loading the command graph", () => {
    // Guards the fast path in `bin/jira-axi.ts`: a heavy static import there
    // would be paid on every `--version` probe an agent harness makes.
    const floor = timeOf(["-e", "console.log(1)"]);
    const measured = timeOf([join(ROOT, "dist", "bin", "jira-axi.js"), "--version"]);

    expect(measured).toBeLessThan(floor + 250);
  });

  it("exits 2 on a usage error from the built binary", () => {
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [join(ROOT, "dist", "bin", "jira-axi.js"), "issue", "list", "--bogus"], {
        encoding: "utf-8",
        env: { ...process.env, JIRA_AXI_CONFIG: "/nonexistent/config.json" },
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status ?? 0;
      stdout = failure.stdout ?? "";
    }

    expect(status).toBe(2);
    expect(stdout).toContain("unknown flag --bogus");
  });
});

function timeOf(args: string[]): number {
  // Warm the module cache so the measurement is not dominated by first-run I/O.
  execFileSync(process.execPath, args, { encoding: "utf-8" });
  const started = process.hrtime.bigint();
  execFileSync(process.execPath, args, { encoding: "utf-8" });
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}
