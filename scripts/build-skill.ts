/**
 * Generate `skills/jira-axi/SKILL.md` from the CLI's own guidance module.
 *
 * AXI principle 7 asks for the skill to come from the same source as the
 * no-args home view so the two cannot drift. `--check` re-renders and compares,
 * which is what `pnpm test` runs to fail on a stale commit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_NOTES,
  COMMANDS,
  DESCRIPTION,
  GLOBAL_FLAG_HELP,
  NOTES,
  QUICK_START,
} from "../src/guidance.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(ROOT, "skills", "jira-axi", "SKILL.md");

/**
 * A skill may be installed without the binary on PATH, so every example runs
 * through `npx -y` (principle 7: non-interactive commands).
 */
const NPX = "npx -y jira-axi";

function toNpx(command: string): string {
  return command.replace(/^jira-axi/, NPX);
}

function table(rows: Array<[string, string]>, headers: [string, string]): string {
  const lines = [
    `| ${headers[0]} | ${headers[1]} |`,
    "| --- | --- |",
    ...rows.map(([left, right]) => `| \`${left}\` | ${right} |`),
  ];
  return lines.join("\n");
}

function render(): string {
  const description = [
    "Read and write Jira Cloud issues, sprints, boards, and projects from the shell —",
    "list and search issues with JQL, create and edit them, move them through workflow",
    "statuses, comment, assign, link, and log time. Use whenever a task involves Jira",
    "issues, tickets, epics, sprints, or an issue key like ACME-123.",
  ].join(" ");

  return `---
name: jira-axi
description: >
  ${description}
---

# jira-axi

${DESCRIPTION}. Output is [TOON](https://toonformat.dev/), not JSON.

Run it with \`${NPX}\` — no install needed.

## Setup

Credentials come from the environment or from \`${NPX} auth login\`:

${AUTH_NOTES.map((note) => `- ${note.replace(/`jira-axi/g, `\`${NPX}`)}`).join("\n")}

Check the current account with \`${NPX} auth status\`.

## Commands

${table(COMMANDS, ["Command", "Description"])}

Every subcommand has its own \`--help\` with flags, defaults, and examples —
for example \`${NPX} issue list --help\`.

## Global flags

${table(GLOBAL_FLAG_HELP, ["Flag", "Description"])}

## Common tasks

${QUICK_START.map(([intent, command]) => `- ${intent}: \`${toNpx(command)}\``).join("\n")}

## Behaviour worth knowing

${NOTES.map((note) => `- ${note.replace(/`jira-axi/g, `\`${NPX}`)}`).join("\n")}
- \`issue list\` defaults to open issues; pass \`--state all\` for closed ones too.
- \`issue view\` includes the available workflow transitions, so no extra call is
  needed before \`issue transition\`.
- Descriptions and comments accept Markdown and are converted to Atlassian
  Document Format; multi-line text can come from a file with
  \`--description-file <path>\` or \`--body-file -\` for stdin.
- Custom fields are reachable by id: find one with \`${NPX} field list -q "<name>"\`,
  then read it with \`--fields <id>\` or write it with \`--field <id>=<value>\`.
`;
}

function main(): void {
  const rendered = render();
  const check = process.argv.includes("--check");

  if (check) {
    let existing: string;
    try {
      existing = readFileSync(SKILL_PATH, "utf-8");
    } catch {
      console.error(`missing ${SKILL_PATH}; run \`npm run build:skill\``);
      process.exitCode = 1;
      return;
    }
    if (existing !== rendered) {
      console.error(`${SKILL_PATH} is stale; run \`npm run build:skill\``);
      process.exitCode = 1;
      return;
    }
    console.log("skill is up to date");
    return;
  }

  mkdirSync(dirname(SKILL_PATH), { recursive: true });
  writeFileSync(SKILL_PATH, rendered, "utf-8");
  console.log(`wrote ${SKILL_PATH}`);
}

main();

export { render as renderSkill, SKILL_PATH };
