# codex-plugin-cc v1.4.3 — Implementation Plan (internal restructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Same behaviour, fewer copies: every helper that exists twice in `plugins/codex/scripts` lives once; the `"queued"/"running"` string comparisons go through `lib/job-status.mjs`; the test harness shares its helpers and `tests/runtime.test.mjs` is split by command family; a module-boundaries test and `no-unused-vars` keep it that way.

**Architecture:** Pure moves and renames, no control-flow edits. `render.mjs` and the new `job-status.mjs` stay leaves (`render` may import only `./job-status.mjs`); `state.mjs`/`fs.mjs` own the shared file helpers; `tracked-jobs.mjs` owns the session filter. Tests change only by import paths, helper names and file moves. `plugins/codex/scripts/codex-companion.mjs` keeps its path and name.

**Tech Stack:** Node 18.18+ ESM, zero runtime deps, `node:test` (files auto-discovered by `scripts/run-tests.mjs`), `rg`.

**Spec:** no spec — behaviour-preserving restructure; design = roadmap section Р3 + this plan.

## Global Constraints

- Worktree `.worktrees/release-v1.4.3`, branch `release/v1.4.3` (base `main` 1f91ec2). Claim per `docs/agent/process.md` before the first write: draft PR `<PR url>`, `agent-work claim --target <PR url>` → `<claim id>` in `.superpowers/sdd/2026-09-30-codex-plugin-cc-v1.4.3/progress.md`. No push without the controller's go.
- `rg`, never `grep`/`egrep`/`fgrep`; never `git add -A`.
- Gate before every commit, `&&` only: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit -m "…"`. While iterating: `node --import ./tests/test-env.mjs --test tests/<f>.test.mjs`.
- Baseline (v1.4.2 ledger, macOS): 466 tests / 455 pass / 11 skipped. After each commit the summary must be 466/455/11 plus exactly the tests this plan adds (A2 +3, D1 +4 → 473/462/11 at the end).
- Line numbers are verified on 1f91ec2 and shift as tasks land; every "delete Lx–y" names the symbol so the implementer re-anchors with `rg -n`.
- Commit trailer, always: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ponytail lite: each task names the lazier alternative; the ruled version is what is built.

## Review Focus

1. Every moved function is byte-identical to its source (diff the bodies, not the intent); the only edits are `export`, parameter names and the explicit `shorten` limit.
2. `isActiveJobStatus(x?.status)` replaces `x?.status !== "queued" && x?.status !== "running"` only where `undefined` was already "not active"; `isTerminalRecord` keeps the `Boolean(stored) &&` guard.
3. The session filter keeps `env?.[X] ?? process.env[X] ?? null`; the stop hook's `input.session_id || …` variant is not touched.
4. `tests/broker-stale-pid.test.mjs:515–526` keeps its null-returning `waitUntil` (the failure diagnostic depends on it).
5. The split keeps the 143 test titles as a set; no test gains or loses `{ skip, timeout }` options; helper renames only.

---

### Task A1 (Sonnet): `nowIso`, `readStoredJob`, `readJsonOrNull` have one home; dead `fs.mjs` exports go

**Files:** `plugins/codex/scripts/lib/state.mjs`, `lib/fs.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/model-catalog.mjs`, `codex-companion.mjs`. Tests: none (the only test mention is the comment at `tests/runtime.test.mjs:3592`).

Verified duplicates: `nowIso` — `state.mjs:17` (private) and `tracked-jobs.mjs:20` (exported, used by companion L1439), identical. `readStoredJob` — `job-control.mjs:185–191` and `tracked-jobs.mjs:169–175` (`readStoredJobOrNull`), identical bodies. `readJsonOrNull` — `state.mjs:140–146` and `model-catalog.mjs:32–34` (`readJson`), identical semantics. `createTempDir`/`writeJsonFile`/`safeReadFile` — zero callers in scripts, tests and repo scripts (`rg -n 'createTempDir|writeJsonFile|safeReadFile' plugins tests scripts` → only the definitions).

- [ ] **Step 1: `fs.mjs`.** Delete `import os from "node:os";` (L2, only used by `createTempDir`), `createTempDir` (L9–11), `writeJsonFile` (L17–19), `safeReadFile` (L21–23). After `readJsonFile` add:

```js
// Missing, unreadable or malformed file → null (state index, job files, model catalogue).
export function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: `state.mjs`.** L17 `function nowIso()` → `export function nowIso()`. After L8 add `import { readJsonOrNull } from "./fs.mjs";`. Delete the private `readJsonOrNull` (L140–146). After `resolveJobFile` (L821–824) add:

```js
// The job file, or null when the job has none yet (queued, never started).
export function readStoredJob(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}
```

- [ ] **Step 3: `tracked-jobs.mjs`.** Delete `nowIso` (L20–22) and `readStoredJobOrNull` (L169–175). Import block L6–16: add `nowIso,` and `readStoredJob,` (alphabetical). Rename the six call sites L182, L206, L232, L282, L465, L522: `readStoredJobOrNull(` → `readStoredJob(`.
- [ ] **Step 4: `job-control.mjs`.** Delete `readStoredJob` (L185–191); L6 state import: add `readStoredJob`. (`fs` stays: L64, L423.)
- [ ] **Step 5: `model-catalog.mjs`.** Delete `readJson` (L32–34); after L5 add `import { readJsonOrNull } from "./fs.mjs";`; L41 and L43 `readJson(` → `readJsonOrNull(`. (Stryker's `model-catalog.mjs` shard loses three mutants; harmless.)
- [ ] **Step 6: `codex-companion.mjs`.** Move `nowIso,` (L68) and `readStoredJob,` (L57) into the `./lib/state.mjs` block (L31–46, alphabetical). Lazier alternative: a one-line `export { readStoredJob } from "./state.mjs";` in job-control — rejected, the direct import is two lines and D1 then reads the true graph.
- [ ] **Step 7: Run** `node --import ./tests/test-env.mjs --test tests/state.test.mjs tests/tracked-jobs.test.mjs tests/job-control.test.mjs tests/model-catalog.test.mjs` → all pass; `rg -n 'readStoredJobOrNull|function readJson\b|function nowIso' plugins/codex/scripts` → `state.mjs` `nowIso` only.
- [ ] **Step 8: Commit** (gate chain) `git add plugins/codex/scripts/lib/state.mjs plugins/codex/scripts/lib/fs.mjs plugins/codex/scripts/lib/tracked-jobs.mjs plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/lib/model-catalog.mjs plugins/codex/scripts/codex-companion.mjs && git commit -m "refactor(lib): one nowIso, readStoredJob and readJsonOrNull; drop the dead fs.mjs exports"`.

### Task A2 (Sonnet): `lib/job-status.mjs` replaces the queued/running string comparisons

**Files:** Create `plugins/codex/scripts/lib/job-status.mjs`, `tests/job-status.test.mjs`. Modify `lib/state.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/codex.mjs`, `lib/render.mjs`, `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`, `codex-companion.mjs`.

Count on 1f91ec2: `rg -n 'status\s*(===|!==)\s*"(queued|running)"' plugins/codex/scripts` → 32 comparisons on 33 lines (companion L451–452 is one comparison): tracked-jobs 7, state 4, codex 1, render 6, session hook 2, job-control 7, stop hook 1, companion 4 (+ the private `isActiveJobStatus` L429–431, `isActiveStatus` tracked-jobs L165–167, `isTerminalRecord` job-control L326–328). Phase strings (`"queued"` as a phase, `status: "running"` literals in records, comments, tests) stay.

- [ ] **Step 1: Create `plugins/codex/scripts/lib/job-status.mjs`** (zero imports):

```js
// Job status vocabulary. A job is active while a worker may still write it.
export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export function isActiveJobStatus(status) {
  return status === JOB_STATUS.QUEUED || status === JOB_STATUS.RUNNING;
}

// A stored record that no worker will write again; null/undefined is not terminal.
export function isTerminalRecord(record) {
  return Boolean(record) && !isActiveJobStatus(record.status);
}
```

- [ ] **Step 2: Create `tests/job-status.test.mjs`:**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { isActiveJobStatus, isTerminalRecord, JOB_STATUS } from "../plugins/codex/scripts/lib/job-status.mjs";

test("isActiveJobStatus: only queued and running are active", () => {
  assert.deepEqual(Object.values(JOB_STATUS).map(isActiveJobStatus), [true, true, false, false, false]);
  assert.equal(isActiveJobStatus(undefined), false);
  assert.equal(isActiveJobStatus("done"), false);
});

test("isTerminalRecord: a finished record is terminal, a missing or active one is not", () => {
  assert.equal(isTerminalRecord({ status: "completed" }), true);
  assert.equal(isTerminalRecord({ status: "running" }), false);
  assert.equal(isTerminalRecord(null), false);
  assert.equal(isTerminalRecord(undefined), false);
});

test("JOB_STATUS is frozen", () => {
  assert.ok(Object.isFrozen(JOB_STATUS));
});
```

- [ ] **Step 3: Replace, file by file** (import line first, then the sites). `A(x)` = `isActiveJobStatus(x)`, `T(x)` = `isTerminalRecord(x)`:
  - `state.mjs`: `import { isActiveJobStatus, JOB_STATUS } from "./job-status.mjs";` L726 `indexed?.status !== "queued" && indexed?.status !== "running"` → `!A(indexed?.status)`; L730 `indexed.status === "queued"` → `indexed.status === JOB_STATUS.QUEUED`; L793 `current.status === "queued"` → `=== JOB_STATUS.QUEUED`; L862 `job?.status !== "queued" && job?.status !== "running"` → `!A(job?.status)`.
  - `tracked-jobs.mjs`: import `isActiveJobStatus, isTerminalRecord, JOB_STATUS`; delete `isActiveStatus` L165–167; L207 `!isActiveStatus(stored.status)` → `!A(stored.status)`; L327 → `!A(base.status)`; L397 `job.status !== "queued" || pid != null` → `job.status !== JOB_STATUS.QUEUED || pid != null`; L462, L519 → `!A(job.status)`; L466, L523 `stored && stored.status !== "running" && stored.status !== "queued"` → `T(stored)`.
  - `job-control.mjs`: import `isActiveJobStatus, isTerminalRecord, JOB_STATUS`; delete the private `isTerminalRecord` L326–328 (callers L334, L356 unchanged); L169 → `A(job.status) || job.status === JOB_STATUS.FAILED`; L227, L283, L300 → `A(job.status)`; L230, L234 → `!A(job.status)`.
  - `codex.mjs` L1355 → `A(job.status)`; `render.mjs` L115, L152, L385 → `A(job.status)`, L155, L158, L386 → `!A(job.status)` (render's only lib import: `import { isActiveJobStatus } from "./job-status.mjs";` at L1).
  - `session-lifecycle-hook.mjs` L144, L235 → `A(job.status)`; `stop-review-gate-hook.mjs` L237 → `A(job.status)` (both `from "./lib/job-status.mjs"`).
  - `codex-companion.mjs`: delete L429–431; import `isActiveJobStatus, isTerminalRecord` from `./lib/job-status.mjs`; L451–452 → `!A(job.status)`; L534 → `A(job.status)`; L1402 `stored && stored.status !== "queued" && stored.status !== "running"` → `T(stored)`.
- [ ] **Step 4: Proof.** `rg -n 'status\s*(===|!==)\s*"(queued|running)"' plugins/codex/scripts` → no output. `node --import ./tests/test-env.mjs --test tests/job-status.test.mjs tests/render.test.mjs tests/state.test.mjs tests/tracked-jobs.test.mjs tests/job-control.test.mjs tests/session-lifecycle-hook.test.mjs` → pass.
- [ ] **Step 5: Commit** `git add plugins/codex/scripts/lib/job-status.mjs tests/job-status.test.mjs plugins/codex/scripts/lib/state.mjs plugins/codex/scripts/lib/tracked-jobs.mjs plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/lib/render.mjs plugins/codex/scripts/session-lifecycle-hook.mjs plugins/codex/scripts/stop-review-gate-hook.mjs plugins/codex/scripts/codex-companion.mjs && git commit -m "refactor(lib): job-status.mjs replaces the queued/running string comparisons"`.

Lazier alternative: only `isActiveJobStatus`, no `JOB_STATUS`/`isTerminalRecord` — rejected because the three single-status sites (state L730/L793, tracked-jobs L397) would keep the regex proof from reaching zero.

### Task A3 (Sonnet): `render.mjs` owns `shorten`, `looksLikeVerificationCommand`, the pending-cancel text; session filter and JSON-RPC error de-duplicated

**Files:** `lib/render.mjs`, `lib/codex.mjs`, `lib/job-control.mjs`, `lib/tracked-jobs.mjs`, `lib/app-server.mjs`, `app-server-broker.mjs`, `codex-companion.mjs`; test `tests/job-control.test.mjs` (L11 import only).

Verified: `looksLikeVerificationCommand` — `job-control.mjs:105–109` and `codex.mjs:157–161`, same regex, parameter `line` vs `command`. `shorten` — `codex.mjs:146–155` (default 72, never used: L164 passes 56, L309/329/343/519/551/552 pass 96) and `codex-companion.mjs:269–278` (default 96, used at L771). `buildJsonRpcError` — `app-server.mjs:45–47` (private) and `app-server-broker.mjs:64–66`, identical. Session filter: `job-control.mjs:17–27` (`options.env?.[X] ?? process.env[X] ?? null`) and `codex-companion.mjs:433–443` (`process.env[X] ?? null`) agree; `stop-review-gate-hook.mjs:79–80` differs (`input.session_id || process.env[X] || null`, hook input first) → **left as is**.

- [ ] **Step 1: `render.mjs`** — after L1 (the job-status import from A2) nothing else; append at the end:

```js
export function shorten(text, limit) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}
```
  then `renderCancelPending` and `emitCancelPending` moved verbatim from `job-control.mjs` L443–481 (both leading comments included; `process` is the global, render imports nothing).
- [ ] **Step 2: `codex.mjs`.** Delete L146–161 (`shorten`, `looksLikeVerificationCommand`); after L47 add `import { looksLikeVerificationCommand, shorten } from "./render.mjs";`. Call sites unchanged (all pass a limit).
- [ ] **Step 3: `job-control.mjs`.** Delete L105–109 and L443–481; add `import { looksLikeVerificationCommand } from "./render.mjs";`. Delete `getCurrentSessionId`/`filterJobsForCurrentSession` L17–27; L7 → `import { DEAD_WORKER_MESSAGE, filterJobsForSession, getCurrentSessionId, reapDeadJobs } from "./tracked-jobs.mjs";` (`SESSION_ID_ENV` was only used at L18). Sites: L222 `filterJobsForCurrentSession(…, options)` → `filterJobsForSession(…, options.env)`; L268 `filterJobsForCurrentSession(…)` → `filterJobsForSession(…)`; L310 → `filterJobsForSession(activeJobs, options.env)`; L319 `getCurrentSessionId(options)` → `getCurrentSessionId(options.env)` (enclosing functions default `options = {}`: L219, L248, L297).
- [ ] **Step 4: `tracked-jobs.mjs`** — after L18:

```js
export function getCurrentSessionId(env) {
  return env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForSession(jobs, env) {
  const sessionId = getCurrentSessionId(env);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}
```

- [ ] **Step 5: `codex-companion.mjs`.** Delete `shorten` L269–278 and L433–443; L771 `shorten(prompt || fallbackSummary)` → `shorten(prompt || fallbackSummary, 96)`; L531, L1299 `getCurrentClaudeSessionId()` → `getCurrentSessionId()`; L533, L1300 `filterJobsForCurrentClaudeSession(` → `filterJobsForSession(`. Imports: `emitCancelPending,` (L54) and `shorten,` go to the `./lib/render.mjs` block (L75–84); `filterJobsForSession, getCurrentSessionId` join the tracked-jobs block and `SESSION_ID_ENV` (L72) leaves it (only use was L434).
- [ ] **Step 6: `app-server.mjs`** L45 `function buildJsonRpcError` → `export function buildJsonRpcError`. **`app-server-broker.mjs`:** delete L64–66; L9 → `import { BROKER_BUSY_RPC_CODE, buildJsonRpcError, CodexAppServerClient } from "./lib/app-server.mjs";`.
- [ ] **Step 7: `tests/job-control.test.mjs`** L11: remove `emitCancelPending, renderCancelPending` from the job-control import; add `import { emitCancelPending, renderCancelPending } from "../plugins/codex/scripts/lib/render.mjs";`. Lazier alternative: `export { emitCancelPending, renderCancelPending } from "./render.mjs";` in job-control (1 line vs 3) — rejected for the same reason as A1 Step 6.
- [ ] **Step 8: Run** `node --import ./tests/test-env.mjs --test tests/job-control.test.mjs tests/render.test.mjs tests/app-server.test.mjs tests/broker-idle-timeout.test.mjs tests/runtime.test.mjs` → pass. `rg -n 'function shorten|function looksLikeVerificationCommand|function buildJsonRpcError|function filterJobsForCurrent|function getCurrentClaudeSessionId' plugins/codex/scripts` → `render.mjs` ×2, `app-server.mjs` ×1, `stop-review-gate-hook.mjs` `filterJobsForCurrentSession` ×1 only. If `npm run build` (checkJs pulls `render.mjs` in through `codex.mjs`) reports a type error in `render.mjs`, fix it with JSDoc only.
- [ ] **Step 9: Commit** `git add plugins/codex/scripts/lib/render.mjs plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/lib/tracked-jobs.mjs plugins/codex/scripts/lib/app-server.mjs plugins/codex/scripts/app-server-broker.mjs plugins/codex/scripts/codex-companion.mjs tests/job-control.test.mjs && git commit -m "refactor(lib): render.mjs owns shorten, looksLikeVerificationCommand and the pending-cancel text; one session filter, one buildJsonRpcError"`.

Not duplicates, left alone (per design): `sleep`/`sleepSync`, the `isAlive` variants, `isDirectRun` in repo scripts vs the hook, `SESSION_ID_ENV` re-declared in `session-lifecycle-hook.mjs:24`.

### Task C1 (Sonnet): shared test harness helpers

**Files:** `tests/helpers.mjs`; `tests/runtime.test.mjs`, `tests/broker-idle-timeout.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/state.test.mjs`.

Verified copies: `waitForExit` — idle-timeout L29–46 (default 5000) and stale-pid L35–52 (default 10000), identical bodies; every idle-timeout call passes `timeoutMs` explicitly (L109, 143, 202, 305, 347, 386, 445), stale-pid L234/590/661 pass it, one call relies on 10000. `deadPid` — state.test L318–322 (`process.exit(0)`, `assert`) and stale-pid L1059–1063 (`""`, `assert`): same effect. `delay` idle-timeout L67–69 (7 sites). `waitUntil` stale-pid L205–215 (9 sites) **returns null on timeout**; L515–526 asserts on that null and prints the broker-log tail only on that path — so `waitUntil` moves **verbatim** (deviation from the ruling `waitUntil → waitFor`: `waitFor` throws first and the diagnostic never prints, against `docs/agent/testing-and-ci.md` "Evidence in tests"). `readPersistedJob` runtime L44–50 (33 sites), `jobDiagnostics` L52–61 (24 sites, cancel + task families), `isAlive` L42 (15 sites), `seededRepo` L3202–3209 (43 sites), constants L27–41.

- [ ] **Step 1: `tests/helpers.mjs`** — add imports `import { fileURLToPath } from "node:url";`, `import { isPidAlive, … } from "../plugins/codex/scripts/lib/process.mjs";` (extend the existing line), `import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";`, then append:

```js
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
export const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
export const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
export const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
export const FAKE_RESOLVED_SETTINGS = { /* verbatim from runtime.test.mjs L32–41 */ };

export const isAlive = (pid) => isPidAlive(pid) === true;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A pid that has certainly exited (a finished child), for stale-record fixtures.
export function deadPid() {
  const finished = run(process.execPath, ["-e", ""]);
  if (finished.status !== 0) throw new Error(`deadPid: helper child exited ${finished.status}`);
  return finished.pid;
}

export function waitForExit(child, { timeoutMs = 10000 } = {}) { /* verbatim from broker-stale-pid L35–52 */ }

// Like waitFor but resolves null on timeout, so the caller's own assertion (and its
// on-failure diagnostic, e.g. the broker-log tail) still runs.
export async function waitUntil(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) { /* verbatim from L205–215 */ }

export function readStateIndex(workspaceRoot) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspaceRoot), "state.json"), "utf8"));
}

export function readJobRecord(workspaceRoot, jobId = null) {
  const resolvedJobId = jobId ?? readStateIndex(workspaceRoot).jobs[0].id;
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspaceRoot), "jobs", `${resolvedJobId}.json`), "utf8"));
}

export function jobDiagnostics(repo, jobId) { /* verbatim from runtime L52–61, readPersistedJob → readJobRecord */ }

export function seededRepo() { /* verbatim from runtime L3202–3209 */ }
```

- [ ] **Step 2: call sites.** `runtime.test.mjs`: delete L27–61 and L3202–3209; import the names from `./helpers.mjs` (L9); `readPersistedJob(` → `readJobRecord(` (33 sites). `broker-idle-timeout.test.mjs`: delete `waitForExit` L29–46 and `delay` L67–69, import both (keep its local `ROOT`/`BROKER_SCRIPT`; do not import `ROOT`). `broker-stale-pid.test.mjs`: delete `waitForExit`, `waitUntil`, `deadPid`; delete its `ROOT`/`SESSION_HOOK`/`SCRIPT` (L30–33, a same-name import would be a SyntaxError) and import them plus `waitForExit, waitUntil, deadPid` (its `isAlive` at L53 has a different body — leave). `state.test.mjs`: delete `deadPid` L318–322, import it. The `delay` default and the `waitForExit` 10000 default keep every existing call's timing.
- [ ] **Step 3: Run** `node --import ./tests/test-env.mjs --test tests/runtime.test.mjs tests/broker-idle-timeout.test.mjs tests/broker-stale-pid.test.mjs tests/state.test.mjs` → same pass/skip counts as before the task. Then the gate.
- [ ] **Step 4: Commit** `git add tests/helpers.mjs tests/runtime.test.mjs tests/broker-idle-timeout.test.mjs tests/broker-stale-pid.test.mjs tests/state.test.mjs && git commit -m "test: shared harness helpers (waitForExit, waitUntil, deadPid, delay, readJobRecord, seededRepo, script paths)"`.

Lazier alternative: keep the name `readPersistedJob` (33 fewer changed lines) — rejected only because the ruling names `readJobRecord`; the rename is mechanical.

### Task C2 (Sonnet): split `tests/runtime.test.mjs` by command family

**Files:** delete `tests/runtime.test.mjs`; create `tests/runtime-setup.test.mjs`, `runtime-review.test.mjs`, `runtime-task.test.mjs`, `runtime-status.test.mjs`, `runtime-cancel.test.mjs`, `runtime-transfer.test.mjs`, `runtime-hooks.test.mjs`. `scripts/run-tests.mjs` discovers `tests/*.test.mjs` — no change; `stryker.config.mjs`/`tsconfig.tests.json` do not name the file.

Shared hooks: `rg -n '^test\.before|^before\(|^after\(|^describe\(|^let |^var |^process\.env' tests/runtime.test.mjs` → none, so a split loses nothing. 143 `test(` calls (start lines on 1f91ec2; a test ends before the next `test(`/helper):

| file | tests (start line) | n |
|---|---|---|
| setup | 62, 80, 101, 119, 137, 155, 2656, 2670, 2740, 3043, 3105, 3179 | 12 |
| review | 172, 400, 421, 442, 463, 490, 510, 1007, 1029, 1272, 1292, 1313, 1334, 3211, 3249 | 15 |
| task | 194, 212, 382, 535–1209 (24 tests through 1209), 2270, 3235–3907 (20), 4011–4154 (7), 4235–4374 (10) | 62 |
| status | 1365, 1463, 1534, 1595, 1656, 1719, 1817, 3150, 3350, 3796, 4388 | 11 |
| cancel | 1843, 1954, 2004, 2032, 2087, 2135, 2208, 2241, 3925, 3972, 4170, 4404, 4428, 4476, 4497, 4531 | 16 |
| transfer | 230, 281, 311, 340, 364 | 5 |
| hooks | 768, 2289, 2415, 2552, 2580, 2636, 2686, 2717, 2729, 2758, 2773, 2811, 2823, 2837, 2853, 2869, 2886, 2906, 2963, 2988, 3015, 4516 | 22 |

- [ ] **Step 1:** Before touching anything, in the scratchpad: `rg -o '^test\("[^"]*"' tests/runtime.test.mjs | sort > <scratch>/titles-before`.
- [ ] **Step 2:** Create the seven files: each starts with the L1–25 import block of the original (trim names the file does not use — after D2 eslint flags leftovers, so do not over-think it here), then its tests in original order, verbatim. `gateDecisions` (L2704–2715) and `runHookWithOpenStdin` (L2788–2810) go to `runtime-hooks` above their first use. `git rm tests/runtime.test.mjs`.
- [ ] **Step 3: bounded cleanup, moved tests only.** (a) 21 raw `JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"))` reads: replace with `readStateIndex(repo)` **only where that leaves `stateDir` unused** (then delete the `stateDir` line); otherwise leave. (b) The 50 inline `initGitRepo … "commit", "-m", "init"` blocks stay: review tests diff the exact seeded content, a blanket `seededRepo()` swap changes fixture data. Record both counts in the task report.
- [ ] **Step 4: Proof.** `rg -o '^test\("[^"]*"' tests/runtime-*.test.mjs | sort > <scratch>/titles-after && diff <scratch>/titles-before <scratch>/titles-after` → empty; `rg -c '^test\(' tests/runtime-*.test.mjs` sums to 143. `node --import ./tests/test-env.mjs --test tests/runtime-*.test.mjs` → 143 tests, same skip count as the old file on this host. (`git diff -M --stat` will most likely show one delete + seven adds — the largest piece is ~43 % of the original, below git's 50 % rename threshold — the title-set diff is the proof, not the rename detection.)
- [ ] **Step 5: CI note for the ledger.** `node --test` already runs the 21 test files in parallel (no `--test-concurrency` in `scripts/run-tests.mjs`); seven runtime files raise the number of subprocess-heavy suites that overlap on the Windows runner. If the matrix flakes on this commit only, add to `scripts/run-tests.mjs` the win32 fallback `...(process.platform === "win32" ? ["--test-concurrency", "2"] : [])` before `--test`, in a separate commit, and record the run ids.
- [ ] **Step 6: Commit** `git add tests/runtime.test.mjs tests/runtime-setup.test.mjs tests/runtime-review.test.mjs tests/runtime-task.test.mjs tests/runtime-status.test.mjs tests/runtime-cancel.test.mjs tests/runtime-transfer.test.mjs tests/runtime-hooks.test.mjs && git commit -m "test: split runtime.test.mjs by command family"`.

Lazier alternative: stop after C1 (helpers extracted, one 4.5 k-line file kept) or split into three (task / cancel+hooks / rest) — `runtime-task` alone stays ~2 000 lines; ruled as seven, the controller may merge `runtime-transfer` into `runtime-setup` if the 5-test file feels silly.

### Task D1 (Sonnet): `tests/module-boundaries.test.mjs`

**Files:** create `tests/module-boundaries.test.mjs`. Allow-lists below are the **post-A3** graph (`rg -n '^import .*from "\./|^} from "\./' plugins/codex/scripts/*.mjs plugins/codex/scripts/lib/*.mjs` after A3 must match them exactly; adjust the list, not the code).

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_ROOT } from "./helpers.mjs";

const SCRIPTS = path.join(PLUGIN_ROOT, "scripts");
const LIB = path.join(SCRIPTS, "lib");
// Leaves may import nothing from lib except the zero-import job-status.mjs (render needs it).
const LEAVES = ["args", "broker-endpoint", "fs", "hook-input", "job-status", "process", "prompts", "render"];
const ENTRY_ALLOW = {
  "app-server-broker.mjs": ["args", "app-server", "broker-endpoint", "broker-lifecycle"],
  "session-lifecycle-hook.mjs": ["process", "app-server", "broker-lifecycle", "state", "job-control", "tracked-jobs", "claude-session-transfer", "workspace", "hook-input", "job-status"],
  "stop-review-gate-hook.mjs": ["codex", "hook-input", "prompts", "state", "job-control", "tracked-jobs", "workspace", "job-status"]
};

// Static import statements only; JSDoc `import("./x")` types do not count.
function imports(file) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/^(?:import\b[^;]*?|\}) from "(\.[^"]+)";/gm)].map((m) => m[1]);
}
const libName = (spec) => path.basename(spec).replace(/\.mjs$/, "");

test("lib modules import only siblings, never ../", () => {
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith(".mjs"))) {
    for (const spec of imports(path.join(LIB, f))) assert.ok(spec.startsWith("./"), `${f} imports ${spec}`);
  }
});

test("leaf modules import nothing from lib (render: job-status only)", () => {
  for (const name of LEAVES) {
    const libImports = imports(path.join(LIB, `${name}.mjs`)).map(libName);
    assert.deepEqual(libImports, name === "render" ? ["job-status"] : [], `${name}.mjs`);
  }
});

test("hooks and the broker stay within their import allow-list", () => {
  for (const [file, allowed] of Object.entries(ENTRY_ALLOW)) {
    const actual = imports(path.join(SCRIPTS, file)).map(libName);
    assert.deepEqual(actual.filter((n) => !allowed.includes(n)), [], `${file} imports outside its allow-list`);
  }
});

test("job-control reaches codex.mjs for getSessionRuntimeStatus only", () => {
  const src = fs.readFileSync(path.join(LIB, "job-control.mjs"), "utf8");
  assert.equal((src.match(/^import \{ getSessionRuntimeStatus \} from "\.\/codex\.mjs";$/m) ?? []).length, 1);
  assert.equal((src.match(/from "\.\/codex\.mjs"/g) ?? []).length, 1);
});
```

- [ ] **Step 1:** Create the file; `node --import ./tests/test-env.mjs --test tests/module-boundaries.test.mjs` → 4 pass. Sanity: temporarily add `import "./state.mjs";` to `render.mjs`, rerun → the leaf test fails; revert.
- [ ] **Step 2:** README Development coverage numbers already match `.c8rc.json` (88/88/78/95, README L393–395) — nothing to do.
- [ ] **Step 3: Commit** `git add tests/module-boundaries.test.mjs && git commit -m "test: module-boundaries guard for plugins/codex/scripts"`.

Lazier alternative: only the leaf test (12 lines) — the hook allow-lists are what catches the next `hook → codex.mjs` shortcut, keep all four.

### Task D2 (Sonnet): `no-unused-vars` on; stale ignore dropped

**Files:** `eslint.config.mjs`, `plugins/codex/scripts/codex-companion.mjs` (+ whatever the rule reports).

Read-only estimate on 1f91ec2 (imports only, script over all `.mjs`): one unused import — `removeJobPidFile` in `codex-companion.mjs:37`. Unused locals, parameters and uncalled private functions are not counted: **measure in stage** with `npx eslint .` after the edit. `.claude/` exists in neither the worktree nor the main checkout and is not in `.gitignore` → the ignore entry is stale.

- [ ] **Step 1: `eslint.config.mjs`.** Delete `".claude/**",` (L6). Replace `"no-unused-vars": "off",` (L28) with `"no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],`.
- [ ] **Step 2:** `npx eslint .` → fix every report by deleting the symbol (imports, dead locals, dead private functions). Rename to `_x` only for a parameter whose position must stay (callback signatures). No logic edits; if a report points at something that looks load-bearing, stop and ask the controller. Start with `codex-companion.mjs:37` `removeJobPidFile,`.
- [ ] **Step 3:** `npm run lint` → 0 problems; `node --import ./tests/test-env.mjs --test tests/` count unchanged (473/462/11 expected).
- [ ] **Step 4: Commit** `git add eslint.config.mjs plugins/codex/scripts/codex-companion.mjs <other files eslint touched> && git commit -m "chore(lint): no-unused-vars on; drop the stale .claude ignore"`.

Deferred, say so in the ledger: Stryker shards beyond `args`/`model-catalog` (no shard change in this release).

### Task F (controller): gate, reviews, release

- [ ] **Step 1: Reviews.** Fable whole-branch review (`superpowers:requesting-code-review`, `model: fable`, `--base main`); `pr-review-toolkit:code-reviewer` and `pr-test-analyzer` on the branch; `ponytail-review` per commit diff (7 diffs); Codex review on the default model `--effort medium` (`/codex:review --base main`); **no adversarial pass** (no behaviour change, ruled in the ledger). Rulings and evidence in `.superpowers/sdd/2026-09-30-codex-plugin-cc-v1.4.3/progress.md`.
- [ ] **Step 2: Whole-branch proofs** (record in the ledger): `rg -n 'status\s*(===|!==)\s*"(queued|running)"' plugins/codex/scripts` → none; `rg -n 'function (shorten|looksLikeVerificationCommand|readStoredJob|nowIso|readJsonOrNull|buildJsonRpcError|waitForExit|deadPid|delay|waitUntil)\b' plugins tests` → one definition each; test summary 473/462/11; leak check 0.
- [ ] **Step 3: CHANGELOG** — insert above `## 1.4.2`, then `cp CHANGELOG.md plugins/codex/CHANGELOG.md`:

```markdown
## 1.4.3 — <date>

### Internal
- No behaviour change. Duplicate helpers in `plugins/codex/scripts` consolidated (`nowIso`, `readStoredJob`, `readJsonOrNull`, `shorten`, `looksLikeVerificationCommand`, the pending-cancel text, the session filter, `buildJsonRpcError`); job status comparisons go through `lib/job-status.mjs`; dead `fs.mjs` exports removed.
- Tests: shared harness helpers in `tests/helpers.mjs`; `tests/runtime.test.mjs` split by command family (`runtime-setup`, `-review`, `-task`, `-status`, `-cancel`, `-transfer`, `-hooks`); new `module-boundaries` and `job-status` unit tests; eslint `no-unused-vars` enabled.
```

- [ ] **Step 4: Bump and release** per `docs/RELEASING.md`: step 0 (claim `<claim id>`, no adversarial findings to park, `npm audit --omit=dev` 0); step 1 `npm run bump-version -- 1.4.3 && npm run check-version`; step 2 gate chain + `claude plugin validate . --strict`, commit `chore(release): v1.4.3`, PR `<PR url>` against `main`, CI line `CI <run-id> <sha>: rc=<n>; <job>: …` (`gh run watch <id> --exit-status; rc=$?`); steps 3–4 tag, `npm pack`, GitHub Release — **only after the user's explicit go**; step 5 local installs (`claude plugin marketplace update cbepx && claude plugin update codex@cbepx`); step 6 smoke, archive the SDD directory to `docs/superpowers/reports/v1.4.3/`, `agent-work release --stopped`.

### Critical Files for Implementation
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.3/plugins/codex/scripts/lib/job-control.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.3/plugins/codex/scripts/lib/tracked-jobs.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.3/plugins/codex/scripts/lib/state.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.3/plugins/codex/scripts/codex-companion.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.3/tests/runtime.test.mjs
