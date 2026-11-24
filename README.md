# Codeflow

Codeflow is a Claude Code plugin that shows where your tokens and money go. It measures every turn, keeps a 30-day record of spend by project, day, model and agent (subagents included), and can optionally trim large read and search results before they reach the context.

It works in normal sessions and alongside the [native Code Mode](https://code.claude.com/docs/en/code-mode). It never changes a permission decision.

## What you get

- A one-line summary under each response: duration, requests, tool calls, tokens and context use.
- `/codeflow spend`: tokens and cost by project, day, model or agent for the last 30 days.
- `/codeflow report`: totals for the current session, and for a group of sessions when you set a run ID.
- An opt-in active mode that shortens long `Read`, `Grep` and `Glob` results.

## Install

Inside Claude Code:

```text
/plugin install codeflow --marketplace flaviomartil/codeflow
```

Or from a shell:

```bash
claude plugin marketplace add flaviomartil/codeflow
claude plugin install codeflow@codeflow
```

To update later:

```bash
claude plugin marketplace update codeflow
claude plugin update codeflow@codeflow
```

Restart open sessions after installing or updating. A running session keeps the version it started with.

## Quick start

Install it and keep working. Codeflow starts in **passive mode**, which only measures. Each response ends with a line like this:

```text
Codeflow · 968.077 s · 45 request(s) · 44 call(s) · total input 9,980,142 · new input 92 · cache read 9,734,921 · cache created 245,129 · output 22,923 · context 24%
```

`total input` is new input plus cache read plus cache created. A high `cache created` figure means the prompt cache was rebuilt, which costs more than a cache read.

After a few sessions, ask where the spend went:

```text
/codeflow spend
```

## See where the spend goes

```text
/codeflow spend [project|day|model|agent] [days]
```

Both arguments are optional and can come in either order. The default is `project` over the last 7 days. The maximum is 30 days.

| Example | Shows |
| --- | --- |
| `/codeflow spend` | Each project, last 7 days |
| `/codeflow spend day 30` | Each day of the last 30 |
| `/codeflow spend model` | Each model |
| `/codeflow spend agent 1` | The main loop and each subagent type, today |

Example, by agent:

```text
Codeflow spend · last 1 day(s) · by agent
main · 12 request(s) · total input 570,079 · new input 24 · cache read 420,775 · cache created 149,280 · output 1,271 · 83.4% of tokens
Explore · 6 request(s) · total input 111,841 · new input 12 · cache read 71,953 · cache created 39,876 · output 1,763 · 16.6% of tokens
Total · 4 session(s) · 18 request(s) · total input 681,920 · new input 36 · cache read 492,728 · cache created 189,156 · output 3,034 · 100% of tokens · USD 0.0413
```

How to read it:

- **Agent** is `main` for the main loop and the subagent type for everything else, such as `Explore` or a plugin's agent name. A subagent whose type cannot be found is listed as `subagent`.
- **Model** is the model that answered the request.
- **Project** is the session's project root.
- **Day** is the local day on which the turn started.
- **USD** appears in the project and day views and in the total. Claude Code reports cost per session, so the model and agent views show tokens and their share of the total instead of a price. The session cost also covers requests that are not part of a turn, such as compaction and titles.
- **Sessions** are counted once each, even when a session spans two days.

### What the ledger stores

The ledger lives in the plugin's local store. Nothing is sent anywhere.

For each session and local day it keeps the absolute project path, the session id, the model ids, the subagent types, the token totals and the session cost in USD. It stores no prompt text, no file content and no tool output.

Once a day is older than yesterday, its sessions are folded into one entry per project, which keeps the totals and the ids of the folded sessions. Entries older than 30 days are deleted.

To turn the ledger off, set the `spendLedger` option to off in the plugin configuration. Entries already stored stay until the ledger is on again, and then they age out.

## Session report

`/codeflow report` shows the current session: requests, tool calls, tokens, time per turn, context use and the estimated session cost when Claude Code provides it.

To include other sessions, group them under a run ID:

```bash
export CLAUDE_CODEFLOW_RUN=daily
```

Or set it for Claude Code only, in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODEFLOW_RUN": "daily" } }
```

The report then adds the sessions that ended in the last 24 hours under that ID, split by mode. This is the basis of the [A/B procedure](docs/hybrid-ab-test.md).

## Active mode

Active mode is off by default. Turn it on for one session:

```bash
CLAUDE_CODEFLOW_ENABLED=1 claude
```

Or for every session, in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODEFLOW_ENABLED": "1" } }
```

In active mode Codeflow does two things:

- It adds a short section to the prompt that asks for targeted searches and tells the model that long results may be shortened.
- It shortens eligible `Read`, `Grep` and `Glob` results in the context to the limits set in the options. The tool still receives the full output, and a marker says how much was cut and how to read the rest.

The variable is read at startup. A missing value, `0` or an invalid value keeps passive mode. Measurement is the same in both modes.

## Commands

| Command | Result |
| --- | --- |
| `/codeflow` | Version and current mode |
| `/codeflow spend [project\|day\|model\|agent] [days]` | Tokens and cost from the spend ledger |
| `/codeflow report` | Session totals, plus grouped sessions when a run ID is set |
| `/codeflow thinking` | Reasoning block and word counts for the last turn. Needs the `thinking` option |
| `/codeflow stash <name> <text>` | Keeps a piece of text in session memory for 30 minutes. Active mode only |
| `/codeflow recall <name>` | Shows a stashed value |
| `/codeflow forget <name>` | Removes a stashed value |

The stash holds up to 20 entries of up to 2,000 characters each and is cleared when the session ends. Text typed in a command may appear in the Claude session history.

## Options

Set these in the plugin configuration.

| Option | Default | Effect |
| --- | --- | --- |
| `spendLedger` | On | Keeps the spend ledger described above |
| `turnSummary` | On | Shows the summary line under each response |
| `maxFileLines` | 200 | Lines of a read file kept in the context, in active mode |
| `maxToolResultChars` | 2,000 | Characters of a tool result kept in the context, in active mode. Values below 64 use the default |
| `maxListItems` | 20 | Lines of a search result kept in the context, in active mode |
| `thinking` | Off | Counts reasoning blocks and words. It never copies the text |
| `sessionLog` | Off | Writes a numeric summary to `.codeflow/session-<id>.ndjson` in the project on exit. Add `.codeflow/` to the project's `.gitignore` |

## What is stored, in short

| Data | Where | When |
| --- | --- | --- |
| Turn telemetry | Memory | Always, until the session ends |
| Spend ledger | Local plugin store, 30 days | Unless `spendLedger` is off |
| Session registry for reports | Local plugin store, 24 hours, 50 sessions | Only with `CLAUDE_CODEFLOW_RUN` set |
| Session summary file | `.codeflow/` in the project | Only with `sessionLog` on |

All of it is numeric telemetry plus the identifiers listed under "What the ledger stores". Fields that Claude Code does not provide are shown as unavailable.

## Compare with and without Codeflow

[Lab Switch](https://github.com/flaviomartil/lab-switch) runs two Claude Code terminals side by side, one with Codeflow and one without, and compares the same prompt on both. There is an [example scenario](docs/landing-page-scenario.md).

## Develop

Load a local checkout without installing it:

```bash
claude --plugin-dir ./codeflow
```

Validate and test:

```bash
claude plugin validate .
claude plugin test .
```

The tests use the simulated Claude Code environment.

## License

MIT
