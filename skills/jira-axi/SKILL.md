---
name: jira-axi
description: >
  Read and write Jira Cloud issues, sprints, boards, and projects from the shell — list and search issues with JQL, create and edit them, move them through workflow statuses, comment, assign, link, and log time. Use whenever a task involves Jira issues, tickets, epics, sprints, or an issue key like ACME-123.
---

# jira-axi

Jira Cloud issues, sprints, and projects for the current account. Output is [TOON](https://toonformat.dev/), not JSON.

Run it with `npx -y jira-axi` — no install needed.

## Setup

Credentials come from the environment or from `npx -y jira-axi auth login`:

- Set JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN, or run `npx -y jira-axi auth login`
- JIRA_SITE accepts `acme`, `acme.atlassian.net`, or a full https URL
- Only Jira Cloud is supported; authentication is an Atlassian API token, not a password

Check the current account with `npx -y jira-axi auth status`.

## Commands

| Command | Description |
| --- | --- |
| `issue` | Issues — list, view, create, edit, transition, assign, comment, link, log time |
| `search` | Search issues with raw JQL |
| `project` | Projects — list and inspect issue types, statuses, and activity |
| `board` | Boards — list and inspect Jira Software boards |
| `sprint` | Sprints — list, inspect progress, and move issues in |
| `user` | Users — show the current account and look up others |
| `field` | Fields — find the ids needed for custom field reads and writes |
| `api` | Raw Jira Cloud REST access |
| `auth` | Credentials — check, store, list, and remove accounts |
| `setup` | Install optional agent session integrations |
| `update` | Upgrade jira-axi to the latest published version |

Every subcommand has its own `--help` with flags, defaults, and examples —
for example `npx -y jira-axi issue list --help`.

## Global flags

| Flag | Description |
| --- | --- |
| `--help` | Show help for any command |
| `-v, -V, --version` | Print the installed jira-axi version |
| `--site <site>` | Target a specific Jira Cloud site |
| `--account <name>` | Use a named account from the config file |

## Common tasks

- your open issues: `npx -y jira-axi`
- open issues in a project: `npx -y jira-axi issue list -p ACME`
- everything assigned to you: `npx -y jira-axi issue list -a @me --state all`
- detail, relationships, comments: `npx -y jira-axi issue view ACME-42`
- create an issue: `npx -y jira-axi issue create -p ACME -s "<summary>"`
- change status: `npx -y jira-axi issue transition ACME-42 --to "In Progress"`
- comment: `npx -y jira-axi issue comment ACME-42 --body "..."`
- reassign: `npx -y jira-axi issue assign ACME-42 --to @me`
- raw JQL: `npx -y jira-axi search "project = ACME AND labels = regression"`
- sprint progress: `npx -y jira-axi sprint list --board 12`

## Behaviour worth knowing

- Output is TOON. Errors go to stdout in the same shape; exit 0 = success, 1 = error, 2 = usage error
- Mutations are idempotent: transitioning to the current status, or an edit that changes nothing, reports a no-op and exits 0
- Long text is truncated with a size hint; pass --full to see all of it
- Unknown flags are rejected rather than ignored, and the error lists the valid flags for that subcommand
- Run `npx -y jira-axi <command> --help` for one command's flags and examples
- `issue list` defaults to open issues; pass `--state all` for closed ones too.
- `issue view` includes the available workflow transitions, so no extra call is
  needed before `issue transition`.
- Descriptions and comments accept Markdown and are converted to Atlassian
  Document Format; multi-line text can come from a file with
  `--description-file <path>` or `--body-file -` for stdin.
- Custom fields are reachable by id: find one with `npx -y jira-axi field list -q "<name>"`,
  then read it with `--fields <id>` or write it with `--field <id>=<value>`.
