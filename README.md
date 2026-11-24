# Codeflow

Codeflow is a Claude Code plugin that shows where your tokens and money go. It measures every turn, keeps a 30-day record of spend by project, day, model, agent and tag (subagents included), and can optionally trim large read and search results before they reach the context.

It works in normal sessions and alongside the [native Code Mode](https://code.claude.com/docs/en/code-mode). It never changes a permission decision.

## What you get

- A one-line summary under each response: duration, requests, tool calls, tokens and context use.
- `/codeflow spend`: tokens and cost by project, day, model, agent or tag for the last 30 days.
- `/codeflow why`: today's spend, its share of your plan window, and what the context and subagents weighed.
- `/codeflow compare`: sessions side by side, to see whether a layer such as a proxy or compression changes the cost per request.
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
Codeflow · 968.077 s · 45 request(s) · 44 call(s) · total input 9,980,142 · new input 92 · cache read 9,734,921 · cache created 245,129 · output 22,923 · turn USD 0.4213 · cache rebuilt 120,000 tok ≈ USD 0.72 write cost · context 24%
```

The line above is an example. `total input` is new input plus cache read plus cache created. A high `cache created` figure means the prompt cache was rebuilt, which costs more than a cache read. `turn USD` is the change in the session cost over the turn, so it includes background agents and side requests that ran meanwhile; it appears only when the turn cost something. `cache rebuilt` appears when the main loop wrote a large part of the prompt to the cache again instead of reading it. It usually happens when the cache expired after a pause, or when something changed the start of the prompt, such as a plugin or MCP server reloading.

After a few sessions, ask where the spend went:

```text
/codeflow spend
```

## See where the spend goes

```text
/codeflow spend [project|day|model|agent|tag] [days]
```

Both arguments are optional and can come in either order. The default is `project` over the last 7 days. The maximum is 30 days.

| Example | Shows |
| --- | --- |
| `/codeflow spend` | Each project, last 7 days |
| `/codeflow spend day 30` | Each day of the last 30 |
| `/codeflow spend model` | Each model |
| `/codeflow spend agent 1` | The main loop and each subagent type, today |
| `/codeflow spend tag` | Each tag set with `CLAUDE_CODEFLOW_TAG`, last 7 days |

Example, by agent:

```text
Codeflow spend · last 1 day(s) · by agent
main · 20 request(s) · total input 997,529 · new input 40 · cache read 723,531 · cache created 273,958 · output 1,755 · 76.3% of tokens · ≈ USD 0.0584
Explore · 14 request(s) · total input 306,403 · new input 28 · cache read 214,884 · cache created 91,491 · output 3,238 · 23.7% of tokens · ≈ USD 0.0197
Total · 7 session(s) · 34 request(s) · total input 1,303,932 · new input 68 · cache read 938,415 · cache created 365,449 · output 4,993 · 100% of tokens · USD 0.0781
```

How to read it:

- **Agent** is `main` for the main loop and the subagent type for everything else, such as `Explore` or a plugin's agent name. A subagent whose type cannot be found is listed as `subagent`.
- **Model** is the model that answered the request. When the response names a different model, that one is used.
- **Project** is the session's project root.
- **Day** is the local day on which the turn started. A request is dated by the local day its turn started.
- **Tag** is the value of `CLAUDE_CODEFLOW_TAG` when the session started. Sessions without a tag are listed as `untagged`.
- **USD** is the real session cost from Claude Code: its list-price cost for the session, an API-price equivalent. On a subscription it is not a bill. It appears in the project, day, tag and total lines. The session cost also covers requests that are not part of a turn, such as compaction and titles, so it is not a per-row price.
- **≈ USD** is an estimate for the model and agent rows, and for any row when Claude Code reports no cost. It splits the session cost by the list-price weight of each row's tokens. List prices are a table inside the plugin and can lag behind Anthropic's current prices.
- **Sessions** are counted once each, even when a session spans two days.
- **Startup context** (in `/codeflow compare`) is the size of the first request of a new session.

### What the ledger stores

The ledger lives in the plugin's local store. Nothing is sent anywhere.

For each session and local day it keeps the absolute project path, the session id, the model ids, the subagent types, the token totals, the session cost in USD, the estimated list-price cost, the optional tag from `CLAUDE_CODEFLOW_TAG`, the size of the first request of a new session (startup context), the plan window percentages and the context mix. It stores no prompt text, no file content and no tool output.

Once a day is older than yesterday, its sessions are folded into one entry per project and tag, which keeps the totals, the estimates, the startup sizes, the plan window percentages, the context mix and the ids of the folded sessions. Entries older than 30 days are deleted.

It also keeps, per day and session, the count, tokens and estimated cost of cache rebuilds in the main loop, which the summary line and `/codeflow why` report.

For `/codeflow why` it also keeps, per project, one snapshot of the fixed context: the largest memory file paths, the loaded MCP server names with their token counts, and the skills and agents totals. Each new snapshot replaces the previous one for that project, and snapshots older than 30 days are deleted.

To turn the ledger off, set the `spendLedger` option to off in the plugin configuration. Entries already stored stay until the ledger is on again, and then they age out.

## Why did I spend this

```text
/codeflow why [days]
```

The default is today. The day count goes up to 30. The command answers in one block, and a line is left out when it has nothing to say:

```text
Codeflow why · last 1 day(s)
Spent USD 0.0933 · plan share not measured yet · 7-day window at 3%
By agent: main 76% (≈ USD 0.0713) · Explore 24% (≈ USD 0.0221)
Main-loop context: Messages 43% · Skills 17% · Memory files 12% · System prompt 9% · MCP server instructions 9% · Custom agents 5% · MCP tools 4% · System tools 1% (share of main-loop input tokens)
Delegation: subagents ≈ USD 0.0221 (24% of spend); the same tokens on claude-haiku-5-5 ≈ USD 0.0221
```

- **Spent** is the session cost summed over the window. It shows `≈` when Claude Code reports no cost for the entries.
- **Plan share** converts the spend into a share of your 7-day plan window. The rate comes from this machine's own sessions: Codeflow records the window's usage percentage on each session and divides the change by the cost. It appears once the plan window has moved at least one point while sessions were being recorded, and it says so until then. Usage from other devices moves the plan percentage but not the recorded USD, so the share is approximate. A window whose reset time has passed is not used.
- **7-day window** and **5-hour window** show the latest percentage Claude Code reported for a window that has not reset yet. The 5-hour line appears only when Claude Code reports that window.
- **By agent** splits the estimated cost across the main loop and each subagent type. Each row's share is its list-price weight of the session's tokens.
- **Main-loop context** shows which parts of the context the main loop's input tokens went to, as `/context` estimates them. It is the share of input tokens, not a price per item.
- **Cache rebuilds** appears only when the window has any. It counts the main-loop requests that wrote at least 50,000 tokens to the cache while the cache read fell below half the previous request's prompt, with the new prompt at least half that size. A prompt that shrank, as after `/clear` or compaction, is not counted, and neither is a large new tool result, which keeps the cache read near the previous prompt. The first request of a fresh session is not counted. The estimate, shown as write cost, uses the 1-hour cache write price and the same share of the session cost as the other estimates. The usual causes are a cache that expired after a pause, or a change at the start of the prompt such as a plugin or MCP server reloading.
- **Largest fixed items** come from the snapshot of the highest-spend project in the window that has one. It lists the largest memory files, loaded MCP servers, the skills listing, custom agents and the system prompt and tools, then the fixed context each request carries before any message.
- **Delegation** reprices the subagents' tokens at the main model's list prices, with their cache writes at the main model's 1-hour rate. It is an indication, not a bound: another model would not use the same number of tokens, and the main loop's context would grow with that work.

The context mix and the fixed items are estimates from a snapshot taken at most every five minutes, at the end of a turn. Nothing here is sent anywhere; the snapshot includes memory file paths and MCP server names, so it stays on this machine with the rest of the ledger.

## Ask the agent

Codeflow adds a tool the agent can call: `mcp__codeflow__spend_report`. It is read-only and deferred, so it costs no context until the agent uses it. Ask in plain language, for example:

- "Was delegating to subagents worth it today?"
- "What did this project cost this week, and how much of the plan did it use?"

The agent picks the report (`why`, `spend` or `compare`) and, when it needs them, a dimension and a number of days.

The tool answers only when your permission rules allow `mcp__codeflow__spend_report`. Before it answers, Codeflow asks Claude Code's permission decision for that call. A deny rule is honoured: the agent gets the refusal and no report. Where the decision is to ask, the tool refuses with a message that says it needs permission, because Codeflow cannot hand that question to Claude Code's dialog for a tool it answers itself. To use the tool, allow it in your Claude Code permission settings, for example by adding `mcp__codeflow__spend_report` to the allow list. Codeflow never changes a permission decision itself. USD in the answers is Claude Code's list-price cost, not a subscription bill.

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
| `/codeflow spend [project\|day\|model\|agent\|tag] [days]` | Tokens and cost from the spend ledger |
| `/codeflow compare [project\|day\|model\|agent\|tag] [days]` | Sessions side by side: prompt size, cache hit, output and startup context per request, and cost per request. Defaults: `tag`, 7 days |
| `/codeflow why [days]` | Today's spend, its share of the plan window, and what the context and the delegation weighed. Defaults to 1 day |
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
| Spend ledger | Local plugin store, 30 days. Includes tag, estimated cost, startup size, plan window percentages and context mix | Unless `spendLedger` is off |
| Fixed-context snapshot | Local plugin store, one per project, 30 days. Memory file paths, MCP server names, token counts | With `spendLedger` on, at most every five minutes |
| Session registry for reports | Local plugin store, 24 hours, 50 sessions | Only with `CLAUDE_CODEFLOW_RUN` set |
| Session summary file | `.codeflow/` in the project | Only with `sessionLog` on |

All of it is numeric telemetry plus the identifiers listed under "What the ledger stores". Fields that Claude Code does not provide are shown as unavailable.

## Compare with and without a layer

To compare a layer such as a proxy, a compression tool or a memory system, tag the sessions that run with it:

```bash
CLAUDE_CODEFLOW_TAG=proxy-on claude
```

Put the variable in the shell profile or in the wrapper that turns the layer on, so every session it starts is tagged. The tag takes 1 to 32 letters, digits, dots, dashes and underscores; an invalid value is ignored. A session keeps the tag it started with.

Then run:

```text
/codeflow compare
/codeflow compare model 3
```

Each column in the output means:

- **input/request** is the prompt size per request. A larger prompt means each request carried more context.
- **cache hit** is the share of the prompt read from the cache. A higher value means more of the prompt was reused.
- **output/request** is the average answer size per request.
- **startup context** is the prompt of the first request of a new session, before any work. It shows what rules, memory, tools and skills cost at start. It appears only for sessions that started fresh.
- **USD/request** is the session cost divided by requests. `≈` marks an estimate from list prices.

Averages over different work are noisy: a session that reads a large repository and one that answers a short question are not comparable. The fair test is the same task run on both sides, with the same model and effort, compared per request.

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
