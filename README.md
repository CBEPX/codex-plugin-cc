# Codex plugin for Claude Code

> **CBEPX fork.** Install with `claude plugin marketplace add CBEPX/codex-plugin-cc` then `claude plugin install codex@cbepx`. Differences from upstream are listed in [CHANGELOG.md](CHANGELOG.md). Upstream: openai/codex-plugin-cc.

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

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
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `--effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Which of those a given model actually supports is decided by Codex, not by the plugin — run `codex debug models` to see the reasoning levels each model advertises.
- model aliases: `spark` -> `gpt-5.3-codex-spark`, `sol` -> `gpt-5.6-sol`, `luna` -> `gpt-5.6-luna`, `terra` -> `gpt-5.6-terra`, `mini` -> `gpt-5.4-mini`
- `--config key=value` (repeatable, also on `/codex:review` and `/codex:adversarial-review`) forwards a `config.toml` override to the Codex thread, e.g. `--config model_provider=ollama`. On `--resume-last` the plugin opens a fresh app-server session (cold resume) so `--config` overrides, sandbox and approval policy take effect; model and effort for the resumed turn are sent on the turn, never on the resume request. In a `--background`/`--await` job record the config **keys** are recorded and the **values** are never stored (they read back as `[redacted]` in `status`/`result`): the real values live only in the job's private 0600 `jobs/<id>.request.json`, which the worker consumes and deletes.
- follow-up rescue requests can continue the latest Codex task in the repo
- under the hood, `/codex:rescue` and the `codex-rescue` agent are each a single `scripts/codex-companion.mjs task --await --prompt-stdin <flags>` call: `--await [--await-timeout-ms <ms>]` launches the same tracked background job as `--background`, then waits for it (default 540000 ms), and `--prompt-stdin` reads the prompt as stdin verbatim (so it cannot be combined with `--args-stdin`, `--prompt-file`, or prompt text on the command line). Exit code is 0 when the job completed, 1 when it failed or was cancelled, and 3 when the wait times out while the job is still queued or running — exit 3 prints a `Re-run: node "<abs>" result <id> --wait --timeout-ms 540000` hint, which is the only follow-up call the rescue flow makes.
- `result <id> [--wait [--timeout-ms <ms>]]` answers a different question, so it has its own contract: `result` exits 0 for any terminal record (completed, failed or cancelled) and 3 while the job is still active. Its exit code means "a result was retrieved", not "the job succeeded" — unlike `task --await` it never returns 1 for a failed job, so read the rendered record for the outcome. A plain `result <id>` on a still-running job prints the same `--wait` hint and exits 3 instead of failing (fixes upstream #498/#524, which reported "No job found" for a running job). `--json` on either returns `{ job, storedJob }` (or, on a timeout, the `status --json` snapshot plus a `resumeCommand` field).
- The detached worker outlives the companion only when the companion returns on its own (exit 3); a host process-tree kill — e.g. Claude Code's Bash timeout — also kills the worker, so keep `--await-timeout-ms` below the host limit (default 540000 < 600000).
- `--turn-timeout-ms <ms>` (or `CODEX_TURN_TIMEOUT_MS`, also on `/codex:review` and `/codex:adversarial-review`) bounds a single Codex turn: on expiry it interrupts the turn and returns a structured failed result ("turn timed out after `<ms>` ms") instead of hanging. Default is `0` (unbounded). The budget travels with a `--background`/`--await` job, so a detached worker enforces it too. The interrupt is not trusted on its own: the run waits up to 10 s for the turn's terminal notification, and if none arrives the failure says so ("interrupt not acknowledged — the turn may still be running in the shared runtime, check status or cancel"), because a shared broker runtime can keep executing a turn nobody is listening to any more. A run that owns its own app-server (a cold `--resume-last`) closes it in that case, which does stop the turn (stdin EOF, then `SIGTERM`, then `SIGKILL`, so the close is bounded too). Partial output on a timed-out turn is best-effort: only whole items Codex had already completed are kept, so a turn interrupted mid-message reports less text than Codex had produced.
- if a background job's session ends while `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=0`, the shared broker that keeps running for that job never self-terminates on its own — its normal idle exit is disabled in that configuration, so the broker only goes away once the job finishes (or is reaped as dead) and a later `SessionEnd` runs.

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

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

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

#### Bounding the review gate

By default the gate keeps blocking the stop until Codex is satisfied, which is what can create the loop above. Set `CODEX_REVIEW_GATE_MAX_ROUNDS` to cap how many consecutive gate rounds run in a single session before the stop is allowed through:

```bash
# allow at most 5 stop-gate review rounds per session, then let the stop proceed
export CODEX_REVIEW_GATE_MAX_ROUNDS=5
```

When unset or `0`, the gate is unbounded (the previous behavior). The count is per session, increments on each blocked round (tracked via `stop_hook_active`), and resets once a stop is allowed or a fresh user turn begins.

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

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
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

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
