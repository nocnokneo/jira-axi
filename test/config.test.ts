import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AxiError } from "axi-sdk-js";

import { configPath, normalizeSite, resolveConfig, writeConfigFile } from "../src/config.js";

let dir: string;
let path: string;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { JIRA_AXI_CONFIG: path, ...overrides } as NodeJS.ProcessEnv;
}

function writeAccounts(config: unknown): void {
  writeFileSync(path, JSON.stringify(config), "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jira-axi-config-"));
  path = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeSite", () => {
  it("expands a bare subdomain to an atlassian.net origin", () => {
    expect(normalizeSite("acme")).toEqual({
      origin: "https://acme.atlassian.net",
      host: "acme.atlassian.net",
    });
  });

  it("accepts a hostname, a full URL, and a trailing slash", () => {
    expect(normalizeSite("acme.atlassian.net").origin).toBe("https://acme.atlassian.net");
    expect(normalizeSite("https://acme.atlassian.net/").origin).toBe("https://acme.atlassian.net");
    expect(normalizeSite("https://jira.acme.com").host).toBe("jira.acme.com");
  });

  it("discards a path so the origin is always clean", () => {
    expect(normalizeSite("https://acme.atlassian.net/jira/software").origin).toBe(
      "https://acme.atlassian.net",
    );
  });

  it("rejects plain http for a remote host", () => {
    expect(() => normalizeSite("http://acme.atlassian.net")).toThrow(/must use https/);
  });

  it("permits http on loopback so a stub server can be targeted", () => {
    expect(normalizeSite("http://127.0.0.1:8080").host).toBe("127.0.0.1:8080");
  });

  it("rejects an empty site", () => {
    expect(() => normalizeSite("   ")).toThrow(/site is empty/);
  });
});

describe("resolveConfig", () => {
  it("reads a complete set of environment variables", () => {
    const config = resolveConfig({
      env: env({ JIRA_SITE: "acme", JIRA_EMAIL: "a@b.com", JIRA_API_TOKEN: "t" }),
    });
    expect(config).toMatchObject({
      site: "https://acme.atlassian.net",
      host: "acme.atlassian.net",
      email: "a@b.com",
      token: "t",
      source: "env",
    });
  });

  it("accepts the JIRA_BASE_URL and JIRA_TOKEN aliases", () => {
    const config = resolveConfig({
      env: env({ JIRA_BASE_URL: "acme", JIRA_EMAIL: "a@b.com", JIRA_TOKEN: "t" }),
    });
    expect(config.host).toBe("acme.atlassian.net");
  });

  it("lets --site override the site while keeping env credentials", () => {
    const config = resolveConfig({
      site: "other",
      env: env({ JIRA_SITE: "acme", JIRA_EMAIL: "a@b.com", JIRA_API_TOKEN: "t" }),
    });
    expect(config.host).toBe("other.atlassian.net");
    expect(config.source).toBe("flag+env");
  });

  it("falls back to the config file's default account", () => {
    writeAccounts({
      default: "work",
      accounts: {
        work: { site: "https://work.atlassian.net", email: "w@b.com", token: "wt" },
        side: { site: "https://side.atlassian.net", email: "s@b.com", token: "st" },
      },
    });

    const config = resolveConfig({ env: env() });
    expect(config.host).toBe("work.atlassian.net");
    expect(config.source).toBe("account:work");
  });

  it("selects a named account with --account", () => {
    writeAccounts({
      default: "work",
      accounts: {
        work: { site: "https://work.atlassian.net", email: "w@b.com", token: "wt" },
        side: { site: "https://side.atlassian.net", email: "s@b.com", token: "st" },
      },
    });

    const config = resolveConfig({ account: "side", env: env() });
    expect(config.host).toBe("side.atlassian.net");
    expect(config.source).toBe("account:side");
  });

  it("prefers environment variables over the config file default", () => {
    writeAccounts({
      default: "work",
      accounts: { work: { site: "https://work.atlassian.net", email: "w@b.com", token: "wt" } },
    });

    const config = resolveConfig({
      env: env({ JIRA_SITE: "envsite", JIRA_EMAIL: "e@b.com", JIRA_API_TOKEN: "et" }),
    });
    expect(config.host).toBe("envsite.atlassian.net");
  });

  it("names the unknown account and lists the known ones", () => {
    writeAccounts({ accounts: { work: { site: "https://w.atlassian.net", email: "w@b.com", token: "t" } } });

    let error: AxiError | undefined;
    try {
      resolveConfig({ account: "nope", env: env() });
    } catch (thrown) {
      error = thrown as AxiError;
    }

    expect(error?.message).toBe("unknown account `nope`");
    expect(error?.suggestions[0]).toContain("work");
  });

  it("names which environment variable is missing", () => {
    let error: AxiError | undefined;
    try {
      resolveConfig({ env: env({ JIRA_SITE: "acme", JIRA_EMAIL: "a@b.com" }) });
    } catch (thrown) {
      error = thrown as AxiError;
    }

    expect(error?.message).toContain("JIRA_API_TOKEN not set");
    expect(error?.code).toBe("AUTH_ERROR");
  });

  it("reports no credentials at all with actionable setup steps", () => {
    let error: AxiError | undefined;
    try {
      resolveConfig({ env: env() });
    } catch (thrown) {
      error = thrown as AxiError;
    }

    expect(error?.message).toBe("no Jira credentials configured");
    expect(error?.suggestions.some((line) => line.includes("auth login"))).toBe(true);
    expect(error?.suggestions.some((line) => line.includes("JIRA_API_TOKEN"))).toBe(true);
  });

  it("reports a corrupt config file rather than silently ignoring it", () => {
    writeFileSync(path, "{ not json", "utf-8");
    expect(() => resolveConfig({ env: env() })).toThrow(/is not valid JSON/);
  });

  it("ignores a missing config file", () => {
    expect(() =>
      resolveConfig({ env: env({ JIRA_SITE: "acme", JIRA_EMAIL: "a@b.com", JIRA_API_TOKEN: "t" }) }),
    ).not.toThrow();
  });
});

describe("writeConfigFile", () => {
  it("writes credentials with owner-only permissions", () => {
    writeConfigFile(
      { default: "work", accounts: { work: { site: "https://w.atlassian.net", email: "w@b.com", token: "t" } } },
      env(),
    );

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("configPath", () => {
  it("honours JIRA_AXI_CONFIG, then XDG_CONFIG_HOME", () => {
    expect(configPath(env())).toBe(path);
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/xdg/jira-axi/config.json",
    );
  });
});
