import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { BIN } from "./bin-name.js";
import type { Output, RunContext } from "./command.js";
import { AUTH_TOKEN_URL, configPath, resolveConfig } from "./config.js";
import { countLine, issueRow, statusLabel, suggest, userLabel } from "./format.js";
import { AUTH_NOTES, quickStartCommands } from "./guidance.js";
import { approximateCount, getIssue, getMyself, searchIssues } from "./jira.js";
import { buildJql, isIssueKey } from "./jql.js";

/**
 * The no-argument home view (principle 8: show live data, not a manual).
 *
 * This is also what the session-start hook injects into every agent
 * conversation, so it is deliberately small — a handful of assigned issues, the
 * issue named by the current git branch, and a few next steps. Deep data belongs
 * in explicit invocations.
 */

const HOME_LIMIT = 8;

/**
 * Read the current branch from `.git` without shelling out to git.
 *
 * A branch named `feature/ACME-42-timeout` is a strong signal about what the
 * agent is working on, and surfacing that issue costs one request.
 */
export function currentBranch(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);

  for (let depth = 0; depth < 64; depth += 1) {
    const gitPath = join(dir, ".git");
    let head: string | undefined;

    try {
      const stat = statSync(gitPath);
      if (stat.isDirectory()) {
        head = readFileSync(join(gitPath, "HEAD"), "utf-8");
      } else if (stat.isFile()) {
        // Worktree or submodule: `.git` is a file pointing at the real gitdir.
        const pointer = readFileSync(gitPath, "utf-8").trim();
        const match = /^gitdir:\s*(.+)$/.exec(pointer);
        if (match?.[1]) {
          const gitDir = isAbsolute(match[1]) ? match[1] : join(dir, match[1]);
          head = readFileSync(join(gitDir, "HEAD"), "utf-8");
        }
      }
    } catch {
      head = undefined;
    }

    if (head) {
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
      return ref?.[1]?.trim();
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}

/** Extract a Jira issue key from a branch name like `fix/ACME-42-timeout`. */
export function issueKeyFromBranch(branch: string | undefined): string | undefined {
  if (!branch) {
    return undefined;
  }
  // `(?![\d.])` keeps a dotted version out: `release-2.4.0` is a release branch,
  // not issue RELEASE-2. The `+` enforces Jira's two-character minimum key.
  const match = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_]+-\d+)(?![\d.])/.exec(branch);
  const candidate = match?.[1];
  return candidate && isIssueKey(candidate) ? candidate.toUpperCase() : undefined;
}

export async function homeView(context: RunContext): Promise<Output> {
  // Unconfigured is a normal first-run state, not a failure. The hook runs this
  // on every session, so it returns setup guidance and exits 0 rather than
  // printing an error into every conversation.
  try {
    resolveConfig();
  } catch {
    return {
      setup: "no Jira credentials configured",
      config_file: configPath(),
      help: [
        `${BIN} auth login --site <your-site> --email <you@example.com> --token <api-token>`,
        "Or set JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN",
        `Create an API token at ${AUTH_TOKEN_URL}`,
        ...AUTH_NOTES.slice(2),
      ],
    };
  }

  const config = context.config();
  const client = context.client();
  const branchKey = issueKeyFromBranch(currentBranch());

  const jql = buildJql({ assignee: "@me", state: "open", orderBy: "updated DESC" });
  const fields = ["summary", "status", "assignee", "updated", "issuetype", "priority"];

  const [me, assigned, total, branchIssue] = await Promise.all([
    getMyself(client).catch(() => undefined),
    searchIssues(client, jql, { fields, limit: HOME_LIMIT }).catch(() => undefined),
    approximateCount(client, jql),
    branchKey
      ? getIssue(client, branchKey, {
          fields: ["summary", "status", "assignee"],
        }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  const out: Output = { site: config.host };
  if (me) {
    out.user = me.emailAddress ? `${userLabel(me)} (${me.emailAddress})` : userLabel(me);
  }

  if (branchKey) {
    out.branch = branchIssue
      ? {
          key: branchIssue.key ?? branchKey,
          summary: branchIssue.fields?.summary ?? "",
          status: statusLabel(branchIssue.fields?.status),
          assignee: userLabel(branchIssue.fields?.assignee),
        }
      : `${branchKey} (named by the current git branch, but not readable on ${config.host})`;
  }

  if (!assigned) {
    out.assigned = "could not be read; the site may be unreachable";
    out.help = [`${BIN} auth status`, ...quickStartCommands().slice(1, 4)];
    return out;
  }

  if (assigned.issues.length === 0) {
    out.assigned = "0 open issues are assigned to you";
    out.help = [
      `${BIN} issue list -p <project>`,
      `${BIN} issue list -a @me --state all`,
      `${BIN} project list`,
    ];
    return out;
  }

  out.count = countLine(assigned.issues.length, total);
  out.assigned = assigned.issues.map((issue) => issueRow(issue, [], context.now));

  const help: string[] = [`${BIN} issue view ${assigned.issues[0]?.key ?? "<key>"}`];
  if (total !== undefined && total > assigned.issues.length) {
    help.push(suggest(`${BIN} issue list -a @me --limit ${Math.min(total, 100)}`, `for all ${total}`));
  }
  help.push(`${BIN} issue transition <key> --to "<status>"`);
  help.push(suggest(`${BIN} --help`, "for every command"));
  out.help = help;

  return out;
}
