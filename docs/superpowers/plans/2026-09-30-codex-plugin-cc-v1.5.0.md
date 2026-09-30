# codex-plugin-cc v1.5.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `codex-companion.mjs` into command modules with no runtime change; bound `status` and a plain `result` to 8192 bytes (text and `--json`) with `--output <new-path>` for the complete JSON; make `review --background` a detached tracked job, run the adversarial reviewer for `/codex:review <focus>`, and fix the review surface (#714, #653, #583, #405, #529, #679) together with what the comparison with the sister plugin `cc-plugin-codex` showed missing (random heredoc delimiter, untracked symlinks, bounded diff read, worker diagnostics).

**Architecture:** S1 moves the entry's code into `lib/cli.mjs`, `commands/shared.mjs` and six `commands/*.mjs` modules behind an unchanged entry path. S2 adds one leaf, `lib/read-views.mjs`, applied at the two read commands; the await/rescue path (`task --await`, `result --wait`) never passes through it. S3 reuses the task worker path for reviews (`handleTaskWorker(argv, runners)` dispatching on `jobClass`), so cancel, SessionEnd and the reaper keep their v1.4.2 rules. One spawn option changes (S3b.4: the worker's stdout/stderr go to the job log).

**Tech Stack:** Node 18.18+ ESM, zero runtime deps, `node:test`, the fake Codex fixture, `rg`.

**Spec:** `docs/superpowers/specs/2026-09-30-codex-plugin-cc-v1.5.0-design.md` (rev. 5). Codex's comparison with the sister plugin: `docs/superpowers/reports/v1.5.0/` after the release; until then `.superpowers/sdd/2026-09-30-codex-plugin-cc-v1.5.0/codex-compare-{S2,S3}.md`

## Global Constraints

- Worktree `.worktrees/release-v1.5.0`, branch `release/v1.5.0` (base `main` 0fa5e8d), draft PR #13. Claim per `docs/agent/process.md` before the first write; check ownership before each write batch.
- `rg`, never `grep`/`egrep`/`fgrep`; never `git add -A`.
- Gate before every commit, `&&` only: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit -m "…"`. While iterating: `node --import ./tests/test-env.mjs --test tests/<f>.test.mjs`. Never judge a gate by its log text.
- Commit trailer, always: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (the controller's line, whatever model implements). The five ported upstream fixes (S3a.1–S3a.5) add their author's `Co-authored-by:` line above it, as written in the task.
- Task order is fixed: S1.1 → S1.2 → S1.3 → S2.1 → S2.2 → S2.3 → S2.4 → S3a.1 → … → S3a.5 → S3b.1 → … → S3b.6 → R.1 → R.2. S1 is a pure move and is reviewed alone before S2 starts. Line numbers written as "today `codex-companion.mjs:L…`" refer to `main` 0fa5e8d; after S1 the code lives in the module the task names.
- The entry path `plugins/codex/scripts/codex-companion.mjs`, the worker argv `task-worker --cwd <cwd> --job-id <id>` and the `--help` output stay as they are (S2.3/S2.4 add `[--output <new-path>]` and S3b.6 adds `[focus text]` to the usage text, and say so).
- Module rules (`tests/module-boundaries.test.mjs`): `commands/*` imports only `../lib/**` and `./shared.mjs`; `shared.mjs` imports only `../lib/**`; `lib/**` never imports `commands/**`; `lib/read-views.mjs`, `lib/args.mjs` stay leaves.
- One spawn call changes, in S3b.4 only: the detached worker's `stdio` becomes `["ignore", logFd, logFd]`; executable, argv, `shell`, `detached`, `windowsHide` stay. That task walks `docs/agent/windows-threat-model.md` point by point. Any other task that finds it needs a spawn change stops and reports.
- Command files never use a fixed heredoc delimiter: `CODEX_ARGS_<random>` / `CODEX_PROMPT_<random>` with the selection rule (S3b.6 converts all of them; S2.3/S2.4 touch `status.md`/`result.md` earlier and leave their heredoc lines alone).
- Timing rules (`docs/agent/testing-and-ci.md`): no absolute `< N ms` under 10 s; `waitFor` 30 s; `{ timeout }` + `t.after` SIGKILL on tests that start a worker or broker; a failing lifecycle assertion prints the stored record and the job-log tail. Posix-only assertions (mode 0600, symlinks) carry `{ skip: IS_WIN }`.
- README states observable outputs only; function names and `plugins/codex/scripts/...` paths go to `docs/*.md` (`tests/docs-contracts.test.mjs`). README, CHANGELOG and the version bump belong to R.1/R.2 only.
- After S2, tests read a job's `request`/`result`/`rendered` from the stored record (`readJobRecord`, `readStateIndex` in `tests/helpers.mjs`), from `result --json` of a small finished job, or from an `--output` export — never from `status --json`.

## Review Focus

1. **Arguments are data, never shell.** A focus line equal to the heredoc delimiter, a focus that contains `--background` or `--model x`, apostrophes, quotes and line breaks all reach the prompt as typed and start nothing (S3a.1 runtime tests, S3b.6 scan test over every command file, the `investigate --background handling` test).
2. **The await/rescue path stays unbounded, and everything else stays under 8192 bytes.** `task --await` and `result <id> --wait` print the full record as in 1.4.3; every other `status`/`result` output — the bottom-out view, the active-job hint, the `--output` receipt — is measured (S2.1 oversized `nextStep`/id/receipt tests; S2.4 `result --wait --timeout-ms 100 --json` keeps the full prompt; `task --await --json` has no `truncated` key).
3. **`--output` never overwrites or follows.** An existing file, directory, symlink or dangling symlink is refused, before a wait starts; a failed write removes only the file this call created; exit codes 1 and 3 of the underlying command survive next to the receipt (S2.1 unit tests, S2.3/S2.4 runtime tests).
4. **The split moved the paths, not the behaviour.** `ROOT_DIR` is one level deeper in `lib/cli.mjs`; `COMPANION_SCRIPT` must equal the path the reaper, the worker command line and the stop gate match on; `argvTokenizedFromStdin` stays in the module of both functions that use it (S1.1 `cli.test`, S1.3 proof a–f).
5. **A background review leaves nothing behind and is cancelled by the task rules.** A bad `--base` or a missing `codex` records no job and starts no app-server; a queued-window cancel removes the request file holding `--config` values; a brokered cancel interrupts the turn and kills nothing, a direct-fallback one kills only its own worker; a worker that cannot start fails the job with its reason and never writes the request file's content to the log; a healthy worker's log still holds only timestamped lines (S3a.2, S3b.1, S3b.3, S3b.4, S3b.5).

---

## S1 — split `codex-companion.mjs` (no runtime change)

S1 is a pure move. Every line of `plugins/codex/scripts/codex-companion.mjs` keeps its text; the only
edits are import/export lines, the two renames (`enqueueBackgroundTask` → `enqueueBackgroundJob`,
`renderQueuedTaskLaunch` → `renderQueuedLaunch`), `handleTaskWorker(argv, runners)` with its one
call `runners.task({`, `ROOT_DIR` recomputed with `"../.."`, and the one-line `renderStatusPayload`
inlined into `handleStatus`. The moved code is not reprinted here: each task gives, per destination
module, the declarations with their verified line ranges, the complete import block and the export
list. Code that is new or changed is written out in full.

Line numbers:
- "main L…" = `git show main:plugins/codex/scripts/codex-companion.mjs` (1496 lines; byte-identical to
  the S1 start, since S0 did not touch the file).
- "after S1.1 L…" / "after S1.2 L…" = the companion as the previous S1 task leaves it. Each range was
  verified on a probe build of that exact state.
- Every range is also named by its first declaration. If a number and a name disagree, stop.

Module rules the tasks establish (spec §3.1):
- `commands/*` imports only `../lib/**` and `./shared.mjs`.
- `commands/shared.mjs` imports only `../lib/**`.
- The entry imports only `./lib/cli.mjs` and `./commands/*.mjs`. That includes `./commands/shared.mjs`,
  because `handleTaskWorker` lives there.
- `lib/cli.mjs` imports only siblings. The existing "lib modules import only siblings, never ../"
  test already enforces this.

Call graph, verified: no command family calls into another family.
- The entry calls `executeTaskRun` (task) only to hand it to `handleTaskWorker` as `runners.task`.
- `commands/cancel.mjs` and `commands/setup.mjs` import nothing from `./shared.mjs`. `cancel.mjs` polls
  with its own inline `setTimeout` promise (main L1373), not `sleep`.
- `renderQueuedLaunch`, `enqueueBackgroundJob`, `spawnDetachedTaskWorker` and `handleTaskWorker` each
  have one consumer in S1. They sit in `shared.mjs` because §3.3 gives them a second one (review).

Module-level mutable state: the only `let` at module scope is `argvTokenizedFromStdin` (main L199).
- It moves to `lib/cli.mjs` together with its only writer (`applyArgsStdin`) and its only reader
  (`normalizeArgv`), and it is not exported.
- Every other top-level binding is a `const`. That includes `WIN32_CANCEL_KILL_MS` (main L1377), which
  moves to `commands/cancel.mjs` and is read only at call time.

Tooling coverage for the new `commands/` directory: no config change is needed.
- `eslint.config.mjs` lints `**/*.mjs`.
- `.c8rc.json` includes `plugins/codex/scripts/**/*.mjs`.
- `tsconfig.app-server.json` never included the companion, so `commands/` is typechecked exactly as the
  companion was (not at all).
- `tsconfig.tests.json` (`checkJs: false`) compiles `tests/cli.test.mjs` and its import of
  `lib/cli.mjs`. Probe: `npx tsc -p tsconfig.tests.json` passes.
- `stryker.config.mjs` mutates an explicit list (`args.mjs`, `model-catalog.mjs`).
- `scripts/run-tests.mjs` finds `tests/cli.test.mjs` through `readdirSync`.

### Task S1.1 (Sonnet): `lib/cli.mjs` — paths, argv, usage and output helpers

**Files:** Create `plugins/codex/scripts/lib/cli.mjs`, `tests/cli.test.mjs`. Modify `plugins/codex/scripts/codex-companion.mjs` (main L1–L90, L97–L106, L109–L266, L461–L471).

**Interfaces:**
- Consumes: `lib/args.mjs` `parseArgs`, `splitRawArgumentString`; `lib/fs.mjs` `readStdinIfPiped`; `lib/model-catalog.mjs` `loadModelCatalog`, `resolveModelAlias`, `supportedEfforts`; `lib/workspace.mjs` `resolveWorkspaceRoot`.
- Produces (`lib/cli.mjs` exports, signatures unchanged from the companion):
  - `ROOT_DIR`, `COMPANION_SCRIPT`, `REVIEW_SCHEMA`, `PROMPT_STDIN_FLAG`;
  - `printUsage()`;
  - `outputResult(value, asJson)`, `outputCommandResult(payload, rendered, asJson)`;
  - `normalizeRequestedModel(model)`, `normalizeReasoningEffort(effort, model = null)`;
  - `parseConfigOverrides(list = [])`, `parseTimeoutOption(value, flag)`;
  - `applyArgsStdin(argv)`, `normalizeArgv(argv)`, `parseCommandInput(argv, config = {})`, `maybePrintCommandHelp(options)`;
  - `resolveCommandCwd(options = {})`, `resolveCommandWorkspace(options = {})`.
- Not exported: `VALID_REASONING_EFFORTS`, `ARGS_STDIN_FLAG`, `let argvTokenizedFromStdin`.

- [ ] **Step 1: Failing test.** Create `tests/cli.test.mjs`:

```js
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPANION_SCRIPT,
  normalizeArgv,
  normalizeReasoningEffort,
  parseConfigOverrides,
  parseTimeoutOption,
  REVIEW_SCHEMA
} from "../plugins/codex/scripts/lib/cli.mjs";
import { SCRIPT } from "./helpers.mjs";

// lib/cli.mjs sits one directory deeper than the entry it names; every matcher
// (reaper, worker command line, stop gate) depends on this path staying the entry's.
test("cli path constants resolve from lib/ to the plugin root", () => {
  assert.equal(COMPANION_SCRIPT, SCRIPT);
  assert.ok(fs.statSync(REVIEW_SCHEMA).isFile(), REVIEW_SCHEMA);
});

test("parseTimeoutOption accepts positive integers only and names the flag", () => {
  assert.equal(parseTimeoutOption(undefined, "--timeout-ms"), null);
  assert.equal(parseTimeoutOption(null, "--timeout-ms"), null);
  assert.equal(parseTimeoutOption("250", "--timeout-ms"), 250);
  for (const bad of ["0", "-5", "1.5", "nope", "1e400"]) {
    assert.throws(() => parseTimeoutOption(bad, "--await-timeout-ms"), {
      message: `--await-timeout-ms expects a positive integer number of milliseconds, got "${bad}".`
    });
  }
});

test("parseConfigOverrides splits at the first = and rejects a missing key", () => {
  assert.deepEqual(parseConfigOverrides(), {});
  assert.deepEqual(parseConfigOverrides(["a=b=c", "empty="]), { a: "b=c", empty: "" });
  for (const bad of ["novalue", "=x"]) {
    assert.throws(() => parseConfigOverrides([bad]), { message: `--config expects key=value, got "${bad}".` });
  }
});

test("normalizeReasoningEffort lowercases, rejects unknown efforts and checks the model", () => {
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort("  "), null);
  assert.equal(normalizeReasoningEffort(" HIGH "), "high");
  assert.throws(() => normalizeReasoningEffort("supreme"), {
    message: 'Unsupported reasoning effort "supreme". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.'
  });
  // tests/fixtures/models-catalog.json: gpt-5.6-sol supports low, medium, high.
  assert.throws(() => normalizeReasoningEffort("max", "gpt-5.6-sol"), {
    message: 'Reasoning effort "max" is not supported by gpt-5.6-sol. gpt-5.6-sol supports: low, medium, high.'
  });
});

test("normalizeArgv splits a single argument string and leaves real argv alone", () => {
  assert.deepEqual(normalizeArgv(["--model sol 'two words' \"x y\""]), ["--model", "sol", "two words", "x y"]);
  assert.deepEqual(normalizeArgv(["   "]), []);
  assert.deepEqual(normalizeArgv([""]), []);
  assert.deepEqual(normalizeArgv(["--model sol", "rest"]), ["--model sol", "rest"]);
});
```

`applyArgsStdin` is not called here: it reads stdin. `argvTokenizedFromStdin` is therefore `false` in this process, which is the single-string branch the last test pins.

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/cli.test.mjs` → FAIL: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/plugins/codex/scripts/lib/cli.mjs' imported from …/tests/cli.test.mjs`.

- [ ] **Step 3: Create `plugins/codex/scripts/lib/cli.mjs`.** The file is:
  1. The import block below.
  2. One blank line.
  3. The moved ranges, in this order, one blank line between groups.
  4. `export ` put in front of each declaration in the Produces list.

Import block (complete):

```js
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import { loadModelCatalog, resolveModelAlias, supportedEfforts } from "./model-catalog.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
```

Body, from the companion at main:

| Group | main lines | Declarations |
|---|---|---|
| 1 | L88–L90 | `ROOT_DIR`, `COMPANION_SCRIPT`, `REVIEW_SCHEMA` (L88 changed, below) |
| 2 | L97–L106 | `VALID_REASONING_EFFORTS` |
| 3 | L109–L265 | `printUsage`, `outputResult`, `outputCommandResult`, `normalizeRequestedModel`, `normalizeReasoningEffort`, `parseConfigOverrides`, the `--args-stdin` comment (L191–L196), `ARGS_STDIN_FLAG`, `PROMPT_STDIN_FLAG`, `let argvTokenizedFromStdin`, `applyArgsStdin`, `normalizeArgv`, `parseCommandInput`, `maybePrintCommandHelp`, `resolveCommandCwd`, `resolveCommandWorkspace` |
| 4 | L461–L470 | `parseTimeoutOption` |

Group 1 becomes exactly (lib/ is one level deeper than scripts/):

```js
export const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const COMPANION_SCRIPT = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
export const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
```

The result is 192 lines.

- [ ] **Step 4: Trim the companion.** Work bottom-up so the main numbers stay valid:
  1. Delete L461–L471 (`parseTimeoutOption` and the blank after it).
  2. Delete L109–L266 (`printUsage` … `resolveCommandWorkspace` and the blank after it).
  3. Delete L97–L106 (`VALID_REASONING_EFFORTS`).
  4. Replace L1–L90 with the block below plus one blank line. It keeps the shebang, drops the `fileURLToPath`, `./lib/args.mjs` and `./lib/model-catalog.mjs` imports, adds the `./lib/cli.mjs` import, and leaves every other import line byte-for-byte as it is (including the 4-space indent of the `./lib/codex.mjs` block).

```js
#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  applyArgsStdin,
  COMPANION_SCRIPT,
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  printUsage,
  PROMPT_STDIN_FLAG,
  resolveCommandCwd,
  resolveCommandWorkspace,
  REVIEW_SCHEMA,
  ROOT_DIR
} from "./lib/cli.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    TURN_INTERRUPT_ACK_MS
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { isActiveJobStatus, isTerminalRecord } from "./lib/job-status.mjs";
import { binaryAvailable, isPidAlive, terminateRecordedProcess, workerCommandLine } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  consumeJobRequestFile,
  generateJobId,
  getConfig,
  listJobs,
  nowIso,
  readStoredJob,
  recordWorkerPid,
  redactConfigValues,
  removeJobRequestFile,
  resolveJobPid,
  setConfig,
  upsertJob,
  withStateLock,
  writeJobFile,
  writeJobRequestFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  brokerExclusion,
  brokerPresence,
  buildStatusSnapshot,
  cancelDecision,
  commitCancel,
  isWorkerProvedRecord,
  isWorkerTerminalRecord,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  filterJobsForSession,
  getCurrentSessionId,
  reapDeadJobs,
  registerWorkerCrashGuard,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  emitCancelPending,
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  shorten
} from "./lib/render.mjs";
```

  Result checks:
  - `wc -l < plugins/codex/scripts/codex-companion.mjs` → `1329`.
  - L103 is `const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;`.
  - L109 is `const STOP_REVIEW_TASK_MARKER = …`, followed directly by a blank line and `function sleep(ms) {` at L111.

- [ ] **Step 5:** Run the checks:
  - `node --import ./tests/test-env.mjs --test tests/cli.test.mjs tests/module-boundaries.test.mjs tests/args.test.mjs` → all pass.
  - `npx eslint plugins/codex/scripts tests/cli.test.mjs` → no output. A leftover or missing import shows up as `no-unused-vars` / `no-undef`.
  - `node plugins/codex/scripts/codex-companion.mjs --help | head -1` → `Usage:`.
- [ ] **Step 6: Commit.**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/cli.mjs plugins/codex/scripts/codex-companion.mjs tests/cli.test.mjs && git commit -m "refactor(companion): S1.1 move argv, path and output helpers to lib/cli.mjs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task S1.2 (Opus): `commands/shared.mjs` — job helpers, background enqueue, the worker

**Files:**
- Create `plugins/codex/scripts/commands/shared.mjs`.
- Modify:
  - `plugins/codex/scripts/codex-companion.mjs` (after S1.1: L1–L101, L103–L108, L111–L122, L226–L232, L275–L335, L575–L613, L698–L783, L916, L918, L969–L1015, L1306);
  - `plugins/codex/scripts/lib/tracked-jobs.mjs` (L385, comment only).
- Test: `tests/module-boundaries.test.mjs` (append after L50).

**Interfaces:**
- Consumes `lib/cli.mjs`: `COMPANION_SCRIPT`, `outputCommandResult`, `outputResult`, `parseCommandInput`, `resolveCommandWorkspace`.
- Produces (`commands/shared.mjs` exports):
  - `firstMeaningfulLine(text, fallback)`;
  - `ensureCodexAvailable(cwd)`;
  - `waitForSingleJobSnapshot(cwd, reference, options = {})`;
  - `waitForTerminalJobOrHint(cwd, reference, options = {})`;
  - `outputJobResult(cwd, reference, asJson)`;
  - `renderQueuedLaunch(payload)`, renamed from `renderQueuedTaskLaunch`;
  - `createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, background = false })`;
  - `runForegroundCommand(job, runner, options = {})`;
  - `enqueueBackgroundJob(cwd, job, request)`, renamed from `enqueueBackgroundTask` and otherwise unchanged;
  - `handleTaskWorker(argv, runners)`, where `runners = { task: (request) => Promise<execution> }`. In S1 the worker always calls `runners.task`. The job-class dispatch (`runners.review`) is §3.3's.
- Not exported: `DEFAULT_STATUS_WAIT_TIMEOUT_MS`, `DEFAULT_AWAIT_TIMEOUT_MS`, `DEFAULT_AWAIT_POLL_INTERVAL_MS`, `DEFAULT_STATUS_POLL_INTERVAL_MS`, `sleep`, `buildResumeWaitCommand`, `outputActiveJobHint`, `getJobKindLabel`, `createTrackedProgress`, `spawnDetachedTaskWorker`.

- [ ] **Step 1: Failing test.** Append to `tests/module-boundaries.test.mjs`:

```js

const COMMANDS = path.join(SCRIPTS, "commands");

test("commands/shared.mjs imports only ../lib/**", () => {
  const specs = imports(path.join(COMMANDS, "shared.mjs"));
  assert.ok(specs.length >= 5, "import parser found nothing");
  for (const spec of specs) assert.ok(spec.startsWith("../lib/"), `shared.mjs imports ${spec}`);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/module-boundaries.test.mjs` → FAIL `commands/shared.mjs imports only ../lib/**` with `ENOENT: no such file or directory, open '…/plugins/codex/scripts/commands/shared.mjs'`.

- [ ] **Step 3: Create `plugins/codex/scripts/commands/shared.mjs`.** The file is:
  1. The import block below.
  2. One blank line.
  3. The moved ranges in this order, one blank line between groups.
  4. `export ` in front of the exported declarations.
  5. The edits listed after the table.

```js
import { spawn } from "node:child_process";
import process from "node:process";

import {
  COMPANION_SCRIPT,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  resolveCommandWorkspace
} from "../lib/cli.mjs";
import { getCodexAvailability } from "../lib/codex.mjs";
import { isActiveJobStatus } from "../lib/job-status.mjs";
import {
  consumeJobRequestFile,
  generateJobId,
  readStoredJob,
  recordWorkerPid,
  redactConfigValues,
  removeJobRequestFile,
  upsertJob,
  writeJobFile,
  writeJobRequestFile
} from "../lib/state.mjs";
import { buildSingleJobSnapshot, resolveResultJob } from "../lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  registerWorkerCrashGuard,
  runTrackedJob
} from "../lib/tracked-jobs.mjs";
import { renderStoredJobResult } from "../lib/render.mjs";
```

| Group | main lines | after S1.1 lines | Declarations |
|---|---|---|---|
| 1 | L91–L96 | L103–L108 | `DEFAULT_STATUS_WAIT_TIMEOUT_MS`, the Bash-timeout comment, `DEFAULT_AWAIT_TIMEOUT_MS`, `DEFAULT_AWAIT_POLL_INTERVAL_MS`, `DEFAULT_STATUS_POLL_INTERVAL_MS` |
| 2 | L267–L277 | L111–L121 | `sleep`, `firstMeaningfulLine` |
| 3 | L382–L387 | L226–L231 | `ensureCodexAvailable` |
| 4 | L431–L459 | L275–L303 | `waitForSingleJobSnapshot`, `buildResumeWaitCommand`, the comment and `outputActiveJobHint` |
| 5 | L472–L501 | L305–L334 | the comment and `waitForTerminalJobOrHint`, the comment and `outputJobResult` |
| 6 | L742–L779 | L575–L612 | `renderQueuedTaskLaunch`, `getJobKindLabel`, `createCompanionJob`, `createTrackedProgress` |
| 7 | L865–L949 | L698–L782 | `runForegroundCommand`, `spawnDetachedTaskWorker`, `enqueueBackgroundTask` |
| 8 | L1136–L1181 | L969–L1014 | `handleTaskWorker` |

Edits inside the moved text. These are the only non-import changes in this file:

```js
export function renderQueuedLaunch(payload) {
```
```js
export function enqueueBackgroundJob(cwd, job, request) {
```
```js
export async function handleTaskWorker(argv, runners) {
```
and in `handleTaskWorker`'s `runTrackedJob` runner (main L1175) `      executeTaskRun({` becomes:
```js
      runners.task({
```
The worker's spawn line (main L879) stays byte-identical: `spawn(process.execPath, [COMPANION_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId], {`. The file is 293 lines.

- [ ] **Step 4: Trim the companion** (line numbers are after S1.1):
  1. Do the in-place edits first:
     - L916 `    const { payload } = enqueueBackgroundTask(cwd, job, request);` → `    const { payload } = enqueueBackgroundJob(cwd, job, request);`
     - L918 `      outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);` → `      outputCommandResult(payload, renderQueuedLaunch(payload), options.json);`
     - L1306 `      await handleTaskWorker(argv);` → `      await handleTaskWorker(argv, { task: executeTaskRun });`
  2. Then delete bottom-up. Each range includes its trailing blank line.
     - L969–L1015 (`handleTaskWorker`)
     - L698–L783 (`runForegroundCommand` … `enqueueBackgroundTask`)
     - L575–L613 (`renderQueuedTaskLaunch` … `createTrackedProgress`)
     - L275–L335 (`waitForSingleJobSnapshot` … `outputJobResult`)
     - L226–L232 (`ensureCodexAvailable`)
     - L111–L122 (`sleep`, `firstMeaningfulLine`)
     - L103–L108 (the four `DEFAULT_*_MS`)
  3. Last, replace L1–L101 (the import block through `} from "./lib/render.mjs";`) with:

```js
#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  applyArgsStdin,
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  printUsage,
  PROMPT_STDIN_FLAG,
  resolveCommandCwd,
  resolveCommandWorkspace,
  REVIEW_SCHEMA,
  ROOT_DIR
} from "./lib/cli.mjs";
import {
  createCompanionJob,
  enqueueBackgroundJob,
  ensureCodexAvailable,
  firstMeaningfulLine,
  handleTaskWorker,
  outputJobResult,
  renderQueuedLaunch,
  runForegroundCommand,
  waitForSingleJobSnapshot,
  waitForTerminalJobOrHint
} from "./commands/shared.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    TURN_INTERRUPT_ACK_MS
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { isActiveJobStatus, isTerminalRecord } from "./lib/job-status.mjs";
import { binaryAvailable, isPidAlive, terminateRecordedProcess, workerCommandLine } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  getConfig,
  listJobs,
  nowIso,
  readStoredJob,
  resolveJobPid,
  setConfig,
  withStateLock
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  brokerExclusion,
  brokerPresence,
  buildStatusSnapshot,
  cancelDecision,
  commitCancel,
  isWorkerProvedRecord,
  isWorkerTerminalRecord,
  resolveCancelableJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  filterJobsForSession,
  getCurrentSessionId,
  reapDeadJobs
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  emitCancelPending,
  renderNativeReviewResult,
  renderReviewResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  shorten
} from "./lib/render.mjs";
```

  Result checks:
  - `wc -l < plugins/codex/scripts/codex-companion.mjs` → `1065`.
  - L97 is `const STOP_REVIEW_TASK_MARKER = …`.
  - `rg -n 'enqueueBackgroundTask|renderQueuedTaskLaunch' plugins/codex/scripts` finds only the `lib/tracked-jobs.mjs` comment, which the next step fixes.

- [ ] **Step 5: Comment rename.** In `plugins/codex/scripts/lib/tracked-jobs.mjs` L385, change `` // `enqueueBackgroundTask` patches the pid in immediately after the spawn, so the `` to `` // `enqueueBackgroundJob` patches the pid in immediately after the spawn, so the ``. This is comment only. `rg -n 'enqueueBackgroundTask|renderQueuedTaskLaunch' plugins tests` → no output.
- [ ] **Step 6:** Run the checks:
  - `node --import ./tests/test-env.mjs --test tests/module-boundaries.test.mjs tests/runtime-task.test.mjs tests/runtime-status.test.mjs tests/runtime-cancel.test.mjs` → all pass. These run the detached worker, `status --wait`, `result --wait`, `task --await` and cancel through the moved code.
  - `npx eslint plugins/codex/scripts tests/module-boundaries.test.mjs` → no output.
- [ ] **Step 7: Commit.**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/commands/shared.mjs plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/tracked-jobs.mjs tests/module-boundaries.test.mjs && git commit -m "refactor(companion): S1.2 move the shared job helpers and the task worker to commands/shared.mjs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task S1.3 (Opus): the six command modules; the entry keeps dispatch only; the S1 proof

**Files:**
- Create `plugins/codex/scripts/commands/{setup,review,task,status,cancel,transfer}.mjs`.
- Rewrite `plugins/codex/scripts/codex-companion.mjs` (after S1.2: 1065 lines → 66).
- Test: `tests/module-boundaries.test.mjs` (append after the S1.2 test).

**Interfaces:**
- Produces:
  - `commands/setup.mjs`: `handleSetup(argv)`.
  - `commands/review.mjs`: `handleReviewCommand(argv, config)`, `handleReview(argv)`. `executeReviewRun` stays module-private until §3.3 exports it as `runners.review`.
  - `commands/task.mjs`: `executeTaskRun(request)`, `handleTask(argv)`, `handleTaskResumeCandidate(argv)`. The spec does not list `executeTaskRun` as an export; the entry needs it for `handleTaskWorker(argv, { task: executeTaskRun })`.
  - `commands/status.mjs`: `handleStatus(argv)`, `handleResult(argv)`.
  - `commands/cancel.mjs`: `handleCancel(argv)`.
  - `commands/transfer.mjs`: `handleTransfer(argv)`.
- Consumes: `lib/cli.mjs` and `commands/shared.mjs` exports from S1.1/S1.2.
- Entry allow-list: `./lib/cli.mjs` plus `./commands/{cancel,review,setup,shared,status,task,transfer}.mjs`.

- [ ] **Step 1: Failing tests.** Append to `tests/module-boundaries.test.mjs` after the S1.2 test (it reuses that test's `COMMANDS`):

```js

const COMMAND_MODULES = ["cancel", "review", "setup", "status", "task", "transfer"];

test("command modules import only ../lib/** and ./shared.mjs", () => {
  const present = fs.readdirSync(COMMANDS).filter((n) => n.endsWith(".mjs")).sort();
  assert.deepEqual(present, [...COMMAND_MODULES, "shared"].map((n) => `${n}.mjs`).sort());
  for (const name of COMMAND_MODULES) {
    const specs = imports(path.join(COMMANDS, `${name}.mjs`));
    assert.ok(specs.length >= 2, `${name}.mjs: import parser found nothing`);
    for (const spec of specs) assert.ok(spec.startsWith("../lib/") || spec === "./shared.mjs", `${name}.mjs imports ${spec}`);
  }
});

test("the companion entry imports only lib/cli.mjs and commands/*", () => {
  const allowed = ["./lib/cli.mjs", ...[...COMMAND_MODULES, "shared"].map((n) => `./commands/${n}.mjs`)];
  const specs = imports(path.join(SCRIPTS, "codex-companion.mjs"));
  assert.ok(specs.includes("./lib/cli.mjs"), "import parser found nothing");
  assert.deepEqual(specs.filter((s) => !allowed.includes(s)), [], "codex-companion.mjs imports outside its allow-list");
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/module-boundaries.test.mjs` → 2 FAIL:
  - `command modules import only ../lib/** and ./shared.mjs` with `Expected values to be strictly deep-equal` (the expected side lists `cancel.mjs`, `review.mjs`, `setup.mjs`, `status.mjs`, `task.mjs`, `transfer.mjs`);
  - `the companion entry imports only lib/cli.mjs and commands/*` with `codex-companion.mjs imports outside its allow-list`.

- [ ] **Step 3: Record the "before" `--help` outputs** so they can be compared at Step 7. Capture from `main` into a temp dir. Runtime deps are zero, so the extracted tree runs as it is.

```bash
S1_T="$(mktemp -d)" && echo "S1_T=$S1_T" && git archive main plugins/codex | tar -x -C "$S1_T"
```

- [ ] **Step 4: Create the six modules.** Each file is:
  1. Its import block, as given.
  2. One blank line.
  3. The listed ranges of the after-S1.2 companion, in the order given, one blank line between groups.
  4. `export ` in front of the exported declarations.
  5. No other edit, except the `handleStatus` line named below.

**`commands/setup.mjs`** (108 lines). Groups:
- L99–L132 (main L279–L312) `buildSetupReport`;
- L134–L189 (main L314–L369) `handleSetup` (export).

```js
import process from "node:process";

import {
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "../lib/cli.mjs";
import { getCodexAuthStatus, getCodexAvailability, getSessionRuntimeStatus } from "../lib/codex.mjs";
import { binaryAvailable } from "../lib/process.mjs";
import { getConfig, setConfig } from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { renderSetupReport } from "../lib/render.mjs";
```

**`commands/review.mjs`** (244 lines). Groups:
- L191–L200 (main L371–L380) `buildAdversarialReviewPrompt`;
- L202–L227 (main L389–L414) `buildNativeReviewTarget`, `validateNativeReviewRequest`;
- L266–L378 (main L525–L637) `executeReviewRun`;
- L459–L465 (main L718–L724) `buildReviewJobMetadata`;
- L567–L632 (main L951–L1016) `handleReviewCommand` (export), `handleReview` (export).

```js
import {
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  resolveCommandCwd,
  resolveCommandWorkspace,
  REVIEW_SCHEMA,
  ROOT_DIR
} from "../lib/cli.mjs";
import { parseStructuredOutput, readOutputSchema, runAppServerReview, runAppServerTurn } from "../lib/codex.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { renderNativeReviewResult, renderReviewResult } from "../lib/render.mjs";
import { createCompanionJob, ensureCodexAvailable, firstMeaningfulLine, runForegroundCommand } from "./shared.mjs";
```

**`commands/task.mjs`** (364 lines). Groups:
- L97 (main L107) `STOP_REVIEW_TASK_MARKER`;
- L233–L242 (main L420–L429) `findLatestResumableTaskJob`;
- L244–L264 (main L503–L523) `resolveLatestTrackedTaskThread`;
- L381–L457 (main L640–L716) `executeTaskRun` (export);
- L467–L481 (main L726–L740) `buildTaskRunMetadata`;
- L483–L510 (main L781–L808) `buildTaskJob`, `buildTaskRequest`;
- L539–L565 (main L837–L863) `readTaskPrompt`, `requireTaskRequest`;
- L634–L734 (main L1018–L1118) `handleTask` (export). It already calls `enqueueBackgroundJob` and `renderQueuedLaunch` after S1.2;
- L823–L858 (main L1254–L1289) `handleTaskResumeCandidate` (export).

```js
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputCommandResult,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  PROMPT_STDIN_FLAG,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "../lib/cli.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  runAppServerTurn
} from "../lib/codex.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { isActiveJobStatus } from "../lib/job-status.mjs";
import { listJobs } from "../lib/state.mjs";
import { sortJobsNewestFirst } from "../lib/job-control.mjs";
import { filterJobsForSession, getCurrentSessionId, reapDeadJobs } from "../lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { renderTaskResult, shorten } from "../lib/render.mjs";
import {
  createCompanionJob,
  enqueueBackgroundJob,
  ensureCodexAvailable,
  firstMeaningfulLine,
  outputJobResult,
  renderQueuedLaunch,
  runForegroundCommand,
  waitForTerminalJobOrHint
} from "./shared.mjs";
```

**`commands/status.mjs`** (84 lines). Groups:
- L752–L821 (main L1183–L1252) `handleStatus` (export), `handleResult` (export).

`renderStatusPayload` (after S1.2 L229–L231, main L416–L418) is not moved; it is inlined. In `handleStatus`, the line `  outputResult(renderStatusPayload(report, options.json), options.json);` (after S1.2 L789, main L1220) becomes:

```js
  outputResult(options.json ? report : renderStatusReport(report), options.json);
```

```js
import process from "node:process";

import {
  maybePrintCommandHelp,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  parseTimeoutOption,
  resolveCommandCwd
} from "../lib/cli.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot } from "../lib/job-control.mjs";
import { renderJobStatusReport, renderStatusReport } from "../lib/render.mjs";
import { outputJobResult, waitForSingleJobSnapshot, waitForTerminalJobOrHint } from "./shared.mjs";
```

**`commands/cancel.mjs`** (171 lines). Groups:
- L860–L1011 (main L1291–L1442) as one block: `handleCancel` (export), the comment and `waitForTerminalRecord`, `WIN32_CANCEL_KILL_MS`, `finishCancel`.

Keep this order. `handleCancel` calls the other two only at run time, after module evaluation.

```js
import process from "node:process";

import { maybePrintCommandHelp, outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/cli.mjs";
import { interruptAppServerTurn, TURN_INTERRUPT_ACK_MS } from "../lib/codex.mjs";
import { isTerminalRecord } from "../lib/job-status.mjs";
import { isPidAlive, terminateRecordedProcess, workerCommandLine } from "../lib/process.mjs";
import { nowIso, readStoredJob, resolveJobPid, withStateLock } from "../lib/state.mjs";
import {
  brokerExclusion,
  brokerPresence,
  cancelDecision,
  commitCancel,
  isWorkerProvedRecord,
  isWorkerTerminalRecord,
  resolveCancelableJob
} from "../lib/job-control.mjs";
import { appendLogLine } from "../lib/tracked-jobs.mjs";
import { emitCancelPending, renderCancelReport } from "../lib/render.mjs";
```

**`commands/transfer.mjs`** (48 lines). Groups:
- L512–L537 (main L810–L835) `renderTransferResult`, `executeTransfer`;
- L736–L750 (main L1120–L1134) `handleTransfer` (export).

```js
import path from "node:path";

import { maybePrintCommandHelp, outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/cli.mjs";
import { resolveClaudeSessionPath } from "../lib/claude-session-transfer.mjs";
import { importExternalAgentSession } from "../lib/codex.mjs";
```

Coverage check: the after-S1.2 companion lines not moved are L1–L96 (imports and the blank), L229–L232 (`renderStatusPayload`, inlined) and L1013–L1065 (`main` and the catch). The entry below replaces all of them.

- [ ] **Step 5: Rewrite the entry.** Replace the whole of `plugins/codex/scripts/codex-companion.mjs` with the file below (66 lines). Everything from `async function main()` down is main L1444–L1496 unchanged, except the `task-worker` line already edited in S1.2.

```js
#!/usr/bin/env node

import process from "node:process";

import { applyArgsStdin, printUsage } from "./lib/cli.mjs";
import { handleCancel } from "./commands/cancel.mjs";
import { handleReview, handleReviewCommand } from "./commands/review.mjs";
import { handleSetup } from "./commands/setup.mjs";
import { handleTaskWorker } from "./commands/shared.mjs";
import { handleResult, handleStatus } from "./commands/status.mjs";
import { executeTaskRun, handleTask, handleTaskResumeCandidate } from "./commands/task.mjs";
import { handleTransfer } from "./commands/transfer.mjs";

async function main() {
  const [subcommand, ...rawArgv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  const argv = applyArgsStdin(rawArgv);

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review",
        acceptsFocusText: true
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv, { task: executeTaskRun });
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 6:** Run the checks:
  - `node --import ./tests/test-env.mjs --test tests/module-boundaries.test.mjs tests/cli.test.mjs tests/args.test.mjs tests/commands.test.mjs tests/docs-contracts.test.mjs` → all pass.
  - `npx eslint plugins/codex/scripts tests` → no output.

- [ ] **Step 7: The S1 proof.** Every command below must exit 0. `main` is the base for all of them: the companion is unchanged from `main` to the S1 start, and S0 added or removed no `test(` line (`git diff main -- tests | rg '^[-+]\s*test\('` printed nothing when this plan was written). Set `S1_T` to the directory printed at Step 3 if the shell changed.

  (a) Test titles are only added: every `test(` line of `main` is still present, and the count grows by exactly 8 (473 → 481 when this plan was written: 5 in `cli.test.mjs`, 3 in `module-boundaries.test.mjs`).
```bash
git archive main tests | tar -x -C "$S1_T" \
  && rg --no-filename '^test\(' "$S1_T/tests" | sort > "$S1_T/titles-before" \
  && rg --no-filename '^test\(' tests | sort > "$S1_T/titles-after" \
  && [ -z "$(comm -23 "$S1_T/titles-before" "$S1_T/titles-after")" ] \
  && [ "$(( $(wc -l < "$S1_T/titles-after") - $(wc -l < "$S1_T/titles-before") ))" = 8 ] \
  && git diff --exit-code main -- $(ls tests/*.test.mjs | rg -v '/(cli|module-boundaries|session-lifecycle-hook|broker-idle-timeout)\.test\.mjs$') \
  && echo "titles OK"
```
  The last `git diff` confirms S1 changed no other test file. `session-lifecycle-hook` and `broker-idle-timeout` are excluded because S0 changed them.

  (b) Sorted-line multiset. The old companion must equal the union of the entry, `lib/cli.mjs` and `commands/*.mjs` once import statements, the `export ` keyword and blank lines are removed. The residue must be exactly the listed renames, the `runners` edit, the `ROOT_DIR` depth and the inlined `renderStatusPayload`.
```bash
cat > "$S1_T/multiset.mjs" <<'EOF'
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const old = execFileSync("git", ["show", "main:plugins/codex/scripts/codex-companion.mjs"], { encoding: "utf8" });
const files = ["plugins/codex/scripts/codex-companion.mjs", "plugins/codex/scripts/lib/cli.mjs",
  ...fs.readdirSync("plugins/codex/scripts/commands").sort().map((n) => `plugins/codex/scripts/commands/${n}`)];
const now = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
// Drop import statements (single- or multi-line), the `export ` keyword and blank lines.
const lines = (s) => s.replace(/^import\b[^;]*;$/gm, "").replace(/^export (?=(async )?function |const |let )/gm, "")
  .split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
const [a, b] = [count(lines(old)), count(lines(now))];
const diff = (x, y) => [...x].flatMap(([l, n]) => Array(Math.max(0, n - (y.get(l) ?? 0))).fill(l)).sort();
const onlyOld = diff(a, b);
const onlyNew = diff(b, a);
const expectOld = [
  "      await handleTaskWorker(argv);",
  "      executeTaskRun({",
  "      outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);",
  "    const { payload } = enqueueBackgroundTask(cwd, job, request);",
  "  outputResult(renderStatusPayload(report, options.json), options.json);",
  "  return asJson ? report : renderStatusReport(report);",
  "async function handleTaskWorker(argv) {",
  "const ROOT_DIR = path.resolve(fileURLToPath(new URL(\"..\", import.meta.url)));",
  "function enqueueBackgroundTask(cwd, job, request) {",
  "function renderQueuedTaskLaunch(payload) {",
  "function renderStatusPayload(report, asJson) {",
  "}"
].sort();
const expectNew = [
  "      await handleTaskWorker(argv, { task: executeTaskRun });",
  "      runners.task({",
  "      outputCommandResult(payload, renderQueuedLaunch(payload), options.json);",
  "    const { payload } = enqueueBackgroundJob(cwd, job, request);",
  "  outputResult(options.json ? report : renderStatusReport(report), options.json);",
  "async function handleTaskWorker(argv, runners) {",
  "const ROOT_DIR = path.resolve(fileURLToPath(new URL(\"../..\", import.meta.url)));",
  "function enqueueBackgroundJob(cwd, job, request) {",
  "function renderQueuedLaunch(payload) {"
].sort();
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
if (!same(onlyOld, expectOld) || !same(onlyNew, expectNew)) {
  console.error(JSON.stringify({ onlyOld, onlyNew }, null, 2));
  process.exit(1);
}
console.log(`multiset OK: ${lines(old).length} old lines, residue ${onlyOld.length} out / ${onlyNew.length} in`);
EOF
node "$S1_T/multiset.mjs"
```
  Expected: `multiset OK: 1281 old lines, residue 12 out / 9 in`. On any other residue it prints `onlyOld`/`onlyNew` and exits 1.

  (c) `--help` is byte-identical. The check compares status, stdout and stderr of the `main` entry and the new entry for 24 invocations: no args, `help`, `--help`, an unknown subcommand, and `--help` / `-h` on every subcommand including `task-worker` and `task-resume-candidate`. It uses absolute script paths, because the child's cwd is the OS temp dir.
```bash
cat > "$S1_T/help.mjs" <<'EOF'
import { spawnSync } from "node:child_process";
import os from "node:os";

const [before, after] = process.argv.slice(2);
const cases = [[], ["help"], ["--help"], ["nope"],
  ...["setup", "review", "adversarial-review", "task", "transfer", "status", "result", "cancel", "task-resume-candidate", "task-worker"]
    .flatMap((sub) => [[sub, "--help"], [sub, "-h"]])];
let failed = 0;
for (const args of cases) {
  const [x, y] = [before, after].map((script) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.stringify([r.status, r.stdout, r.stderr]);
  });
  if (x !== y) {
    failed += 1;
    console.error(`differs: ${args.join(" ") || "(no args)"}\n  before ${x}\n  after  ${y}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} identical`);
process.exit(failed ? 1 : 0);
EOF
node "$S1_T/help.mjs" "$S1_T/plugins/codex/scripts/codex-companion.mjs" "$PWD/plugins/codex/scripts/codex-companion.mjs"
```
  Expected: `24/24 identical`.

  (d) The entry is under 100 lines: `[ "$(wc -l < plugins/codex/scripts/codex-companion.mjs | tr -d ' ')" -lt 100 ]` (it is 66).

  (e) `new URL("..` hits: the only new one is `lib/cli.mjs`. On `main` the hits are `codex-companion.mjs:88`, `lib/app-server.mjs:18` and `lib/broker-lifecycle.mjs:501`.
```bash
[ "$(rg -l 'new URL\("\.\.' plugins/codex/scripts | sort | tr '\n' ' ')" = "plugins/codex/scripts/lib/app-server.mjs plugins/codex/scripts/lib/broker-lifecycle.mjs plugins/codex/scripts/lib/cli.mjs " ] && echo "URL OK"
```

  (f) Everything that matches on the entry's path or name still matches:
```bash
git diff --exit-code main -- plugins/codex/commands plugins/codex/skills plugins/codex/agents plugins/codex/hooks plugins/codex/prompts plugins/codex/scripts/stop-review-gate-hook.mjs plugins/codex/scripts/lib/process.mjs \
  && [ "$(git diff main -- plugins/codex/scripts/lib/tracked-jobs.mjs | rg -c '^[-+][^-+]')" = 2 ] \
  && rg -q '!commandLine\.includes\("codex-companion\.mjs"\)' plugins/codex/scripts/lib/tracked-jobs.mjs \
  && rg -q 'path\.join\(SCRIPT_DIR, "codex-companion\.mjs"\)' plugins/codex/scripts/stop-review-gate-hook.mjs \
  && rg -qF 'return new RegExp(`task-worker.*--job-id ${escaped}(\\s|$)`);' plugins/codex/scripts/lib/process.mjs \
  && rg -qF '[COMPANION_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId]' plugins/codex/scripts/commands/shared.mjs \
  && rg -q 'export const SCRIPT = path\.join\(PLUGIN_ROOT, "scripts", "codex-companion\.mjs"\);' tests/helpers.mjs \
  && test -f plugins/codex/scripts/codex-companion.mjs && echo "matchers OK"
```
  What this covers:
  - The command files, skills, agents, hooks and prompts are untouched.
  - `tracked-jobs.mjs` differs only by the one comment line (−1/+1).
  - The reaper's match (`tracked-jobs.mjs:557`), the stop gate (`stop-review-gate-hook.mjs:138`), `workerCommandLine` (`process.mjs:449`), the worker argv and `helpers.SCRIPT` are unchanged.
  - `COMPANION_SCRIPT === SCRIPT` is pinned by `tests/cli.test.mjs`.
  - The gate's `runtime-task`, `runtime-cancel` and `runtime-hooks` files run the worker, the reaper and the stop gate end to end.

  Clean up: `rm -rf "$S1_T"`.

- [ ] **Step 8: Commit.**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/commands/setup.mjs plugins/codex/scripts/commands/review.mjs plugins/codex/scripts/commands/task.mjs plugins/codex/scripts/commands/status.mjs plugins/codex/scripts/commands/cancel.mjs plugins/codex/scripts/commands/transfer.mjs tests/module-boundaries.test.mjs && git commit -m "refactor(companion): S1.3 split the command families into commands/*; the entry keeps dispatch only" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

## S2 — bounded read views

### Task S2.1 (Sonnet): `lib/read-views.mjs` — bounded view, export, next-step strings

**Files:**
- Create `plugins/codex/scripts/lib/read-views.mjs`.
- Create `tests/read-views.test.mjs`.
- Modify `tests/module-boundaries.test.mjs` L10 (`LEAVES`). S1 must not add `read-views` there: the leaf test reads the file, which exists only from this task on.

**Interfaces:**
- Consumes: node builtins only (`node:fs`, `node:path`, `node:crypto`).
- Produces (S2.3 and S2.4 rely on these exact names):
  - `PUBLIC_READ_BYTES = 8192`.
  - `boundedReadView(payload, { summary = false, render = null, asJson = true, nextStep })` → `{ view, text, complete }`.
    - Limits: `{ string: Infinity, items: Infinity }`, then the first shrink step, then both halved (`Math.floor`) each round. The first step is chosen by `summary`: `{ string: 512, items: 8 }` for a summary view (`status` list, `status <id>`, the active-job hint; as in the sister, so a list keeps 8 records with 512-byte strings), `{ string: 4096, items: 8 }` otherwise (the `result` preview). When both reach 0 the loop stops without trying `{0, 0}`: at most 11 rounds (∞, 512, …, 1) in summary mode, 14 (∞, 4096, …, 1) otherwise.
    - A string longer than `limits.string` UTF-8 bytes is cut to the longest prefix within that many bytes that does not end in a high surrogate, plus `…`; `omissions.strings += 1`.
    - An array longer than `limits.items` is sliced; `omissions.records += length - items`.
    - An object or array at depth > 12 (the payload itself is depth 0) becomes `null`; `omissions.fields += 1`.
    - Summary mode drops a key named `request`, `result` or `rendered` at any depth **only when its value is not `null`/`undefined`**; each drop adds 1 to `omissions.fields`, the name (once) to `omissions.fieldNames` in traversal order, and, when the value is an array, its length to `omissions.records` (as the sister does). A `null` value stays and counts nothing.
    - Projected objects get every key as an own data property (`Object.defineProperty`, not assignment), so a JSON key `__proto__` is kept, not lost to the inherited setter. The objects are ordinary (`Object.prototype`), so the renderers, spread and `JSON.stringify` see them as before.
    - `omissions = { fields, fieldNames, records, strings }`; `records` starts at `payload.omittedJobs ?? 0`. `truncated = fields + records + strings > 0` (JSON meaning: anything is missing).
    - `view = { ...projected, truncated, omissions, nextStep? }`; `nextStep` only when `truncated`.
    - **Text rule:** `shortened` counts only what a text renderer could have shown: strings cut, array items sliced, depth-limit `null`s, and `omittedJobs`. It is kept apart from `omissions` in an internal `cuts` counter that `project` increments next to `omissions`; the deliberate summary drops (the field and a dropped array's records) never touch it. So a summary drop alone prints no `Truncated:` block in text; a depth `null` does.
    - Text mode is `asJson === false` **and** `render` is a function. Printed form: JSON mode `JSON.stringify(view, null, 2) + "\n"`; text mode `render(projected)` when not `shortened`, else `render(projected).trimEnd() + "\n\nTruncated: " + JSON.stringify(omissions) + "\n" + nextStep + "\n"`.
    - The size check is on the printed bytes. `complete` describes the printed form: `!shortened` in text mode, `!truncated` in JSON mode.
    - Bottom-out, measured like every other candidate: `view = { truncated: true, omissions: { fields: Object.keys(payload).length, fieldNames: [], records: payload.omittedJobs ?? 0, strings: 0 }, nextStep }`; text is that JSON (JSON mode) or `Truncated: output exceeds 8192 bytes.\n<nextStep>\n` (text mode); `complete: false`. When that is over 8192 bytes (an oversized `nextStep`, e.g. `resultNextStep` of a very long job id), the same view is printed with the fixed `nextStep` **`Use --output <new-path> for the complete JSON payload.`** (no id, no path). Every printed read view is ≤ 8192 bytes.
    - `render` receives the projected payload, never the original. For a complete view the projection is a deep copy with equal values, so `render(projected)` is byte-identical to `render(payload)`.
  - `exportReadPayload(payload, outputPath, cwd)` → `{ outputFile, bytes, sha256 }`. `outputFile = path.resolve(cwd, outputPath)`. The file holds `JSON.stringify(payload, null, 2) + "\n"` (UTF-8). Before anything is created, the exact receipt is serialized as it will be printed (`JSON.stringify(receipt, null, 2) + "\n"`, the full path and the real `bytes`/`sha256`); over 8192 bytes throws **`--output path is too long: its receipt would exceed 8192 bytes; pass a shorter path.`** (exit 1 from `main`), never a shortened path or checksum. Then it is opened with `openSync(outputFile, "wx", 0o600)`. `EEXIST` throws `new Error("--output " + outputFile + " already exists; pass a new path.")` (the resolved path). Any other open error is rethrown raw. On a write or close failure the fd is closed and the file is unlinked only if `lstatSync(outputFile, { bigint: true })` shows the `dev`/`ino` that `fstatSync(fd, { bigint: true })` returned right after the create; then the original error is rethrown.
  - `assertOutputPathFree(outputPath, cwd)` → `undefined`; throws the same `--output <abs> already exists; pass a new path.` error when `fs.lstatSync(path.resolve(cwd, outputPath))` finds any entry (file, directory, symlink, dangling symlink). An `lstat` error of any kind means "nothing to report" and returns: the `wx` open in `exportReadPayload` decides. A courtesy check so `status <id> --wait --output` fails before a long wait, not a security boundary. S2.3 calls it.
  - `statusNextStep(omittedJobs)` → `"Use --all to include omitted records, with --output <new-path> for the complete JSON payload."` when `omittedJobs > 0`, else `"Use --output <new-path> for the complete JSON payload."`.
  - `resultNextStep(jobId)` → ``"Full output: `result <jobId> --wait` (text) or `result <jobId> --output <new-path>` (JSON)."``.

- [ ] **Step 1: Failing tests.** Create `tests/read-views.test.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { IS_WIN, makeTempDir } from "./helpers.mjs";
import {
  PUBLIC_READ_BYTES,
  assertOutputPathFree,
  boundedReadView,
  exportReadPayload,
  resultNextStep,
  statusNextStep
} from "../plugins/codex/scripts/lib/read-views.mjs";

const NEXT = "Use --output <new-path> for the complete JSON payload.";
const bytes = (text) => Buffer.byteLength(text);

test("a small payload is complete and printed as plain JSON", () => {
  const payload = { job: { id: "task-1", status: "completed" }, count: 2 };
  const { view, text, complete } = boundedReadView(payload, { nextStep: NEXT });
  assert.equal(complete, true);
  assert.equal(view.truncated, false);
  assert.equal("nextStep" in view, false);
  assert.deepEqual(view.omissions, { fields: 0, fieldNames: [], records: 0, strings: 0 });
  assert.equal(text, `${JSON.stringify({ ...payload, truncated: false, omissions: view.omissions }, null, 2)}\n`);
});

test("a 60 KB string shrinks to parseable JSON within the limit; keys, numbers and booleans survive", () => {
  const payload = {
    job: { id: "task-1", status: "running" },
    waitTimedOut: true,
    timeoutMs: 25,
    resumeCommand: "node x result task-1 --wait",
    body: "x".repeat(60_000)
  };
  const { view, text, complete } = boundedReadView(payload, { nextStep: NEXT });
  assert.equal(complete, false);
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES, `${bytes(text)} bytes`);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, view);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.omissions.strings >= 1);
  assert.equal(parsed.nextStep, NEXT);
  assert.equal(parsed.body, `${"x".repeat(4096)}…`, "the first shrink step keeps 4096 bytes");
  assert.deepEqual(
    [parsed.job.status, parsed.waitTimedOut, parsed.timeoutMs, parsed.resumeCommand],
    ["running", true, 25, payload.resumeCommand]
  );
});

test("summary mode drops non-null request, result and rendered at any depth and names them", () => {
  const payload = {
    job: { id: "task-1", request: { prompt: "p" }, result: null },
    storedJob: { rendered: "r", nested: { result: { rawOutput: "o" } } }
  };
  const { view } = boundedReadView(payload, { summary: true, nextStep: NEXT });
  assert.equal(view.truncated, true);
  assert.deepEqual(view.omissions.fieldNames, ["request", "rendered", "result"]);
  assert.equal(view.omissions.fields, 3);
  assert.equal("request" in view.job, false);
  assert.equal(view.job.result, null, "a null field is kept and not counted");
  assert.deepEqual(view.storedJob, { nested: {} });
  const full = boundedReadView(payload, { nextStep: NEXT }).view;
  assert.equal(full.truncated, false, "without summary nothing is dropped");
  assert.equal(full.job.request.prompt, "p");
});

test("omittedJobs counts as omitted records; the next-step strings", () => {
  const nextStep = statusNextStep(3);
  const { view, complete } = boundedReadView({ omittedJobs: 3, recent: [] }, { summary: true, nextStep });
  assert.equal(complete, false);
  assert.equal(view.omissions.records, 3);
  assert.equal(view.nextStep, "Use --all to include omitted records, with --output <new-path> for the complete JSON payload.");
  assert.equal(statusNextStep(0), NEXT);
  assert.equal(
    resultNextStep("task-9"),
    "Full output: `result task-9 --wait` (text) or `result task-9 --output <new-path>` (JSON)."
  );
});

test("strings that do not fit at 4096 bytes shrink in later rounds and still parse", () => {
  const payload = { a: "a".repeat(60_000), b: "b".repeat(60_000), c: "c".repeat(60_000) };
  const { view, text } = boundedReadView(payload, { nextStep: NEXT });
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES, `${bytes(text)} bytes`);
  assert.deepEqual(JSON.parse(text), view);
  assert.equal(view.a, `${"a".repeat(2048)}…`, "3 × 4096 bytes is over the limit, 3 × 2048 is not");
  assert.equal(view.omissions.strings, 3);
});

test("a summary drop alone truncates the JSON view but not the text", () => {
  const payload = { job: { id: "task-1", status: "running", request: { prompt: "p".repeat(60_000) } } };
  const json = boundedReadView(payload, { summary: true, nextStep: NEXT });
  assert.equal(json.complete, false);
  assert.equal(json.view.truncated, true);
  assert.deepEqual(json.view.omissions.fieldNames, ["request"]);
  assert.equal(JSON.parse(json.text).nextStep, NEXT);
  const text = boundedReadView(payload, { summary: true, render: (view) => `${view.job.id} ${view.job.status}\n`, asJson: false, nextStep: NEXT });
  assert.equal(text.complete, true);
  assert.equal(text.text, "task-1 running\n", "no Truncated: block for a field the text never shows");
});

test("a summary view keeps eight records with 512-byte strings; a result view starts at 4096", () => {
  const recent = Array.from({ length: 8 }, (_, index) => ({ id: `job-${index}`, note: "n".repeat(5000) }));
  const { view, text } = boundedReadView({ recent }, { summary: true, nextStep: NEXT });
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES, `${bytes(text)} bytes`);
  assert.equal(view.recent.length, 8, "all eight records survive the first shrink step");
  assert.ok(view.recent.every((record) => record.note === `${"n".repeat(512)}…`));
  assert.equal(boundedReadView({ body: "r".repeat(20_000) }, { nextStep: NEXT }).view.body, `${"r".repeat(4096)}…`);
});

test("a summary-dropped array counts its records, in JSON only", () => {
  const payload = { job: { id: "task-1", result: [{ a: 1 }, { b: 2 }, { c: 3 }] } };
  const json = boundedReadView(payload, { summary: true, nextStep: NEXT });
  assert.deepEqual(json.view.omissions, { fields: 1, fieldNames: ["result"], records: 3, strings: 0 });
  const text = boundedReadView(payload, { summary: true, render: (view) => `${view.job.id}\n`, asJson: false, nextStep: NEXT });
  assert.equal(text.text, "task-1\n", "records the text never showed do not print a Truncated: block");
  assert.equal(text.complete, true);
});

test("a depth-limit null counts as shortened in text mode", () => {
  let deep = { leaf: "shown" };
  for (let level = 0; level < 15; level += 1) {
    deep = { d: deep };
  }
  const text = boundedReadView(deep, { render: () => "deep\n", asJson: false, nextStep: NEXT });
  assert.equal(text.complete, false);
  assert.equal(text.text, `deep\n\nTruncated: {"fields":1,"fieldNames":[],"records":0,"strings":0}\n${NEXT}\n`);
});

test("a __proto__ key stays an own key through every round", () => {
  const payload = JSON.parse(`{"safe":1,"__proto__":{"kept":2},"body":"${"b".repeat(60_000)}"}`);
  const { view, text } = boundedReadView(payload, { nextStep: NEXT });
  const parsed = JSON.parse(text);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), text.slice(0, 200));
  assert.deepEqual(parsed["__proto__"], { kept: 2 });
  assert.ok(Object.prototype.hasOwnProperty.call(view, "__proto__"));
  assert.deepEqual(view.omissions, { fields: 0, fieldNames: [], records: 0, strings: 1 });
});

test("an oversized next step falls back to the fixed export instruction in both formats", () => {
  const payload = { body: "x".repeat(60_000) };
  for (const nextStep of ["n".repeat(9000), resultNextStep("j".repeat(5000))]) {
    const json = boundedReadView(payload, { nextStep });
    assert.ok(bytes(json.text) <= PUBLIC_READ_BYTES, `${bytes(json.text)} bytes`);
    assert.deepEqual(JSON.parse(json.text), { truncated: true, omissions: { fields: 1, fieldNames: [], records: 0, strings: 0 }, nextStep: NEXT });
    const text = boundedReadView(payload, { render: (view) => `${view.body}\n`, asJson: false, nextStep });
    assert.equal(text.text, `Truncated: output exceeds 8192 bytes.\n${NEXT}\n`);
    assert.equal(text.complete, false);
  }
});

test("arrays are cut to the item limit and the cut items are counted", () => {
  const payload = { recent: Array.from({ length: 40 }, (_, index) => ({ id: `job-${index}`, note: "n".repeat(300) })) };
  const { view, text } = boundedReadView(payload, { nextStep: NEXT });
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES);
  assert.equal(view.recent.length, 8);
  assert.equal(view.omissions.records, 32);
});

test("text mode prints the render, then the Truncated line and the next step, within the limit", () => {
  const render = (view) => `# Result\n\n${view.body}\n`;
  const small = boundedReadView({ body: "short" }, { render, asJson: false, nextStep: NEXT });
  assert.equal(small.text, "# Result\n\nshort\n");
  assert.equal(small.complete, true);
  const large = boundedReadView({ body: "y".repeat(60_000) }, { render, asJson: false, nextStep: NEXT });
  assert.ok(bytes(large.text) <= PUBLIC_READ_BYTES);
  assert.equal(
    large.text,
    `# Result\n\n${"y".repeat(4096)}…\n\nTruncated: {"fields":0,"fieldNames":[],"records":0,"strings":1}\n${NEXT}\n`
  );
});

test("the text-mode size check is on the printed bytes, not on the JSON view", () => {
  const text3k = "z".repeat(3000);
  const payload = { rendered: text3k, rawOutput: text3k, stdout: text3k };
  const render = (view) => `${view.rendered}\n`;
  const printed = boundedReadView(payload, { render, asJson: false, nextStep: NEXT });
  assert.equal(printed.complete, true);
  assert.equal(printed.text, `${text3k}\n`);
  assert.equal(boundedReadView(payload, { nextStep: NEXT }).complete, false, "the same payload as JSON is over the limit");
});

test("strings are cut on a code-point boundary within the byte limit", () => {
  const { view } = boundedReadView({ s: `a${"😀".repeat(5000)}` }, { nextStep: NEXT });
  assert.equal(view.s.at(-1), "…");
  const cut = view.s.slice(0, -1);
  assert.equal(bytes(cut), 4093, "1 + 1023 × 4 bytes: the 1024th emoji's lone high surrogate is dropped");
  assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut, "no lone surrogate");
});

test("nesting deeper than 12 levels becomes null", () => {
  let deep = { leaf: 1 };
  for (let level = 0; level < 15; level += 1) {
    deep = { d: deep };
  }
  const { view } = boundedReadView(deep, { nextStep: NEXT });
  let node = view;
  for (let level = 0; level < 12; level += 1) {
    node = node.d;
  }
  assert.equal(node.d, null);
  assert.equal(view.omissions.fields, 1);
  assert.equal(view.truncated, true);
});

test("a payload too wide for any limit bottoms out to the minimal view", () => {
  const wide = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`key${String(index).padStart(4, "0")}`, "v"]));
  const json = boundedReadView(wide, { nextStep: NEXT });
  assert.equal(json.complete, false);
  assert.deepEqual(json.view, { truncated: true, omissions: { fields: 2000, fieldNames: [], records: 0, strings: 0 }, nextStep: NEXT });
  assert.equal(json.text, `${JSON.stringify(json.view, null, 2)}\n`);
  const text = boundedReadView(wide, { render: () => "x".repeat(9000), asJson: false, nextStep: NEXT });
  assert.equal(text.text, `Truncated: output exceeds 8192 bytes.\n${NEXT}\n`);
});

test("exportReadPayload writes the full JSON to a new file and returns its receipt", () => {
  const dir = makeTempDir();
  const payload = { job: { id: "task-1" }, body: "😀".repeat(20_000) };
  const receipt = exportReadPayload(payload, "full.json", dir);
  const outputFile = path.join(dir, "full.json");
  const written = fs.readFileSync(outputFile);
  assert.deepEqual(receipt, { outputFile, bytes: written.length, sha256: createHash("sha256").update(written).digest("hex") });
  assert.equal(written.toString("utf8"), `${JSON.stringify(payload, null, 2)}\n`);
  const absolute = path.join(dir, "absolute.json");
  assert.equal(exportReadPayload(payload, absolute, makeTempDir()).outputFile, absolute, "an absolute path ignores cwd");
});

test("exportReadPayload refuses a path whose receipt would not fit, before creating anything", () => {
  const dir = makeTempDir();
  // Each U+0001 is 6 bytes once JSON-escaped: 1400 of them push the receipt past 8192 bytes.
  assert.throws(() => exportReadPayload({ a: 1 }, `${"\u0001".repeat(1400)}.json`, dir), {
    message: "--output path is too long: its receipt would exceed 8192 bytes; pass a shorter path."
  });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("exportReadPayload creates the file owner-only", { skip: IS_WIN }, () => {
  const { outputFile } = exportReadPayload({ a: 1 }, "private.json", makeTempDir());
  assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
});

test("exportReadPayload refuses an existing file untouched; other errors stay raw", () => {
  const dir = makeTempDir();
  const existing = path.join(dir, "existing.json");
  fs.writeFileSync(existing, "keep");
  assert.throws(() => exportReadPayload({ a: 1 }, "existing.json", dir), {
    message: `--output ${existing} already exists; pass a new path.`
  });
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  assert.throws(() => exportReadPayload({ a: 1 }, path.join("no-such-dir", "x.json"), dir), { code: "ENOENT" });
});

test("exportReadPayload refuses a symlink, live or dangling, and a directory", { skip: IS_WIN }, () => {
  const dir = makeTempDir();
  const target = path.join(dir, "target.json");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, path.join(dir, "live-link.json"));
  fs.symlinkSync(path.join(dir, "missing.json"), path.join(dir, "dangling-link.json"));
  fs.mkdirSync(path.join(dir, "a-dir"));
  for (const name of ["live-link.json", "dangling-link.json", "a-dir"]) {
    assert.throws(() => exportReadPayload({ a: 1 }, name, dir), /already exists; pass a new path\.$/, name);
  }
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(dir, "missing.json")), false, "a dangling link is never followed");
  assert.ok(fs.lstatSync(path.join(dir, "live-link.json")).isSymbolicLink());
});

test("exportReadPayload removes the file it created when the write fails", (t) => {
  const dir = makeTempDir();
  t.mock.method(fs, "writeFileSync", (fd) => {
    fs.writeSync(fd, "partial");
    throw new Error("injected disk full");
  });
  assert.throws(() => exportReadPayload({ a: 1 }, "partial.json", dir), /injected disk full/);
  assert.equal(fs.existsSync(path.join(dir, "partial.json")), false);
});

test("exportReadPayload keeps an entry that replaced its file before the failure", { skip: IS_WIN }, (t) => {
  const dir = makeTempDir();
  const outputFile = path.join(dir, "raced.json");
  t.mock.method(fs, "writeFileSync", () => {
    fs.renameSync(outputFile, `${outputFile}.moved`);
    const other = fs.openSync(outputFile, "w");
    fs.writeSync(other, "someone else's");
    fs.closeSync(other);
    throw new Error("injected after replace");
  });
  assert.throws(() => exportReadPayload({ a: 1 }, outputFile, dir), /injected after replace/);
  assert.equal(fs.readFileSync(outputFile, "utf8"), "someone else's", "only the file this call created may be removed");
});

test("assertOutputPathFree refuses any existing entry before a long wait", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "file.json"), "keep");
  fs.mkdirSync(path.join(dir, "a-dir"));
  for (const name of ["file.json", "a-dir"]) {
    assert.throws(() => assertOutputPathFree(name, dir), { message: `--output ${path.join(dir, name)} already exists; pass a new path.` });
  }
  assert.equal(assertOutputPathFree("free.json", dir), undefined);
  assert.equal(fs.existsSync(path.join(dir, "free.json")), false, "the check creates nothing");
});

test("assertOutputPathFree refuses a dangling symlink", { skip: IS_WIN }, () => {
  const dir = makeTempDir();
  fs.symlinkSync(path.join(dir, "missing.json"), path.join(dir, "dangling.json"));
  assert.throws(() => assertOutputPathFree("dangling.json", dir), /already exists; pass a new path\.$/);
});
```

In `tests/module-boundaries.test.mjs` L10 add `"read-views"` to `LEAVES` (alphabetical, after `"process", "prompts"`):

```js
const LEAVES = ["args", "broker-endpoint", "fs", "hook-input", "job-status", "process", "prompts", "read-views", "render"];
```

- [ ] **Step 2: Run** `node --import ./tests/test-env.mjs --test tests/read-views.test.mjs tests/module-boundaries.test.mjs` → FAIL: `read-views.test.mjs` with `ERR_MODULE_NOT_FOUND` (`Cannot find module '…/plugins/codex/scripts/lib/read-views.mjs'`); `module-boundaries` "leaf modules import nothing from lib" with `ENOENT … read-views.mjs`.

- [ ] **Step 3: Implement.** Create `plugins/codex/scripts/lib/read-views.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// `status` and `result` (without `--wait`) print at most this many bytes, text
// or JSON. The full payload goes to a file with `--output <new-path>`.
export const PUBLIC_READ_BYTES = 8192;
const MAX_DEPTH = 12;
// Bodies a summary view (every `status` read, an active job's `result` hint)
// leaves out: the prompt and config keys, the stored result, its rendering.
const SUMMARY_FIELDS = new Set(["request", "result", "rendered"]);

const EXPORT_NEXT_STEP = "Use --output <new-path> for the complete JSON payload.";

export function statusNextStep(omittedJobs) {
  return omittedJobs > 0
    ? "Use --all to include omitted records, with --output <new-path> for the complete JSON payload."
    : EXPORT_NEXT_STEP;
}

export function resultNextStep(jobId) {
  return `Full output: \`result ${jobId} --wait\` (text) or \`result ${jobId} --output <new-path>\` (JSON).`;
}

// The longest prefix of `value` that fits in `maxBytes` UTF-8 bytes and does
// not end in the high half of a surrogate pair. A prefix of `maxBytes` code
// units already has at least `maxBytes` bytes, so the scan starts there.
function cutString(value, maxBytes) {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

// A copy of `value` with strings and arrays shrunk to `limits`, objects past
// MAX_DEPTH replaced by null and, in summary mode, the bodies dropped. Every
// loss is counted in `omissions`; `cuts` counts the losses a text renderer
// could have shown (not the deliberate summary drops). Values shrink before
// serialization, so the JSON printed from the copy is never cut mid-token.
function project(value, limits, summary, omissions, cuts, depth) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= limits.string) {
      return value;
    }
    omissions.strings += 1;
    cuts.count += 1;
    return `${cutString(value, limits.string)}…`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > MAX_DEPTH) {
    omissions.fields += 1;
    cuts.count += 1;
    return null;
  }
  if (Array.isArray(value)) {
    const sliced = Math.max(0, value.length - limits.items);
    omissions.records += sliced;
    cuts.count += sliced;
    return value.slice(0, limits.items).map((item) => project(item, limits, summary, omissions, cuts, depth + 1));
  }
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (summary && SUMMARY_FIELDS.has(key) && item != null) {
      omissions.fields += 1;
      if (Array.isArray(item)) {
        omissions.records += item.length;
      }
      if (!omissions.fieldNames.includes(key)) {
        omissions.fieldNames.push(key);
      }
      continue;
    }
    // defineProperty, not assignment: a JSON key "__proto__" stays an own key
    // instead of hitting the inherited setter and vanishing.
    Object.defineProperty(projected, key, {
      value: project(item, limits, summary, omissions, cuts, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return projected;
}

// The view a read command prints: the payload itself when it fits, otherwise
// the first projection whose PRINTED form (JSON, or `render`'s text plus the
// Truncated block) fits in PUBLIC_READ_BYTES. Unlike the cc-plugin-codex
// original the check is on the printed bytes: a `result` JSON view repeats the
// output three times (`rendered`, `result.rawOutput`, `codex.stdout`), so a
// JSON-size check would shrink small text results for nothing. Summary views
// (lists) start at 512-byte strings like the original, keeping 8 records; a
// `result` preview starts at 4096 bytes.
export function boundedReadView(payload, { summary = false, render = null, asJson = true, nextStep } = {}) {
  const omittedRecords = payload?.omittedJobs ?? 0;
  const asText = asJson === false && typeof render === "function";
  let limits = { string: Infinity, items: Infinity };
  for (;;) {
    const omissions = { fields: 0, fieldNames: [], records: omittedRecords, strings: 0 };
    const cuts = { count: omittedRecords };
    const projected = project(payload, limits, summary, omissions, cuts, 0);
    const truncated = omissions.fields + omissions.records + omissions.strings > 0;
    // Text reports only what it could have shown: a summary drop alone is no
    // truncation there (no text renderer prints `request`, `result`, `rendered`).
    const shortened = cuts.count > 0;
    const view = { ...projected, truncated, omissions, ...(truncated ? { nextStep } : {}) };
    let text;
    if (!asText) {
      text = `${JSON.stringify(view, null, 2)}\n`;
    } else if (shortened) {
      text = `${render(projected).trimEnd()}\n\nTruncated: ${JSON.stringify(omissions)}\n${nextStep}\n`;
    } else {
      text = render(projected);
    }
    if (Buffer.byteLength(text) <= PUBLIC_READ_BYTES) {
      return { view, text, complete: asText ? !shortened : !truncated };
    }
    limits = limits.string === Infinity
      ? { string: summary ? 512 : 4096, items: 8 }
      : { string: Math.floor(limits.string / 2), items: Math.floor(limits.items / 2) };
    if (limits.string === 0 && limits.items === 0) {
      return bottomOut(payload, omittedRecords, asText, nextStep);
    }
  }
}

// Nothing fits: an object with thousands of keys, or a `nextStep` that is itself
// too long (a job id of any length appears twice in `resultNextStep`). The
// fallback is measured too; when the caller's instruction does not fit, the
// fixed EXPORT_NEXT_STEP (no id, no path) is printed instead.
function bottomOut(payload, omittedRecords, asText, nextStep) {
  const omissions = { fields: Object.keys(payload ?? {}).length, fieldNames: [], records: omittedRecords, strings: 0 };
  const print = (step) => {
    const view = { truncated: true, omissions, nextStep: step };
    const text = asText
      ? `Truncated: output exceeds ${PUBLIC_READ_BYTES} bytes.\n${step}\n`
      : `${JSON.stringify(view, null, 2)}\n`;
    return { view, text, complete: false };
  };
  const printed = print(nextStep);
  return Buffer.byteLength(printed.text) <= PUBLIC_READ_BYTES ? printed : print(EXPORT_NEXT_STEP);
}

function outputExistsError(outputFile) {
  return new Error(`--output ${outputFile} already exists; pass a new path.`);
}

// Fails at once when anything (file, directory, symlink, dangling symlink) is
// at the path, so `status <id> --wait --output` does not wait minutes first.
// A courtesy, not a security boundary: exportReadPayload's `wx` open is the guard.
export function assertOutputPathFree(outputPath, cwd) {
  const outputFile = path.resolve(cwd, outputPath);
  try {
    fs.lstatSync(outputFile);
  } catch {
    return;
  }
  throw outputExistsError(outputFile);
}

// `--output <new-path>`: the full payload, exactly what `--json` printed before
// 1.5.0, in a new owner-only file. O_CREAT|O_EXCL never overwrites and never
// follows a symlink (a dangling one too): all of them are EEXIST. On Windows the
// mode is ignored (the directory ACL applies) and `wx` stays exclusive.
export function exportReadPayload(payload, outputPath, cwd) {
  const outputFile = path.resolve(cwd, outputPath);
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // The receipt is printed whole (never a shortened path or checksum), so a
  // path whose receipt would not fit in PUBLIC_READ_BYTES is refused up front.
  const receipt = { outputFile, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`) > PUBLIC_READ_BYTES) {
    throw new Error(`--output path is too long: its receipt would exceed ${PUBLIC_READ_BYTES} bytes; pass a shorter path.`);
  }
  let fd;
  try {
    fd = fs.openSync(outputFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw outputExistsError(outputFile);
    }
    throw error;
  }
  let created = null;
  try {
    created = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, bytes);
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {}
    // Remove only the file this call created: the path may name another entry by now.
    try {
      const current = fs.lstatSync(outputFile, { bigint: true });
      if (created && current.dev === created.dev && current.ino === created.ino) {
        fs.unlinkSync(outputFile);
      }
    } catch {}
    throw error;
  }
  return receipt;
}
```

- [ ] **Step 4: Run** `node --import ./tests/test-env.mjs --test tests/read-views.test.mjs tests/module-boundaries.test.mjs` → all pass (on win32 the four `IS_WIN` tests report skipped).
- [ ] **Step 5: Commit**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/read-views.mjs tests/read-views.test.mjs tests/module-boundaries.test.mjs && git commit -m "feat(read-views): bounded read view and --output export (port of cc-plugin-codex read-views)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task S2.2 (Sonnet): `buildStatusSnapshot` gains `totalJobs` and `omittedJobs`

**Files:** Modify `plugins/codex/scripts/lib/job-control.mjs` (`buildStatusSnapshot`, L195-222). Test `tests/job-control.test.mjs` (imports L1-11, append after the last test).

**Interfaces:**
- Consumes: `filterJobsForSession`, `SESSION_ID_ENV` (`lib/tracked-jobs.mjs`), `resolveStateDir` (`lib/state.mjs`), `isActiveJobStatus` (already imported).
- Produces: the status snapshot gains `totalJobs` (the session-filtered job count) and `omittedJobs` (`options.all ? 0 :` the finished jobs in `jobs.slice(maxJobs)` other than `latestFinished`). S2.3 reads `report.omittedJobs`; `boundedReadView` counts it in `omissions.records`.

- [ ] **Step 1: Failing test.** In `tests/job-control.test.mjs` add `buildStatusSnapshot` to the existing `job-control.mjs` import on L11 (keep every name already there): `import { brokerExclusion, brokerPresence, buildStatusSnapshot, cancelDecision, commitCancel, isWorkerProvedRecord, isWorkerTerminalRecord } from "../plugins/codex/scripts/lib/job-control.mjs";`. `fs`, `path`, `makeTempDir`, `resolveStateDir` and `SESSION_ID_ENV` are already imported (L2-5, L8). Append:

```js
// Twelve finished jobs, newest first by `updatedAt`; the last two belong to another session.
function seedFinishedJobs(workspace) {
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const jobs = Array.from({ length: 12 }, (_, index) => {
    const at = `2026-03-18T15:${String(59 - index).padStart(2, "0")}:00.000Z`;
    return { id: `task-${String(index).padStart(2, "0")}`, status: "completed", jobClass: "task", sessionId: index < 10 ? "sess-a" : "sess-b", createdAt: at, updatedAt: at };
  });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`, "utf8");
}

test("buildStatusSnapshot counts the session's jobs and the finished ones past the list", () => {
  const workspace = makeTempDir();
  seedFinishedJobs(workspace);
  const listed = buildStatusSnapshot(workspace, { env: {} });
  assert.deepEqual([listed.totalJobs, listed.omittedJobs, listed.latestFinished.id, listed.recent.length], [12, 4, "task-00", 7]);
  const all = buildStatusSnapshot(workspace, { env: {}, all: true });
  assert.deepEqual([all.totalJobs, all.omittedJobs, all.recent.length], [12, 0, 11]);
  const otherSession = buildStatusSnapshot(workspace, { env: { [SESSION_ID_ENV]: "sess-b" } });
  assert.deepEqual([otherSession.totalJobs, otherSession.omittedJobs], [2, 0]);
});
```

- [ ] **Step 2: Run** `node --import ./tests/test-env.mjs --test --test-name-pattern "counts the session's jobs" tests/job-control.test.mjs` → FAIL: `Expected values to be strictly deep-equal` with actual `[undefined, undefined, 'task-00', 7]`.

- [ ] **Step 3: Implement.** In `buildStatusSnapshot` replace the `return { … }` block (L213-221) with:

```js
  // Finished jobs past the list's cut, other than the one shown as latest
  // finished: what `--all` would add. Active jobs are always listed.
  const omittedJobs = options.all
    ? 0
    : jobs.slice(maxJobs).filter((job) => !isActiveJobStatus(job.status) && job.id !== latestFinished?.id).length;

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate),
    totalJobs: jobs.length,
    omittedJobs
  };
```

- [ ] **Step 4: Run** `node --import ./tests/test-env.mjs --test tests/job-control.test.mjs tests/runtime-status.test.mjs` → all pass (the `status --json` tests compare two snapshots or read named fields only).
- [ ] **Step 5: Commit**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/job-control.mjs tests/job-control.test.mjs && git commit -m "feat(status): the status snapshot reports totalJobs and omittedJobs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task S2.3 (Sonnet): `status` prints a bounded summary (rows 1, 2) and exports with `--output` (row 7)

**Files:**
- Modify `plugins/codex/scripts/lib/cli.mjs`: new `outputReadView` next to `outputCommandResult` (today `codex-companion.mjs:142-144`); the `status` line of `printUsage` (today `codex-companion.mjs:118`).
- Modify `plugins/codex/scripts/commands/status.mjs`: `handleStatus` (today `codex-companion.mjs:1183-1221`; its last statement was `outputResult(renderStatusPayload(report, options.json), options.json)`, which S1 inlined).
- Modify `plugins/codex/commands/status.md`.
- Test `tests/runtime-status.test.mjs` (imports L1-15; a helper after L15; new tests after L583), `tests/runtime-task.test.mjs` (L955-966, L1024-1038, L1081-1084).

**Interfaces:**
- Consumes: `boundedReadView`, `exportReadPayload`, `assertOutputPathFree`, `statusNextStep` (S2.1); `report.omittedJobs` (S2.2); `outputResult` (`lib/cli.mjs`).
- Produces: `outputReadView(payload, render, { asJson, summary, nextStep, outputPath = null, cwd })` exported from `lib/cli.mjs`. With `outputPath != null` it writes `exportReadPayload(payload, outputPath, cwd)` and prints the receipt with `outputResult(receipt, true)` (always JSON). Otherwise it writes `boundedReadView(payload, { summary, render, asJson: asJson === true, nextStep }).text` to stdout. `asJson === true` matters: `options.json` is `undefined` without `--json`, and `boundedReadView`'s `asJson = true` default would print JSON. `render` gets the projected view. S2.4 calls it from `commands/shared.mjs`.
- `status` and `status <id>` accept `--output <path>` (value option `output`). Exit codes stay: 0; 1 for the `--wait` timeout (with or without `--output`); 1 for any thrown error (EEXIST included).
- Text for a shortened status view: the report, a blank line, `Truncated: {"fields":…,"fieldNames":[…],"records":…,"strings":…}`, the next-step line. A record whose only omission is its dropped `request` prints no `Truncated:` block in text; its `--json` view has `truncated: true`, `fieldNames: ["request"]` and `nextStep`.
- `handleStatus` calls `assertOutputPathFree(options.output, cwd)` right after resolving `cwd`, before any `--wait`. It is the one call site: `result` never waits with `--output` (row 8 refuses `--wait --output`), and `result` without `--wait` goes straight to the `wx` open.

- [ ] **Step 1: Failing tests.** In `tests/runtime-status.test.mjs`:

L1-15 imports become:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  initGitRepo,
  jobDiagnostics,
  makeTempDir,
  readJobRecord,
  run,
  SCRIPT,
  seededRepo
} from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const READ_LIMIT = 8192;
const STATUS_NEXT = "Use --output <new-path> for the complete JSON payload.";
const bytes = (text) => Buffer.byteLength(text);

// A `running` task whose index entry carries a 60 KB prompt, as a background
// task's does. No pid: nothing runs, and the reaper leaves the record alone
// (the pattern of "status --wait times out cleanly" below).
function seedLiveTask(workspace, prompt) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  const job = {
    id: "task-live",
    kind: "task",
    jobClass: "task",
    status: "running",
    phase: "running",
    title: "Codex Task",
    summary: "Investigate flaky test",
    background: true,
    logFile,
    request: { prompt, config: {} },
    createdAt: "2026-03-18T15:30:00.000Z",
    startedAt: "2026-03-18T15:30:01.000Z",
    updatedAt: "2026-03-18T15:30:02.000Z"
  };
  fs.writeFileSync(path.join(jobsDir, "task-live.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );
}
```

Append after L583:

```js
test("status of a finished task with a 60 KB prompt stays bounded; --output exports it once", { timeout: 90_000 }, (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const prompt = `investigate ${"p".repeat(60_000)}`;
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "--prompt-stdin"], { cwd: repo, env, input: prompt });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  t.after(() => {
    try {
      const { pid } = readJobRecord(repo, jobId);
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
  });
  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "30000"], { cwd: repo, env });
  assert.equal(done.status, 0, `${done.stderr}\n${jobDiagnostics(repo, jobId)}`);

  for (const args of [["status", "--json"], ["status", jobId, "--json"]]) {
    const status = run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
    assert.equal(status.status, 0, status.stderr);
    assert.ok(bytes(status.stdout) <= READ_LIMIT, `${args.join(" ")}: ${bytes(status.stdout)} bytes`);
    assert.equal(status.stdout.includes("p".repeat(100)), false, `${args.join(" ")} printed the prompt`);
    const view = JSON.parse(status.stdout);
    assert.equal(view.truncated, true);
    assert.ok(view.omissions.fieldNames.includes("request"));
    assert.equal(view.nextStep, STATUS_NEXT);
  }
  const listed = JSON.parse(run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env }).stdout);
  assert.equal(listed.latestFinished.id, jobId);
  assert.equal("request" in listed.latestFinished, false);
  assert.deepEqual([listed.totalJobs, listed.omittedJobs], [1, 0]);

  for (const args of [["status"], ["status", jobId]]) {
    const text = run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(bytes(text.stdout) <= READ_LIMIT, `${args.join(" ")}: ${bytes(text.stdout)} bytes`);
    // The text never shows the prompt, so dropping it is no truncation there
    // (the --json runs above still report it: truncated, fieldNames ["request"]).
    assert.doesNotMatch(text.stdout, /Truncated:|--output <new-path>/);
  }

  // A relative --output resolves against --cwd, not the process cwd.
  const elsewhere = makeTempDir();
  const exported = run(process.execPath, [SCRIPT, "status", "--output", "status-full.json", "--cwd", repo], { cwd: elsewhere, env });
  assert.equal(exported.status, 0, exported.stderr);
  const outputFile = path.join(repo, "status-full.json");
  const written = fs.readFileSync(outputFile);
  assert.deepEqual(JSON.parse(exported.stdout), {
    outputFile,
    bytes: written.length,
    sha256: createHash("sha256").update(written).digest("hex")
  });
  const full = JSON.parse(written.toString("utf8"));
  assert.equal(full.latestFinished.request.prompt, prompt);
  assert.equal("truncated" in full, false, "the file holds the pre-1.5.0 payload");

  const again = run(process.execPath, [SCRIPT, "status", "--output", outputFile], { cwd: repo, env });
  assert.equal(again.status, 1);
  assert.equal(again.stdout, "");
  assert.match(again.stderr, /--output .*status-full\.json already exists; pass a new path\./);
  assert.equal(fs.readFileSync(outputFile).equals(written), true, "an existing file is never overwritten");
});

test("status <id> --wait on a job with a 60 KB prompt times out bounded with exit 1, also with --output", () => {
  const workspace = makeTempDir();
  const prompt = "q".repeat(60_000);
  seedLiveTask(workspace, prompt);

  const json = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], { cwd: workspace });
  assert.equal(json.status, 1, json.stderr);
  assert.ok(bytes(json.stdout) <= READ_LIMIT, `${bytes(json.stdout)} bytes`);
  const view = JSON.parse(json.stdout);
  assert.deepEqual([view.job.id, view.job.status, view.waitTimedOut, view.truncated], ["task-live", "running", true, true]);
  assert.equal("request" in view.job, false);
  assert.equal(view.nextStep, STATUS_NEXT);

  const text = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25"], { cwd: workspace });
  assert.equal(text.status, 1, text.stderr);
  assert.ok(bytes(text.stdout) <= READ_LIMIT);
  assert.ok(text.stdout.endsWith("\nTimed out after 1s while the job was still running.\n"), text.stdout);
  assert.doesNotMatch(text.stdout, /Truncated:/);

  const outputFile = path.join(makeTempDir(), "status-wait.json");
  const exported = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--output", outputFile], { cwd: workspace });
  assert.equal(exported.status, 1, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).outputFile, outputFile);
  const full = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(full.waitTimedOut, true);
  assert.equal(full.job.request.prompt, prompt);
});

test("status <id> --wait --output <existing> fails before waiting and leaves the job running", { timeout: 90_000 }, () => {
  const workspace = makeTempDir();
  seedLiveTask(workspace, "q".repeat(60_000));
  const existing = path.join(makeTempDir(), "taken.json");
  fs.writeFileSync(existing, "keep");
  // A wait that is not skipped lasts 120 s; spawnSync kills it at 60 s and `status` is then null.
  const refused = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "120000", "--output", existing], { cwd: workspace, timeout: 60_000 });
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stderr.includes(`--output ${existing} already exists; pass a new path.`), true, refused.stderr);
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  const after = run(process.execPath, [SCRIPT, "status", "task-live", "--json"], { cwd: workspace });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).job.status, "running");
});

test("status lists 8 jobs, counts the finished ones past the cut and points at --all", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const jobs = Array.from({ length: 12 }, (_, index) => {
    const at = `2026-03-18T15:${String(59 - index).padStart(2, "0")}:00.000Z`;
    return { id: `task-${String(index).padStart(2, "0")}`, kind: "task", jobClass: "task", status: "completed", phase: "done", title: "Codex Task", summary: `job ${index}`, createdAt: at, completedAt: at, updatedAt: at };
  });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`, "utf8");

  const listed = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: workspace });
  assert.equal(listed.status, 0, listed.stderr);
  const view = JSON.parse(listed.stdout);
  assert.deepEqual([view.totalJobs, view.omittedJobs, view.omissions.records, view.truncated], [12, 4, 4, true]);
  assert.equal(view.nextStep, "Use --all to include omitted records, with --output <new-path> for the complete JSON payload.");

  const text = run(process.execPath, [SCRIPT, "status"], { cwd: workspace });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\nUse --all to include omitted records, with --output <new-path> for the complete JSON payload\.\n$/);

  const all = run(process.execPath, [SCRIPT, "status", "--all", "--json"], { cwd: workspace });
  assert.equal(all.status, 0, all.stderr);
  const allView = JSON.parse(all.stdout);
  assert.equal(allView.omittedJobs, 0);
  assert.equal(allView.omissions.records, 0);
  assert.ok(bytes(all.stdout) <= READ_LIMIT);
});

// Port of the cc-plugin-codex "bounds --all lists" regression, with active records:
// the text renderer prints those twice, in the table and in the details.
test("an oversized status list shrinks its arrays and counts every omitted record", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const at = (minute) => `2026-03-18T15:${String(minute).padStart(2, "0")}:00.000Z`;
  const active = Array.from({ length: 4 }, (_, index) => {
    const logFile = path.join(jobsDir, `task-active-${index}.log`);
    fs.writeFileSync(logFile, "[2026-03-18T15:59:00.000Z] Starting Codex Task.\n", "utf8");
    return { id: `task-active-${index}`, kind: "task", jobClass: "task", status: "running", phase: "running", title: "Codex Task", summary: "長".repeat(2000), logFile, createdAt: at(59 - index), updatedAt: at(59 - index) };
  });
  const finished = Array.from({ length: 30 }, (_, index) => ({
    id: `task-done-${String(index).padStart(2, "0")}`, kind: "task", jobClass: "task", status: "completed", phase: "done", title: "Codex Task", summary: "済".repeat(2000), createdAt: at(50 - index), completedAt: at(50 - index), updatedAt: at(50 - index)
  }));
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [...active, ...finished] }, null, 2)}\n`, "utf8");

  for (const [args, omittedJobs, recentTotal] of [[["--all"], 0, 29], [[], 26, 3]]) {
    const listed = run(process.execPath, [SCRIPT, "status", ...args, "--json"], { cwd: workspace });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(bytes(listed.stdout) <= READ_LIMIT, `${bytes(listed.stdout)} bytes`);
    const view = JSON.parse(listed.stdout);
    assert.deepEqual([view.totalJobs, view.omittedJobs, view.truncated], [34, omittedJobs, true]);
    if (args.length) {
      assert.ok(view.recent.length < recentTotal, "--all: the recent array was shrunk");
    }
    assert.equal(view.omissions.records, omittedJobs + (4 - view.running.length) + (recentTotal - view.recent.length));
    const text = run(process.execPath, [SCRIPT, "status", ...args], { cwd: workspace });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(bytes(text.stdout) <= READ_LIMIT, `text: ${bytes(text.stdout)} bytes`);
    assert.match(text.stdout, /\n\nTruncated: \{.*\}\n/);
    assert.ok(text.stdout.endsWith(`\n${omittedJobs > 0 ? "Use --all to include omitted records, with --output <new-path> for the complete JSON payload." : STATUS_NEXT}\n`));
  }
});
```

In `tests/runtime-task.test.mjs` (each change keeps what the test protects: no `--config` value reaches any output; keys and the `[redacted]` placeholder stay visible where the request is printed):

(a) L955-966 ("task --background keeps secret --config values out of every job record"): drop the `"status --json stdout": waited.stdout,` entry (L958) from `exposures`, and after the loop's closing `}` (L966) add:

```js
  // `status` is a summary since 1.5.0: it drops `request`, so only the values' absence can be checked there.
  assert.equal(waited.stdout.includes("SECRET_SENTINEL_42"), false, "status --json stdout leaked the secret --config value");
  assert.equal(waited.stdout.includes("ollama"), false, "status --json stdout leaked a --config value");
  assert.ok(JSON.parse(waited.stdout).omissions.fieldNames.includes("request"), "status --json drops the request");
```

(b) L1024-1029 ("a v1.1.1 record's --config values never reach status/result…"): replace the `exposures` object with:

```js
  // `status` is a summary since 1.5.0 (no `request`): only the value's absence is checked there.
  assert.equal(status.stdout.includes("SESSION_SECRET_FROM_1_1_1"), false, "status --json stdout leaked a legacy --config value");
  assert.ok(JSON.parse(status.stdout).omissions.fieldNames.includes("request"), "status --json drops the request");
  const exposures = {
    "result --json stdout": result.stdout,
    "state index": fs.readFileSync(statePath, "utf8"),
    "job file": fs.readFileSync(legacyJobFile, "utf8")
  };
```
(the loop L1030-1038 stays: `result --json` of this completed job is not a summary and still carries `[redacted]` and the key name).

(c) L1084 ("an active v1.1.1 record keeps its real --config…"): the job is `queued`, so `result --json` is an active-job hint, also a summary without `request`. Replace L1084 (`assert.equal(status.stdout.includes("[redacted]"), true);`) with:

```js
  // The summary drops `request` (and `result --json` of an active job is a summary too):
  // the full export is where the redacted request is visible.
  const exportFile = path.join(makeTempDir(), "legacy-queued.json");
  const exported = run(process.execPath, [SCRIPT, "status", "task-legacy-queued", "--output", exportFile], { cwd: repo, env });
  assert.equal(exported.status, 0, exported.stderr);
  const exportedText = fs.readFileSync(exportFile, "utf8");
  assert.equal(exportedText.includes("SESSION_SECRET_FROM_1_1_1"), false, "status --output leaked a legacy --config value");
  assert.equal(JSON.parse(exportedText).job.request.config["model_providers.x.http_headers.Cookie"], "[redacted]");
```

- [ ] **Step 2: Run** `node --import ./tests/test-env.mjs --test tests/runtime-status.test.mjs tests/runtime-task.test.mjs` → FAIL: the five new status tests (the oversized-list test with `Expected values to be strictly deep-equal` on `[view.totalJobs, …]`,`status --json` has no `truncated`/`totalJobs` bound: `Expected values to be strictly equal: undefined !== true`, and `Unknown option: --output` for the `--output` runs, including the early-refusal test's exit 1 with the wrong stderr), "task --background keeps secret --config values…" and "a v1.1.1 record's --config values…" with `TypeError: Cannot read properties of undefined (reading 'fieldNames')` (no `omissions` yet), and "an active v1.1.1 record…" with `Unknown option: --output`.

- [ ] **Step 3: Implement.**

`lib/cli.mjs`: add to the imports `import { boundedReadView, exportReadPayload } from "./read-views.mjs";` and, right after `outputCommandResult`:

```js
// Rows 1–4 of the read-view table (spec §3.2): the bounded view — at most
// PUBLIC_READ_BYTES — on stdout or, with `--output`, the full payload in a new
// 0600 file and its receipt, always JSON, on stdout. `render` gets the projected
// view, never the original, so text mode is bounded too. `asJson === true`:
// without `--json` the option is undefined, and boundedReadView defaults to JSON.
export function outputReadView(payload, render, { asJson, summary, nextStep, outputPath = null, cwd }) {
  if (outputPath != null) {
    outputResult(exportReadPayload(payload, outputPath, cwd), true);
    return;
  }
  process.stdout.write(boundedReadView(payload, { summary, render, asJson: asJson === true, nextStep }).text);
}
```

`printUsage` (today L118): the status line becomes

```js
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json] [--output <new-path>]",
```

`commands/status.mjs`: replace the import block as shown after the function below, and replace `handleStatus` with:

```js
export async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "output"],
    booleanOptions: ["json", "all", "wait"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  // Rows 1, 2 and 7: every status read is a bounded summary (no `request`,
  // `result`, `rendered`), or the full payload exported with `--output`.
  const readView = { asJson: options.json, summary: true, outputPath: options.output ?? null, cwd };
  if (readView.outputPath != null) {
    // Fail before a --wait that may last minutes; exportReadPayload's `wx` open stays the guard.
    assertOutputPathFree(readView.outputPath, cwd);
  }
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    if (snapshot.waitTimedOut) {
      const seconds = Math.max(1, Math.round(snapshot.timeoutMs / 1000));
      outputReadView(
        snapshot,
        (view) => `${renderJobStatusReport(view.job)}\nTimed out after ${seconds}s while the job was still running.\n`,
        { ...readView, nextStep: statusNextStep(0) }
      );
      process.exitCode = 1;
      return;
    }
    outputReadView(snapshot, (view) => renderJobStatusReport(view.job), { ...readView, nextStep: statusNextStep(0) });
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputReadView(report, renderStatusReport, { ...readView, nextStep: statusNextStep(report.omittedJobs) });
}
```
S1 exports `handleStatus` and `handleResult` (S1.3 Interfaces), so keep the `export` keyword. After this change `outputCommandResult` and `outputResult` are unused in `status.mjs` (lint fails on them); the import block of `commands/status.mjs` becomes exactly:

```js
import process from "node:process";

import {
  maybePrintCommandHelp,
  outputReadView,
  parseCommandInput,
  parseTimeoutOption,
  resolveCommandCwd
} from "../lib/cli.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot } from "../lib/job-control.mjs";
import { assertOutputPathFree, statusNextStep } from "../lib/read-views.mjs";
import { renderJobStatusReport, renderStatusReport } from "../lib/render.mjs";
import { outputJobResult, waitForSingleJobSnapshot, waitForTerminalJobOrHint } from "./shared.mjs";
```

`plugins/codex/commands/status.md`: the `argument-hint` line becomes `argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all] [--output <new-path>]'`, and append after the last bullet:

```markdown

If the output ends with a `Truncated:` line, keep that line and the next-step line after it as printed, below the table or the output. Do not re-run the command on your own.
```

- [ ] **Step 4: Run** `node --import ./tests/test-env.mjs --test tests/runtime-status.test.mjs tests/runtime-task.test.mjs tests/runtime-cancel.test.mjs tests/runtime-review.test.mjs tests/runtime-hooks.test.mjs tests/runtime-setup.test.mjs tests/commands.test.mjs` → all pass. The pre-existing text tests (`runtime-status.test.mjs:93`, `:172`, `:237`; `runtime-review.test.mjs:301`; `runtime-hooks.test.mjs:391`; `runtime-setup.test.mjs:292`) use `assert.match` on records without `request`, so their output is unchanged. `npx eslint plugins/codex/scripts tests` exits 0.
- [ ] **Step 5: Commit**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/cli.mjs plugins/codex/scripts/commands/status.mjs plugins/codex/commands/status.md tests/runtime-status.test.mjs tests/runtime-task.test.mjs && git commit -m "feat(status): bounded status output, --output <new-path> for the full JSON" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task S2.4 (Sonnet): `result` without `--wait` prints a bounded preview (rows 3, 4, 7); `--wait --output` refused (row 8); `/codex:result` presents the preview

**Files:**
- Modify `plugins/codex/scripts/commands/shared.mjs`: `outputActiveJobHint` (today `codex-companion.mjs:453-459`), `outputJobResult` (today `codex-companion.mjs:489-501`).
- Modify `plugins/codex/scripts/commands/status.mjs`: `handleResult` (today `codex-companion.mjs:1223-1252`).
- Modify `plugins/codex/scripts/lib/cli.mjs`: the `result` line of `printUsage` (today `codex-companion.mjs:119`).
- Modify `plugins/codex/commands/result.md`.
- Test `tests/runtime-status.test.mjs` (append after the S2.3 tests), `tests/runtime-task.test.mjs` (import block L8-19; append after the last test, L1703), `tests/commands.test.mjs` (L213; new test after the test that ends at L219).

**Interfaces:**
- Consumes: `outputReadView` (`lib/cli.mjs`, S2.3), `resultNextStep` (S2.1), `seedLiveTask`, `READ_LIMIT`, `bytes` (top of `tests/runtime-status.test.mjs`, S2.3).
- Produces:
  - `outputJobResult(cwd, reference, asJson, readView = null)` and `outputActiveJobHint(snapshot, leadIn, asJson, readView = null)`, `readView = { outputPath, cwd }`. **Predicate:** `readView == null` → the 1.4.3 output via `outputCommandResult`, byte for byte. The only caller that passes a non-null `readView` is `handleResult` when `!options.wait`. `waitForTerminalJobOrHint` (today L485; the `result --wait` and `task --await` timeout hint) and `handleTask`'s awaited result (today L1093) never pass one, so rows 5 and 6 stay unbounded by construction. `outputJobResult` still returns the resolved job (L1093 reads `.status`).
  - Row 3: `summary: false` (strings and arrays shrink only), render `(view) => renderStoredJobResult(view.job, view.storedJob)`, `nextStep: resultNextStep(job.id)`, exit 0.
  - Row 4: `summary: true`, render `(view) => \`Job ${view.job.id} is still ${view.job.status}. Re-run: ${view.resumeCommand}\n\`` (from the projection: a huge id or companion path shrinks with the view, and when even that cannot fit the measured bottom-out applies; the unbounded branch keeps the original `leadIn` rendering), `nextStep: resultNextStep(snapshot.job.id)`, exit 3 (with `--output` too: receipt on stdout, exit 3). Its only omission is the dropped `request`, so the text is exactly the 1.4.3 line; `--json` has `truncated: true` and `nextStep`.
  - Row 3 text preview: the first shrink step keeps 4096 bytes of each long string, so a 20 KB answer previews its first 4096 bytes plus `…`, the session lines, the `Truncated:` block and the `Full output:` line.
  - Row 8: `result --wait --output <p>` throws `--output cannot be combined with --wait; result --wait already prints the full record.` before any wait (exit 1 from `main`'s catch). The check runs after the existing `--timeout-ms requires --wait.` check.

- [ ] **Step 1: Failing tests.** Append to `tests/runtime-status.test.mjs`:

```js
// Port of the cc-plugin-codex "large historical Unicode reads" regression.
test("a large historical record with CJK and astral text reads bounded through status and result, untouched on disk", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  // Astral characters straddle every cut point (512, 4096 and the halvings).
  const body = `漢字${"😀漢".repeat(20_000)}`;
  const job = {
    id: "task-unicode",
    kind: "task",
    jobClass: "task",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    summary: `概要😀${"長".repeat(3000)}`,
    threadId: "thr_unicode",
    request: { prompt: body, config: {} },
    createdAt: "2026-03-18T15:00:00.000Z",
    completedAt: "2026-03-18T15:01:00.000Z",
    updatedAt: "2026-03-18T15:01:00.000Z"
  };
  const jobFile = path.join(jobsDir, "task-unicode.json");
  const statePath = path.join(stateDir, "state.json");
  fs.writeFileSync(jobFile, `${JSON.stringify({ ...job, result: { rawOutput: body }, rendered: `${body}\n` }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`, "utf8");
  const before = [fs.readFileSync(jobFile), fs.readFileSync(statePath)];

  for (const args of [["status", "task-unicode"], ["result", "task-unicode"]]) {
    for (const format of [[], ["--json"]]) {
      const read = run(process.execPath, [SCRIPT, ...args, ...format], { cwd: workspace });
      const label = [...args, ...format].join(" ");
      assert.equal(read.status, 0, `${label}: ${read.stderr}`);
      assert.ok(bytes(read.stdout) <= READ_LIMIT, `${label}: ${bytes(read.stdout)} bytes`);
      assert.equal(read.stdout.includes("�"), false, `${label} printed a broken surrogate`);
      assert.match(read.stdout, /Truncated|"truncated": true/, label);
      if (format.length) {
        assert.equal(JSON.parse(read.stdout).truncated, true, label);
      }
    }
  }
  assert.ok(fs.readFileSync(jobFile).equals(before[0]), "the job file is never rewritten by a read");
  assert.ok(fs.readFileSync(statePath).equals(before[1]), "the state index is never rewritten by a read");
});

test("result on an active job with a 3000-character id stays bounded with exit 3", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const id = `task-${"x".repeat(3000)}`;
  // Index only: a job file name that long is over NAME_MAX, and nothing reads one for an active job without a pid.
  const job = { id, kind: "task", jobClass: "task", status: "running", phase: "running", title: "Codex Task", summary: "long id", createdAt: "2026-03-18T15:30:00.000Z", updatedAt: "2026-03-18T15:30:02.000Z" };
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`, "utf8");
  for (const format of [[], ["--json"]]) {
    const read = run(process.execPath, [SCRIPT, "result", id, ...format], { cwd: workspace });
    assert.equal(read.status, 3, read.stderr);
    assert.ok(bytes(read.stdout) <= READ_LIMIT, `${format.join(" ") || "text"}: ${bytes(read.stdout)} bytes`);
    if (format.length) {
      assert.ok("resumeCommand" in JSON.parse(read.stdout));
    } else {
      assert.ok(read.stdout.startsWith(`Job ${id.slice(0, 100)}`), read.stdout.slice(0, 200));
    }
  }
});

test("result of a 20 KB answer prints a bounded preview; --wait prints it in full; --wait --output is refused", { timeout: 60_000 }, () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const answer = "0123456789".repeat(2000);
  const env = buildEnv(binDir, { FAKE_CODEX_ANSWER_TEXT: answer });
  const task = run(process.execPath, [SCRIPT, "task", "--json", "a long answer please"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  const stored = readJobRecord(repo);
  const jobId = stored.id;
  const nextStep = `Full output: \`result ${jobId} --wait\` (text) or \`result ${jobId} --output <new-path>\` (JSON).`;

  const preview = run(process.execPath, [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(bytes(preview.stdout) <= READ_LIMIT, `${bytes(preview.stdout)} bytes`);
  assert.ok(preview.stdout.startsWith(`${answer.slice(0, 4096)}…\n`), preview.stdout.slice(0, 4200));
  assert.match(preview.stdout, new RegExp(`\\nCodex session ID: ${stored.threadId}\\n`));
  assert.match(preview.stdout, /\n\nTruncated: \{"fields":0,"fieldNames":\[\],"records":0,"strings":\d+\}\n/);
  assert.ok(preview.stdout.endsWith(`\n${nextStep}\n`), preview.stdout.slice(-300));

  const json = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
  assert.equal(json.status, 0, json.stderr);
  assert.ok(bytes(json.stdout) <= READ_LIMIT, `${bytes(json.stdout)} bytes`);
  const view = JSON.parse(json.stdout);
  assert.deepEqual([view.job.id, view.job.status, view.truncated, view.nextStep], [jobId, "completed", true, nextStep]);
  assert.ok(view.omissions.strings >= 1);
  assert.equal(view.omissions.fields, 0, "result is not a summary: nothing is dropped");
  assert.ok(view.storedJob.result.rawOutput.endsWith("…"));

  const full = run(process.execPath, [SCRIPT, "result", jobId, "--wait"], { cwd: repo, env });
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.stdout, `${stored.rendered}\nCodex session ID: ${stored.threadId}\nResume in Codex: codex resume ${stored.threadId}\n`);

  const outputFile = path.join(makeTempDir(), "result.json");
  const refused = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--output", outputFile], { cwd: repo, env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--output cannot be combined with --wait; result --wait already prints the full record\./);
  assert.equal(fs.existsSync(outputFile), false);

  const exported = run(process.execPath, [SCRIPT, "result", jobId, "--output", outputFile], { cwd: repo, env });
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).outputFile, outputFile);
  assert.equal(JSON.parse(fs.readFileSync(outputFile, "utf8")).storedJob.result.rawOutput, answer);
});

test("result on an active job with a 60 KB prompt: bounded hint with exit 3; --wait's timeout hint stays full", () => {
  const workspace = makeTempDir();
  const prompt = "q".repeat(60_000);
  seedLiveTask(workspace, prompt);
  const nextStep = "Full output: `result task-live --wait` (text) or `result task-live --output <new-path>` (JSON).";

  const json = run(process.execPath, [SCRIPT, "result", "task-live", "--json"], { cwd: workspace });
  assert.equal(json.status, 3, json.stderr);
  assert.ok(bytes(json.stdout) <= READ_LIMIT, `${bytes(json.stdout)} bytes`);
  const view = JSON.parse(json.stdout);
  assert.match(view.resumeCommand, /^node ".*codex-companion\.mjs" result task-live --wait --timeout-ms 540000$/);
  assert.deepEqual([view.job.status, view.truncated, view.nextStep], ["running", true, nextStep]);
  assert.equal("request" in view.job, false);

  const text = run(process.execPath, [SCRIPT, "result", "task-live"], { cwd: workspace });
  assert.equal(text.status, 3, text.stderr);
  // Only the summary drop happened: the text hint is the 1.4.3 line, nothing appended.
  assert.match(text.stdout, /^Job task-live is still running\. Re-run: node .*result task-live --wait --timeout-ms 540000\n$/);

  const outputFile = path.join(makeTempDir(), "active.json");
  const exported = run(process.execPath, [SCRIPT, "result", "task-live", "--output", outputFile], { cwd: workspace });
  assert.equal(exported.status, 3, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).outputFile, outputFile);
  const full = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(full.job.request.prompt, prompt);
  assert.equal(full.resumeCommand, view.resumeCommand);

  // Row 5: the `--wait` timeout hint is the rescue path's, printed in full as in 1.4.3.
  const waited = run(process.execPath, [SCRIPT, "result", "task-live", "--wait", "--timeout-ms", "100", "--json"], { cwd: workspace });
  assert.equal(waited.status, 3, waited.stderr);
  const hint = JSON.parse(waited.stdout);
  assert.equal(hint.job.request.prompt, prompt);
  assert.equal("truncated" in hint, false);
});
```

In `tests/runtime-task.test.mjs` add `jobDiagnostics,` to the `./helpers.mjs` import (between `IS_WIN,` and `makeTempDir,`) and append after L1703:

```js
// Row 6 of the read-view table: the rescue path's awaited result is never bounded.
test("task --await --json of a 20 KB answer prints the full record without read-view fields", { timeout: 60_000 }, (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const answer = "0123456789".repeat(2000);
  const env = buildEnv(binDir, { FAKE_CODEX_ANSWER_TEXT: answer });
  t.after(() => {
    try {
      const { pid } = readJobRecord(repo);
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
  });
  const awaited = run(process.execPath, [SCRIPT, "task", "--await", "--json", "--prompt-stdin"], { cwd: repo, env, input: "a long answer please\n" });
  assert.equal(awaited.status, 0, `${awaited.stderr}\n${jobDiagnostics(repo, readJobRecord(repo).id)}`);
  assert.ok(Buffer.byteLength(awaited.stdout) > 8192);
  const out = JSON.parse(awaited.stdout);
  assert.equal("truncated" in out, false);
  assert.equal("omissions" in out, false);
  assert.equal(out.storedJob.result.rawOutput, answer);
});
```

In `tests/commands.test.mjs` L213 becomes:

```js
  assert.match(result, /argument-hint:\s*'\[job-id\] \[--wait\] \[--timeout-ms <ms>\] \[--output <new-path>\]'/);
```
and after the test that ends at L219 add:

```js
// Spec rev. 2: a truncated `result` is shown as the preview it is; the full text
// is a second, explicit request, never an automatic `--wait` re-run.
test("result.md presents a truncated preview as printed and fetches the full text only on request", () => {
  const result = read("commands/result.md");
  assert.match(result, /ends with a `Truncated:` block and a `Full output:` line/);
  assert.match(result, /Present that preview and the `Full output:` line as printed/);
  assert.match(result, /Do not re-run the command on your own/);
  assert.match(
    result,
    /Only when the user asks for the full text, run `node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" result <id> --wait`/
  );
  assert.doesNotMatch(result, /present the full (command )?output/i);
  assert.match(read("commands/status.md"), /ends with a `Truncated:` line/);
});
```

- [ ] **Step 2: Run** `node --import ./tests/test-env.mjs --test tests/runtime-status.test.mjs tests/runtime-task.test.mjs tests/commands.test.mjs` → FAIL: "a large historical record…" (`result task-unicode` prints the whole 160 KB body), "result of a 20 KB answer…" (`bytes(preview.stdout) <= READ_LIMIT`: about 20 100 bytes), "result on an active job…" (JSON over the limit: `…bytes`), `commands.test.mjs:213` and the new `result.md` test (argument hint, `Truncated:`). The `task --await` test and the 3000-character-id test pass already: they pin row 6, and the long-id hint, against this task's change.

- [ ] **Step 3: Implement.**

`commands/shared.mjs`: add `outputReadView` to the `../lib/cli.mjs` import and `import { resultNextStep } from "../lib/read-views.mjs";`. Replace `outputActiveJobHint` (with its comment) by:

```js
// Every "the job outlived this command" exit looks the same: the lead-in, the
// exact command that resumes the wait, and exit code 3. `readView`
// (`{ outputPath, cwd }`) is passed only by `result` without `--wait` (row 4):
// a bounded summary, or the full payload exported. Without it (`result --wait`,
// `task --await`) the hint prints in full, as in 1.4.3.
function outputActiveJobHint(snapshot, leadIn, asJson, readView = null) {
  const resumeCommand = buildResumeWaitCommand(snapshot.job.id);
  const payload = { ...snapshot, resumeCommand };
  if (readView) {
    // Rendered from the projection, never the captured strings, so a huge id or
    // companion path shrinks with the view. Only `result` without --wait passes
    // a read view, and its lead-in is exactly this line.
    outputReadView(
      payload,
      (view) => `Job ${view.job.id} is still ${view.job.status}. Re-run: ${view.resumeCommand}\n`,
      { ...readView, asJson, summary: true, nextStep: resultNextStep(snapshot.job.id) }
    );
  } else {
    outputCommandResult(payload, `${leadIn} Re-run: ${resumeCommand}\n`, asJson);
  }
  process.exitCode = 3;
}
```

Replace `outputJobResult` (with its comment) by:

```js
// Prints exactly what `result <reference>` prints — the awaited task path reuses
// it so both commands stay on one rendering — and returns the resolved job.
// `readView` (only `result` without `--wait` passes one) bounds the output to
// PUBLIC_READ_BYTES or exports it (rows 3, 4, 7); `result --wait` and
// `task --await` pass none and print the full record (rows 5, 6).
export function outputJobResult(cwd, reference, asJson, readView = null) {
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  if (isActiveJobStatus(job.status)) {
    outputActiveJobHint(buildSingleJobSnapshot(cwd, job.id), `Job ${job.id} is still ${job.status}.`, asJson, readView);
    return job;
  }

  const storedJob = readStoredJob(workspaceRoot, job.id);
  if (readView) {
    outputReadView(
      { job, storedJob },
      (view) => renderStoredJobResult(view.job, view.storedJob),
      { ...readView, asJson, summary: false, nextStep: resultNextStep(job.id) }
    );
  } else {
    outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), asJson);
  }
  return job;
}
```
`outputActiveJobHint` stays module-private (S1.2 lists it under "Not exported"; only `outputJobResult` and `waitForTerminalJobOrHint` call it). `outputJobResult` keeps the `export` S1.2 gave it (`commands/status.mjs` and `commands/task.mjs` import it).

`commands/status.mjs`: replace `handleResult` with:

```js
export async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "output"],
    booleanOptions: ["json", "wait"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  if (options["timeout-ms"] != null && !options.wait) {
    throw new Error("--timeout-ms requires --wait.");
  }
  if (options.output != null && options.wait) {
    throw new Error("--output cannot be combined with --wait; result --wait already prints the full record.");
  }
  const reference = positionals[0] ?? "";
  if (options.wait) {
    if (!reference) {
      throw new Error("`result --wait` requires a job id.");
    }
    const jobId = await waitForTerminalJobOrHint(cwd, reference, {
      timeoutMs: parseTimeoutOption(options["timeout-ms"], "--timeout-ms"),
      json: options.json
    });
    if (jobId) {
      // Row 5: the full record, exactly as 1.4.3 printed it.
      outputJobResult(cwd, jobId, options.json);
    }
    return;
  }

  // Rows 3, 4 and 7: the only caller that passes a read view.
  outputJobResult(cwd, reference, options.json, { outputPath: options.output ?? null, cwd });
}
```

`lib/cli.mjs` `printUsage` (today L119): the result line becomes

```js
      "  node scripts/codex-companion.mjs result [job-id] [--wait [--timeout-ms <ms>]] [--json] [--output <new-path>]",
```

`plugins/codex/commands/result.md` becomes (whole file):

~~~markdown
---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--output <new-path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show the stored final output for a finished Codex job by running the Bash command below, then present the output as printed.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result --args-stdin <<'CODEX_ARGS'
$ARGUMENTS
CODEX_ARGS
```

Present the command output to the user as printed. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

When the output ends with a `Truncated:` block and a `Full output:` line, it is a preview (the command prints at most 8192 bytes). Present that preview and the `Full output:` line as printed. Do not re-run the command on your own. Only when the user asks for the full text, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <id> --wait` with the job id from that line, and present its output as printed.
~~~

- [ ] **Step 4: Run** `node --import ./tests/test-env.mjs --test tests/runtime-status.test.mjs tests/runtime-task.test.mjs tests/runtime-cancel.test.mjs tests/commands.test.mjs` → all pass. Unchanged on purpose: `runtime-status.test.mjs:366-369` and `:464-467` (exact `result` text of small records: a complete view renders the projection, byte-identical to the record), `:557-562` (row 4 text still starts with the `Re-run:` line), `runtime-task.test.mjs:729-742` (`result --json` of a small record keeps `storedJob.rendered`), `:1268-1275` (row 5 timeout hint), `runtime-cancel.test.mjs:500`, `:542`. `npx eslint plugins/codex/scripts tests` exits 0.
- [ ] **Step 5: Commit**

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/commands/shared.mjs plugins/codex/scripts/commands/status.mjs plugins/codex/scripts/lib/cli.mjs plugins/codex/commands/result.md tests/runtime-status.test.mjs tests/runtime-task.test.mjs tests/commands.test.mjs && git commit -m "feat(result): bounded result preview without --wait, --output for the full JSON; /codex:result presents the preview" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

## S3a — review surface: five self-contained fixes

### Task S3a.1 (Sonnet): #714 verbatim focus through `--args-stdin` for the review commands

**Files:**
- Modify `plugins/codex/scripts/lib/args.mjs` (replace `splitRawArgumentString`, L106–160).
- Modify `plugins/codex/scripts/lib/cli.mjs`: `applyArgsStdin` (today `codex-companion.mjs:201-225`), `parseCommandInput` (today `codex-companion.mjs:238-249`), the `./args.mjs` import.
- Modify `plugins/codex/scripts/commands/review.mjs`: new `REVIEW_ARG_SPEC`; the `parseCommandInput` call in `handleReviewCommand` (today `codex-companion.mjs:952-962`).
- Modify `plugins/codex/scripts/codex-companion.mjs` (`main`): the `applyArgsStdin` call (today L1451) and the `adversarial-review` case (today L1460-1464).
- Test `tests/args.test.mjs` (import L6, append after L137), `tests/runtime-review.test.mjs` (append after L351).

**Interfaces:**
- Consumes: `parseArgs` (`lib/args.mjs:1-104`, unchanged); `readStdinIfPiped` (`lib/fs.mjs:36`); S1's `lib/cli.mjs` with `argvTokenizedFromStdin`, `applyArgsStdin`, `normalizeArgv`, `parseCommandInput`.
- Produces (S3b relies on these exact names):
  - `splitArgsWithVerbatimTail(raw: string, spec: { valueOptions?: string[], repeatableOptions?: string[], aliasMap?: Record<string,string> }): string[]` in `lib/args.mjs`. Only those three keys are read; `booleanOptions` and every other `parseArgs` key are ignored (a boolean or unknown flag consumes no value either way). Rules:
    - Tokens are the existing splitter's tokens (quotes, `\` escapes as in `splitRawArgumentString`).
    - A token that starts with `-` (not `-` alone, not `--`) is copied. If its key (after `aliasMap`, long `--k` or short `-k`) is a value or repeatable option and it is not a `--k=value` form, the next token is copied as its value, even when it starts with `-` (as `parseArgs` does).
    - `--flag=value`: one token, never consumes the next one.
    - An unknown `--flag` before the focus is copied; `parseArgs` (`rejectUnknownOptions`) then throws `Unknown option: --flag`, as today.
    - A value option at the very end without a value is copied alone; `parseArgs` throws `Missing value for --base`, as today.
    - The first token that does not start with `-` (or is `-`) ends the scan: `raw.slice(<its start offset>).trim()` becomes ONE token. After a `--` token: `"--"` plus `raw.slice(<end of -->).trim()` (omitted when empty).
    - `trim()` is `String.prototype.trim`: leading/trailing spaces, tabs, `\r`, `\n` of the tail go; everything inside (apostrophes, quotes, backslashes, newlines) stays byte for byte.
    - Empty or whitespace-only input → `[]`. An empty quoted pair (`''`) is dropped by the splitter, as today.
  - `splitRawArgumentString(raw)`: unchanged output (now `tokenizeRawArguments(raw).map((t) => t.value)`).
  - `REVIEW_ARG_SPEC` (exported const, `commands/review.mjs`) = `{ valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"], booleanOptions: ["json", "background", "wait"], repeatableOptions: ["config"], stopAtFirstPositional: true, aliasMap: { m: "model" } }`. It is today's `handleReviewCommand` table (L953-961) with `stopAtFirstPositional` fixed to `true` for both commands (spec §3.3). No accepted flag changes meaning. `review` with focus text still fails in `validateNativeReviewRequest` until S3b; only the retry text in that error now includes flag-looking words after the focus.
  - `applyArgsStdin(argv, spec = null)` in `lib/cli.mjs`. With a spec it splits stdin with `splitArgsWithVerbatimTail(raw, withCommonOptions(spec))`, otherwise with `splitRawArgumentString(raw)`. Both paths set `argvTokenizedFromStdin = true`, so a focus-only heredoc (`argv.length === 1`) is never re-split by `normalizeArgv`.
  - `withCommonOptions(config)` (module-private, `lib/cli.mjs`) adds the `help` boolean and the `C`/`h` aliases. `parseCommandInput` and `applyArgsStdin` share it, so `-C <dir>` and `-h` before the focus keep their meaning.
  - `main` passes `REVIEW_ARG_SPEC` for `review` and `adversarial-review`, `null` for every other subcommand. `lib/cli.mjs` never imports `commands/*`: the spec comes in as an argument.
  - Argv after `--args-stdin` on the real command line (`argv.slice(flagIndex + 1)`) lands after the tail token, so for the review commands it is focus text (#547 rule). The command files put every flag before `--args-stdin`.

- [ ] **Step 1: Failing unit tests.** In `tests/args.test.mjs` L6 change the import to `import { parseArgs, splitArgsWithVerbatimTail, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";` and append after L137:

```js
// The review commands' option table as applyArgsStdin hands it over:
// REVIEW_ARG_SPEC plus the shared help flag and -C/-h aliases.
const REVIEW_SPLIT_SPEC = {
  valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"],
  booleanOptions: ["help", "json", "background", "wait"],
  repeatableOptions: ["config"],
  aliasMap: { C: "cwd", h: "help", m: "model" }
};

test("splitArgsWithVerbatimTail keeps everything from the first positional as one verbatim token (#714)", () => {
  const cases = [
    ["don't mangle this", ["don't mangle this"]],
    ["--base main don't mangle \"this\"\nline 2\n", ["--base", "main", "don't mangle \"this\"\nline 2"]],
    ["focus \"quoted\" and 'single' C:\\dir\\x \\n", ["focus \"quoted\" and 'single' C:\\dir\\x \\n"]],
    ["--json\n  line 1\n\n  line 2  \n", ["--json", "line 1\n\n  line 2"]],
    ["--model sol check --model x please", ["--model", "sol", "check --model x please"]],
    ["-m sol focus", ["-m", "sol", "focus"]],
    ["-C /tmp/x focus", ["-C", "/tmp/x", "focus"]],
    ["--config k=v --config=a=b focus", ["--config", "k=v", "--config=a=b", "focus"]],
    ["--model=sol focus", ["--model=sol", "focus"]],
    ["--config 'a b=c d' focus", ["--config", "a b=c d", "focus"]],
    ["-- -x y", ["--", "-x y"]],
    ["--base main -- --model is wrong\n", ["--base", "main", "--", "--model is wrong"]],
    ["--", ["--"]],
    ["--base main --json", ["--base", "main", "--json"]],
    ["--bogus focus", ["--bogus", "focus"]],
    ["--base", ["--base"]],
    ["--base -x focus", ["--base", "-x", "focus"]],
    ["", []],
    ["  \n\t", []]
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(splitArgsWithVerbatimTail(raw, REVIEW_SPLIT_SPEC), expected, JSON.stringify(raw));
  }
});

test("splitArgsWithVerbatimTail output parses to the same options and one focus string", () => {
  const parse = (raw) =>
    parseArgs(splitArgsWithVerbatimTail(raw, REVIEW_SPLIT_SPEC), { ...REVIEW_SPLIT_SPEC, rejectUnknownOptions: true, stopAtFirstPositional: true });
  const { options, positionals } = parse("--model sol -C /tmp/x --config a=1 check --model x, don't \"stop\"\n");
  assert.equal(options.model, "sol");
  assert.equal(options.cwd, "/tmp/x");
  assert.deepEqual(options.config, ["a=1"]);
  assert.deepEqual(positionals, ["check --model x, don't \"stop\""]);
  assert.deepEqual(parse("-- --model is wrong").positionals, ["--model is wrong"]);
  assert.throws(() => parse("--base"), /Missing value for --base/);
  assert.throws(() => parse("--bogus focus"), /Unknown option: --bogus/);
});
```

- [ ] **Step 2: Failing runtime tests.** Append to `tests/runtime-review.test.mjs` after L351:

```js
// A repo on `feature` one commit ahead of `main`, clean, for `--base main`.
function featureBranchRepo() {
  const repo = seededRepo();
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello feature\n");
  run("git", ["commit", "-am", "feature"], { cwd: repo });
  return repo;
}

function focusLine(prompt) {
  return prompt.slice(prompt.indexOf("User focus:"), prompt.indexOf("</task>"));
}

test("adversarial-review --args-stdin passes the focus text verbatim (#714)", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "--base main don't mangle \"this\"\nline 2\n"
  });

  assert.equal(result.status, 0, result.stderr);
  const prompt = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt;
  assert.ok(prompt.includes("Target: branch diff against main\n"), "the flags before the focus still apply");
  assert.ok(prompt.includes("User focus: don't mangle \"this\"\nline 2\n</task>"), focusLine(prompt));
});

test("adversarial-review --args-stdin keeps a focus-only heredoc in one piece and takes -- as the end of flags", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  // One token after splitting: normalizeArgv must not re-split it.
  const only = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "don't stop\n" });
  assert.equal(only.status, 0, only.stderr);
  let turn = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart;
  assert.ok(turn.prompt.includes("User focus: don't stop\n</task>"), focusLine(turn.prompt));

  const dashed = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "-- --model is wrong\n" });
  assert.equal(dashed.status, 0, dashed.stderr);
  turn = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart;
  assert.ok(turn.prompt.includes("User focus: --model is wrong\n</task>"), focusLine(turn.prompt));
  assert.equal(turn.model, null, "--model after -- is focus text, not a flag");
});

test("review --args-stdin with flags only still runs the built-in reviewer", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "--base main\n" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed changes against main/);
});
```

- [ ] **Step 3:** `node --import ./tests/test-env.mjs --test tests/args.test.mjs` → FAIL: `SyntaxError: The requested module '../plugins/codex/scripts/lib/args.mjs' does not provide an export named 'splitArgsWithVerbatimTail'`. `node --import ./tests/test-env.mjs --test --test-name-pattern "args-stdin" tests/runtime-review.test.mjs` → FAIL on "passes the focus text verbatim" with the message `User focus: dont mangle "this"\nline 2\n` (the apostrophe opened a quote), and on "focus-only heredoc" with `User focus: dont stop`. The `--` half and the flags-only review test already pass: they pin behaviour that must not change.

- [ ] **Step 4: Implement `lib/args.mjs`.** Replace L106–160 (`splitRawArgumentString`) with:

```js
// The shell-like splitter, with each token's start/end offset in `raw`, so a
// caller can take the rest of the raw string verbatim from any token.
function tokenizeRawArguments(raw) {
  const tokens = [];
  let current = "";
  let start = -1;
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start === -1 && !/\s/.test(character)) {
      start = index;
    }
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      const next = raw[index + 1];
      if (next === "\"" || next === "'" || next === "\\" || /\s/.test(next ?? "")) {
        escaping = true;
        continue;
      }
      current += "\\";
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push({ value: current, start, end: index });
      }
      current = "";
      start = -1;
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push({ value: current, start, end: raw.length });
  }

  return tokens;
}

export function splitRawArgumentString(raw) {
  return tokenizeRawArguments(raw).map((token) => token.value);
}

// Review focus text is free prose (#714): split flags shell-like up to the first
// positional (or `--`), then hand the rest of the raw string over as ONE token,
// trimmed, with quotes, apostrophes, backslashes and newlines untouched. `spec`
// is the parseArgs config; only valueOptions, repeatableOptions and aliasMap
// matter here — they say which flag swallows the next token as its value.
export function splitArgsWithVerbatimTail(raw, spec = {}) {
  const takesValue = new Set([...(spec.valueOptions ?? []), ...(spec.repeatableOptions ?? [])]);
  const aliasMap = spec.aliasMap ?? {};
  const tokens = tokenizeRawArguments(raw);
  const argv = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const { value, start, end } = tokens[index];
    if (value === "--") {
      const tail = raw.slice(end).trim();
      return tail ? [...argv, "--", tail] : [...argv, "--"];
    }
    if (!value.startsWith("-") || value === "-") {
      return [...argv, raw.slice(start).trim()];
    }
    argv.push(value);
    const isLong = value.startsWith("--");
    if (isLong && value.includes("=")) {
      continue;
    }
    const name = value.slice(isLong ? 2 : 1);
    if (takesValue.has(aliasMap[name] ?? name) && index + 1 < tokens.length) {
      index += 1;
      argv.push(tokens[index].value);
    }
  }

  return argv;
}
```

- [ ] **Step 5: Implement `lib/cli.mjs`.** Add `splitArgsWithVerbatimTail` to the `./args.mjs` import (`import { parseArgs, splitArgsWithVerbatimTail, splitRawArgumentString } from "./args.mjs";`). Replace `applyArgsStdin` (moved by S1 from today `codex-companion.mjs:201-225`; keep the `export` S1 gave it and the comment block above `ARGS_STDIN_FLAG`) and `parseCommandInput` (today `:238-249`) with:

```js
// The defaults every command parser shares. applyArgsStdin needs them too, so
// `-C <dir>` and `-h` keep their meaning in front of a verbatim review focus.
function withCommonOptions(config = {}) {
  return {
    rejectUnknownOptions: true,
    ...config,
    booleanOptions: ["help", ...(config.booleanOptions ?? [])],
    aliasMap: {
      C: "cwd",
      h: "help",
      ...(config.aliasMap ?? {})
    }
  };
}

// `spec` (the review commands' option table, passed in by main) keeps the focus
// text after the flags verbatim (#714); without it stdin splits shell-like.
export function applyArgsStdin(argv, spec = null) {
  const flagIndex = argv.indexOf(ARGS_STDIN_FLAG);

  // Decided before anything reads stdin: both flags consume it and it can only
  // be read once. `--prompt-stdin` therefore has to be on the command line, and
  // is never visible inside the `--args-stdin` heredoc.
  if (argv.includes(PROMPT_STDIN_FLAG)) {
    if (flagIndex !== -1) {
      throw new Error(
        `${PROMPT_STDIN_FLAG} cannot be combined with ${ARGS_STDIN_FLAG}; put flags on the command line.`
      );
    }
    return argv;
  }

  if (flagIndex === -1) {
    return argv;
  }
  // Set on both paths: a focus-only heredoc is one token, and normalizeArgv must
  // not re-split it as the single-string argv form.
  argvTokenizedFromStdin = true;
  const raw = readStdinIfPiped();
  const tokens = spec ? splitArgsWithVerbatimTail(raw, withCommonOptions(spec)) : splitRawArgumentString(raw);
  return [...argv.slice(0, flagIndex), ...tokens, ...argv.slice(flagIndex + 1)];
}
```

```js
export function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), withCommonOptions(config));
}
```
(Keep `export` on `parseCommandInput` exactly as S1 has it.)

- [ ] **Step 6: Implement `commands/review.mjs`.** Above `handleReviewCommand` add:

```js
// One option table for `review` and `adversarial-review`. main hands it to
// applyArgsStdin so `--args-stdin` knows which flags take a value before the
// verbatim focus (#714). Text after the first positional is focus even when
// it looks like a flag (#547).
export const REVIEW_ARG_SPEC = {
  valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"],
  booleanOptions: ["json", "background", "wait"],
  repeatableOptions: ["config"],
  stopAtFirstPositional: true,
  aliasMap: { m: "model" }
};
```
and replace the `parseCommandInput(argv, { … })` call in `handleReviewCommand` (today `codex-companion.mjs:952-962`, including the two-line `#547` comment) with `const { options, positionals } = parseCommandInput(argv, REVIEW_ARG_SPEC);`. `config.acceptsFocusText` is no longer read.

- [ ] **Step 7: Implement `main`** (`codex-companion.mjs`). Add `REVIEW_ARG_SPEC` to the existing `./commands/review.mjs` import. Replace `const argv = applyArgsStdin(rawArgv);` (today L1451) with:

```js
  // Review commands keep their focus text verbatim (#714); the rest split shell-like.
  const argv = applyArgsStdin(rawArgv, subcommand === "review" || subcommand === "adversarial-review" ? REVIEW_ARG_SPEC : null);
```
and in the `adversarial-review` case (today L1460-1464) drop the `acceptsFocusText: true` line, so the call passes `{ reviewName: "Adversarial Review" }`.

- [ ] **Step 8:** `node --import ./tests/test-env.mjs --test tests/args.test.mjs tests/runtime-review.test.mjs tests/runtime-task.test.mjs tests/runtime-status.test.mjs tests/module-boundaries.test.mjs` → all pass. Pinned: `runtime-review.test.mjs:219` (same tokens either way), `runtime-task.test.mjs:865` (`task --args-stdin` unchanged), `runtime-status.test.mjs:525`, the `args.test.mjs:112-137` splitter semantics. `args.mjs` stays a leaf.

- [ ] **Step 9: Commit** (gate chain):

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/args.mjs plugins/codex/scripts/lib/cli.mjs plugins/codex/scripts/commands/review.mjs plugins/codex/scripts/codex-companion.mjs tests/args.test.mjs tests/runtime-review.test.mjs && git commit -F - <<'MSG'
fix(review): pass --args-stdin focus text verbatim to the review commands (#714)

Co-authored-by: ALV0612 <136440668+ALV0612@users.noreply.github.com>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task S3a.2 (Sonnet): #653 refuse an explicit `--base` that is not a local commit

**Files:**
- Modify `plugins/codex/scripts/lib/git.mjs` (new helper above `resolveReviewTarget` L135; the explicit-base branch L143-150).
- Test `tests/git.test.mjs` (append after L212), `tests/runtime-review.test.mjs` (import block L6-16, append at the end).

**Interfaces:**
- Consumes: `git()` (`lib/git.mjs:12`, `shell: false`).
- Produces: `resolveReviewTarget(cwd, options)` throws `Base ref "<ref>" not found in this repository; pass a branch, tag or commit that resolves locally (git fetch it first for a remote ref).` for an explicit `options.base` that starts with `-` or that `git rev-parse --verify --quiet <ref>^{commit}` rejects (exit ≠ 0). The `-` check runs first, so git never sees such a ref (`-x^{commit}` would still start with `-`). The return shape is unchanged. Detected bases (`scope: branch`, clean-tree `auto`) are not re-checked: `detectDefaultBranch` (L94-116) verifies them with `show-ref`.
- Callers (all pass the user's `--base`): `handleReviewCommand` (today `codex-companion.mjs:974`, before `createCompanionJob` at `:981`) and `executeReviewRun` (today `:529`, the worker's re-resolve after S3b). No caller passes a base that is not user-supplied. So the refusal happens before any job record, request file or `codex` start in both commands.
- Probe on HEAD: `rev-parse --verify --quiet` exits 1 for `nope` and for a tree sha (the tree sha also prints `expected commit type` to stderr, which `git()` captures), and 0 for `main`, a tag, a commit sha and `origin/main` after `update-ref`.

- [ ] **Step 1: Failing unit tests.** Append to `tests/git.test.mjs`:

```js
function baseRefRepo() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["tag", "v1"], { cwd });
  run("git", ["update-ref", "refs/remotes/origin/main", "main"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  return cwd;
}

const baseNotFound = (ref) =>
  `Base ref "${ref}" not found in this repository; pass a branch, tag or commit that resolves locally (git fetch it first for a remote ref).`;

test("resolveReviewTarget refuses an explicit base that is not a local commit (#653)", () => {
  const cwd = baseRefRepo();
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd }).stdout.trim();
  for (const ref of ["nope", tree, "-x", "--output=/tmp/owned"]) {
    assert.throws(() => resolveReviewTarget(cwd, { base: ref }), { message: baseNotFound(ref) }, ref);
  }
});

test("resolveReviewTarget accepts a branch, tag, sha and remote-tracking base", () => {
  const cwd = baseRefRepo();
  const sha = run("git", ["rev-parse", "main"], { cwd }).stdout.trim();
  for (const ref of ["main", "v1", sha, "origin/main"]) {
    assert.deepEqual(resolveReviewTarget(cwd, { base: ref }), { mode: "branch", label: `branch diff against ${ref}`, baseRef: ref, explicit: true }, ref);
  }
});
```

- [ ] **Step 2: Failing runtime test.** In `tests/runtime-review.test.mjs` add after the helpers import (L16) `import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";` and append:

```js
test("review and adversarial-review refuse an unresolvable --base before any job or Codex start (#653)", () => {
  for (const command of ["review", "adversarial-review"]) {
    for (const ref of ["nope", "-x"]) {
      const repo = seededRepo();
      const binDir = makeTempDir();
      installFakeCodex(binDir);
      fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
      const label = `${command} --base ${ref}`;

      const result = run(process.execPath, [SCRIPT, command, "--base", ref], { cwd: repo, env: buildEnv(binDir) });

      assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
      assert.ok(
        result.stderr.includes(`Base ref "${ref}" not found in this repository; pass a branch, tag or commit that resolves locally (git fetch it first for a remote ref).`),
        `${label}: ${result.stderr}`
      );
      // Failing before the job means no state was written at all.
      const indexPath = path.join(resolveStateDir(repo), "state.json");
      assert.deepEqual(fs.existsSync(indexPath) ? readStateIndex(repo).jobs : [], [], `${label}: no job record`);
      // The fake bumps appServerStarts on every `codex app-server` launch (fake-codex-fixture.mjs:288).
      const fakeStatePath = path.join(binDir, "fake-codex-state.json");
      const starts = fs.existsSync(fakeStatePath) ? JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts : 0;
      assert.equal(starts, 0, `${label}: no app-server start`);
    }
  }
});
```

- [ ] **Step 3:** `node --import ./tests/test-env.mjs --test --test-name-pattern "base" tests/git.test.mjs tests/runtime-review.test.mjs` → FAIL: `Missing expected exception` for `nope` in git.test. The runtime test fails on `review --base nope` with exit 0: the fake reviews `baseBranch: "nope"` without checking it. The accept test passes (a pin).

- [ ] **Step 4: Implement.** In `lib/git.mjs` add above `resolveReviewTarget` (L135):

```js
// An explicit --base must name a commit in this repository: an unknown ref used
// to widen the review silently (#653), and a `-`-leading one reached
// `git merge-base` as an option. The `-` check comes first, so git never sees it.
function assertBaseRefResolves(cwd, baseRef) {
  if (baseRef.startsWith("-") || git(cwd, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).status !== 0) {
    throw new Error(
      `Base ref "${baseRef}" not found in this repository; pass a branch, tag or commit that resolves locally (git fetch it first for a remote ref).`
    );
  }
}
```
and in `resolveReviewTarget` replace L143 `if (baseRef) {` with:

```js
  if (baseRef) {
    assertBaseRefResolves(cwd, baseRef);
```
(the `return { mode: "branch", … }` block L144-149 stays).

- [ ] **Step 5:** `node --import ./tests/test-env.mjs --test tests/git.test.mjs tests/runtime-review.test.mjs` → all pass (L70 `honors explicit base overrides` and the `--base main` runtime tests still resolve).

- [ ] **Step 6: Commit** (gate chain):

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/git.mjs tests/git.test.mjs tests/runtime-review.test.mjs && git commit -F - <<'MSG'
fix(review): refuse a --base that does not resolve to a local commit (#653)

Co-authored-by: Jacob Babula <301920471+jacobbabula@users.noreply.github.com>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task S3a.3 (Sonnet): #583 recover structured output from a fence or prose, as the sister plugin does

**Files:**
- Modify `plugins/codex/scripts/lib/codex.mjs` (`parseStructuredOutput`, L1469-1494). It stays in `codex.mjs`: that module is not a leaf (`module-boundaries.test.mjs:11` `LEAVES`), and its only production caller imports it from there. No new module.
- Create `tests/codex-structured-output.test.mjs`.

**Interfaces:**
- Consumes: nothing new. Port of `cc-plugin-codex/scripts/lib/structured-output.mjs` (HEAD 66846d9): `extractFirstJsonObject` L5-59 and the recovery chain of `parseStructuredOutput` L61-96. The sister's strings are not taken ("No output from Claude Code.", "Could not parse structured JSON output from Claude Code.").
- Produces: `parseStructuredOutput(rawOutput, fallback)` keeps its signature, its return shape `{ parsed, parseError, rawOutput, ...fallback }` and its empty-output behaviour (`!rawOutput` → `fallback.failureMessage ?? "Codex did not return a final structured message."`). The recovery order on the trimmed message:
  1. The whole message parsed as JSON.
  2. The first fenced block anywhere in the message: `/```(?:json)?\s*\n([\s\S]*?)\r?\n```/`.
     - This is the sister's regex, except the closing `\n` became `\r?\n`, so a CRLF block's `\r` is not captured.
     - The sister's own regex also handles CRLF (its `\s*` eats the opening `\r`, and `JSON.parse` tolerates the captured trailing `\r`); the `\r?` just keeps the capture clean.
     - The spec's anchored whole-message regex is dropped: every row of the spec table passes with the unanchored one (probe).
  3. The first balanced `{…}` that parses (module-private `extractFirstJsonObject(text): object | null`).
     - The scan knows JSON strings and `\` escapes, so braces inside strings do not count.
     - A candidate that fails to parse moves the scan to the next `{`.
  - `rawOutput` is always the raw, untrimmed message.
  - When nothing parses, `parseError` is the whole message's `JSON.parse` error message, as today. Malformed JSON, prose without an object and empty output still fail.
- Accepted risk, pinned by a test: a prose reply that quotes an object is parsed as that object. If the quoted object has the review shape, it is rendered as the review.
- The consumer already guards against wrong shapes, so nothing is planned there. The only caller is `executeReviewRun` (today `codex-companion.mjs:594-632`), which stores `result: parsed.parsed`, `parseError` and `rawOutput` and renders with `renderReviewResult`.
  - That renderer validates the shape (`render.mjs:26-43` `validateReviewResultShape`: string `verdict`, string `summary`, array `findings`, array `next_steps`). A wrong-shaped object gets `Codex returned JSON with an unexpected review shape.` with `- Validation error: …` and the raw final message (`render.mjs:237-255`, pinned by `tests/render.test.mjs:25`). It is never rendered as an empty or "no findings" review.
  - `result` prints the stored `rendered` (`render.mjs:400`). The job summary falls back to `firstMeaningfulLine` when `summary` is missing (today `codex-companion.mjs:632`).
  - The stop gate does not use `parseStructuredOutput` (it reads `ALLOW:`/`BLOCK:`, `stop-review-gate-hook.mjs:119-123`).
  - One gap stays, and it predates this change for bare wrong-shaped JSON: in `--json`, a wrong-shaped object appears as `result` with `parseError: null`.

- [ ] **Step 1: Failing test.** Create `tests/codex-structured-output.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutput } from "../plugins/codex/scripts/lib/codex.mjs";

const REVIEW = { verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] };
const BODY = JSON.stringify(REVIEW);
const TICKS = { ...REVIEW, summary: "use ``` fences" };

// Recovery chain ported from cc-plugin-codex (#583): whole message, first fenced
// block, first balanced object that parses. rawOutput is always the raw message.
test("parseStructuredOutput recovers JSON from the whole message, a fenced block or embedded prose (#583)", () => {
  const rows = [
    ["bare", BODY, REVIEW],
    ["json fence", "```json\n" + BODY + "\n```", REVIEW],
    ["untagged fence", "```\n" + BODY + "\n```", REVIEW],
    ["CRLF fence with surrounding whitespace", "\r\n```json\r\n" + BODY + "\r\n```\r\n", REVIEW],
    ["backticks inside a string", "```json\n" + JSON.stringify(TICKS) + "\n```", TICKS],
    ["fenced block after a prose preface", "Here is my review:\n\n```json\n" + BODY + "\n```\nThanks.", REVIEW],
    ["a fenced block wins over an earlier prose object", "Format: {\"verdict\":\"x\"}.\n```json\n" + BODY + "\n```", REVIEW],
    ["prose with one embedded object", "Now I have all the evidence.\n\n" + BODY + "\n", REVIEW],
    ["broken first object, valid later one", 'prefix {"bad": } middle {"ok":true}', { ok: true }],
    ["braces inside a JSON string", 'noise {"message":"brace: \\"{\\"","nested":{"ok":true}} tail', { message: 'brace: "{"', nested: { ok: true } }],
    ["nested objects", 'Intro\n\n{"ok":true,"nested":{"a":1}}\n', { ok: true, nested: { a: 1 } }]
  ];
  for (const [label, raw, expected] of rows) {
    const result = parseStructuredOutput(raw, { status: 0 });
    assert.deepEqual(result.parsed, expected, label);
    assert.equal(result.parseError, null, label);
    assert.equal(result.rawOutput, raw, `${label}: rawOutput stays the raw message`);
    assert.equal(result.status, 0, `${label}: fallback fields still spread`);
  }
});

test("parseStructuredOutput still fails on malformed JSON, prose without an object and empty output", () => {
  const rows = [
    ["malformed inside a fence", "```json\n{not json}\n```"],
    ["truncated object", '{"verdict":"approve","summary":'],
    ["prose without an object", "Looks good to me."]
  ];
  for (const [label, raw] of rows) {
    const result = parseStructuredOutput(raw);
    assert.equal(result.parsed, null, label);
    assert.ok(result.parseError, label);
    assert.equal(result.rawOutput, raw, label);
  }
  const empty = parseStructuredOutput("", {});
  assert.deepEqual([empty.parsed, empty.parseError, empty.rawOutput], [null, "Codex did not return a final structured message.", ""]);
});

// Accepted risk (spec §Limits): a reply that only quotes an object is read as
// that object. A quoted review-shaped object therefore renders as a review.
test("parseStructuredOutput takes an object quoted in prose as the answer", () => {
  const raw = `The expected format is ${BODY}, but I could not finish the review.`;
  const result = parseStructuredOutput(raw);
  assert.deepEqual(result.parsed, REVIEW);
  assert.equal(result.parseError, null);
  assert.equal(result.rawOutput, raw);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/codex-structured-output.test.mjs` → FAIL: the first test at `json fence` (`parsed` is `null`, expected the review object); the third test (`null` instead of the review object). The second test passes: it pins behaviour that must not change.

- [ ] **Step 3: Implement.** Replace L1469-1494 of `lib/codex.mjs` with:

```js
// Codex sometimes wraps its schema answer in a markdown fence or in prose (#583).
// Recovery, ported from cc-plugin-codex: the whole message, else the first
// fenced block, else the first balanced `{…}` that parses. A reply that only
// quotes an object is therefore read as that object (spec §Limits).
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*\n([\s\S]*?)\r?\n```/;

// First balanced `{…}` in `text` that parses. The scan knows JSON strings and
// `\` escapes, so braces inside strings do not count; a candidate that fails to
// parse moves the scan to the next `{`.
function extractFirstJsonObject(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const text = rawOutput.trim();
  const whole = tryParseJson(text);
  if (whole.ok) {
    return { parsed: whole.value, parseError: null, rawOutput, ...fallback };
  }
  const fenced = FENCED_BLOCK_PATTERN.exec(text);
  const fromFence = fenced ? tryParseJson(fenced[1]) : null;
  if (fromFence?.ok) {
    return { parsed: fromFence.value, parseError: null, rawOutput, ...fallback };
  }
  const embedded = extractFirstJsonObject(text);
  if (embedded !== null) {
    return { parsed: embedded, parseError: null, rawOutput, ...fallback };
  }
  return { parsed: null, parseError: whole.error.message, rawOutput, ...fallback };
}
```

- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/codex-structured-output.test.mjs tests/runtime-review.test.mjs tests/render.test.mjs` → all pass (`render.test.mjs:25`, the unexpected-shape rendering, is unchanged). `lib/codex.mjs` is typechecked (`tsconfig.app-server.json`): the new functions use no typed API.

- [ ] **Step 5: Commit** (gate chain):

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/codex.mjs tests/codex-structured-output.test.mjs && git commit -F - <<'MSG'
fix(review): recover structured output from a code fence or surrounding prose (#583)

Co-authored-by: andyli953 <189941205+andyli953@users.noreply.github.com>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task S3a.4 (Sonnet): #405 cap untracked content and the adversarial prompt

**Files:** (line numbers are HEAD's; S3a.2 inserts ~10 lines above `resolveReviewTarget`, so match on the quoted text)
- Modify `plugins/codex/scripts/lib/git.mjs`:
  - constant after L9;
  - `formatUntrackedFile` (L197-223): `lstatSync` and a symlink skip;
  - new `formatUntrackedBody` and `readGitOutputWithin` after `formatUntrackedFile`;
  - `collectWorkingTreeContext` (L225-260) and `collectBranchContext` (L262-290): bounded inline diff reads with a self-collect fallback, both untracked sections through `formatUntrackedBody`;
  - `export` on `buildAdversarialCollectionGuidance` (L292);
  - `collectReviewContext` (L300-347): the collectors get `maxInlineDiffBytes`; `inputMode`/`collectionGuidance` follow what was actually inlined.
- Modify `plugins/codex/scripts/commands/review.mjs`: `buildAdversarialReviewPrompt` (today `codex-companion.mjs:371-380`); its call in `executeReviewRun` (today `:583`); the `../lib/git.mjs` import.
- Test `tests/git.test.mjs` (append at the end); create `tests/review-prompt.test.mjs`.

**Interfaces:**
- Consumes: `formatUntrackedFile` (L197), `formatSection` (L193), `loadPromptTemplate`/`interpolateTemplate` (`lib/prompts.mjs`), `ROOT_DIR` (`lib/cli.mjs`, S1), `request.onProgress`. `request.onProgress` accepts a bare string and appends it to the job log (and to stderr in the foreground): `createProgressReporter`, `tracked-jobs.mjs:164-171`.
- Produces:
  - `export const MAX_UNTRACKED_TOTAL_BYTES = 262144` (`lib/git.mjs`).
    - Both modes build the untracked section through `formatUntrackedBody(cwd, files)`. The section is formatted today at L234 (inline, `includeDiff`) and L244 (self-collect): the same `state.untracked.map(formatUntrackedFile).join("\n\n")`, so self-collect inlines file bodies too.
    - The budget counts the UTF-8 bytes of each formatted entry plus the 2-byte `\n\n` separator.
    - At the first entry that does not fit, that entry and every later file are left out (the later ones are never stat'ed or read). One line is added in their place: `(<N> untracked file(s) omitted: aggregate untracked content exceeds the 262144 byte limit; see Git Status for the full list and inspect them directly.)`. The line itself is outside the budget.
    - Git Status (`status --short --untracked-files=all`, L227) still lists every file.
  - Untracked symlinks are never followed. Today `formatUntrackedFile` calls `statSync` (L201), which follows the link, and then `readFileSync` (L214) copies the target into the prompt, even a file outside the repository. With `lstatSync`:
    - a link whose target exists → `### <path>\n(skipped: symlink)` (the sister's wording, `cc-plugin-codex/scripts/lib/git.mjs:329-331`);
    - a broken link → today's `(skipped: broken symlink or unreadable file)` (`fs.existsSync` follows the link to tell the two apart; it reads nothing).
    - Directories are unchanged (`(skipped: directory)`). A symlink to a directory now reads `(skipped: symlink)` instead of `(skipped: directory)`.
    - A skipped link is an ordinary entry for the cap: it costs its one skip line plus the separator. Past the cap it is counted in `<N>` of the omission line like any other file.
  - The inline diff is bounded where it is read. Today the probe (`measureGitOutputBytes`, L40-52, `maxBuffer: maxBytes + 1`) and the real read are separate git calls, and the real read has no bound:
    - It uses `gitChecked` (working tree L232-233, branch L279), so `git()` (L12-14) → `runCommand` (`process.mjs:217-222`) passes `maxBuffer: undefined`, which is spawnSync's 1 MiB default.
    - A diff that grew past 1 MiB after the probe fails there: spawnSync sets `error.code === "ENOBUFS"`, and `runCommandChecked` (`process.mjs:245-254`) throws that raw error, so the review fails before the prompt ceiling runs.
    - A diff that grew to under 1 MiB is inlined in full, past the cap.
  - The fix is a new module-private `readGitOutputWithin(cwd, args, maxBytes): string | null`, the probe's own pattern:
    - it calls `git(cwd, args, { maxBuffer: max(0, maxBytes) + 1 })`;
    - `ENOBUFS` or more than `maxBytes` bytes → `null`;
    - any other error or a non-zero exit throws, as today.
  - Where it is used:
    - Working tree: staged diff within `maxInlineDiffBytes`, unstaged within the rest.
    - Branch: the branch diff within `maxInlineDiffBytes`.
    - A `null` read falls back to the existing self-collect sections.
  - Both collectors return `inlined: boolean`. `collectReviewContext` derives `inputMode` and `collectionGuidance` from it rather than from the planned `includeDiff`, and strips it from the returned context.
  - No seam is added. The existing `options.includeDiff: true` override (L319-320, L332) skips the probe's decision and stands in for "measured small, grew before collection". Combined with `maxInlineDiffBytes: 128`, it drives the collection read over its bound. The companion never passes `options` (today `codex-companion.mjs:582`), so production behaviour differs only in the bounded read.
  - `export function buildAdversarialCollectionGuidance(options)` (`lib/git.mjs`, unchanged body).
  - `export const MAX_REVIEW_PROMPT_CHARS = 786432` and `export function buildAdversarialReviewPrompt(context, focusText, onLog = null): string` (`commands/review.mjs`).
    - When the interpolated prompt is ≤ the ceiling it is returned unchanged and `onLog` is not called.
    - Otherwise `REVIEW_COLLECTION_GUIDANCE` becomes `buildAdversarialCollectionGuidance({ includeDiff: false })` (the self-collect text). `REVIEW_INPUT` becomes `content.slice(0, lastNewline + 1)` + `[Repository context truncated at <N> characters: inspect the target yourself with read-only git commands before finalizing findings.]`.
    - The kept part ends with its newline, so the marker is on its own line. `<N>` = kept characters of `context.content`.
    - `onLog` gets `Review context truncated to fit the prompt ceiling (<N> of <M> characters).` with `<M>` = `context.content.length`.
    - The result is ≤ 786432 characters, unless the frame alone (template + focus text) is over the ceiling. In that case the context is dropped entirely and the prompt is still over (not handled; focus text of ~780 K characters).
  - `executeReviewRun` passes `request.onProgress` as `onLog`.

- [ ] **Step 1: Failing tests.** Append to `tests/git.test.mjs`:

```js
test("collectReviewContext caps aggregate untracked content in both modes and counts what it left out (#405)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const body = `${"x".repeat(99)}\n`.repeat(200); // 20,000 bytes of text, under the 24 KiB per-file limit
  for (let index = 0; index < 300; index += 1) {
    fs.writeFileSync(path.join(cwd, `untracked-${String(index).padStart(3, "0")}.txt`), body);
  }
  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const header = "## Untracked Files\n\n";
  const notice = /\n\((\d+) untracked file\(s\) omitted: aggregate untracked content exceeds the 262144 byte limit; see Git Status for the full list and inspect them directly\.\)\n/;

  for (const includeDiff of [false, true]) {
    const context = collectReviewContext(cwd, target, { includeDiff });
    const mode = context.inputMode;
    const section = context.content.slice(context.content.indexOf(header));
    const match = notice.exec(section);
    assert.ok(match, `${mode}: omission notice missing`);
    const inlined = section.slice(header.length, match.index - 1);
    assert.ok(Buffer.byteLength(inlined, "utf8") <= 262144, `${mode}: ${Buffer.byteLength(inlined, "utf8")} bytes inlined`);
    const kept = (inlined.match(/^### /gm) ?? []).length;
    assert.ok(kept > 0, `${mode}: some files still inlined`);
    assert.equal(kept + Number(match[1]), 300, `${mode}: every file is inlined or counted`);
    assert.match(context.content, /untracked-299\.txt/, `${mode}: Git Status still lists every file`);
  }
});

// Ported from cc-plugin-codex tests/git.test.mjs:85, with the target outside the repository.
// No win32 skip: the broken-symlink test above (L135) already creates symlinks on windows-latest.
test("collectReviewContext never inlines an untracked symlink's target, even outside the repository", () => {
  const outside = makeTempDir();
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_SECRET_MARKER\n");
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "outside-link"));

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  for (const includeDiff of [false, true]) {
    const context = collectReviewContext(cwd, target, { includeDiff });
    assert.doesNotMatch(context.content, /OUTSIDE_SECRET_MARKER/, `${context.inputMode}: the link target leaked into the prompt`);
    assert.match(context.content, /### outside-link\n\(skipped: symlink\)/, context.inputMode);
  }
});

// `includeDiff: true` overrides the probe's decision: it stands in for a diff
// that measured small and grew before collection. The collection read itself
// must stay within the cap and fall back to self-collect, never throw ENOBUFS.
test("collectReviewContext falls back to self-collect when the inline diff read outgrows the cap", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);
  const working = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }), { includeDiff: true, maxInlineDiffBytes: 128 });
  run("git", ["checkout", "-b", "feature/grow"], { cwd });
  run("git", ["commit", "-am", "grow"], { cwd });
  const branch = collectReviewContext(cwd, resolveReviewTarget(cwd, { base: "main" }), { includeDiff: true, maxInlineDiffBytes: 128 });
  for (const context of [working, branch]) {
    const mode = context.target.mode;
    assert.equal(context.inputMode, "self-collect", mode);
    assert.match(context.collectionGuidance, /lightweight summary/i, mode);
    assert.doesNotMatch(context.content, /xxx/, mode);
    assert.match(context.content, /## Changed Files/, mode);
  }
});
```

Create `tests/review-prompt.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildAdversarialReviewPrompt, MAX_REVIEW_PROMPT_CHARS } from "../plugins/codex/scripts/commands/review.mjs";

const inlineContext = (content) => ({
  target: { label: "working tree diff" },
  collectionGuidance: "Use the repository context below as primary evidence.",
  content
});

test("buildAdversarialReviewPrompt leaves a prompt under the ceiling untouched", () => {
  const logs = [];
  const prompt = buildAdversarialReviewPrompt(inlineContext("## Git Status\n\nM app.js\n"), "auth", (message) => logs.push(message));
  assert.match(prompt, /primary evidence/);
  assert.match(prompt, /M app\.js/);
  assert.doesNotMatch(prompt, /Repository context truncated/);
  assert.deepEqual(logs, []);
});

test("buildAdversarialReviewPrompt cuts a 1 MB context at a line and switches to self-collect guidance (#405)", () => {
  const line = `${"y".repeat(63)}\n`;
  const content = line.repeat(16384); // 1,048,576 characters
  const logs = [];
  const prompt = buildAdversarialReviewPrompt(inlineContext(content), "auth", (message) => logs.push(message));

  assert.equal(MAX_REVIEW_PROMPT_CHARS, 786432);
  assert.ok(prompt.length <= MAX_REVIEW_PROMPT_CHARS, `prompt is ${prompt.length} characters`);
  const marker = /\n\[Repository context truncated at (\d+) characters: inspect the target yourself with read-only git commands before finalizing findings\.\]\n/.exec(prompt);
  assert.ok(marker, "truncation marker missing");
  const kept = Number(marker[1]);
  assert.equal(kept % line.length, 0, "cut after a whole line");
  assert.ok(prompt.includes(`${content.slice(0, kept)}[Repository context truncated at ${kept} characters`), "the kept part is the context's prefix");
  assert.match(prompt, /Inspect the target diff yourself with read-only git commands before finalizing findings\./);
  assert.doesNotMatch(prompt, /primary evidence/);
  assert.deepEqual(logs, [`Review context truncated to fit the prompt ceiling (${kept} of ${content.length} characters).`]);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/git.test.mjs tests/review-prompt.test.mjs` → FAIL in git.test with three messages:
  - `self-collect: omission notice missing`;
  - `self-collect: the link target leaked into the prompt` (the content holds `### outside-link` followed by a fenced `OUTSIDE_SECRET_MARKER`);
  - `working-tree` from `'inline-diff' !== 'self-collect'` (these three were checked on a HEAD copy).

  In review-prompt: `SyntaxError: The requested module '../plugins/codex/scripts/commands/review.mjs' does not provide an export named 'MAX_REVIEW_PROMPT_CHARS'` (or `buildAdversarialReviewPrompt`, if S1 left it unexported).

- [ ] **Step 3: Implement `lib/git.mjs`.** After L9 (`DEFAULT_INLINE_DIFF_MAX_BYTES`) add:

```js
// The whole untracked section's budget, in both input modes (#405).
export const MAX_UNTRACKED_TOTAL_BYTES = 262144;
```
After `formatUntrackedFile` (ends L223) add:

```js
// Past the budget the remaining files are only listed in Git Status: they are
// counted, never stat'ed or read.
function formatUntrackedBody(cwd, files) {
  const entries = [];
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    const entry = formatUntrackedFile(cwd, file);
    const entryBytes = Buffer.byteLength(entry, "utf8") + (entries.length > 0 ? 2 : 0);
    if (totalBytes + entryBytes > MAX_UNTRACKED_TOTAL_BYTES) {
      entries.push(
        `(${files.length - index} untracked file(s) omitted: aggregate untracked content exceeds the ${MAX_UNTRACKED_TOTAL_BYTES} byte limit; see Git Status for the full list and inspect them directly.)`
      );
      break;
    }
    entries.push(entry);
    totalBytes += entryBytes;
  }
  return entries.join("\n\n");
}
```
In `formatUntrackedFile` replace L199-205 (from `let stat;` through the `isDirectory` check's opening line) with:

```js
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  // Never follow a link: its target may live outside the repository.
  if (stat.isSymbolicLink()) {
    return fs.existsSync(absolutePath)
      ? `### ${relativePath}\n(skipped: symlink)`
      : `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
```
(the rest of the function, L206-223, stays).

After `formatUntrackedBody` add:

```js
// The inline read carries the probe's bound itself: a diff that grew past it
// after it was measured gives null (self-collect) instead of ENOBUFS from
// spawnSync's 1 MiB default or an unbounded prompt.
function readGitOutputWithin(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: Math.max(0, maxBytes) + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return null;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8") > maxBytes ? null : result.stdout;
}
```
Replace `collectWorkingTreeContext` (L225-260) with:

```js
function collectWorkingTreeContext(cwd, state, options = {}) {
  const maxDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let stagedDiff = null;
  let unstagedDiff = null;
  if (options.includeDiff !== false) {
    stagedDiff = readGitOutputWithin(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"], maxDiffBytes);
    unstagedDiff =
      stagedDiff === null
        ? null
        : readGitOutputWithin(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"], maxDiffBytes - Buffer.byteLength(stagedDiff, "utf8"));
  }
  const inlined = unstagedDiff !== null;

  let parts;
  if (inlined) {
    const untrackedBody = formatUntrackedBody(cwd, state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = formatUntrackedBody(cwd, state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
    inlined
  };
}
```
Replace `collectBranchContext` (L262-290) with:

```js
function collectBranchContext(cwd, baseRef, options = {}) {
  const maxDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();
  const branchDiff =
    options.includeDiff === false
      ? null
      : readGitOutputWithin(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange], maxDiffBytes);

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: branchDiff !== null
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Branch Diff", branchDiff)
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison,
    inlined: branchDiff !== null
  };
}
```
At L292 change `function buildAdversarialCollectionGuidance` to `export function buildAdversarialCollectionGuidance`. In `collectReviewContext`:
- L323 becomes `details = collectWorkingTreeContext(repoRoot, state, { includeDiff, maxInlineDiffBytes });`;
- L333 becomes `details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, maxInlineDiffBytes });`;
- the return block L336-346 becomes:

```js
  const { inlined, ...collected } = details;
  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: collected.changedFiles.length,
    diffBytes,
    inputMode: inlined ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff: inlined }),
    ...collected
  };
```

- [ ] **Step 4: Implement `commands/review.mjs`.** Add `buildAdversarialCollectionGuidance` to the `../lib/git.mjs` import. Replace `buildAdversarialReviewPrompt` (today `codex-companion.mjs:371-380`) with:

```js
// 75 % of Codex's 1,048,576-character input limit; the rest covers the template
// and the output schema (#405). `length` counts UTF-16 units, never fewer than
// code points, so the check errs on the safe side.
export const MAX_REVIEW_PROMPT_CHARS = 786432;

function truncationMarker(characters) {
  return `[Repository context truncated at ${characters} characters: inspect the target yourself with read-only git commands before finalizing findings.]`;
}

export function buildAdversarialReviewPrompt(context, focusText, onLog = null) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const variables = {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  };
  const prompt = interpolateTemplate(template, variables);
  if (prompt.length <= MAX_REVIEW_PROMPT_CHARS) {
    return prompt;
  }

  // Over the ceiling: keep whole lines of the context, say where it stops, and
  // have Codex collect the rest itself.
  const content = context.content;
  const selfCollect = { ...variables, REVIEW_COLLECTION_GUIDANCE: buildAdversarialCollectionGuidance({ includeDiff: false }) };
  const frame = interpolateTemplate(template, { ...selfCollect, REVIEW_INPUT: "" }).length;
  const budget = MAX_REVIEW_PROMPT_CHARS - frame - truncationMarker(content.length).length;
  const cutAt = budget > 0 ? content.lastIndexOf("\n", budget - 1) : -1;
  const kept = content.slice(0, cutAt + 1);
  onLog?.(`Review context truncated to fit the prompt ceiling (${kept.length} of ${content.length} characters).`);
  return interpolateTemplate(template, { ...selfCollect, REVIEW_INPUT: `${kept}${truncationMarker(kept.length)}` });
}
```
In `executeReviewRun` replace `const prompt = buildAdversarialReviewPrompt(context, focusText);` (today `codex-companion.mjs:583`) with `const prompt = buildAdversarialReviewPrompt(context, focusText, request.onProgress);`.

- [ ] **Step 5:** `node --import ./tests/test-env.mjs --test tests/git.test.mjs tests/review-prompt.test.mjs tests/runtime-review.test.mjs tests/module-boundaries.test.mjs` → all pass. These existing tests still pass unchanged:
- `git.test.mjs:192` (untracked content still inlined in self-collect under the cap);
- `:135` (broken symlink wording);
- `:118` (directory wording);
- `:174` (oversized diff → self-collect);
- `runtime-review.test.mjs:104`.

The full patched `git.mjs` passed all 13 `git.test` cases on a scratch copy.

- [ ] **Step 6: Commit** (gate chain):

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/git.mjs plugins/codex/scripts/commands/review.mjs tests/git.test.mjs tests/review-prompt.test.mjs && git commit -F - <<'MSG'
fix(review): cap untracked content, the inline diff read and the adversarial prompt; never follow untracked symlinks (#405)

Co-authored-by: Ayobami Adegoke <66267222+ayobamiseun@users.noreply.github.com>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

### Task S3a.5 (Sonnet): #529 persisted, named review threads

**Files:** (line numbers are HEAD's; this task's Step 3 inserts 5 lines after L151 and S3a.3 grew the file past L1469, so match on the quoted text)
- Modify `plugins/codex/scripts/lib/codex.mjs`: new `buildReviewThreadName` after `buildTaskThreadName` (L148-151); `runAppServerReview`'s `ephemeral` (L1238).
- Modify `plugins/codex/scripts/commands/review.mjs` (`executeReviewRun`: the `runAppServerReview` call, today `codex-companion.mjs:537-544`; the `runAppServerTurn` call, today `:584-593`; the `../lib/codex.mjs` import).
- Test `tests/thread-config.test.mjs` (import L3, append at the end), `tests/runtime-review.test.mjs` (append at the end).

**Interfaces:**
- Consumes:
  - `shorten(text, limit)` (`render.mjs:474`, imported by `codex.mjs:52`): collapses whitespace and cuts to `limit − 3` plus `...`.
  - `TASK_THREAD_PREFIX` (`codex.mjs:57`, exported at L1500).
  - `startThread` (`codex.mjs:954-970`): sends `thread/name/set` when `threadName` is set.
  - The fake: `thread/start` stores its params in `lastThreadStart`, `ephemeral` included (`fake-codex-fixture.mjs:378-379`). `thread/name/set` stores the name on the thread record in `state.threads` (`:386-391`), not in `lastThreadStart`.
- Produces:
  - `export function buildReviewThreadName(reviewName: string, label: string): string` (`lib/codex.mjs`) = `` `Codex Companion ${reviewName}: ${shorten(label, 56)}` ``.
  - `executeReviewRun` names the thread with the focus text when present, else `target.label`:
    - built-in reviewer: `runAppServerReview(cwd, { …, threadName })`, and `runAppServerReview` now starts its thread with `ephemeral: false`;
    - adversarial reviewer: `runAppServerTurn(repoRoot, { …, persistThread: true, threadName })`.
  - No other caller changes. `runAppServerTurn`'s body (L1347-1441) is untouched, and so is its only other caller, `executeTaskRun` (today `codex-companion.mjs:664-679`). That caller already passes `persistThread: true` with `buildPersistentTaskThreadName`, or `null` on resume. The stop-review gate spawns `codex-companion.mjs task --json` (`stop-review-gate-hook.mjs:138-154`), so it runs `executeTaskRun` too.
  - `runAppServerReview` has one caller, `executeReviewRun`. The detached-delivery review thread the app-server itself creates is not affected (the companion uses `delivery: "inline"`, L1252).
  - Review names never start with `TASK_THREAD_PREFIX`, so `findLatestTaskThread` (L1443-1463: `searchTerm` plus `startsWith`) and `--resume-last` never pick them.

- [ ] **Step 1: Failing tests.** In `tests/thread-config.test.mjs` change L3 to `import { buildReviewThreadName, buildThreadConfig, TASK_THREAD_PREFIX } from "../plugins/codex/scripts/lib/codex.mjs";` and append:

```js
test("buildReviewThreadName names review threads outside the task prefix (#529)", () => {
  assert.equal(buildReviewThreadName("Review", "working tree diff"), "Codex Companion Review: working tree diff");
  const long = buildReviewThreadName("Adversarial Review", `check ${"the auth flow ".repeat(10)}`);
  assert.equal(long.length, "Codex Companion Adversarial Review: ".length + 56);
  assert.ok(long.endsWith("..."), long);
  for (const name of [long, buildReviewThreadName("Review", "branch diff against main")]) {
    assert.equal(name.startsWith(TASK_THREAD_PREFIX), false, name);
  }
});
```
Append to `tests/runtime-review.test.mjs`:

```js
test("review and adversarial-review persist named threads that --resume-last never picks (#529)", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const env = buildEnv(binDir);
  const lastThread = () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { start: state.lastThreadStart, thread: state.threads.find((entry) => entry.id === state.lastThreadStart.threadId) };
  };

  const review = run(process.execPath, [SCRIPT, "review"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  let { start, thread } = lastThread();
  assert.equal(start.ephemeral, false, "built-in review thread persists");
  assert.equal(thread.name, "Codex Companion Review: working tree diff");

  const adversarial = run(process.execPath, [SCRIPT, "adversarial-review", "check auth"], { cwd: repo, env });
  assert.equal(adversarial.status, 0, adversarial.stderr);
  ({ start, thread } = lastThread());
  assert.equal(start.ephemeral, false, "adversarial review thread persists");
  assert.equal(thread.name, "Codex Companion Adversarial Review: check auth");

  // No session id in tests (test-env.mjs), so --resume-last falls through to findLatestTaskThread.
  const resume = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.notEqual(resume.status, 0, resume.stdout);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/thread-config.test.mjs tests/runtime-review.test.mjs` → FAIL: thread-config `SyntaxError: … does not provide an export named 'buildReviewThreadName'`; runtime-review `built-in review thread persists` (`true !== false`).

- [ ] **Step 3: Implement `lib/codex.mjs`.** After `buildTaskThreadName` (ends L151) add:

```js
// Review threads persist like task threads (#529) but never carry the task
// prefix, so findLatestTaskThread and `--resume-last` cannot pick one.
export function buildReviewThreadName(reviewName, label) {
  return `Codex Companion ${reviewName}: ${shorten(label, 56)}`;
}
```
At L1238 replace `      ephemeral: true,` with `      ephemeral: false,`.

- [ ] **Step 4: Implement `commands/review.mjs`.** Add `buildReviewThreadName` to the `../lib/codex.mjs` import. In `executeReviewRun`:
  - in the `runAppServerReview(request.cwd, { … })` options (today `codex-companion.mjs:537-544`) add, after `turnTimeoutMs: request.turnTimeoutMs,`: `threadName: buildReviewThreadName(reviewName, focusText || target.label),`;
  - in the `runAppServerTurn(context.repoRoot, { … })` options (today `:584-593`) add, after `turnTimeoutMs: request.turnTimeoutMs,`:

```js
    persistThread: true,
    threadName: buildReviewThreadName(reviewName, focusText || context.target.label),
```

- [ ] **Step 5:** `node --import ./tests/test-env.mjs --test tests/thread-config.test.mjs tests/runtime-review.test.mjs tests/runtime-task.test.mjs tests/runtime-hooks.test.mjs` → all pass: task naming and `--resume-last` (`runtime-task.test.mjs:86`, `:220`) and the stop gate unchanged.

- [ ] **Step 6: Commit** (gate chain):

```bash
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/commands/review.mjs tests/thread-config.test.mjs tests/runtime-review.test.mjs && git commit -F - <<'MSG'
fix(review): persist review threads under a review name (#529)

Co-authored-by: Minh Hoàng <110018571+dinhnguyenminhhoang@users.noreply.github.com>
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

## S3b — review surface: dispatch, background worker, command files

### Task S3b.1 (Opus): review dispatch order, focus text runs the adversarial reviewer, `focusText` on the record

**Files:** Modify `plugins/codex/scripts/commands/review.mjs` (`handleReviewCommand`, today `codex-companion.mjs:951-1009`; `handleReview`, today `:1011-1016`; `validateNativeReviewRequest`, today `:401-414`; `executeReviewRun`, today `:525-637`), `plugins/codex/scripts/codex-companion.mjs` (`main`, the `adversarial-review` case, today `:1460-1465`), `plugins/codex/scripts/lib/render.mjs` (`pushJobDetails`, L126-170). Test `tests/runtime-review.test.mjs` (import block L6-16, test at L19-39, test at L219-237 rewritten, new tests), `tests/render.test.mjs` (import L4, new test at the end).

**Interfaces:**
- Consumes (S1): from `../lib/cli.mjs` `parseCommandInput`, `maybePrintCommandHelp`, `resolveCommandCwd`, `resolveCommandWorkspace`, `normalizeRequestedModel`, `normalizeReasoningEffort`, `parseConfigOverrides`, `parseTimeoutOption`; from `./shared.mjs` `ensureCodexAvailable`, `createCompanionJob`, `runForegroundCommand`.
- Consumes (S3a): `REVIEW_ARG_SPEC` exported by `commands/review.mjs`, assumed `{ valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"], booleanOptions: ["json", "background", "wait"], repeatableOptions: ["config"], stopAtFirstPositional: true, aliasMap: { m: "model" } }`. If S3a's constant lacks `stopAtFirstPositional: true`, add it there (spec §3.3: `review` parses with `stopAtFirstPositional`). `resolveReviewTarget(cwd, { base, scope })` with S3a's `--base` validation inside it.
- Produces: `export const REVIEW_FOCUS_NOTICE = "Focus text given: running the adversarial reviewer (the built-in reviewer accepts no instructions)."` in `commands/review.mjs`.
- Produces: `validateNativeReviewRequest(target) → { type: "uncommittedChanges" } | { type: "baseBranch", branch }` (the `focusText` parameter and its throw are gone).
- Produces: `handleReviewCommand(argv, { reviewName: "Review" | "Adversarial Review" })` (the `validateRequest` and `acceptsFocusText` keys are gone).
- Produces: the review request object `{ cwd, base, scope, model, effort, config, focusText, reviewName, notice, turnTimeoutMs, jobId }` (`base`/`scope` are `null` when not given, `notice` is `null` or `REVIEW_FOCUS_NOTICE`). S3b.3 writes exactly this object to the request file.
- Produces: every review job record carries top-level `focusText: string | null`. The adversarial payload carries `notice` when the request had one.

- [ ] **Step 1: Failing tests.** In `tests/runtime-review.test.mjs` add `IS_WIN,` to the `./helpers.mjs` import list and, below the imports, add (keep any `state.mjs` import S3a added; add `resolveStateDir` to it instead of a second import line):

```js
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const REVIEW_FOCUS_NOTICE = "Focus text given: running the adversarial reviewer (the built-in reviewer accepts no instructions).";

// The job index as the companion left it, or [] when no command wrote one.
function reviewJobsInIndex(repo) {
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  return fs.existsSync(stateFile) ? readStateIndex(repo).jobs : [];
}

// A codex on PATH whose `--version` fails, so getCodexAvailability reports it
// unavailable. The .cmd shim of the fake stays, so this works on Windows too.
function installBrokenCodex(binDir) {
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(binDir, IS_WIN ? "codex.cjs" : "codex"), "#!/usr/bin/env node\nprocess.exit(1);\n");
}
```

In the test at L19-39 ("review renders a no-findings result from app-server review/start"), after L38 add:

```js
  const record = readJobRecord(repo);
  assert.deepEqual([record.kind, record.title, record.focusText], ["review", "Codex Review", null], "every review record carries focusText");
```

Replace the test at L219-237 ("review rejects focus text because it is native-review only") with:

```js
test("review with focus text runs the adversarial reviewer and says so first", () => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("\n")[0], REVIEW_FOCUS_NOTICE);
  assert.match(result.stdout, /# Codex Adversarial Review/);
  assert.match(result.stdout, /Missing empty-state guard/);
  const prompt = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt;
  assert.match(prompt, /adversarial software review/);
  assert.match(prompt, /focus on auth/);
  const record = readJobRecord(repo);
  assert.deepEqual(
    [record.kind, record.title, record.jobClass, record.focusText],
    ["adversarial-review", "Codex Adversarial Review", "review", "focus on auth"]
  );
  assert.ok(record.rendered.startsWith(`${REVIEW_FOCUS_NOTICE}\n\n# Codex Adversarial Review`), record.rendered);
  assert.equal(record.result.notice, REVIEW_FOCUS_NOTICE);
  assert.ok(fs.readFileSync(record.logFile, "utf8").includes(REVIEW_FOCUS_NOTICE), "the notice is in the job log");

  const json = run(process.execPath, [SCRIPT, "review", "--json", "tighten", "the", "auth", "checks"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.review, "Adversarial Review");
  assert.equal(payload.notice, REVIEW_FOCUS_NOTICE);
  assert.equal(readJobRecord(repo).focusText, "tighten the auth checks");
});
```

Append at the end of the file:

```js
test("review and adversarial-review refuse --wait with --background before anything else", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  for (const command of ["review", "adversarial-review"]) {
    // --effort bogus would fail step 2: the flag conflict is step 1.
    const result = run(process.execPath, [SCRIPT, command, "--wait", "--background", "--effort", "bogus"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(result.status, 1, `${command}: ${result.stdout}`);
    assert.match(result.stderr, /Choose either --wait or --background\./, command);
  }
  assert.deepEqual(reviewJobsInIndex(repo), []);
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false, "no app-server was started");
});

test("review checks the target, then Codex, before it records a job", () => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  installBrokenCodex(binDir);
  for (const command of ["review", "adversarial-review"]) {
    const scope = run(process.execPath, [SCRIPT, command, "--scope", "staged"], { cwd: repo, env: buildEnv(binDir) });
    assert.equal(scope.status, 1, command);
    assert.match(scope.stderr, /Unsupported review scope "staged"/, `${command}: the target is checked before Codex`);
    const missing = run(process.execPath, [SCRIPT, command], { cwd: repo, env: buildEnv(binDir) });
    assert.equal(missing.status, 1, command);
    assert.match(missing.stderr, /Codex CLI is not installed or is missing required runtime support/, command);
  }
  assert.deepEqual(reviewJobsInIndex(repo), [], "no failed record is left behind");
});
```

In `tests/render.test.mjs` nothing changes in the import (L4 already imports `renderJobStatusReport` and `shorten`); append:

```js
test("renderJobStatusReport shows a review's focus text on one shortened line after the summary", () => {
  const base = { id: "review-1", status: "completed", kindLabel: "adversarial-review", title: "Codex Adversarial Review", summary: "Adversarial Review working tree diff" };
  const focusText = `check the auth path\n${"x".repeat(200)}`;
  const lines = renderJobStatusReport({ ...base, focusText }).split("\n");
  const focusLine = `  Focus: ${shorten(focusText, 96)}`;
  assert.ok(lines.includes(focusLine), lines.join("\n"));
  assert.equal(lines.indexOf(focusLine), lines.indexOf(`  Summary: ${base.summary}`) + 1);
  assert.doesNotMatch(renderJobStatusReport({ ...base, focusText: null }), /Focus:/);
  assert.doesNotMatch(renderJobStatusReport(base), /Focus:/, "records from before 1.5.0 have no focusText");
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/runtime-review.test.mjs tests/render.test.mjs` → FAIL:
  - "renders a no-findings result": `focusText` is `undefined`, expected `null`;
  - "focus text runs the adversarial reviewer": exit 1, stderr `does not support custom focus text`;
  - "--wait with --background": stderr is `Unsupported reasoning effort "bogus"…`, not the flag-conflict text (today the effort is checked first and the flag pair never);
  - "checks the target, then Codex": `no failed record is left behind` (today the codex check runs inside `runTrackedJob` and leaves a `failed` record);
  - render: `Focus:` line missing.
- [ ] **Step 3: Implement.**
  1. `commands/review.mjs`, above `validateNativeReviewRequest` add:

```js
// Rows 3-4 of spec §3.3: focus text on `/codex:review` selects the adversarial
// reviewer, because the built-in reviewer takes a diff target and no instructions.
export const REVIEW_FOCUS_NOTICE = "Focus text given: running the adversarial reviewer (the built-in reviewer accepts no instructions).";
```

  2. Replace `validateNativeReviewRequest` (today `:401-414`) with:

```js
// Focus text never reaches the built-in reviewer: the handler routes it to the
// adversarial one. What is left to check is that the target maps.
function validateNativeReviewRequest(target) {
  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }
  return nativeTarget;
}
```

  3. `executeReviewRun` — anchored edits only (S3a rewrites other lines of this function; do not replace it wholesale):
     - after the line `const reviewName = request.reviewName ?? "Review";` insert:

```js
  const notice = request.notice ?? null;
  // Goes to the job log (the foreground reporter also echoes it on stderr as
  // `[codex] …`; stdout gets it as the first line of `rendered` below).
  if (notice) {
    request.onProgress?.(notice);
  }
```
     - replace `const reviewTarget = validateNativeReviewRequest(target, focusText);` with `const reviewTarget = validateNativeReviewRequest(target);`
     - in the adversarial `payload` object (today `:598-617`), after `review: reviewName,` insert `...(notice ? { notice } : {}),`
     - in the adversarial return object (today `:626-630`), wrap the `rendered:` value: `rendered: prependNotice(renderReviewResult(parsed, { … unchanged … }), notice),`
     - below `executeReviewRun` add:

```js
function prependNotice(rendered, notice) {
  return notice ? `${notice}\n\n${rendered}` : rendered;
}
```
  The built-in branch gets no notice: the handler only sets one together with `reviewName: "Adversarial Review"`.

  4. Replace the body of `handleReviewCommand` (today `:951-1009`) with:

```js
export async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, REVIEW_ARG_SPEC);
  if (maybePrintCommandHelp(options)) {
    return;
  }

  // Spec §3.3 Dispatch: everything is validated before any job record, request
  // file or codex start, in this order.
  // 1. flag conflict
  if (options.wait && options.background) {
    throw new Error("Choose either --wait or --background.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // 2. model and effort
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort, model);
  // 3. --config and --turn-timeout-ms
  const configOverrides = parseConfigOverrides(options.config);
  const turnTimeoutMs = parseTimeoutOption(options["turn-timeout-ms"], "--turn-timeout-ms");
  // 4. git repository, scope, --base
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  // 5. codex (before 1.5.0 this ran inside the run and left a failed record)
  ensureCodexAvailable(cwd);
  // 6. the reviewer and, for the built-in one, its target
  const focusText = positionals.join(" ").trim();
  const reviewName = config.reviewName === "Review" && focusText ? "Adversarial Review" : config.reviewName;
  const notice = reviewName === config.reviewName ? null : REVIEW_FOCUS_NOTICE;
  if (reviewName === "Review") {
    validateNativeReviewRequest(target);
  }

  const metadata = buildReviewJobMetadata(reviewName, target);
  const job = {
    ...createCompanionJob({
      prefix: "review",
      kind: metadata.kind,
      title: metadata.title,
      workspaceRoot,
      jobClass: "review",
      summary: metadata.summary,
      // Until the companion detaches `--background` itself (S3b.3) the run stays
      // here; the record still has to outlive the dispatching session.
      background: Boolean(options.background)
    }),
    // Top level so `status` shows it: the status summary drops `request`.
    focusText: focusText || null
  };
  const request = {
    cwd,
    base: options.base ?? null,
    scope: options.scope ?? null,
    model,
    effort,
    config: configOverrides,
    focusText,
    reviewName,
    notice,
    turnTimeoutMs,
    jobId: job.id
  };
  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), { json: options.json });
}
```

  5. `handleReview` (today `:1011-1016`) becomes:

```js
export async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review" });
}
```
     and in `main` (`codex-companion.mjs`) the `adversarial-review` case passes `{ reviewName: "Adversarial Review" }` (drop `acceptsFocusText: true`; keep whatever spec argument S3a added to `applyArgsStdin`).
  6. `lib/render.mjs` `pushJobDetails`: after the `Summary:` block (L128-130) insert:

```js
  if (job.focusText) {
    lines.push(`  Focus: ${shorten(job.focusText, 96)}`);
  }
```
- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/runtime-review.test.mjs tests/render.test.mjs tests/runtime-hooks.test.mjs tests/runtime-status.test.mjs` → pass. Still green unchanged: "review accepts --background while still running…" (L281, still a foreground run with `background: true` until S3b.3), `runtime-hooks.test.mjs:318` (the record keeps `background: true`), both staged-scope tests (L239, L260).
- [ ] **Step 5: Commit** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/commands/review.mjs plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/render.mjs tests/runtime-review.test.mjs tests/render.test.mjs && git commit -m "feat(review): focus text on /codex:review runs the adversarial reviewer; validate before any job record" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task S3b.2 (Sonnet): built-in review `--json` carries `result: null`, `rawOutput`, `parseError` (#679)

**Files:** Modify `plugins/codex/scripts/commands/review.mjs` (`executeReviewRun` built-in `payload`, today `codex-companion.mjs:545-556`). Test `tests/runtime-review.test.mjs` (new test at the end), `tests/render.test.mjs` (new test at the end).

**Interfaces:**
- Produces: `export const BUILTIN_REVIEW_PARSE_ERROR = "The built-in reviewer returns prose, not the review-output schema; use adversarial-review (or /codex:review with focus text) for structured findings."` in `commands/review.mjs`.
- Produces: the built-in payload `{ review, target, threadId, sourceThreadId, codex: { status, stderr, stdout, reasoning }, result: null, rawOutput: <review text>, parseError: BUILTIN_REVIEW_PARSE_ERROR }`. With `result`/`parseError` present, `isStructuredReviewStoredResult` (`lib/render.mjs:75-85`) is true, so `result` prints the stored `rendered` (L400-406) instead of the bare `codex.stdout` (L408-418). Records written before 1.5.0 have neither key and render as before (pinned by `tests/runtime-status.test.mjs:308` "result returns the stored output for the latest finished job by default", unchanged).

- [ ] **Step 1: Failing tests.** Append to `tests/runtime-review.test.mjs`:

```js
test("review --json marks the built-in reviewer's prose as unstructured, and result prints the rendered review", () => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const reviewed = run(process.execPath, [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(reviewed.status, 0, reviewed.stderr);
  const payload = JSON.parse(reviewed.stdout);
  assert.equal(payload.result, null);
  assert.match(payload.rawOutput, /Reviewed uncommitted changes\.\nNo material issues found\./);
  assert.equal(
    payload.parseError,
    "The built-in reviewer returns prose, not the review-output schema; use adversarial-review (or /codex:review with focus text) for structured findings."
  );
  const { id } = readJobRecord(repo);
  const shown = run(process.execPath, [SCRIPT, "result", id], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.startsWith("# Codex Review\n\nTarget: working tree diff\n\nReviewed uncommitted changes."), shown.stdout);
});
```

Append to `tests/render.test.mjs`:

```js
test("renderStoredJobResult prints a 1.5.0 built-in review's rendered text and a pre-1.5.0 one's bare stdout", () => {
  const job = { id: "review-9", status: "completed", title: "Codex Review", jobClass: "review", threadId: null };
  const rendered = "# Codex Review\n\nTarget: working tree diff\n\nReviewed uncommitted changes.\n";
  const codex = { status: 0, stderr: "", stdout: "Reviewed uncommitted changes." };
  const current = { rendered, result: { review: "Review", codex, result: null, rawOutput: codex.stdout, parseError: "The built-in reviewer returns prose, not the review-output schema; use adversarial-review (or /codex:review with focus text) for structured findings." } };
  assert.equal(renderStoredJobResult(job, current), rendered);
  const legacy = { rendered, result: { review: "Review", codex } };
  assert.equal(renderStoredJobResult(job, legacy), "Reviewed uncommitted changes.\n");
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/runtime-review.test.mjs tests/render.test.mjs` → FAIL: `payload.result` is `undefined`, expected `null` (the render test passes already: it pins the existing branch choice).
- [ ] **Step 3: Implement.** In `commands/review.mjs` next to `REVIEW_FOCUS_NOTICE` add:

```js
// #679: `exitedReviewMode` carries only a string (lib/codex.mjs `recordItem`), so
// a schema-shaped result would be a guess. The payload says so in the same keys
// the adversarial reviewer fills.
export const BUILTIN_REVIEW_PARSE_ERROR =
  "The built-in reviewer returns prose, not the review-output schema; use adversarial-review (or /codex:review with focus text) for structured findings.";
```

In `executeReviewRun`'s built-in `payload` object, after the `codex: { … }` member add:

```js
      result: null,
      rawOutput: result.reviewText,
      parseError: BUILTIN_REVIEW_PARSE_ERROR
```
(`rendered` and `summary` are unchanged.)
- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/runtime-review.test.mjs tests/render.test.mjs tests/runtime-status.test.mjs` → pass (L308 of runtime-status unchanged: a pre-1.5.0 record).
- [ ] **Step 5: Commit** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/commands/review.mjs tests/runtime-review.test.mjs tests/render.test.mjs && git commit -m "feat(review): built-in review --json gains result null, rawOutput and parseError (#679)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task S3b.3 (Opus): `review --background` / `adversarial-review --background` detach in the companion (#615)

**Files:** Modify `plugins/codex/scripts/commands/review.mjs` (`handleReviewCommand`, the block S3b.1 wrote; `executeReviewRun` exported), `plugins/codex/scripts/commands/shared.mjs` (`handleTaskWorker`, today `codex-companion.mjs:1136-1181`), `plugins/codex/scripts/codex-companion.mjs` (`main`, the `task-worker` case, today `:1472-1474`; imports). Test `tests/helpers.mjs` (new `killJobWorkerAfter`), `tests/runtime-review.test.mjs` (test at L281-310 rewritten, new tests, imports), `tests/runtime-hooks.test.mjs` (test at L314-344 replaced), `tests/runtime-cancel.test.mjs` (new test after the test ending at L615, import L27-36).

**Interfaces:**
- Consumes (S1, `commands/shared.mjs`): `enqueueBackgroundJob(cwd, job, request) → { payload: { jobId, status: "queued", title, summary, logFile }, logFile }` (the task enqueue, today `enqueueBackgroundTask` `:890-949`, unchanged: queued record with `background: true` and `request` with `redactConfigValues` applied, 0600 `jobs/<id>.request.json` via `writeJobRequestFile`, `spawnDetachedTaskWorker`, `recordWorkerPid`); `renderQueuedLaunch(payload) → "<title> started in the background as <id>. Check /codex:status <id> for progress.\n"`; `outputCommandResult` from `../lib/cli.mjs`.
- Consumes (S3b.1): the request object and `REVIEW_FOCUS_NOTICE`.
- Produces: `export async function handleTaskWorker(argv, runners)`, `runners = { review?: (request) => Promise<Execution>, task: (request) => Promise<Execution> }`; `runners.review` runs when `storedJob.jobClass === "review"`, otherwise `runners.task`.
- Produces: `export async function executeReviewRun(request)` (export only; body per S3b.1/S3b.2/S3a).
- Produces: `main` calls `handleTaskWorker(argv, { review: executeReviewRun, task: executeTaskRun })`.
- Produces: queued stdout `<title> started in the background as <id>. Check /codex:status <id> for progress.` preceded, for rows 4, by the notice line; `--json` payload `{ jobId, status: "queued", title, summary, logFile[, notice] }`.

- [ ] **Step 1: Failing tests.**
  (0) `tests/helpers.mjs`: add `resolveJobPidFile` to the `state.mjs` import (L9) and append:

```js
// Registered as soon as a background job's id is known, before any wait or
// assertion. The pid is resolved when the cleanup runs, from the sidecar the
// parent wrote (`recordWorkerPid`); no sidecar means the job reached a terminal
// record (which removes it), so there is nothing left to kill.
export function killJobWorkerAfter(t, repo, jobId) {
  t.after(() => {
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(resolveJobPidFile(repo, jobId), "utf8")).pid;
    } catch {
      return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  });
}
```

  (a) `tests/runtime-review.test.mjs`: add `jobDiagnostics,`, `killJobWorkerAfter,` and `SESSION_HOOK,` to the `./helpers.mjs` import list and `resolveJobRequestFile` to the `state.mjs` import S3b.1 added. In every test below, `t.after(() => sessionEnd(repo, env))` is registered before the launch and `killJobWorkerAfter` right after the job id is parsed, before any wait. Below `installBrokenCodex` add:

```js
function sessionEnd(repo, env) {
  return run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) });
}

// Waits for a detached review to finish; a failure prints the record and the log tail.
function waitCompleted(repo, jobId, env) {
  const waited = run(process.execPath, [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "30000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, `${waited.stderr}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed", jobDiagnostics(repo, jobId));
  return readJobRecord(repo, jobId);
}
```

Replace the test at L281-310 ("review accepts --background while still running as a tracked review job") with:

```js
test("review --background returns the queued job at once and a detached worker finishes it", { timeout: 90_000 }, (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  t.after(() => sessionEnd(repo, env));

  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json", "--config", "model_provider=ollama"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const queued = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, queued.jobId);
  assert.deepEqual(Object.keys(queued).sort(), ["jobId", "logFile", "status", "summary", "title"]);
  assert.deepEqual([queued.status, queued.title], ["queued", "Codex Review"]);
  assert.match(queued.jobId, /^review-/);

  const stored = waitCompleted(repo, queued.jobId, env);
  assert.deepEqual([stored.background, stored.jobClass, stored.kind, stored.focusText], [true, "review", "review", null]);
  assert.deepEqual(stored.request.config, { model_provider: "[redacted]" });
  assert.deepEqual([stored.request.reviewName, stored.request.notice], ["Review", null]);
  assert.equal(fs.existsSync(resolveJobRequestFile(repo, queued.jobId)), false, "the worker consumed its request file");
  assert.equal(stored.result.result, null, "the built-in #679 shape");
  assert.equal(typeof stored.result.parseError, "string");
  assert.match(stored.rendered, /Reviewed uncommitted changes/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastThreadStart.config.model_provider, "ollama", "the worker got the unredacted --config value");

  const text = run(process.execPath, [SCRIPT, "adversarial-review", "--background"], { cwd: repo, env });
  assert.equal(text.status, 0, text.stderr);
  const line = /^Codex Adversarial Review started in the background as (review-\S+)\. Check \/codex:status \1 for progress\.\n$/.exec(text.stdout);
  assert.ok(line, text.stdout);
  killJobWorkerAfter(t, repo, line[1]);
  assert.equal(waitCompleted(repo, line[1], env).kind, "adversarial-review");
});
```

Append:

```js
test("review --background with focus text queues the adversarial reviewer behind the notice", { timeout: 90_000 }, (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  t.after(() => sessionEnd(repo, env));

  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json", "check", "the", "retry", "path"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const queued = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, queued.jobId);
  assert.deepEqual(Object.keys(queued).sort(), ["jobId", "logFile", "notice", "status", "summary", "title"]);
  assert.deepEqual([queued.notice, queued.title], [REVIEW_FOCUS_NOTICE, "Codex Adversarial Review"]);
  const stored = waitCompleted(repo, queued.jobId, env);
  assert.deepEqual(
    [stored.kind, stored.focusText, stored.request.focusText, stored.request.notice, stored.request.reviewName],
    ["adversarial-review", "check the retry path", "check the retry path", REVIEW_FOCUS_NOTICE, "Adversarial Review"]
  );
  assert.ok(stored.rendered.startsWith(`${REVIEW_FOCUS_NOTICE}\n\n# Codex Adversarial Review`), stored.rendered);
  assert.ok(fs.readFileSync(stored.logFile, "utf8").includes(REVIEW_FOCUS_NOTICE), "the worker logged the notice");
  assert.match(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt, /check the retry path/);

  const text = run(process.execPath, [SCRIPT, "review", "--background", "second", "pass"], { cwd: repo, env });
  assert.equal(text.status, 0, text.stderr);
  const [first, second, rest] = text.stdout.split("\n");
  assert.equal(first, REVIEW_FOCUS_NOTICE);
  const line = /^Codex Adversarial Review started in the background as (review-\S+)\. Check \/codex:status \1 for progress\.$/.exec(second);
  assert.ok(line && rest === "", text.stdout);
  killJobWorkerAfter(t, repo, line[1]);
  waitCompleted(repo, line[1], env);
});

// findLatestResumableTaskJob keeps jobClass "task" only, and a review thread's
// name never starts with "Codex Companion Task": neither a tracked review job nor
// its persisted thread may be what `task --resume-last` continues.
test("a background review is never a resume candidate for task --resume-last", { timeout: 90_000 }, (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-review" };
  t.after(() => sessionEnd(repo, env));

  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, jobId);
  assert.ok(waitCompleted(repo, jobId, env).threadId, "the review recorded its thread");

  const candidate = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);
  // With a session: the tracked-job list. Without one: the thread-name lookup.
  for (const resumeEnv of [env, buildEnv(binDir)]) {
    const resume = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env: resumeEnv });
    assert.equal(resume.status, 1, resume.stdout);
    assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
  }
});
```

  (b) `tests/runtime-hooks.test.mjs`: add `jobDiagnostics,`, `killJobWorkerAfter,` and `readJobRecord,` to the `./helpers.mjs` import list (L8-20). Replace the test at L314-344 (comment and "an adversarial review dispatched with --background survives its own session's SessionEnd") with the version below. The adversarial turn is held by the fake's existing `FAKE_CODEX_TURN_DELAY_MS` (a held `turn/start` is registered in `interruptibleTurns`, `fake-codex-fixture.mjs:725-744`), so SessionEnd meets a review that is really `running`; the test then ends it by the v1.4.2 brokered cancel. Cross-platform, like the test it replaces (a brokered cancel records `pid = null` before `finishCancel`, so win32 kills nothing either).

```js
// `--background` on a review means what it means on a task (#615): the job is a
// detached worker that outlives the session that started it. SessionEnd must
// leave the running worker, its record and the shared broker it talks to alone.
test("a running background review survives its own session's SessionEnd, with its worker and the shared broker", { timeout: 120_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");
  const env = { ...buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000" }), CODEX_COMPANION_SESSION_ID: "sess-current" };
  const endSession = () => run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });
  // Registered before anything can fail: whatever happens below, the worker is
  // killed and a second SessionEnd tears the broker down once nothing is active.
  t.after(endSession);

  const review = run(process.execPath, [SCRIPT, "adversarial-review", "--background", "--json"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  const { jobId } = JSON.parse(review.stdout);
  killJobWorkerAfter(t, repo, jobId);
  const running = await waitFor(() => { const job = readJobRecord(repo, jobId); return job.status === "running" && job.pid && job.turnId && job.transport ? job : null; });
  assert.deepEqual([running.background, running.transport], [true, "broker"], jobDiagnostics(repo, jobId));
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, `the review worker started the shared broker\n${jobDiagnostics(repo, jobId)}`);

  const cleanup = endSession();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.map((job) => job.id), [jobId], "the background review record must survive the dispatching session's SessionEnd");
  assert.equal(readJobRecord(repo, jobId).status, "running", jobDiagnostics(repo, jobId));
  assert.equal(isAlive(running.pid), true, "the review worker outlives its session");
  assert.equal(isAlive(broker.pid), true, "the shared broker stays while the review runs");

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled", jobDiagnostics(repo, jobId));
  await waitFor(() => !isAlive(running.pid));
  assert.equal(readJobRecord(repo, jobId).status, "cancelled", jobDiagnostics(repo, jobId));
});
```

  (c) `tests/runtime-cancel.test.mjs`: add `killJobWorkerAfter,` to the `./helpers.mjs` import list (L9-24) and `resolveJobRequestFile,` to the `state.mjs` import list (L27-36). After the test ending at L615 add:

```js
// Row 1 of the v1.4.2 rules for a review: queued, no turn yet. The worker is held
// before it reads its request file, so the cancel kills it by its recorded pid and
// identity, and commitCancel (job-control.mjs:342) releases the 0600 payload with
// the --config secret. posix only: the removal is platform-independent, and the
// win32 queued-window kill is the hand-made case above (L552).
test("cancelling a background review in its queued window kills the worker and removes its request file", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const preload = path.join(binDir, "worker-blocks-at-start.mjs");
  fs.writeFileSync(preload, 'if (process.argv.includes("task-worker")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n');
  const env = buildEnv(binDir, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim() });
  const secret = "sk-review-queued-secret";

  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json", "--config", `auth_header=${secret}`], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, jobId);
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));
  const sidecar = JSON.parse(fs.readFileSync(resolveJobPidFile(repo, jobId), "utf8"));
  assert.ok(sidecar.identity, "recordWorkerPid proved the worker's identity");
  const requestFile = resolveJobRequestFile(repo, jobId);
  assert.equal(readJobRecord(repo, jobId).status, "queued", jobDiagnostics(repo, jobId));
  assert.ok(fs.readFileSync(requestFile, "utf8").includes(secret), "the unredacted value lives only in the request file");

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${cancel.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterruptAttempted, false, "no turn yet: nothing to interrupt");
  assert.equal(fs.existsSync(requestFile), false, "the private payload must not outlive the cancelled job");
  const stored = readJobRecord(repo, jobId);
  assert.deepEqual([stored.status, stored.requestFile], ["cancelled", null], jobDiagnostics(repo, jobId));
  assert.equal(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8").includes(secret), false);
  await waitFor(() => !isAlive(sidecar.pid));
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/runtime-review.test.mjs tests/runtime-hooks.test.mjs tests/runtime-cancel.test.mjs` → FAIL: the rewritten L281 test and the focus test get the full review payload instead of the queued one (`Object.keys` mismatch); the resume test has no `jobId` (`status undefined --wait` exits 1); the queued-window test throws `ENOENT` on `jobs/undefined.pid`. The resume and queued-window tests fail only because the launch payload has no `jobId` yet; once the branch lands they pass without further production change (they pin rules that already hold for any `review` record). The rewritten hooks test fails with `Timed out waiting for condition.` after the review ran 60 s in the foreground (its payload has no `jobId`, and the record it reads back is already `completed`).
- [ ] **Step 3: Implement.**
  1. `commands/review.mjs`: add `enqueueBackgroundJob` and `renderQueuedLaunch` to the `./shared.mjs` import and `outputCommandResult` to the `../lib/cli.mjs` import; change `async function executeReviewRun` to `export async function executeReviewRun`. The complete `handleReviewCommand` becomes:

```js
export async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, REVIEW_ARG_SPEC);
  if (maybePrintCommandHelp(options)) {
    return;
  }

  // Spec §3.3 Dispatch: everything is validated before any job record, request
  // file or codex start, in this order.
  // 1. flag conflict
  if (options.wait && options.background) {
    throw new Error("Choose either --wait or --background.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // 2. model and effort
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort, model);
  // 3. --config and --turn-timeout-ms
  const configOverrides = parseConfigOverrides(options.config);
  const turnTimeoutMs = parseTimeoutOption(options["turn-timeout-ms"], "--turn-timeout-ms");
  // 4. git repository, scope, --base
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  // 5. codex (before 1.5.0 this ran inside the run and left a failed record)
  ensureCodexAvailable(cwd);
  // 6. the reviewer and, for the built-in one, its target
  const focusText = positionals.join(" ").trim();
  const reviewName = config.reviewName === "Review" && focusText ? "Adversarial Review" : config.reviewName;
  const notice = reviewName === config.reviewName ? null : REVIEW_FOCUS_NOTICE;
  if (reviewName === "Review") {
    validateNativeReviewRequest(target);
  }

  const metadata = buildReviewJobMetadata(reviewName, target);
  const job = {
    ...createCompanionJob({
      prefix: "review",
      kind: metadata.kind,
      title: metadata.title,
      workspaceRoot,
      jobClass: "review",
      summary: metadata.summary
    }),
    // Top level so `status` shows it: the status summary drops `request`.
    focusText: focusText || null
  };
  // Also the request file of a background run (0600, the only place the
  // unredacted --config values live); the worker re-resolves base and scope.
  const request = {
    cwd,
    base: options.base ?? null,
    scope: options.scope ?? null,
    model,
    effort,
    config: configOverrides,
    focusText,
    reviewName,
    notice,
    turnTimeoutMs,
    jobId: job.id
  };

  if (options.background) {
    // The task path unchanged: queued record (background: true, redacted
    // request), request file, detached `task-worker`, recordWorkerPid.
    const { payload: queued } = enqueueBackgroundJob(cwd, job, request);
    const payload = notice ? { ...queued, notice } : queued;
    outputCommandResult(payload, `${notice ? `${notice}\n` : ""}${renderQueuedLaunch(payload)}`, options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), { json: options.json });
}
```

  2. `commands/shared.mjs`: the complete `handleTaskWorker` becomes:

```js
// The detached worker of every background job. The subcommand stays `task-worker`
// with the same argv, so `workerCommandLine` and the reaper's companion-path
// match are unchanged. A review record runs the review runner; anything else — a
// task, or a job queued before 1.5.0 without `jobClass` — runs the task runner.
export async function handleTaskWorker(argv, runners) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  // The private payload carries the unredacted request; fall back to the record
  // for jobs queued before that file existed.
  const request = consumeJobRequestFile(workspaceRoot, options["job-id"]) ?? storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }
  const runner = storedJob.jobClass === "review" ? runners.review : runners.task;

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  registerWorkerCrashGuard(workspaceRoot, options["job-id"], logFile);
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      runner({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}
```

  3. `codex-companion.mjs` `main`: import `executeReviewRun` from `./commands/review.mjs` (add it to the existing import of that module) and make the case

```js
    case "task-worker":
      await handleTaskWorker(argv, { review: executeReviewRun, task: executeTaskRun });
      break;
```
- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/runtime-review.test.mjs tests/runtime-hooks.test.mjs tests/runtime-cancel.test.mjs tests/runtime-task.test.mjs tests/runtime-status.test.mjs tests/module-boundaries.test.mjs` → pass (`runtime-task.test.mjs:111` "task-resume-candidate returns the latest rescue thread" still passes: a hand-made review record newer than the task is skipped).
- [ ] **Step 5: Verified unaffected (no edit; cite in the review).** `rg -n 'jobClass|kind ===|"task"|background' plugins/codex/scripts` on HEAD, every hit:
  - `codex-companion.mjs:424` (`findLatestResumableTaskJob`, `jobClass === "task"`) and `:508` (the active-task guard of `--resume-last`): a review is never a candidate and a running review never blocks a resume — pinned by the resume test above.
  - `codex-companion.mjs:577/634/713` (`jobClass` on executions; `runTrackedJob` ignores it, the record keeps the queued `jobClass`), `:746-791` (`getJobKindLabel`, `createCompanionJob`, `buildTaskJob`: labels and builders).
  - `lib/job-control.mjs:19-39` (`getJobTypeLabel`), `:126`, `:144` (legacy phase inference): labels only. `resolveCancelableJob` (L273-300), `commitCancel` (L325-357), `cancelDecision` (L362-386), `isWorkerTerminalRecord`/`isWorkerProvedRecord` (L305-314): no class or kind key.
  - `commands/cancel.mjs` (`handleCancel`/`finishCancel`, today `:1291-1442`): keyed on `transport`, `turnId`, `pid`/`pidIdentity`, `workerClosed`, `appServerExited` only.
  - `lib/render.mjs:160` (the "Review changes" hint, task jobs only).
  - `session-lifecycle-hook.mjs:141` and `:212`: keyed on `job.background` (a queued review record has it from `enqueueBackgroundJob`); `activeWorkspaceJobs` counts every job, so the broker stays while a review runs — pinned by the replaced `runtime-hooks.test.mjs` test ("a running background review survives its own session's SessionEnd…": worker, record and broker alive after SessionEnd).
  - `stop-review-gate-hook.mjs:144` (its own `task --json` run) and `:236-240` (any active job gives the note "Codex task <id> is still running", class-agnostic, a pre-existing label).
  - Reaper `lib/tracked-jobs.mjs:434-567`: keyed on status, pid, identity and the companion path in the command line (`:557`); request-file removal sites `tracked-jobs.mjs:274`, `:306`, `:351` and `job-control.mjs:342` take no class.
  - What a review record needs for the v1.4.2 cancel rules, verified: `runAppServerReview` (`lib/codex.mjs:1224-1290`) uses `withAppServer` (so the execution carries `appServerExited`, `:829-838`) and `captureTurn` with `delivery: "inline"`, so `state.threadId === sourceThreadId`; the fake and the real server send `turn/started` on that thread, and `applyTurnNotification` (`:571-593`) emits `{ threadId, turnId, transport }`, which `createJobProgressUpdater` (`lib/tracked-jobs.mjs:97-157`) writes to the index and the file; `runTrackedJob` (`:189-310`) writes `pid`, `pidIdentity`, `workerClosed`, `appServerExited` and keeps `transport`.
  - Windows: `docs/agent/windows-threat-model.md` does not apply. The worker is spawned by the same `spawnDetachedTaskWorker` (today `:878-888`: `process.execPath`, `[COMPANION_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId]`, `detached: true`, `stdio: "ignore"`, `windowsHide: true`) through the same `enqueueBackgroundJob`; only the job id prefix differs (`review-`), and `workerCommandLine` (`lib/process.mjs:447-450`) escapes the id literally.
- [ ] **Step 6: Commit** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/commands/review.mjs plugins/codex/scripts/commands/shared.mjs plugins/codex/scripts/codex-companion.mjs tests/helpers.mjs tests/runtime-review.test.mjs tests/runtime-hooks.test.mjs tests/runtime-cancel.test.mjs && git commit -m "feat(review): --background detaches a review worker in the companion (#615)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task S3b.4 (Opus): a detached worker's startup failure keeps its reason — stdout/stderr to the job log, request read under a failure record

**Files:** Modify `plugins/codex/scripts/commands/shared.mjs` (`spawnDetachedTaskWorker`, today `codex-companion.mjs:878-888`; its call in `enqueueBackgroundJob`, today `:916`; `handleTaskWorker` as S3b.3 left it), `plugins/codex/scripts/lib/tracked-jobs.mjs` (`markJobDead`, L316-320: `export` only). Test `tests/runtime-task.test.mjs` (imports L1-29, two new tests at the end).

**Interfaces:**
- Produces: `spawnDetachedTaskWorker(cwd, jobId, logFile)` — the third parameter is the job's existing log path (from `createTrackedProgress(job)` in `enqueueBackgroundJob`); the child's stdout and stderr are appended to it.
- Produces: `export function markJobDead(workspaceRoot, jobSummary, errorMessage, lockWaitMs = undefined)` (body unchanged).
- Produces: a job whose worker cannot read its request ends `failed` with `errorMessage` `worker could not start: <reason>`; `<reason>` is `its request file is not valid JSON` for a JSON error (never the parser's text, which quotes the file), else the error's own message (`Stored job <id> is missing its task request payload.`, or an fs error naming the path). The job log gets `Marked failed: <errorMessage>` and, through the worker's stderr, the same message.
- Record fields: none added. `handleTaskWorker(argv, runners)` keeps its signature.

- [ ] **Step 1: Failing tests.** `tests/runtime-task.test.mjs`: add `import { pathToFileURL } from "node:url";` after L5; add `jobDiagnostics,`, `killJobWorkerAfter,` and `PLUGIN_ROOT,` to the `./helpers.mjs` import list. Append:

```js
// Before 1.5.0 a detached worker ran with stdio "ignore": whatever it printed
// before it could write its own log (an import error, main's catch) was lost, and
// the reaper later recorded only "worker exited before completing".
test("a background worker that throws before it tracks its job leaves the error in the job log", { timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const preload = path.join(binDir, "worker-throws.mjs");
  fs.writeFileSync(preload, 'if (process.argv.includes("task-worker")) throw new Error("worker preload exploded");\n');
  const env = buildEnv(binDir, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim() });

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "never runs"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId, logFile } = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, jobId);
  await waitFor(() => fs.readFileSync(logFile, "utf8").includes("worker preload exploded"));
  // The reaper judges the dead worker and can still append to the log it wrote to.
  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
    return status.status === 0 && JSON.parse(status.stdout).job.status === "failed";
  }, { intervalMs: 500 });
  assert.match(fs.readFileSync(logFile, "utf8"), /Marked failed: worker exited before completing/, jobDiagnostics(repo, jobId));
});

// A request file the worker cannot parse fails the job with that reason, not the
// reaper's generic one, and the parser's text (which quotes the file, and so a
// --config value) reaches neither the record nor the log.
test("a background worker that cannot read its request file fails the job with the real reason", { timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const stateUrl = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs")).href;
  const preload = path.join(binDir, "corrupt-request.mjs");
  fs.writeFileSync(preload, [
    'const at = process.argv.indexOf("--job-id");',
    'if (process.argv.includes("task-worker") && at !== -1) {',
    `  const { resolveJobRequestFile } = await import(${JSON.stringify(stateUrl)});`,
    '  const cwd = process.argv[process.argv.indexOf("--cwd") + 1];',
    '  (await import("node:fs")).writeFileSync(resolveJobRequestFile(cwd, process.argv[at + 1]), \'{"config":{"auth":"sk-corrupt-secret"\');',
    "}",
    ""
  ].join("\n"));
  const env = buildEnv(binDir, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim() });

  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, jobId);
  const failed = await waitFor(() => { const job = readJobRecord(repo, jobId); return job.status === "failed" ? job : null; });
  assert.equal(failed.errorMessage, "worker could not start: its request file is not valid JSON", jobDiagnostics(repo, jobId));
  const log = fs.readFileSync(failed.logFile, "utf8");
  assert.ok(log.includes(`Marked failed: ${failed.errorMessage}`), log);
  assert.equal(log.includes("sk-corrupt-secret"), false, "the parser's text never reaches the log");
  assert.equal(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8").includes("sk-corrupt-secret"), false);
  assert.equal(fs.existsSync(resolveJobRequestFile(repo, jobId)), false, "the unreadable payload is removed");
});
```
Both run on every platform: the preload is a `file:` URL (`--import` works on Windows, Node ≥ 18.18), and neither test signals a live worker.

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test --test-name-pattern "background worker that" tests/runtime-task.test.mjs` → FAIL, both `Timed out waiting for condition.`: the first because the worker's stderr is discarded (`stdio: "ignore"`), the second because the worker dies in `consumeJobRequestFile` before any record write, so the job file stays `queued` (only a later reaper pass would write the generic message).
- [ ] **Step 3: Implement.**
  1. `lib/tracked-jobs.mjs` L316: `function markJobDead(` → `export function markJobDead(`.
  2. `commands/shared.mjs`: import `fs` from `node:fs` if S1 did not, and `appendLogLine`, `markJobDead` from `../lib/tracked-jobs.mjs` (add to the existing import). `spawnDetachedTaskWorker` becomes:

```js
// The worker's stdout and stderr are appended to its job log, so what it prints
// before it can write the log itself (an import error, main's catch) stays next
// to its record. The same pattern as the broker's own log (`spawnBrokerProcess`,
// lib/broker-lifecycle.mjs:129-141). The child gets a duplicate of the
// descriptor; the parent's copy is closed at once.
export function spawnDetachedTaskWorker(cwd, jobId, logFile) {
  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [COMPANION_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(logFd);
  }
  // An asynchronous spawn failure (ENOENT, EACCES) arrives as 'error'; unhandled,
  // it would crash the parent. enqueueBackgroundJob already turns the missing pid
  // into a failed record; this keeps the reason in the log.
  child.on("error", (error) => appendLogLine(logFile, `Could not spawn the background Codex worker: ${error.message}`));
  child.unref();
  return child;
}
```
     In `enqueueBackgroundJob` the call becomes `child = spawnDetachedTaskWorker(cwd, job.id, logFile);` (`logFile` is the one `createTrackedProgress(job)` created two statements earlier).
  3. The complete `handleTaskWorker` becomes (the log and the crash guard now come before the request read):

```js
// The detached worker of every background job. The subcommand stays `task-worker`
// with the same argv, so `workerCommandLine` and the reaper's companion-path
// match are unchanged. A review record runs the review runner; anything else — a
// task, or a job queued before 1.5.0 without `jobClass` — runs the task runner.
export async function handleTaskWorker(argv, runners) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob) {
    throw new Error(`No stored job found for ${jobId}.`);
  }

  // From here every failure ends the job with its own reason: the crash guard
  // for an async crash, the catch below for an unreadable request.
  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  registerWorkerCrashGuard(workspaceRoot, jobId, logFile);

  let request;
  try {
    // The private payload carries the unredacted request; fall back to the
    // record for jobs queued before that file existed.
    request = consumeJobRequestFile(workspaceRoot, jobId) ?? storedJob.request;
    if (!request || typeof request !== "object") {
      throw new Error(`Stored job ${jobId} is missing its task request payload.`);
    }
  } catch (error) {
    // A JSON error quotes the start of the file, which may hold a --config
    // value: neither the record nor the log (this worker's stderr) gets it.
    const reason = error instanceof SyntaxError ? "its request file is not valid JSON" : error instanceof Error ? error.message : String(error);
    const message = `worker could not start: ${reason}`;
    // Also removes the payload and the pid sidecar; keeps a terminal record.
    markJobDead(workspaceRoot, { ...storedJob, logFile }, message);
    throw new Error(message);
  }
  const runner = storedJob.jobClass === "review" ? runners.review : runners.task;

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      runner({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}
```
- [ ] **Step 4: Windows spawn review (`docs/agent/windows-threat-model.md`, point by point).** This task changes one spawn call: two `stdio` entries.
  - (a) In-box tools by absolute path: no in-box tool is started. The executable stays `process.execPath` (absolute).
  - (b) Bare-name resolution: none. No name is resolved; `resolveExecutable` is not involved, as before.
  - (c) `.cmd` shims: none. `node.exe` runs the companion directly; `shell` stays unset (false). `cmd.exe` is not involved.
  - (d) Console-output decoding: the plugin never parses the child's output. The bytes go straight into the log file. Only `readJobProgressPreview` reads the log, for display: lines that start with `[`, never a decision.
  - (e) `%VAR%`/CR/LF in a `.cmd` argument: no `.cmd`. The argv is unchanged (`[COMPANION_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId]`).
  - Unchanged: executable, argv, `cwd`, `env`, `detached: true`, `windowsHide: true`, `unref()`. Changed: `stdio` from `"ignore"` to `["ignore", logFd, logFd]`.
  - Log file: the same path the record already names (`jobs/<id>.log` under the workspace state dir, `resolveJobLogFile`), created by `createJobLogFile` before the spawn with the default mode. `openSync(path, "a")` on that existing file changes neither its mode nor its location.
  - Handles:
    - The parent closes its descriptor right after `spawn` (`finally`).
    - Only the worker holds an inherited handle, until it exits. Its own children do not inherit it: the app-server has `stdio: ["pipe", "pipe", "pipe"]` (`lib/app-server.mjs:255`), and the broker opens its own log (`broker-lifecycle.mjs:130-135`).
    - libuv opens files with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, so the reaper's `Marked failed` append, cancel's `appendLogLine`/`commitCancel` lines and `saveState`'s prune unlink are not blocked while the worker lives.
    - Pinned on windows-latest by the existing win32 cancel tests, which append to a live worker's log: `runtime-cancel.test.mjs:617` (direct) and `:641` (brokered). The first test above also pins it: its reaper append after the worker died.
- [ ] **Step 5:** `node --import ./tests/test-env.mjs --test tests/runtime-task.test.mjs tests/runtime-cancel.test.mjs tests/runtime-review.test.mjs tests/tracked-jobs.test.mjs` → pass. The existing reaper and cancel tests for task workers are unchanged: `runtime-cancel.test.mjs:200`, `:331`, `:403`, `:510`, `:552`, and `tracked-jobs.test.mjs`. `runtime-task.test.mjs:754` ("a worker started against a cancelled job…") still exits 0: its record carries `request`, so the worker reaches `runTrackedJob`, which refuses the job.
- [ ] **Step 6: Commit** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/commands/shared.mjs plugins/codex/scripts/lib/tracked-jobs.mjs tests/runtime-task.test.mjs && git commit -m "fix(worker): a detached worker's output goes to its job log, and an unreadable request fails the job with its reason" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task S3b.5 (Opus): fake `FAKE_CODEX_REVIEW_DELAY_MS`; a brokered background review is cancelled by the v1.4.2 rules

**Files:** Modify `tests/fake-codex-fixture.mjs` (after L300; `review/start` case L473-503). Test `tests/runtime-cancel.test.mjs` (three new tests after the queued-window review test S3b.3 added; `killJobWorkerAfter` is already imported by S3b.3).

**Interfaces:**
- Produces: env knob `FAKE_CODEX_REVIEW_DELAY_MS=N` (N > 0): `review/start` answers, sends `turn/started` and `item/started` `enteredReviewMode` at once, and completes (reasoning under `with-reasoning`, `exitedReviewMode`, `turn/completed` `completed`) after N ms. The turn is registered in `interruptibleTurns`, so the existing `turn/interrupt` handler (L751-777) completes it as `interrupted` and `FAKE_CODEX_IGNORE_INTERRUPT`, `FAKE_CODEX_IGNORE_FIRST_INTERRUPTS` and `FAKE_CODEX_EXIT_AFTER_INTERRUPT` apply unchanged. Unset or 0: byte-identical notification sequence to today.

- [ ] **Step 1: Failing tests.** In `tests/runtime-cancel.test.mjs`, after the queued-window review test, add:

```js
// The built-in review's turn runs in the shared broker like a task's: cancel sends
// turn/interrupt, waits for the worker's own terminal record and kills nothing.
// The interrupted review ends with status 1, so the worker writes `failed`
// (workerClosed: true); the cancel that caused it turns that record into
// `cancelled` (turnEnded) — a `failed` record here is not the bug to fix.
test("a brokered background built-in review is cancelled by interrupting its turn; nothing is killed", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_REVIEW_DELAY_MS: "60000" });
  // Before anything can fail: SessionEnd tears down the broker (posix idle 5 s otherwise).
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));
  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  killJobWorkerAfter(t, repo, jobId);
  const running = await waitFor(() => { const job = readJobRecord(repo, jobId); return job.status === "running" && job.pid && job.turnId && job.transport ? job : null; });
  assert.deepEqual([running.jobClass, running.background, running.transport], ["review", true, "broker"], jobDiagnostics(repo, jobId));

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${cancel.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.deepEqual([payload.turnInterruptAttempted, payload.turnInterrupted], [true, true]);
  const stored = readJobRecord(repo, jobId);
  assert.deepEqual([stored.status, stored.transport, stored.workerClosed], ["cancelled", "broker", true], jobDiagnostics(repo, jobId));
  const log = fs.readFileSync(stored.logFile, "utf8");
  assert.ok(log.includes("Turn interrupted.") && log.indexOf("Turn interrupted.") < log.indexOf("Cancelled by user."), `the turn ended before the cancel wrote:\n${log}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastInterrupt, { threadId: running.threadId, turnId: running.turnId });
  await waitFor(() => !isAlive(running.pid));
});

test("a brokered background review cancel on Windows kills nothing until the turn ends and leaves the shared broker and its subtree alive", { skip: !IS_WIN, timeout: 180_000 }, async (t) => {
  const repo = seededRepo(); fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir(); installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  // The broker's app-server ignores only the first interrupt: the first cancel must stay pending, the second ends the turn.
  const env = buildEnv(binDir, { FAKE_CODEX_REVIEW_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobA = JSON.parse(launched.stdout).jobId;
  // Registered before any wait: the worker by its sidecar, the broker (60 s idle
  // here) and its subtree by whatever record exists when the cleanup runs.
  killJobWorkerAfter(t, repo, jobA);
  t.after(() => {
    const recorded = loadBrokerSession(repo);
    if (!recorded?.pid) {
      return;
    }
    let tree = [];
    try { tree = cimTree(recorded.pid); } catch {}
    for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} }
    try { process.kill(recorded.pid, "SIGKILL"); } catch {}
  });
  const withPid = await waitFor(() => { const j = readJobRecord(repo, jobA); return j.pid ? j : null; });
  const running = await waitFor(() => { const j = readJobRecord(repo, jobA); return j.status === "running" && j.turnId ? j : null; });
  assert.deepEqual([running.jobClass, running.transport], ["review", "broker"], jobDiagnostics(repo, jobA));
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, "the review worker started the shared broker");
  const brokerTree = cimTree(broker.pid);
  assert.ok(brokerTree.some((n) => /^cmd\.exe$/i.test(n.name)), `expected the app-server tree under the broker, got ${JSON.stringify(brokerTree)}`);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  const pending = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(pending.status, 1, `cancel said: ${pending.stdout.trim()}\n${jobDiagnostics(repo, jobA)}`);
  assert.deepEqual(JSON.parse(pending.stdout), { jobId: jobA, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(withPid.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readJobRecord(repo, jobA).status, "running", jobDiagnostics(repo, jobA));
  assert.equal(isAlive(broker.pid), true, "the shared broker is untouched by a pending cancel");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "and so is its subtree");
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobA)}`);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled", jobDiagnostics(repo, jobA));
  await waitFor(() => (!isAlive(withPid.pid) ? "gone" : null));
  assert.equal(isAlive(broker.pid), true, "the shared broker survives the review's end");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "the broker's subtree survives");
  assert.deepEqual([readJobRecord(repo, jobA).status, readJobRecord(repo, jobA).transport], ["cancelled", "broker"], jobDiagnostics(repo, jobA));
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1, "cancel started no codex of its own");
});

// Two background reviews at once: while the first holds the shared broker's
// stream, the second worker's request gets `busy` and withAppServer retries on
// its own app-server (lib/codex.mjs:840-862), so it records `transport: "direct"`.
// Cancelling that one is v1.4.2 row 2 (no interrupt, verified kill of the worker
// that owns its app-server); the brokered sibling is not touched and completes.
// posix only: the win32 direct kill is `:617`, and a second cimTree walk per
// worker would double the twin's runtime for no new code path.
test("two background reviews at once keep their records apart; cancelling the direct one leaves the brokered one to complete", { skip: IS_WIN, timeout: 150_000 }, async (t) => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  // Long enough for the direct review to be caught running and cancelled; short
  // enough for the brokered one to finish inside the test (its wait is 90 s).
  const env = buildEnv(binDir, { FAKE_CODEX_REVIEW_DELAY_MS: "30000" });
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));

  const first = run(process.execPath, [SCRIPT, "review", "--background", "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const brokered = JSON.parse(first.stdout).jobId;
  killJobWorkerAfter(t, repo, brokered);
  const brokeredRunning = await waitFor(() => { const job = readJobRecord(repo, brokered); return job.status === "running" && job.turnId && job.transport ? job : null; });
  assert.equal(brokeredRunning.transport, "broker", jobDiagnostics(repo, brokered));

  // The second is an adversarial review held 60 s by the plain-turn knob (its
  // direct app-server inherits this env), so the cancel never races its end.
  const second = run(process.execPath, [SCRIPT, "adversarial-review", "--background", "--json"], { cwd: repo, env: buildEnv(binDir, { FAKE_CODEX_REVIEW_DELAY_MS: "30000", FAKE_CODEX_TURN_DELAY_MS: "60000" }) });
  assert.equal(second.status, 0, second.stderr);
  const direct = JSON.parse(second.stdout).jobId;
  killJobWorkerAfter(t, repo, direct);
  assert.notEqual(direct, brokered);
  const directRunning = await waitFor(() => { const job = readJobRecord(repo, direct); return job.status === "running" && job.pid && job.turnId && job.transport ? job : null; });
  assert.equal(directRunning.transport, "direct", `the busy broker sends the second review to its own app-server\n${jobDiagnostics(repo, direct)}`);
  assert.deepEqual([directRunning.kind, readJobRecord(repo, brokered).kind], ["adversarial-review", "review"], "each record keeps its own job");

  const cancel = run(process.execPath, [SCRIPT, "cancel", direct, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, direct)}`);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${cancel.stdout.trim()}\n${jobDiagnostics(repo, direct)}`);
  assert.equal(payload.turnInterruptAttempted, false, "a direct job's app-server is the worker's own");
  await waitFor(() => !isAlive(directRunning.pid));
  assert.deepEqual([readJobRecord(repo, direct).status, readJobRecord(repo, direct).transport], ["cancelled", "direct"], jobDiagnostics(repo, direct));
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastInterrupt ?? null, null, "no turn/interrupt reached either app-server");

  const waited = run(process.execPath, [SCRIPT, "status", brokered, "--wait", "--timeout-ms", "90000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, `${waited.stderr}\n${jobDiagnostics(repo, brokered)}`);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed", jobDiagnostics(repo, brokered));
  const done = readJobRecord(repo, brokered);
  assert.deepEqual([done.transport, done.workerClosed], ["broker", true], jobDiagnostics(repo, brokered));
  assert.match(done.rendered, /Reviewed uncommitted changes/);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test --test-name-pattern "brokered background|two background reviews" tests/runtime-cancel.test.mjs` → FAIL (posix): `Timed out waiting for condition.` in both tests. Without the knob the fake completes `review/start` at once, so the job never shows `running` with a `turnId`. (The win32 twin is skipped locally; CI windows-latest runs it.)
- [ ] **Step 3: Implement.** `tests/fake-codex-fixture.mjs` — the body is a template literal: no `${`, escapes as the file already uses them, keep the file's mixed tab/space indentation. After L300 (`const TURN_DELAY_MS = …`) add:

```js

// Test knob: hold a review/start turn open for this long before it completes, so
// a test can cancel a running built-in review. Registered like a held plain turn.
const REVIEW_DELAY_MS = Number(process.env.FAKE_CODEX_REVIEW_DELAY_MS || 0);
```

Replace the `review/start` case (L473-503) with:

```js
      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        const entered = { started: { type: "enteredReviewMode", id: turnId, review: "current changes" } };
        const finished = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ];
        if (REVIEW_DELAY_MS > 0) {
          // Registered in interruptibleTurns: turn/interrupt completes it as
          // "interrupted", and the FAKE_CODEX_IGNORE_* knobs apply.
          send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
          send({ method: "item/started", params: { threadId: reviewThread.id, turnId, item: entered.started } });
          const timer = setTimeout(() => {
            if (!interruptibleTurns.has(turnId)) {
              return;
            }
            interruptibleTurns.delete(turnId);
            for (const entry of finished) {
              send({ method: "item/completed", params: { threadId: reviewThread.id, turnId, item: entry.completed } });
            }
            send({ method: "turn/completed", params: { threadId: reviewThread.id, turn: buildTurn(turnId, "completed") } });
          }, REVIEW_DELAY_MS);
          interruptibleTurns.set(turnId, { threadId: reviewThread.id, timer });
          break;
        }
        emitTurnCompleted(reviewThread.id, turnId, [entered, ...finished]);
        break;
      }
```
(With the knob unset, `emitTurnCompleted` receives the same three-or-two entries in the same order as today: `turn/started`, `item/started enteredReviewMode`, [`item/completed reasoning`], `item/completed exitedReviewMode`, `turn/completed`.)
- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/runtime-cancel.test.mjs tests/runtime-review.test.mjs` → pass; every existing review test (knob unset) unchanged.
- [ ] **Step 5: Commit** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add tests/fake-codex-fixture.mjs tests/runtime-cancel.test.mjs && git commit -m "test(cancel): a brokered background review is cancelled by the v1.4.2 rules" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

### Task S3b.6 (Sonnet): command files — the companion's own `--background`, mode flags only before the focus, a fresh heredoc delimiter everywhere; usage shows review focus text

**Files:** Modify `plugins/codex/commands/review.md` (whole file), `plugins/codex/commands/adversarial-review.md` (whole file), `plugins/codex/commands/status.md`, `result.md`, `cancel.md`, `setup.md`, `transfer.md` (heredoc lines and one rule paragraph each; `status.md`/`result.md` as S2.3/S2.4 left them), `plugins/codex/skills/codex-cli-runtime/SKILL.md` (after L15), `plugins/codex/scripts/lib/cli.mjs` (`printUsage`, today `codex-companion.mjs:114`). Test `tests/commands.test.mjs` (L17-76 replaced; L210, L214, L216, L264, L316-322 edited; one new test), `tests/runtime-review.test.mjs` (two new tests at the end).

**Interfaces:** none in code. User-facing contract:
- Every command file that feeds `$ARGUMENTS` through `--args-stdin` uses the heredoc delimiter `CODEX_ARGS_<random>`, with this rule next to it (the same rule rescue already uses for `CODEX_PROMPT_<random>`, `commands/rescue.md:15-24`): *Pass the raw arguments in a quoted heredoc whose delimiter is `CODEX_ARGS_` + 8 fresh random hex characters that do not appear as an exact line in the arguments. Never reuse a delimiter suffix that appears as an exact line in the arguments: an argument line equal to it would end the heredoc early and run the rest on the host shell.*
- The review command files count a `--wait`/`--background` as a mode flag only among the leading flags. Before 1.5.0 the rule was "the raw arguments include". Now it is "before the first word that is neither a flag nor a flag's value, and before `--`".
- `plugins/codex/agents/**` checked on HEAD: `codex-rescue.md:22-28` already has the random delimiter and its rule; no text describes the review background flow or "review takes no focus". The same holds for `plugins/codex/skills/**` (`rg -n -i "background|focus|/codex:review|adversarial"`); only `codex-cli-runtime/SKILL.md` has a heredoc (L13-15) without the rule sentence, which this task adds.

- [ ] **Step 1: Failing tests.** In `tests/commands.test.mjs` replace L17-76 (the two tests) with:

```js
test("review command asks, then runs the companion (which detaches --background itself), staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.doesNotMatch(source, /```typescript/);
  assert.doesNotMatch(source, /run_in_background/);
  assert.match(source, /review --args-stdin <<'CODEX_ARGS_<random>'\n\$ARGUMENTS\nCODEX_ARGS_<random>\n/);
  assert.match(source, /review --background --args-stdin <<'CODEX_ARGS_<random>'\n\$ARGUMENTS\nCODEX_ARGS_<random>\n/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\].*\[focus \.\.\.\]/);
  assert.match(source, /\[--turn-timeout-ms <ms>\]/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /A mode flag is a `--wait` or `--background` among the leading flags/);
  assert.match(source, /the same words inside the focus text are not mode flags/i);
  assert.doesNotMatch(source, /If the raw arguments include `--(wait|background)`/);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /the companion detaches a `--background` review itself/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review or unstaged-only review/i);
  assert.match(source, /Focus text after the flags runs the adversarial reviewer/i);
});

test("adversarial review command asks, then runs the companion (which detaches --background itself), staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.doesNotMatch(source, /```typescript/);
  assert.doesNotMatch(source, /run_in_background/);
  assert.match(source, /adversarial-review --args-stdin <<'CODEX_ARGS_<random>'\n\$ARGUMENTS\nCODEX_ARGS_<random>\n/);
  assert.match(source, /adversarial-review --background --args-stdin <<'CODEX_ARGS_<random>'\n\$ARGUMENTS\nCODEX_ARGS_<random>\n/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\].*\[focus \.\.\.\]/);
  assert.match(source, /\[--turn-timeout-ms <ms>\]/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /A mode flag is a `--wait` or `--background` among the leading flags/);
  assert.match(source, /the same words inside the focus text are not mode flags/i);
  assert.doesNotMatch(source, /If the raw arguments include `--(wait|background)`/);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /the companion detaches a `--background` review itself/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /takes extra focus text after the flags/i);
});
```

In the same file:
- L210 → `assert.match(transfer, /codex-companion\.mjs" transfer --args-stdin <<'CODEX_ARGS_<random>'/);`
- L214 → `assert.match(result, /codex-companion\.mjs" result --args-stdin <<'CODEX_ARGS_<random>'/);`
- L216 → `assert.match(cancel, /codex-companion\.mjs" cancel --args-stdin <<'CODEX_ARGS_<random>'/);`
- L264 → `assert.match(setup, /codex-companion\.mjs" setup --json --args-stdin <<'CODEX_ARGS_<random>'/);`
- L316-320 (the comment and `expectedDelimiter`) become:

```js
    // rescue.md sends only the request prose through a randomized --prompt-stdin
    // heredoc (flags travel on the command line); the other seven command bodies
    // send their raw arguments through a randomized --args-stdin heredoc.
    const expectedDelimiter = file === "rescue.md" ? /--prompt-stdin <flags> <<'CODEX_PROMPT_/ : /--args-stdin <<'CODEX_ARGS_<random>'\n\$ARGUMENTS\nCODEX_ARGS_<random>\n/;
```

After the test that ends at L356 ("rescue sends the request prose through --prompt-stdin…") add:

```js
// A heredoc body line equal to its delimiter ends the heredoc early and the rest
// runs on the host shell. Review focus text is multi-line and verbatim (#714), so
// no heredoc a command, agent or skill tells Claude to write may use a fixed one.
test("every heredoc in commands, agents and skills uses a fresh random delimiter and says how to choose it", () => {
  const files = [
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).map((file) => path.join("commands", file)),
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "agents")).map((file) => path.join("agents", file)),
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).map((dir) => path.join("skills", dir, "SKILL.md")).filter((file) => fs.existsSync(path.join(PLUGIN_ROOT, file)))
  ];
  let heredocs = 0;
  for (const file of files) {
    const body = read(file);
    assert.doesNotMatch(body, /<<(?!')/, `${file}: every heredoc must be quoted`);
    for (const [, delimiter] of body.matchAll(/<<'([^']*)'/g)) {
      heredocs += 1;
      assert.match(delimiter, /^CODEX_(ARGS|PROMPT)_<random>$/, `${file}: fixed heredoc delimiter ${delimiter}`);
      const prefix = delimiter.replace("<random>", "");
      assert.match(
        body,
        new RegExp(`\`${prefix}\` \\+ 8 fresh random hex (chars|characters) that do not appear as an exact line in the (arguments|request)`),
        `${file} must say how to choose the ${prefix} delimiter`
      );
      assert.match(body, /would end the heredoc early and run the rest on the host shell/, `${file} must say why`);
    }
  }
  // review ×2, adversarial-review ×2, setup ×2, status, result, cancel, transfer, rescue, the agent, the runtime skill.
  assert.equal(heredocs, 13, "every heredoc was scanned");
});
```

Append to `tests/runtime-review.test.mjs`:

```js
test("usage shows focus text on review", () => {
  const help = run(process.execPath, [SCRIPT, "help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /codex-companion\.mjs review \[--wait\|--background\] .*\[--config key=value\]\.\.\. \[focus text\]\n/);
});

// The companion side of the command files' mode rule: a mode word after the first
// focus word is focus (#547, verbatim tail #714), so nothing detaches.
test("--background inside the focus text is focus, not a mode flag", () => {
  const repo = seededRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "investigate --background handling\n" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/, "the review ran in the foreground");
  const record = readJobRecord(repo);
  assert.deepEqual([record.status, record.background, record.focusText], ["completed", undefined, "investigate --background handling"]);
  assert.match(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt, /investigate --background handling/);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/commands.test.mjs tests/runtime-review.test.mjs` → FAIL:
  - the two review command tests: `run_in_background` is still present and the delimiter is `CODEX_ARGS`;
  - L210/L214/L216/L264 and the "command bodies" test: the delimiter is `CODEX_ARGS`;
  - the heredoc scan: `commands/adversarial-review.md: fixed heredoc delimiter CODEX_ARGS`;
  - the usage test: the line ends at `[--config key=value]...`.

  The `--background inside the focus text` test already passes. It pins the S3a.1/S3b.3 behaviour that the new command-file rule relies on. S3a.1's tests (`-- --model is wrong`, the verbatim tail) do not cover a mode word inside the focus.
- [ ] **Step 3: Implement.**
  1. `plugins/codex/commands/review.md` becomes exactly:

````markdown
---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark|astra|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--turn-timeout-ms <ms>] [--config key=value] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review: the shared built-in reviewer, or the adversarial reviewer when focus text is given.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- A mode flag is a `--wait` or `--background` among the leading flags: before the first word that is neither a flag nor a flag's value (`--base`, `--scope`, `--model`/`-m`, `--effort`, `--turn-timeout-ms` and `--config` each take one value), and before `--`. From that word on everything is focus text, so the same words inside the focus text are not mode flags (`investigate --background handling` has none).
- With a `--wait` mode flag, do not ask. Run the foreground flow.
- With a `--background` mode flag, do not ask. Run the background flow.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`; the companion detaches a `--background` review itself and returns at once.
- Without focus text, `/codex:review` runs the built-in reviewer. It does not support staged-only review or unstaged-only review.
- Focus text after the flags runs the adversarial reviewer instead (the built-in reviewer accepts no instructions); the output then starts with a line saying so.
- If the user needs more adversarial framing, they should use `/codex:adversarial-review`.
- Pass the raw arguments in a quoted heredoc whose delimiter is `CODEX_ARGS_` + 8 fresh random hex characters that do not appear as an exact line in the arguments. Never reuse a delimiter suffix that appears as an exact line in the arguments: an argument line equal to it would end the heredoc early and run the rest on the host shell.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --args-stdin <<'CODEX_ARGS_<random>'
$ARGUMENTS
CODEX_ARGS_<random>
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --background --args-stdin <<'CODEX_ARGS_<random>'
$ARGUMENTS
CODEX_ARGS_<random>
```
- The command returns at once with the job id; the review runs in a detached worker.
- Return the command stdout verbatim, exactly as-is.
- Do not wait for the review or poll `/codex:status` in this turn.
````

  2. `plugins/codex/commands/adversarial-review.md` becomes exactly:

````markdown
---
description: Run a Codex review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark|astra|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--turn-timeout-ms <ms>] [--config key=value] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Codex review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- A mode flag is a `--wait` or `--background` among the leading flags: before the first word that is neither a flag nor a flag's value (`--base`, `--scope`, `--model`/`-m`, `--effort`, `--turn-timeout-ms` and `--config` each take one value), and before `--`. From that word on everything is focus text, so the same words inside the focus text are not mode flags (`investigate --background handling` has none).
- With a `--wait` mode flag, do not ask. Run the foreground flow.
- With a `--background` mode flag, do not ask. Run the background flow.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`; the companion detaches a `--background` review itself and returns at once.
- `/codex:adversarial-review` uses the same review target selection as `/codex:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- It takes extra focus text after the flags (`/codex:review` with focus text runs this same reviewer).
- Pass the raw arguments in a quoted heredoc whose delimiter is `CODEX_ARGS_` + 8 fresh random hex characters that do not appear as an exact line in the arguments. Never reuse a delimiter suffix that appears as an exact line in the arguments: an argument line equal to it would end the heredoc early and run the rest on the host shell.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --args-stdin <<'CODEX_ARGS_<random>'
$ARGUMENTS
CODEX_ARGS_<random>
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --background --args-stdin <<'CODEX_ARGS_<random>'
$ARGUMENTS
CODEX_ARGS_<random>
```
- The command returns at once with the job id; the review runs in a detached worker.
- Return the command stdout verbatim, exactly as-is.
- Do not wait for the review or poll `/codex:status` in this turn.
````
     (`--background` stays before `--args-stdin`: `applyArgsStdin` keeps the argv before the flag and splices the heredoc after it, so it survives when the user's arguments do not contain it — the "Run in background" answer.)
  3. `status.md`, `result.md`, `cancel.md`, `setup.md`, `transfer.md`. Edit only the heredoc lines and add one paragraph. Keep everything else, including S2.3/S2.4's text in `status.md` and `result.md`.
     - Every `<<'CODEX_ARGS'` becomes `<<'CODEX_ARGS_<random>'`.
     - Every closing line `CODEX_ARGS` becomes `CODEX_ARGS_<random>`. `setup.md` has two blocks, today L10-12 and L30-32.
     - Directly above the first ```` ```bash ```` fence that holds such a heredoc, insert this paragraph and a blank line:

```markdown
Pass the raw arguments in a quoted heredoc whose delimiter is `CODEX_ARGS_` + 8 fresh random hex characters that do not appear as an exact line in the arguments. Never reuse a delimiter suffix that appears as an exact line in the arguments: an argument line equal to it would end the heredoc early and run the rest on the host shell.
```
  4. `plugins/codex/skills/codex-cli-runtime/SKILL.md`: after the closing fence at L16, insert a blank line and:

```markdown
The heredoc delimiter is `CODEX_PROMPT_` + 8 fresh random hex characters that do not appear as an exact line in the request. Never reuse a delimiter suffix that appears as an exact line in the request: a payload line equal to it would end the heredoc early and run the rest on the host shell.
```
  5. `printUsage` (`lib/cli.mjs`, today `codex-companion.mjs:114`): append ` [focus text]` to the `review` line, so it ends `… [--turn-timeout-ms <ms>] [--config key=value]... [focus text]",`. If S1's `tests/cli.test.mjs` pins the usage text byte for byte, update that pin in this task.
- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/commands.test.mjs tests/runtime-review.test.mjs tests/docs-contracts.test.mjs` → pass; `claude plugin validate . --strict` → exit 0; `rg -n "<<'CODEX_ARGS'" plugins README.md docs --glob '!docs/superpowers/**'` → no hit (README is the controller's task; report any hit there).
- [ ] **Step 5: Commit** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/commands/review.md plugins/codex/commands/adversarial-review.md plugins/codex/commands/status.md plugins/codex/commands/result.md plugins/codex/commands/cancel.md plugins/codex/commands/setup.md plugins/codex/commands/transfer.md plugins/codex/skills/codex-cli-runtime/SKILL.md plugins/codex/scripts/lib/cli.mjs tests/commands.test.mjs tests/runtime-review.test.mjs && git commit -m "fix(commands): a fresh random heredoc delimiter in every command file; review commands use the companion's own --background and read mode flags only before the focus" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

## Release

### Task R.1 (Sonnet): README, internals docs, CHANGELOG 1.5.0

Docs only; runs after every S1–S3 task is merged into the branch. The README states observable
outputs only (flags, JSON fields, exit codes, printed lines): no `scripts/lib/` path and no
`name()` call outside backticks (`tests/docs-contracts.test.mjs:55-60`). The two sentences pinned by
`tests/commands.test.mjs:422-440` stay word for word.

**Files:** Modify `README.md`, `docs/windows.md` (Code path), `docs/state-and-lifecycle.md` (Code path), `CHANGELOG.md`, `plugins/codex/CHANGELOG.md`.

- [ ] **Step 1: README `/codex:review`.** Replace the paragraph that starts `Use \`--base <ref>\` for branch review.` with:

  "Use `--base <ref>` for branch review. It also supports `--wait` and `--background` (one or the other: passing both is an error). Without focus text it runs Codex's built-in reviewer, which is not steerable. Text after the flags is focus text: the run then uses the adversarial reviewer, exactly as [`/codex:adversarial-review`](#codexadversarial-review) does, and its output starts with `Focus text given: running the adversarial reviewer (the built-in reviewer accepts no instructions).` `--wait`/`--background` count as mode flags only before the focus text; the same words inside the focus text are focus."

  Add `/codex:review look at the retry path in the uploader` as a fourth line of the Examples block. After the paragraph that starts `This command is read-only and will not perform any changes.` add:

  "A `--base <ref>` that does not resolve to a commit in this repository, or that starts with `-`, stops the command with `Base ref "<ref>" not found in this repository; …` and exit 1 before a job is recorded.

  `--background` returns at once with `<title> started in the background as <id>. Check /codex:status <id> for progress.` (with `--json`: `{ jobId, status: "queued", title, summary, logFile }`, plus `notice` when focus text was given). The review runs as a tracked job that outlives the session: follow it with `/codex:status`, read it with `/codex:result`, stop it with `/codex:cancel`.

  With `--json`, the built-in reviewer's payload carries `result: null`, `rawOutput` (the review text) and `parseError` (the built-in reviewer returns prose); the adversarial reviewer's payload carries structured findings in `result`. Every review record has `focusText` (`null` without focus text), shown by `/codex:status <id>` as a `Focus:` line. Review threads are saved and named `Codex Companion <Review|Adversarial Review>: <focus text or target>`, so `codex resume <session-id>` reopens them; `/codex:rescue --resume-last` never picks one."

- [ ] **Step 2: README `/codex:adversarial-review`.** Replace `It also supports \`--wait\` and \`--background\`. Unlike \`/codex:review\`, it can take extra focus text after the flags.` with:

  "It also supports `--wait` and `--background` (one or the other). Focus text after the flags reaches the reviewer exactly as typed — quotes, apostrophes and line breaks included — and everything after the first focus word is focus text, even if it looks like a flag; put `--` before focus text that starts with a dash. `--wait`/`--background` count as mode flags only before the focus text. `/codex:review` with focus text runs this same reviewer."

  Keep the line `It uses the same review target selection as \`/codex:review\`, including \`--base <ref>\` for branch review.` and the three examples unchanged (pinned). After `This command is read-only. It does not fix code.` add:

  "Large inputs are capped: untracked files are inlined up to 262144 bytes in total (the rest are listed by name with an `untracked file(s) omitted` line; an untracked symlink is listed as `(skipped: symlink)` and never read through), and a prompt over 786432 characters is cut at a line boundary with a `[Repository context truncated at <N> characters: …]` marker, after which the reviewer is told to read the target itself with read-only git commands. The structured result is read from a bare JSON reply, from the first fenced code block in the reply, or else from the first complete JSON object in its text; a reply with none of these shows `Codex did not return valid structured JSON.` with the raw final message."

- [ ] **Step 3: README `/codex:status`.** After the paragraph that starts `\`status <id> --wait [--timeout-ms <ms>]\` blocks until` add:

  "Output is bounded to 8192 bytes, as text and with `--json`, including `status <id> --wait`. It is a summary: the job's prompt (`request`), its stored `result` and its `rendered` output are left out, and long strings and lists are shortened. A shortened view says so: `truncated: true`, an `omissions` object (`fields`, `fieldNames`, `records`, `strings`) and a `nextStep` line in `--json`; a `Truncated:` line followed by the next step in text. The list view also reports `totalJobs` and `omittedJobs`; `--all` includes the omitted records. `--output <new-path>` writes the complete JSON payload to a new file — an existing path, including a symlink, is refused with `--output <path> already exists; pass a new path.`; the file mode is 0600 except on Windows, where the directory's ACL applies — and prints the receipt `{ outputFile, bytes, sha256 }`. The path must be free when the command starts (`status <id> --wait --output` checks it before waiting); a path so long that the receipt itself would exceed 8192 bytes is refused with `--output path is too long: its receipt would exceed 8192 bytes; pass a shorter path.`"

  Add `/codex:status task-abc123 --output ./status-task-abc123.json` to the Examples block. In the text form the `Truncated:` line appears only when something the text shows was shortened (a cut string, a shortened list, omitted records); the summary's missing `request`/`result`/`rendered` are reported in `--json` only — say so in one sentence after the paragraph above.

- [ ] **Step 4: README `/codex:result`.** In the paragraph that starts `On a job that already has a terminal record`, replace the last sentence (`\`--json\` returns \`{ job, storedJob }\` (or, on a \`--wait\` timeout, the \`status --json\` snapshot plus a \`resumeCommand\` field).`) with:

  "`--json` returns `{ job, storedJob }` (or, on a `--wait` timeout, the `status --json` snapshot plus a `resumeCommand` field).

  A plain `/codex:result <id>` is bounded to 8192 bytes, as text and with `--json`: a larger result is shown as a preview that ends with a `Truncated:` line and ``Full output: `result <id> --wait` (text) or `result <id> --output <new-path>` (JSON).`` — the `--json` view carries `truncated`, `omissions` and `nextStep`. `/codex:result` shows that preview as it is; ask for the full text to get it. `result <id> --wait` prints the full record, unbounded, as before 1.5.0. `--output <new-path>` writes the complete JSON to a new file and prints the receipt `{ outputFile, bytes, sha256 }`; it cannot be combined with `--wait`."

  Add `/codex:result task-abc123 --output ./result-task-abc123.json` to the Examples block.

- [ ] **Step 5: README `/codex:rescue` bullets and "Start Something Long-Running".** In the bullet that starts `\`result <id> [--wait [--timeout-ms <ms>]]\` answers a different question`, replace its last sentence (`\`--json\` on either returns \`{ job, storedJob }\` (or, on a timeout, the \`status --json\` snapshot plus a \`resumeCommand\` field).`) with: "`--json` on either returns `{ job, storedJob }` (or, on a timeout, the `status --json` snapshot plus a `resumeCommand` field); `task --await` and `result --wait` always print the full record, while a plain `result <id>` and every `status` are bounded to 8192 bytes (see [`/codex:result`](#codexresult) and [`/codex:status`](#codexstatus))." Do not touch the sentence `\`result\` exits 0 for any terminal record (completed, failed or cancelled) and 3 while the job is still active` (pinned). In "Start Something Long-Running" add `/codex:review --background` as the first line of the first code block. In the `/codex:rescue` bullets, after the bullet that starts `The detached worker outlives the companion only when`, add the bullet: "a background job's worker appends its stdout and stderr to the job log (`logFile` in `status --json`); a worker that cannot read its request ends the job `failed` with `worker could not start: <reason>`."

- [ ] **Step 6: Internals docs.** `docs/windows.md` Code path: replace `\`plugins/codex/scripts/codex-companion.mjs\` (cancel)` with `\`plugins/codex/scripts/commands/cancel.mjs\` (cancel)`. `docs/state-and-lifecycle.md` Code path: append `, \`plugins/codex/scripts/lib/read-views.mjs\` (bounded \`status\`/\`result\` views, \`--output\`), \`plugins/codex/scripts/commands/status.mjs\` (\`status\`, \`result\`)` before the final full stop. Then `rg -n 'codex-companion\.mjs' docs/*.md docs/agent/*.md README.md` and fix any remaining sentence that names the entry file as the home of a command's logic (the entry path itself — what the commands run — stays).

- [ ] **Step 7: Check.** `node --import ./tests/test-env.mjs --test tests/commands.test.mjs tests/docs-contracts.test.mjs` → all pass (anchors `#codexresult`, `#codexstatus`, `#codexadversarial-review` resolve; no `scripts/lib/` in README).

- [ ] **Step 8: CHANGELOG.** Insert above `## 1.4.3`, then `cp CHANGELOG.md plugins/codex/CHANGELOG.md`:

```markdown
## 1.5.0 — 2026-09-30

### Added
- `status` and `result` take `--output <new-path>`: the complete JSON payload goes to a new file (an existing path, including a symlink, is refused; mode 0600 outside Windows) and stdout carries the receipt `{ outputFile, bytes, sha256 }`. The `status` list reports `totalJobs` and `omittedJobs`.
- `/codex:review --background` and `/codex:adversarial-review --background` detach inside the companion and return at once with the job id (`{ jobId, status: "queued", title, summary, logFile }` with `--json`); the review is a tracked job for `/codex:status`, `/codex:result` and `/codex:cancel` and outlives the session (upstream #615, partly: there is still no wall-clock limit per job).
- `/codex:review <focus text>` runs the adversarial reviewer and says so: `Focus text given: running the adversarial reviewer (the built-in reviewer accepts no instructions).` (upstream #522, parity only).
- Review records carry `focusText`; `/codex:status <id>` shows it as a `Focus:` line.
- Review threads are persisted and named `Codex Companion <Review|Adversarial Review>: <label>`, so `codex resume <session-id>` reopens them; `--resume-last` never picks one (upstream #529, PR #557).

### Changed
- **Compatibility:** `status` (list, `<id>`, `<id> --wait`) and a plain `result <id>` are bounded to 8192 bytes, as text and with `--json`. `status` is a summary without `request`, `result` and `rendered`; long strings and lists are shortened. A shortened view carries `truncated: true`, `omissions` and `nextStep` (`--json`) or ends with a `Truncated:` line and the next step (text). `result <id> --wait` and `task --await` print the full record as before. Callers that read large fields from `status --json` or `result --json` use `--output <new-path>`.
- `/codex:result` shows a truncated result as a preview with the `Full output:` line; the full text is `result <id> --wait`.
- `review --json` of the built-in reviewer gains `result: null`, `rawOutput` and `parseError`, and `result` for such a job prints the rendered review (heading, target, text) instead of the bare reviewer output (upstream #679).
- `--wait` together with `--background` on a review is an error (`Choose either --wait or --background.`); both were accepted silently.
- Codex availability is checked before a review job is recorded: a foreground review without `codex` no longer leaves a failed record.
- The `/codex:review` and `/codex:adversarial-review` command files no longer use Claude Code's background Bash.

### Fixed
- Focus text given to a review through `--args-stdin` reaches the prompt exactly as typed: apostrophes, quotes, backslashes and line breaks are no longer split or dropped (upstream #714).
- `--base <ref>` that does not resolve to a commit, or that starts with `-`, fails with `Base ref "<ref>" not found in this repository; …` before a job is recorded, instead of reviewing a wide or empty diff (upstream #653, PR #658).
- The adversarial review prompt is capped: untracked content past 262144 bytes is listed by name, and a prompt over 786432 characters is cut at a line boundary with a marker and the reviewer reads the target itself (upstream #405, PR #461).
- The adversarial review reads its structured result when Codex wraps the JSON in a code fence (with or without the `json` tag, LF or CRLF), puts prose before or after it, or embeds the object in prose: the first fenced block wins, otherwise the first complete JSON object in the text (upstream #583; recovery as in the sister plugin).
- **Security:** every command file passed the slash-command arguments through a heredoc with the fixed delimiter `CODEX_ARGS`; an argument line equal to it ended the heredoc and ran the following lines on the host shell. The delimiter is now `CODEX_ARGS_` + 8 random hex characters chosen so that no argument line equals it (the rule `/codex:rescue` already used). Present since `--args-stdin` was introduced.
- An untracked symlink is no longer read into the adversarial review context (a link to a file outside the repository put that file into the prompt); it is listed as `(skipped: symlink)`.
- The inline diff of an adversarial review is read within the inline limit; a diff that grew past it between measuring and reading falls back to self-collection instead of failing with `ENOBUFS`.
- A background worker that failed while starting lost its reason: its stdout and stderr now go to the job log, and an unreadable request file fails the job with `worker could not start: <reason>`.
- `--wait`/`--background` inside the focus text no longer select the run mode in the review command files.

### Internal
- `codex-companion.mjs` is split into `scripts/commands/*` and `scripts/lib/cli.mjs` with no runtime change; the entry path and the worker's command line are unchanged.
- `AGENTS.md`: for the maintainer the marketplace is a directory source, so `/codex:*` runs the main checkout.
- Tests: the `SessionEnd` table injects the liveness probe; the broker idle-timeout test uses a wider window and prints the broker log on failure.

### Known limitations
- `/codex:result` shows a preview when the result is over 8 KB; `status` never shows the prompt — read it with `result --json` or `--output` (spec §Limits)
- `task --await --json` and `result --wait --json` keep the 1.4.3 shape, without `truncated`/`omissions` (spec §Limits)
- Any text after `/codex:review` selects the adversarial reviewer, including model or effort words in another language; they become focus text (spec §Limits)
- Verbatim focus applies to review commands fed through `--args-stdin`; flags after the first focus word are focus text (spec §Limits)
- A brokered background review follows the 1.4.2 cancel rules: `/codex:cancel` may answer `turn-not-interrupted` and kills nothing; that a real app-server honours `turn/interrupt` on a review turn is assumed (spec §Limits)
- A background review keeps running after the session and keeps the session's broker alive while it runs (spec §Limits)
- A background review resolves its target when the worker starts: with automatic scope, a tree changed in between is reviewed as found (spec §Limits)
- Review context past the caps is only listed or cut; findings there depend on the model's own git reads; the built-in reviewer has no plugin-side cap (spec §Limits)
- No wall-clock limit per job; use `--turn-timeout-ms` (spec §Limits)
- The built-in reviewer never returns a schema-shaped `result` (spec §Limits)
- `--output` on Windows does not set mode 0600; a crash between create and write can leave a partial file; the path must be free when the command starts (spec §Limits)
- A review reply that only quotes a JSON object is read as that object; if it has the review shape it is shown as the review — `--json` carries the raw reply in `rawOutput` (spec §Limits)
```

  The gate's changelog check needs a section for the package version (still 1.4.3, present) and byte-equal copies, so it passes before the bump.

- [ ] **Step 9: Commit** (gate chain) `git add README.md docs/windows.md docs/state-and-lifecycle.md CHANGELOG.md plugins/codex/CHANGELOG.md && git commit -m "docs: v1.5.0 — bounded read views, review surface, changelog"`.

### Task R.2 (controller): reviews, adversarial gate, release

- [ ] **Step 1: Per-task review.** After each task: Fable review (`superpowers:requesting-code-review`, `model: fable`; R.1 may use Sonnet), `ponytail-review` on the diff, rulings and evidence in `.superpowers/sdd/2026-09-30-codex-plugin-cc-v1.5.0/progress.md` (a claim about code cites the hunk or the test name; a CI line is `CI <run-id> <sha>: rc=<n>; <job>: …`). After the last S1 task: the S1 proof output is pasted into the ledger and the split is reviewed alone before any S2 commit. `advisor` before each wave and before "done".
- [ ] **Step 2: Whole-branch review.** `pr-review-toolkit` (`code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`) on `git diff main...HEAD`, plus a Codex pass `/codex:review --base main --effort medium` (default model, `gpt-6.1-sol`) and a Codex read-only comparison of the implemented S2/S3 code with the sister plugin (`~/project/personal/cc-plugin-codex`), as was done for the plan. Fix waves as separate commits.
- [ ] **Step 3: Whole-branch gate.** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && claude plugin validate . --strict` → exit 0. `npm run test:coverage` meets `.c8rc.json` (the new `commands/` directory is inside its globs).
- [ ] **Step 4: Adversarial gate.** `/codex:adversarial-review --base main --effort max`; save `adv-1.5.0-passN.json` in the ledger directory. The brief names the new surfaces (detached review worker and its cancel, the worker's stdout/stderr in the job log, `--output` file creation, `--base` validation, the verbatim focus tail and the heredoc delimiter in the command files, untracked symlinks, the 8192-byte views) and quotes the stop rule verbatim:
  > Each pass brief must tag findings that already existed in the previous release (`pre-existing vX.Y`) and separate **blocking** classes — a foreign process killed; a live broker without a record and then killed; loss of a live broker's record; cancel reporting success on an unconfirmed tree; a cancelled job that still runs — from residual ones. A fix wave opens only for a blocking class that this release introduced or first exposed. Pre-existing semantics, and findings whose premise is "a process suspended for seconds" or "two consecutive disk-write failures", are parked with a ruling as a documented limit (spec `## Limits`, CHANGELOG "Known limitations") and go to the next release. Cap: 5 passes per release; every further pass needs an explicit user decision.

  For this release three more classes are blocking: arguments or focus text reaching a host shell; `--output` overwriting or following a path that already exists; a bounded view that prints invalid JSON or more than 8192 bytes. Parked findings → spec `## Limits` + CHANGELOG "Known limitations" + a spec revision-log row.
- [ ] **Step 5: Release** per `docs/RELEASING.md`: step 0 (claim, stop rule closed, revision tables current, README command sections match `plugins/codex/commands/*.md`, `npm audit --omit=dev` 0); step 1 `node scripts/bump-version.mjs 1.5.0 && npm run check-version` (the `## 1.5.0` heading exists from R.1); step 2 gate + PR #13 ready against `main`, CI line in the ledger (`gh run watch <id> --exit-status; rc=$?`); steps 3–4 merge, tag, `npm pack`, GitHub Release — **only after the user's explicit go**; step 5 `claude plugin marketplace update cbepx && claude plugin update codex@cbepx` in both config dirs, restart; step 6 smoke by the installed companion (`status`, sync and background task, `result`, `review --background`, `review <focus>`, `status --output`, a focus text with a line `CODEX_ARGS`), archive the SDD directory to `docs/superpowers/reports/v1.5.0/`, draft `docs/superpowers/triage/upstream-comments-v1.5.0.md` (#714/#333, #653/#658, #529/#557, #405/#461, #583, #679 closed; #615, #522 partly) for the user's approval, `agent-work release --stopped`.
