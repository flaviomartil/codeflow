# Codeflow

Claude Code mod that measures the main turn and offers an option to reduce the output of reads and searches that reaches the context. It works in normal sessions and can run alongside the [native Code Mode](https://code.claude.com/docs/en/code-mode).

## Install

```text
/plugin install codeflow --marketplace flaviomartil/codeflow
```

Or from a shell:

```bash
claude plugin marketplace add flaviomartil/codeflow
claude plugin install codeflow@codeflow
```

Once installed, every Claude Code session loads Codeflow in **passive mode**: it only measures. Under each response you get a one-line summary with duration, requests, tools, tokens and context, and `/codeflow report` shows the session totals.

## Daily use

Passive mode is safe to leave on all the time. It never changes prompts, tool results or permissions. To get a rolling report across sessions instead of only the current one, group them under a run ID:

```bash
export CLAUDE_CODEFLOW_RUN=daily
```

Or set it for Claude Code only in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODEFLOW_RUN": "daily" } }
```

`/codeflow report` then adds the sessions that ended in the last 24 hours under that ID. Turn on `sessionLog` in the plugin options if you also want a numeric summary written to `.codeflow/` in each project on exit (add `.codeflow/` to that project's `.gitignore`).

## Active mode

```bash
CLAUDE_CODEFLOW_ENABLED=1 claude
claude --plugin-dir ./codeflow
```

The first command opens an installed Codeflow in **active mode**. The second loads a local checkout without installing it. Active mode adds guidance to the prompt, reduces eligible `Read`, `Grep` and `Glob` results and flags sensitive patterns in `Bash` and `REPL`. The variable is read from the environment at startup. A missing value, an invalid value or `0` keeps passive mode.

## Commands

| Command | Result |
| --- | --- |
| `/codeflow` | Mode status |
| `/codeflow report` | Requests, calls, tokens, time, context and estimated cost when available |
| `/codeflow thinking` | Block and word counts for the last turn, with the `thinking` option enabled |
| `/codeflow stash <name> <text>` | Keeps text chosen in the terminal in memory for up to 30 minutes, in active mode |
| `/codeflow recall <name>` | Shows the stored value |
| `/codeflow forget <name>` | Removes the entry |

The stash accepts up to 20 entries of up to 2,000 characters each. It is cleared when the session ends or is cleared. Text typed in commands may appear in the Claude session history.

## Measurement and storage

Event counting is the same in both modes. Total input adds uncached input, cache read and cache created. The request count for requests with multiple tools uses the model step response. Reports show the duration of completed turns and the total number of turns observed. Unavailable fields appear as such.

By default, collection stays in memory. Set `CLAUDE_CODEFLOW_RUN` if you want to group sessions for a comparison. The record uses one key per session and includes only telemetry data. The report uses sessions that ended in the last 24 hours with the same experiment ID. See the [A/B procedure](docs/hybrid-ab-test.md).

The options below live in the plugin configuration.

| Option | Default |
| --- | --- |
| `maxFileLines` | 200 |
| `maxToolResultChars` | 2,000. Values below 64 use the default. |
| `maxListItems` | 20 |
| `guardPatterns` | Empty. Additional comma-separated patterns. |
| `turnSummary` | On |
| `thinking` | Off. When on, it keeps counts. |
| `sessionLog` | Off. When on, it writes a summary to `.codeflow/session-<id>.ndjson` on exit. |

## Compare with and without Codeflow

[Lab Switch](https://github.com/flaviomartil/lab-switch) runs two Claude Code terminals side by side, one with Codeflow and one without, and compares the same prompt on both.

## Validate the local package

```bash
claude plugin validate .
claude plugin test .
```

The tests use the simulated Claude Code environment. To measure a real task, use the same test project and check the result in each mode. There is an [example scenario](docs/landing-page-scenario.md).

## License

MIT
