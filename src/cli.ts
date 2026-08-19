import { runAxiCli } from "axi-sdk-js";

import { makeContext, nounHandler, type Noun, type Renderable } from "./command.js";
import { apiNoun } from "./commands/api.js";
import { authNoun, setupNoun } from "./commands/auth.js";
import { boardNoun, sprintNoun } from "./commands/agile.js";
import { issueNoun } from "./commands/issue.js";
import { projectNoun } from "./commands/project.js";
import { searchNoun } from "./commands/search.js";
import { fieldNoun, userNoun } from "./commands/user.js";
import { DESCRIPTION, topLevelHelp } from "./guidance.js";
import { homeView } from "./home.js";
import { VERSION } from "./version.js";

const NOUNS: Noun[] = [
  issueNoun,
  searchNoun,
  projectNoun,
  boardNoun,
  sprintNoun,
  userNoun,
  fieldNoun,
  apiNoun,
  authNoun,
  setupNoun,
];

function buildCommands(now?: Date): Record<string, (args: string[]) => Promise<Renderable>> {
  const commands: Record<string, (args: string[]) => Promise<Renderable>> = {};
  for (const noun of NOUNS) {
    commands[noun.name] = nounHandler(noun, now);
  }
  return commands;
}

export interface RunOptions {
  stdout?: { write: (chunk: string) => unknown };
  /** Fixed clock, so relative ages in output are deterministic under test. */
  now?: Date;
}

/**
 * Entry point shared by `bin/jira-axi.ts` and the tests.
 *
 * `getCommandHelp` is deliberately not passed: the SDK would only ever see the
 * top-level command name, and this CLI wants help scoped to the *subcommand*
 * (principle 10), which each noun handler resolves for itself.
 */
export async function run(argv: string[], options: RunOptions = {}): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: topLevelHelp(),
    commands: buildCommands(options.now),
    home: async () => homeView(makeContext({ flags: {}, positionals: [] }, options.now)),
    ...(options.stdout ? { stdout: options.stdout } : {}),
  });
}

export async function main(): Promise<void> {
  await run(process.argv.slice(2));
}
