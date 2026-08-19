import { AxiError, installSessionStartHooks } from "axi-sdk-js";

import { BIN } from "../bin-name.js";
import { JiraClient } from "../client.js";
import type { Noun, Output, Subcommand } from "../command.js";
import {
  AUTH_TOKEN_URL,
  configPath,
  normalizeSite,
  readConfigFile,
  resolveConfig,
  writeConfigFile,
  type ConfigFile,
} from "../config.js";
import { userLabel } from "../format.js";
import { bool, requireStr, str } from "../flags.js";
import { getMyself } from "../jira.js";
import { readStdinSync } from "../input.js";

const statusSubcommand: Subcommand = {
  name: "status",
  summary: "Show which site and account are in use, and verify the credentials",
  args: "[flags]",
  flags: {},
  examples: [`${BIN} auth status`, `${BIN} auth status --account work`],
  async run(_parsed, context) {
    const config = context.config();
    const out: Output = {
      auth: {
        site: config.host,
        email: config.email,
        source: config.source,
        config_file: configPath(),
      },
    };

    // Reaching /myself is the only way to know the token still works, and a
    // credential command that does not verify is worse than useless.
    try {
      const me = await getMyself(new JiraClient(config));
      (out.auth as Output).status = "ok";
      (out.auth as Output).user = userLabel(me);
      (out.auth as Output).account_id = me.accountId ?? "unknown";
    } catch (error) {
      (out.auth as Output).status = "failed";
      (out.auth as Output).detail = error instanceof Error ? error.message : String(error);
      out.help = [
        `${BIN} auth login --site ${config.host} --email ${config.email} --token <api-token>`,
        `Create an API token at ${AUTH_TOKEN_URL}`,
      ];
      return out;
    }

    const accounts = Object.keys(readConfigFile().accounts ?? {});
    if (accounts.length > 1) {
      (out.auth as Output).accounts = accounts.join(", ");
    }

    out.help = [`${BIN} issue list -a @me`, `${BIN} project list`];
    return out;
  },
};

const loginSubcommand: Subcommand = {
  name: "login",
  summary: "Store credentials for a Jira Cloud site",
  args: "--site <site> --email <email> --token <token>",
  flags: {
    email: { type: "string", placeholder: "<email>", describe: "Atlassian account email (required)" },
    token: {
      type: "string",
      placeholder: "<token>",
      describe: "API token, or `-` to read it from stdin (required)",
    },
    name: {
      type: "string",
      placeholder: "<name>",
      describe: "Save under this account name instead of the site host",
    },
    default: { type: "boolean", describe: "Make this the default account" },
    "skip-verify": { type: "boolean", describe: "Save without checking the credentials first" },
  },
  notes: [
    "`--token -` reads the token from stdin, keeping it out of the process argument list",
    "Credentials are written with 0600 permissions",
    "`--site` is the standard global flag and is required here",
  ],
  examples: [
    `${BIN} auth login --site acme --email you@acme.com --token <api-token>`,
    `echo -n "<api-token>" | ${BIN} auth login --site acme --email you@acme.com --token -`,
    `${BIN} auth login --site other --email you@other.com --token <t> --name other --default`,
  ],
  async run(parsed) {
    const site = requireStr(parsed, "site", "auth login");
    const email = requireStr(parsed, "email", "auth login");
    const tokenFlag = requireStr(parsed, "token", "auth login");
    const token = tokenFlag === "-" ? readStdinSync().trim() : tokenFlag;

    if (token.length === 0) {
      throw new AxiError("the API token is empty", "VALIDATION_ERROR", [
        `Create an API token at ${AUTH_TOKEN_URL}`,
      ]);
    }

    const { origin, host } = normalizeSite(site);
    const name = str(parsed, "name") ?? host;

    const account = { site: origin, email, token };

    if (!bool(parsed, "skip-verify")) {
      const client = new JiraClient({ ...account, host, source: "env" });
      const me = await getMyself(client);
      if (!me.accountId) {
        throw new AxiError(`${host} accepted the credentials but returned no account`, "AUTH_ERROR", [
          "Check that the site is a Jira Cloud site",
        ]);
      }
    }

    const config: ConfigFile = readConfigFile();
    const accounts = { ...(config.accounts ?? {}), [name]: account };
    const makeDefault = bool(parsed, "default") || config.default === undefined;
    const next: ConfigFile = {
      ...config,
      accounts,
      default: makeDefault ? name : config.default,
    };
    const path = writeConfigFile(next);

    return {
      login: {
        account: name,
        site: host,
        email,
        default: next.default === name,
        config_file: path,
        verified: !bool(parsed, "skip-verify"),
      },
      help: [`${BIN} auth status`, `${BIN} issue list -a @me`],
    };
  },
};

const logoutSubcommand: Subcommand = {
  name: "logout",
  summary: "Remove a stored account",
  args: "[flags]",
  flags: {
    name: { type: "string", placeholder: "<name>", describe: "Account to remove; defaults to the default account" },
  },
  notes: ["Reports a no-op and exits 0 when the account is not stored"],
  examples: [`${BIN} auth logout`, `${BIN} auth logout --name other`],
  async run(parsed) {
    const config = readConfigFile();
    const accounts = { ...(config.accounts ?? {}) };
    const name = str(parsed, "name") ?? config.default ?? Object.keys(accounts)[0];

    if (!name || !accounts[name]) {
      return {
        logout: name ? `account \`${name}\` is not stored (no-op)` : "no accounts are stored (no-op)",
        config_file: configPath(),
        help: [`${BIN} auth login --site <site> --email <email> --token <token>`],
      };
    }

    delete accounts[name];
    const remaining = Object.keys(accounts);
    const next: ConfigFile = {
      accounts,
      default: config.default === name ? remaining[0] : config.default,
    };
    writeConfigFile(next);

    return {
      logout: { removed: name, remaining: remaining.length > 0 ? remaining.join(", ") : "none" },
      help:
        remaining.length > 0
          ? [`${BIN} auth status`]
          : [`${BIN} auth login --site <site> --email <email> --token <token>`],
    };
  },
};

const listSubcommand: Subcommand = {
  name: "list",
  summary: "List stored accounts",
  args: "",
  flags: {},
  examples: [`${BIN} auth list`],
  async run() {
    const config = readConfigFile();
    const accounts = config.accounts ?? {};
    const names = Object.keys(accounts);

    if (names.length === 0) {
      return {
        accounts: "0 accounts stored",
        config_file: configPath(),
        help: [
          `${BIN} auth login --site <site> --email <email> --token <token>`,
          "Or set JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN",
        ],
      };
    }

    return {
      config_file: configPath(),
      accounts: names.map((name) => ({
        name,
        site: normalizeSite(accounts[name]?.site ?? "").host,
        email: accounts[name]?.email ?? "unknown",
        default: config.default === name,
      })),
      help: [`${BIN} auth status --account ${names[0]}`],
    };
  },
};

export const authNoun: Noun = {
  name: "auth",
  summary: "Credentials — check, store, list, and remove Jira Cloud accounts",
  default: "status",
  subcommands: [statusSubcommand, loginSubcommand, logoutSubcommand, listSubcommand],
};

/* ------------------------------------------------------------------ */
/* setup                                                              */
/* ------------------------------------------------------------------ */

const hooksSubcommand: Subcommand = {
  name: "hooks",
  summary: "Install session-start hooks so agents see your Jira state automatically",
  args: "",
  flags: {},
  notes: [
    "Installs a SessionStart hook for Claude Code and Codex, and an ambient-context plugin for OpenCode",
    "Repeating the install is a no-op; restart your agent session afterwards",
  ],
  examples: [`${BIN} setup hooks`],
  async run() {
    const problems: string[] = [];
    installSessionStartHooks({
      marker: "jira-axi",
      binaryNames: ["jira-axi"],
      onError: (message) => problems.push(message),
    });

    const out: Output = {
      setup: "session-start hooks installed or already up to date",
      apps: "Claude Code, Codex, OpenCode",
    };
    if (problems.length > 0) {
      out.warnings = problems;
    }

    // The hook only produces useful context once credentials exist.
    let configured = true;
    try {
      resolveConfig();
    } catch {
      configured = false;
    }

    out.help = configured
      ? ["Restart your agent session so the hook takes effect"]
      : [
          `${BIN} auth login --site <site> --email <email> --token <token>`,
          "Restart your agent session so the hook takes effect",
        ];

    return out;
  },
};

export const setupNoun: Noun = {
  name: "setup",
  summary: "Install optional agent session integrations",
  default: "hooks",
  subcommands: [hooksSubcommand],
};
