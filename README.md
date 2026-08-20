<h1 align="center">jira-axi</h1>

<p align="center">Jira Cloud CLI for agents — designed with <a href="https://axi.md">AXI</a> (Agent eXperience Interface).</p>

Issues, sprints, boards, and projects over the shell, with token-efficient
[TOON](https://toonformat.dev/) output, contextual next-step suggestions, and
structured error handling. Built for autonomous agents that reach Jira through
shell execution rather than a tool protocol.

Jira Cloud only. Authentication is an Atlassian API token.

## Quick Start

Install the skill in the [Agent Skills](https://agentskills.io) format with
[`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add nocnokneo/jira-axi --skill jira-axi -g
```

That is the whole setup — no npm install needed. The skill teaches your agent to
run `npx -y jira-axi`, so the CLI comes along on demand. Then give it
credentials:

```sh
export JIRA_SITE=acme            # or acme.atlassian.net, or a full https URL
export JIRA_EMAIL=you@acme.com
export JIRA_API_TOKEN=<token>    # id.atlassian.com/manage-profile/security/api-tokens
```

`-g` installs the skill for all projects (`~/.claude/skills/`); drop it to
install for the current project only.

### Other ways to install

**Zero setup.** jira-axi is an AXI, so any capable agent can run it with nothing
installed. Just tell your agent:

```
Execute `npx -y jira-axi` to get Jira tools.
```

**Session hook.** To feed ambient Jira context — your open issues, plus the issue
named by the current git branch — into every agent session instead of loading on
demand, install globally and opt in:

```sh
npm install -g jira-axi
jira-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code** and **Codex**, and an
ambient-context plugin for **OpenCode**. Restart your agent session afterwards.
Repeat runs are no-ops. Use `jira-axi update --check` to see whether a newer
release exists.

The hook and the skill are two ways to reach the same place — install whichever
fits, or both.

## Authentication

Credentials resolve in this order:

1. `--account <name>` — a named account from the config file
2. `JIRA_SITE` / `JIRA_EMAIL` / `JIRA_API_TOKEN` in the environment
   (`JIRA_BASE_URL`, `JIRA_URL`, and `JIRA_TOKEN` are accepted as aliases)
3. the default account in `~/.config/jira-axi/config.json`

`--site` overlays whichever of those wins, so one stored credential can target
several sites.

To store credentials instead of exporting them:

```sh
jira-axi auth login --site acme --email you@acme.com --token <api-token>

# Keep the token out of the process argument list:
echo -n "<api-token>" | jira-axi auth login --site acme --email you@acme.com --token -
```

`auth login` verifies the credentials before saving, and writes the config file
with `0600` permissions. Manage accounts with `auth status`, `auth list`, and
`auth logout`.

## Usage

```bash
jira-axi                                   # dashboard - live state, no args needed
jira-axi issue list -p ACME                # open issues in a project
jira-axi issue list -a @me --state all     # everything assigned to you, open or closed
jira-axi issue list -p ACME --sprint current
jira-axi issue list --jql "labels = regression AND priority = High"
jira-axi issue view ACME-42                # detail, relationships, newest comments
jira-axi issue ACME-42                     # same thing - a bare key is a view
jira-axi issue view ACME-42 --full --comments 10
jira-axi issue create -p ACME -t Bug -s "Crash on save" --description-file report.md
jira-axi issue edit ACME-42 --add-label regression --priority High
jira-axi issue transition ACME-42 --to "In Progress"
jira-axi issue transitions ACME-42         # what statuses are reachable
jira-axi issue close ACME-42 --comment "Fixed in 2.4.0"
jira-axi issue assign ACME-42 --to @me
jira-axi issue comment ACME-42 --body "Reproduced on Safari 17.4"
cat notes.md | jira-axi issue comment ACME-42 --body-file -
jira-axi issue link ACME-42 --type blocks --to ACME-9
jira-axi issue worklog ACME-42 --time 90m --comment "Traced the timeout"
jira-axi search "project = ACME AND status = 'In Review'"
jira-axi search "labels = regression" --count
jira-axi project view ACME                 # issue types, statuses, open count
jira-axi board list -p ACME
jira-axi sprint list --board 12
jira-axi sprint view 34                    # progress and status breakdown
jira-axi sprint add 34 -i ACME-42 -i ACME-43
jira-axi user search "Alice Chen"
jira-axi field list -q "story points"      # find a custom field id
jira-axi api /rest/api/3/myself            # anything not wrapped above
jira-axi setup hooks
jira-axi update --check
```

### Commands

| Command   | Description                                                                          |
| --------- | ------------------------------------------------------------------------------------ |
| `issue`   | Issues — list, view, create, edit, transition, close, reopen, assign, comment, link, worklog |
| `search`  | Raw JQL search                                                                       |
| `project` | Projects — list, view issue types and workflow statuses                              |
| `board`   | Jira Software boards — list, view                                                    |
| `sprint`  | Sprints — list, view progress, add issues                                            |
| `user`    | Users — current account, search                                                      |
| `field`   | Fields — find the ids needed for custom field reads and writes                       |
| `api`     | Raw Jira Cloud REST access                                                           |
| `auth`    | Credentials — status, login, logout, list                                            |
| `setup`   | Install optional agent session hooks                                                 |
| `update`  | Built-in self-update, inherited from `axi-sdk-js`                                    |

Every subcommand has its own `--help` with flags, defaults, and examples:
`jira-axi issue list --help`.

### Global flags

- `--help` — show help for any command
- `-v`, `-V`, `--version` — print the installed version
- `--site <site>` — target a specific Jira Cloud site
- `--account <name>` — use a named account from the config file

## Behaviour worth knowing

**Output.** Everything on stdout is TOON. Errors go to stdout too, in the same
shape (`error`, `code`, `help`), so an agent can read and act on them. Exit codes
are `0` for success, `1` for an error, `2` for a usage error. stderr carries
nothing an agent needs.

**Defaults and filters.** `issue list` shows open issues
(`statusCategory != Done`); pass `--state all` or `--state closed` to widen it.
The `jql:` line in list output shows exactly what was queried, and `count:` is
Jira's approximate total for that query — which lags very recent writes, so a
total smaller than the page being shown is dropped in favour of `showing N`.

**List schemas are small on purpose.** A row is `key`, `summary`, `status`,
`assignee`. Add columns explicitly with `--fields type,priority,updated`, which
also accepts raw custom field ids (`--fields customfield_10016`).

**Truncation.** Long descriptions and comment bodies are truncated with the total
size reported and a `--full` suggestion — never omitted.

**Idempotent mutations.** Transitioning to the status an issue is already in,
editing a field to the value it already holds, assigning the current assignee,
adding a label that is already there, creating a link that already exists, or
logging out of an account that is not stored all report a no-op and exit 0.

**Unknown flags fail loudly.** An unrecognized flag is rejected by name, with the
valid flags for that subcommand listed inline so the correction takes one turn.
Renamed flags get a targeted hint (`--status was renamed; use --state instead`).
Nothing is silently ignored, and validation happens before any API call.

**Markdown in, Markdown out.** Jira Cloud's v3 API speaks Atlassian Document
Format. Descriptions and comments you write are parsed from a Markdown subset
(headings, fenced code, lists, quotes, rules, and inline bold/italic/code/links)
into ADF, and ADF you read is flattened back to Markdown-ish text. Multi-line
text can come from a file: `--description-file <path>` or `--body-file -` for
stdin.

**Users.** Jira Cloud hides email addresses unless a user made theirs public, so
an email often matches nothing. `--assignee` accepts `@me`, an account id, an
email, a display name, or `none`, and names are resolved to account ids before
they reach JQL. An ambiguous name is reported with the candidate account ids
rather than guessed. Jira returns user searches as a single page with no total,
so a page filled to `--limit` is reported as `N (more may match)` rather than
implying the list is complete.

**Custom fields.** Find an id with `jira-axi field list -q "story points"`, then
read it with `--fields <id>` or write it with `--field <id>=<value>`. Values that
parse as JSON are sent as JSON, so object-shaped fields work:
`--field customfield_10001='{"value":"Team A"}'`.

**Issue link direction.** Atlassian documents that `inwardIssue` and
`outwardIssue` carry no direction meaning at the API level — the semantics exist
only in the UI — and the primary sources conflict on which slot is the subject.
So `issue link` does not assert a direction it cannot verify: it matches
`--type` against each link type's name and both of its directional descriptions
(`blocks`, `is blocked by`), creates the link, then reads it back and reports the
relation Jira itself returns. If that differs from what you asked for, the output
says so instead of claiming success.

**Sprints and boards** live on Jira's separate Agile API and exist only for Jira
Software projects. Empty results say so rather than looking broken.

## Development

```sh
npm install
npm run build         # compile TypeScript to dist/
npm run dev -- issue list -p ACME
npm test              # builds first, then runs vitest (two tests exercise dist/)
npm run build:skill   # regenerate skills/jira-axi/SKILL.md
npm run check:skill   # fail if the committed skill is stale
```

`skills/jira-axi/SKILL.md` is generated from `src/guidance.ts` — the same module
that renders the top-level `--help` — so the skill cannot drift from what the CLI
prints. `npm test` fails if the committed copy is out of date.

The test suite runs the CLI against a stub Jira Cloud API over loopback HTTP
rather than mocking the client, so argument parsing, credential resolution,
error translation, and TOON encoding are all exercised end to end.

## License

MIT
