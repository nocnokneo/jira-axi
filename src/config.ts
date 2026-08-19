import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AxiError } from "axi-sdk-js";

import { BIN } from "./bin-name.js";

export interface Account {
  site: string;
  email: string;
  token: string;
}

export interface ConfigFile {
  /** Name of the account used when `--account` is not passed. */
  default?: string;
  accounts?: Record<string, Account>;
}

export interface ResolvedConfig extends Account {
  /** Where the credentials came from, for `auth status`. */
  source: "flag+env" | "env" | `account:${string}`;
  /** Bare host, e.g. `acme.atlassian.net`. */
  host: string;
}

const API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JIRA_AXI_CONFIG;
  if (override) {
    return override;
  }

  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "jira-axi", "config.json");
}

export function readConfigFile(env: NodeJS.ProcessEnv = process.env): ConfigFile {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as ConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new AxiError(`config file at ${path} is not valid JSON`, "CONFIG_ERROR", [
      `Fix or delete ${path}`,
      `Run \`${BIN} auth login --site <site> --email <email> --token <token>\` to rewrite it`,
    ]);
  }
}

export function writeConfigFile(config: ConfigFile, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    // The file holds an API token; tighten permissions even when it pre-existed
    // with a looser mode.
    chmodSync(path, 0o600);
  } catch {
    // Best effort — some filesystems (and Windows) do not support this.
  }
  return path;
}

/**
 * Accept the shorthand forms an agent is likely to produce and normalize them to
 * an origin: `acme`, `acme.atlassian.net`, `https://acme.atlassian.net/`, or a
 * full URL that accidentally carries a path.
 */
export function normalizeSite(input: string): { origin: string; host: string } {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new AxiError("site is empty", "VALIDATION_ERROR", [
      `${BIN} auth login --site acme.atlassian.net --email <email> --token <token>`,
    ]);
  }

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    // A bare word is a Jira Cloud subdomain; anything with a dot is a hostname.
    candidate = candidate.includes(".") ? `https://${candidate}` : `https://${candidate}.atlassian.net`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AxiError(`\`${input}\` is not a valid Jira site`, "VALIDATION_ERROR", [
      "Pass a Jira Cloud site like `acme` or `acme.atlassian.net`",
    ]);
  }

  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !isLoopback) {
    throw new AxiError(`\`${input}\` must use https`, "VALIDATION_ERROR", [
      `Use \`https://${url.host}\` instead`,
    ]);
  }

  return { origin: url.origin, host: url.host };
}

function envValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export interface ResolveConfigOptions {
  /** `--site` override. */
  site?: string;
  /** `--account` selector. */
  account?: string;
  env?: NodeJS.ProcessEnv;
}

function missingCredentials(detail: string, env: NodeJS.ProcessEnv): AxiError {
  return new AxiError(detail, "AUTH_ERROR", [
    `${BIN} auth login --site <site> --email <you@example.com> --token <api-token>`,
    "Or set JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN",
    `Create an API token at ${API_TOKEN_URL}`,
    `Config file: ${configPath(env)}`,
  ]);
}

/**
 * Resolve which site and credentials a command should use.
 *
 * Precedence: explicit `--account` > environment variables > the config file's
 * default account. `--site` overlays whichever of those wins, so an agent can
 * retarget a site without duplicating credentials.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const file = readConfigFile(env);
  const accounts = file.accounts ?? {};

  if (options.account) {
    const account = accounts[options.account];
    if (!account) {
      const known = Object.keys(accounts);
      throw new AxiError(`unknown account \`${options.account}\``, "VALIDATION_ERROR", [
        known.length > 0
          ? `known accounts: ${known.join(", ")}`
          : `no accounts configured yet in ${configPath(env)}`,
        `${BIN} auth login --account ${options.account} --site <site> --email <email> --token <token>`,
      ]);
    }
    return finalize(account, `account:${options.account}`, options.site);
  }

  const envSite = envValue(env, ["JIRA_SITE", "JIRA_BASE_URL", "JIRA_URL"]);
  const envEmail = envValue(env, ["JIRA_EMAIL", "JIRA_USER_EMAIL"]);
  const envToken = envValue(env, ["JIRA_API_TOKEN", "JIRA_TOKEN"]);

  if (envEmail && envToken && (envSite || options.site)) {
    return finalize(
      { site: (options.site ?? envSite) as string, email: envEmail, token: envToken },
      options.site ? "flag+env" : "env",
      undefined,
    );
  }

  const defaultName = file.default ?? Object.keys(accounts)[0];
  if (defaultName) {
    const account = accounts[defaultName];
    if (account) {
      return finalize(account, `account:${defaultName}`, options.site);
    }
  }

  // Partial environment configuration is a common and confusing failure, so name
  // the piece that is missing rather than reporting a generic "not configured".
  if (envSite || envEmail || envToken) {
    const missing = [
      envSite || options.site ? undefined : "JIRA_SITE",
      envEmail ? undefined : "JIRA_EMAIL",
      envToken ? undefined : "JIRA_API_TOKEN",
    ].filter((name): name is string => name !== undefined);
    throw missingCredentials(`incomplete Jira credentials: ${missing.join(", ")} not set`, env);
  }

  throw missingCredentials("no Jira credentials configured", env);
}

function finalize(
  account: Account,
  source: ResolvedConfig["source"],
  siteOverride: string | undefined,
): ResolvedConfig {
  const site = siteOverride ?? account.site;
  if (!site) {
    throw new AxiError("account has no site configured", "CONFIG_ERROR", [
      `${BIN} auth login --site <site> --email ${account.email} --token <token>`,
    ]);
  }
  if (!account.email || !account.token) {
    throw new AxiError("account is missing an email or API token", "CONFIG_ERROR", [
      `${BIN} auth login --site ${site} --email <email> --token <token>`,
    ]);
  }

  const { origin, host } = normalizeSite(site);
  return { site: origin, host, email: account.email, token: account.token, source };
}

/** True when credentials exist, without throwing. Used by the home view. */
export function hasCredentials(options: ResolveConfigOptions = {}): boolean {
  try {
    resolveConfig(options);
    return true;
  } catch {
    return false;
  }
}

export const AUTH_TOKEN_URL = API_TOKEN_URL;
