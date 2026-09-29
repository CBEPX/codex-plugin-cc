# Codex plugin for Claude Code

> **CBEPX fork.** Install with `claude plugin marketplace add CBEPX/codex-plugin-cc` then `claude plugin install codex@cbepx`. Differences from upstream are listed in [CHANGELOG.md](CHANGELOG.md). Upstream: openai/codex-plugin-cc.

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add CBEPX/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@cbepx
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-6-astra --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `--effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Which of those a given model supports comes from the local Codex model catalogue: when `--model` names a catalogued model, the plugin rejects an effort that model does not list, and otherwise leaves the check to Codex — run `codex debug models` to see the reasoning levels each model advertises.
- model aliases resolve against the local Codex model catalogue (`$CODEX_HOME/models_cache.json`, else `codex debug models --bundled`): an alias picks the listed model whose slug ends in `-<alias>`, lowest priority number first, newest family on ties; today `sol` -> `gpt-6-sol`, `astra` -> `gpt-6-astra`, `luna` -> `gpt-6-luna`, `terra` -> `gpt-5.6-terra`, `spark` -> `gpt-5.3-codex-spark`, `mini` -> `gpt-5.4-mini`; run `codex debug models` to see yours. An exact model slug passes through unchanged, and when the model is in the catalogue `--effort` is checked against the reasoning levels it lists
- `--config key=value` (repeatable, also on `/codex:review` and `/codex:adversarial-review`) forwards a `config.toml` override to the Codex thread, e.g. `--config model_provider=ollama`. On `--resume-last` the plugin opens a fresh app-server session (cold resume) so `--config` overrides, sandbox and approval policy take effect; model and effort for the resumed turn are sent on the turn, never on the resume request. In a `--background`/`--await` job record the config **keys** are recorded and the **values** are never stored (they read back as `[redacted]` in `status`/`result`): the real values live only in the job's private 0600 `jobs/<id>.request.json`, which the worker consumes and deletes.
- follow-up rescue requests can continue the latest Codex task in the repo
- under the hood, `/codex:rescue` and the `codex-rescue` agent are each a single `scripts/codex-companion.mjs task --await --prompt-stdin <flags>` call: `--await [--await-timeout-ms <ms>]` launches the same tracked background job as `--background`, then waits for it (default 540000 ms), and `--prompt-stdin` reads the prompt as stdin verbatim (so it cannot be combined with `--args-stdin`, `--prompt-file`, or prompt text on the command line). Exit code is 0 when the job completed, 1 when it failed or was cancelled, and 3 when the wait times out while the job is still queued or running — exit 3 prints a `Re-run: node "<abs>" result <id> --wait --timeout-ms 540000` hint, which is the only follow-up call the rescue flow makes. With `--args-stdin` (and a single-string `$ARGUMENTS`), a backslash escapes only a following quote, backslash or whitespace and stays literal before anything else, so `C:\Users\me` survives but `\\server\share` becomes `\server\share`; use `--prompt-stdin` for byte-exact text.
- `result <id> [--wait [--timeout-ms <ms>]]` answers a different question, so it has its own contract: `result` exits 0 for any terminal record (completed, failed or cancelled) and 3 while the job is still active. Its exit code means "a result was retrieved", not "the job succeeded" — unlike `task --await` it never returns 1 for a failed job, so read the rendered record for the outcome. A plain `result <id>` on a still-running job prints the same `--wait` hint and exits 3 instead of failing (fixes upstream #498/#524, which reported "No job found" for a running job). `--json` on either returns `{ job, storedJob }` (or, on a timeout, the `status --json` snapshot plus a `resumeCommand` field).
- The detached worker outlives the companion only when the companion returns on its own (exit 3); a host process-tree kill — e.g. Claude Code's Bash timeout — also kills the worker, so keep `--await-timeout-ms` below the host limit (default 540000 < 600000).
- `--turn-timeout-ms <ms>` (or `CODEX_TURN_TIMEOUT_MS`, also on `/codex:review` and `/codex:adversarial-review`) bounds a single Codex turn: on expiry it interrupts the turn and returns a structured failed result ("turn timed out after `<ms>` ms") instead of hanging. Default is `0` (unbounded). The budget travels with a `--background`/`--await` job, so a detached worker enforces it too. The interrupt is not trusted on its own: the run waits up to 10 s for the turn's terminal notification, and if none arrives the failure says so ("interrupt not acknowledged — the turn may still be running in the shared runtime, check status or cancel"), because a shared broker runtime can keep executing a turn nobody is listening to any more. A run that owns its own app-server (a cold `--resume-last`) closes it in that case, which does stop the turn (stdin EOF, then `SIGTERM`, then `SIGKILL`, so the close is bounded too). Partial output on a timed-out turn is best-effort: only whole items Codex had already completed are kept, so a turn interrupted mid-message reports less text than Codex had produced.
- the `SessionEnd` hook works to one absolute budget (`SESSION_END_BUDGET_MS`, 12 s; `CODEX_COMPANION_SESSION_END_BUDGET_MS` can only *shorten* it — a larger value is ignored with a note, since the hook timeout is fixed), and every bounded step inside it — the workspace state lock, each broker handshake, the busy retries, the teardown probe — is clamped to what is left of that budget. `hooks/hooks.json` gives `SessionEnd` a 15 s timeout, which must stay **above** the budget: below it Claude Code would kill the hook mid-decision instead of letting it report one. A test asserts the pair, so the two numbers cannot drift apart.
- if a background job's session ends while `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=0`, the shared broker that keeps running for that job never self-terminates on its own — its normal idle exit is disabled in that configuration, so the broker only goes away once the job finishes (or is reaped as dead) and a later `SessionEnd` runs.
- the `SessionEnd` broker teardown line (`[codex] Broker teardown: ... reason=<reason>`) names one of:

  | reason | meaning |
  | --- | --- |
  | `no-pid` | no broker pid was recorded; nothing to signal |
  | `identity-match` | the pid was proven to be this broker by its recorded identity, so the signal was attempted (`signalled` says whether it landed) |
  | `command-line-match` | a record without an identity was proven by its command line, so the signal was attempted |
  | `identity-mismatch` | the pid is no longer provably ours (another process, or a command line that did not match or could not be read); left alone |
  | `identity-unavailable` | the identity could not be read (e.g. on Windows under Constrained Language Mode/AppLocker); left alone |
  | `process-missing` | Windows: the pid was provably gone before anything was signalled; `/codex:cancel` leaves the job to the reaper (unless the worker already wrote its final record), other kills clean the record up |
  | `kill-failed` | the ownership probe or the kill threw, or (Windows, method `handle`) the kill left survivors or its outcome could not be verified; the broker may still be running |

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` when `CLAUDE_CONFIG_DIR` is set), and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

`status <id> --wait [--timeout-ms <ms>]` blocks until the job reaches a terminal status; it exits 1 when the wait times out while the job is still running (with `--json` too, whose snapshot carries `waitTimedOut: true`), and the text output ends with `Timed out after <N>s while the job was still running.`

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
/codex:result task-abc123 --wait
/codex:result task-abc123 --wait --timeout-ms 60000
```

On a job that already has a terminal record (completed, failed, or cancelled), `/codex:result` exits 0 and shows it — the exit code reports that a result was retrieved, not whether the job succeeded. On a job that is still queued or running, a plain `/codex:result <id>` prints a `Re-run: … result <id> --wait` hint and exits 3 instead of failing; add `--wait [--timeout-ms <ms>]` (default 540000 ms) to block until the job reaches a terminal status instead of returning immediately. `--json` returns `{ job, storedJob }` (or, on a `--wait` timeout, the `status --json` snapshot plus a `resumeCommand` field).

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first. When the review itself fails (timeout, killed by a signal, invalid output), the block reason says why and ends with `Disable with /codex:setup --disable-review-gate.` The hooks read their input from stdin against a deadline (1 s for `SessionEnd`, before its budget starts; 5 s for `SessionStart`; 2 s for `Stop`), so a disabled gate never waits on a stdin Claude Code leaves open, while an enabled gate blocks when the input never arrives. With the gate on and a host that never closes stdin or never sends the input, every stop is blocked; run `/codex:setup --disable-review-gate` to get out.

To pin the model and reasoning effort the gate's review uses, independently of your Codex config:

```bash
/codex:setup --review-gate-model spark --review-gate-effort low
/codex:setup --review-gate-model inherit --review-gate-effort inherit
```

Model aliases (`spark`, `astra`, `sol`, `luna`, `terra`, `mini`) resolve the same way as for `/codex:rescue`; `inherit` clears the pin so the review uses your Codex config again.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

#### Bounding the review gate

By default the gate blocks at most 3 consecutive rounds in a single session, then lets the stop through. Set `CODEX_REVIEW_GATE_MAX_ROUNDS` to change that cap:

```bash
# allow at most 5 stop-gate review rounds per session, then let the stop proceed
export CODEX_REVIEW_GATE_MAX_ROUNDS=5
```

When unset, the cap is 3. Set it to `0` explicitly to keep the gate unbounded (the pre-1.3.0 behavior). The count is per session, increments on each blocked round (tracked via `stop_hook_active`), and resets once a stop is allowed or a fresh user turn begins.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-6-astra` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-6-astra"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### A command failed with "Timed out … waiting for the Codex state lock"

Every write to this workspace's job state is serialized by a ticket lock: each
command takes a numbered ticket in `state.lock.d/` and waits for the tickets ahead
of it. A ticket whose process is gone is cleared automatically, so a crash never
wedges the workspace. A ticket whose process is still *running* is never taken
away — a slow writer and a stuck one look the same from outside, and taking the
lock from a process that is mid-write is how state gets corrupted — so the error
names that PID and the exact ticket file. If that process really is stuck, stop it
and the next command goes through; if the PID belongs to something unrelated (PID
reuse), delete the ticket file the error names.

### A command failed with a raw `EACCES` or `EIO` from the state directory

The same lock refuses to guess. If a ticket in `state.lock.d/` cannot be listed,
read or `stat`ed, the command fails with that error instead of assuming the entry
is absent or abandoned — guessing there is what would let two commands write the
job state at once. Fix the permissions on the state directory (or remove the entry
the error names, once you know no Codex command is using it) and the next command
goes through.

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

### Windows

As of v1.4.0, the plugin no longer spawns commands through `$SHELL` on Windows (usually Git Bash, which mangled `taskkill` and other arguments): `codex`, `npm` and `git` are resolved by a file-based lookup over the absolute `PATH` entries × `PATHEXT` (relative `PATH` entries and the current directory are skipped; `where.exe` is not used), `.exe` files run directly and `.cmd` shims run through `cmd.exe`. This is the spawn path behind the commands, `/codex:review`, `/codex:adversarial-review` and background `task`/`--await` jobs. Separately, the `Stop`, `SessionStart` and `SessionEnd` hooks now read stdin with a bounded deadline instead of a blocking read, so a disabled review gate no longer hangs until the hook timeout on Windows. `/codex:transfer`'s own Windows-specific issues (verbatim `\\?\` paths, ledger lookups) are unrelated to these changes and are not fixed.

As of v1.4.1, kills issued from stored process records — `/codex:cancel`, `SessionEnd` cleanup of a still-running job, stale-broker replacement, and broker teardown — work on Windows. The plugin captures a process identity (start time) for workers and the broker at spawn and verifies the recorded pid against it before killing; the verified process tree is then terminated children-first through one in-box Windows PowerShell 5.1 run with pinned handles (no `taskkill`). A pid that is provably gone is reported as `process-missing`; `/codex:cancel` then leaves such a job to the reaper (it records `cancelled` only when the worker already wrote its final record), other kills clean the record up. `status` and the reaper probe all live jobs in one PowerShell run. If part of the tree outlives the kill, `/codex:cancel` reports `cancellationPending` with the `survivors` (pid and identity) and never marks such a job cancelled; if the outcome of a kill cannot be verified (refused, unverified or timed out), `SessionEnd` keeps the record of that job or broker (`kept=true` in the teardown line, survivors included) and re-judges it at the next `SessionEnd`. When the root itself died but part of its tree survived, the reaper fails the job during the same `SessionEnd` (or the next `status`), so the survivor is only reported and logged, not re-judged. A broker whose record is missing or unreadable while its endpoint is still advertised is presumed present, so kills that would need to exclude it are refused (`identity-unavailable`). The shared broker is excluded from a worker's kill tree only by a verified identity, so it is never killed together with a worker (a broker record without an identity refuses the worker kill).

Limits: descendants spawned after the tree snapshot are outside the guarantee. A survivor process that outlived its root is not tracked and is never retried by pid: it is a known leak with no upper bound, and its pid and identity in the cancel output and the log are diagnostics for the operator. Under PowerShell Constrained Language Mode or AppLocker the identity cannot be read, so kills from records are refused (`identity-unavailable`): `SessionEnd` keeps the broker and job records, while `/codex:cancel` sends the turn interrupt and leaves the job running with its record in place; everything else works as in v1.4.0. An argument containing CR/LF is refused with an error, and `%VAR:a=b%` substitution inside a `.cmd` shim argument remains a documented limitation (see the comment block in `plugins/codex/scripts/lib/process.mjs` near `resolveExecutable`/`buildLaunch`).

Requirements: `cmd.exe` (for `.cmd` shims) and Windows PowerShell 5.1 (for the v1.4.1 kills) ship with Windows, so nothing extra needs installing, and a Store `pwsh` is not needed. `codex` and `npm` must be on the Windows `PATH` as `.cmd`/`.exe` (a global `npm install -g @openai/codex` already does that for `codex`); a `codex` or `npm` that only exists inside Git Bash (an alias, a shell function or a bash-only `PATH` entry) is no longer found. On Windows a long-running `task --await` or `status --wait` loop probes the live jobs with at most one PowerShell run per 2 s (the probe result is remembered inside that process; a standalone `/codex:status` still runs one probe).

When `CLAUDE_PLUGIN_DATA` is not set, job state falls back to a per-user directory: `%LOCALAPPDATA%\codex-companion` on Windows as of v1.4.0 (a private `codex-companion-<uid>` directory under the system temp directory elsewhere). If a pre-1.4.0 state root under `%TEMP%\codex-companion-user` already exists, it keeps being used (with a one-line notice) until you remove it; nothing is migrated. On Windows, `state.json` reads and writes and lock-ticket reads also retry briefly (up to 20 attempts, roughly 300 ms worst case) on `EPERM`/`EBUSY`/`EACCES` when another process holds `state.json` or a lock ticket open.

## Development

The plugin runtime supports Node.js 18.18 or later; the development tooling below
(eslint, c8, Stryker) needs Node.js 24. `npm run build` also needs the `codex` CLI
on `PATH`, because it generates the app-server protocol types first.

- `npm run check` — the full local gate: version metadata, changelog, lint,
  typecheck (`npm run build`), typecheck of tests and scripts, and the test suite.
- `npm run setup:git-hooks` — points git at `.githooks/` (pre-commit runs lint and
  typecheck). The setting lives in the shared `.git/config`, so it applies to the
  main checkout and every worktree and replaces any `.git/hooks/*`; typecheck runs
  `prebuild`, so committing needs the `codex` CLI on `PATH`.
- `npm run test:coverage` — runs the suite under c8 and writes
  `reports/coverage/`; thresholds live in `.c8rc.json` (long-term target:
  85% lines, 75% branches, 90% functions).
- `npm run test:mutation:critical` — Stryker over `args.mjs` and
  `model-catalog.mjs`, reports in `reports/mutation/` (also runs weekly in CI).

Coverage includes the companion, broker and hook subprocesses that tests spawn,
because c8 passes `NODE_V8_COVERAGE` to child processes. It has limits: a child
killed with SIGKILL or `taskkill /F` leaves no coverage dump, a detached broker or
worker may exit after the report is written, and Windows-only branches are not
measured on the ubuntu CI job.
