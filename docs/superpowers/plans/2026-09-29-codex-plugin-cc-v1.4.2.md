# codex-plugin-cc v1.4.2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brokered `/codex:cancel` reports `cancelled` only after the turn ended (else `cancellationPending`, `turn-not-interrupted`, nothing killed); a direct close reports whether the app-server exited; Windows `SessionEnd` keeps refused/failed kills; `updateJobPid` never revives a sidecar.

**Architecture:** Two record fields (`transport` from `turn/started`, `appServerExited` from `close()`), a 10 s poll in `handleCancel` before the win32 lock, one predicate in job-control, one condition in the SessionEnd hook, one lock move in `state.mjs`. No spawn change, no broker change.

**Tech Stack:** Node 18.18+ ESM, zero runtime deps, `node:test`, `rg`.

**Spec:** `docs/superpowers/specs/2026-09-29-codex-plugin-cc-v1.4.2-design.md`

## Global Constraints

- Worktree `.worktrees/release-v1.4.2`, branch `release/v1.4.2` (base `main` 4d7d62c). Claim per `docs/agent/process.md` before the first write.
- `rg`, never `grep`/`egrep`/`fgrep`; never `git add -A`.
- Gate before every commit, `&&` only: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit -m "…"`. While iterating: `node --import ./tests/test-env.mjs --test tests/<f>.test.mjs`.
- No behaviour change outside the spec's five items. `tests/commands.test.mjs` README pins untouched (run it after every README edit). `docs/agent/windows-threat-model.md` does not apply: no spawn path changes (the T4 fixture knob is test-only and spawns nothing).
- Timing rules (`docs/agent/testing-and-ci.md`): no absolute `< N ms` under 10 s; `waitFor` 30 s; `{ timeout }` + `t.after` SIGKILL on child-spawning tests; failing lifecycle assertions print `jobDiagnostics(repo, jobId)` (T4 Step 1).
- Line numbers are verified on 4d7d62c. Corrections to the brief: the pinned log assertion is `tests/job-control.test.mjs:172`; `tests/runtime.test.mjs:3888` is a **brokered** job, so T4 converts it to the direct case (the only other direct cancel test is win32-only, L4340).
- Commit trailer, always: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (the controller's line, whatever model implements).

## Review Focus

1. A job without a recorded `turnId` (queued, pre-turn, hand-made records at runtime.test L1860/L1942/L2064/L2112/L4160) is still killed as in v1.4.1 — no wait, no `turn-not-interrupted`.
2. The 10 s poll runs outside `withStateLock` (the worker's terminal write needs it); on win32 the lock covers only `finishCancel`.
3. Brokered `causedByCancel` = the record that ended the wait carries `workerClosed: true`; never `interrupt.interrupted` alone; after a terminal record `pid = null`, nothing is killed.
4. `appServerExited`: fail-closed on write (`=== true`, all three executions carry it), `!== false` on read only for pre-1.4.2 records; `exitPromise` is never the evidence.
5. SessionEnd/`updateJobPid`: no unlocked write added; `identity-mismatch`, and `process-missing` without survivors, with a dead root are still dropped.

---

### Task 1 (Sonnet): `updateJobPid` writes the sidecar only for an active job, under the lock

**Files:** Modify `plugins/codex/scripts/lib/state.mjs` (L717–730). Test `tests/tracked-jobs.test.mjs` (import block L11–25, new test after L655).

- [ ] **Step 1: Failing test.** Add `removeJobPidFile,` to the state import list, then after the test ending at L655:

```js
// A cancel inside the (win32, seconds-long) identity probe removes the sidecar
// and writes `cancelled`; the probe's second write must not bring the pid back.
test("recordWorkerPid does not revive the sidecar of a job cancelled during the probe", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-mid-probe", status: "queued", pid: null, logFile: null });
  recordWorkerPid(workspace, "job-mid-probe", 4244, {
    getProcessIdentityImpl: (pid) => {
      upsertJob(workspace, { id: "job-mid-probe", status: "cancelled", pid: null, pidIdentity: null });
      removeJobPidFile(workspace, "job-mid-probe");
      return `win32:${pid}`;
    }
  });
  assert.equal(fs.existsSync(resolveJobPidFile(workspace, "job-mid-probe")), false, "a cancelled job must not get its sidecar back");
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-mid-probe");
  assert.deepEqual([indexed.status, indexed.pid, indexed.pidIdentity], ["cancelled", null, null]);
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test --test-name-pattern "revive the sidecar" tests/tracked-jobs.test.mjs` → FAIL `a cancelled job must not get its sidecar back`.
- [ ] **Step 3: Implement.** Replace L717–730 (keep the comment block L709–716):

```js
export function updateJobPid(cwd, jobId, pid, identity = null) {
  // Sidecar and index patch share one lock, and neither is written for a job
  // that is no longer active: a cancel (or the worker's terminal write) that
  // landed first removed the sidecar, and a rewrite would hand a finished job's
  // pid to the next reader. Only `queued` gets the index patch — a worker that
  // already reported `running` wrote its own pid there, the newer one.
  withStateLock(cwd, () => {
    const indexed = listJobs(cwd).find((job) => job.id === jobId);
    if (indexed?.status !== "queued" && indexed?.status !== "running") {
      return;
    }
    writeJobPidFile(cwd, jobId, pid, identity);
    if (indexed.status === "queued") {
      upsertJob(cwd, { id: jobId, pid, pidIdentity: identity });
    }
  });
}
```

- [ ] **Step 4:** `node --import ./tests/test-env.mjs --test tests/tracked-jobs.test.mjs tests/state.test.mjs` → all pass (L273, L292, L339, L495, L641 unchanged: queued/running still get the sidecar).
- [ ] **Step 5: Commit** (gate chain) `git add plugins/codex/scripts/lib/state.mjs tests/tracked-jobs.test.mjs && git commit -m "fix(state): write a worker's pid sidecar only while its job is active"`.

### Task 2 (Sonnet): SessionEnd keeps a refused or failed win32 kill whose root is dead

**Files:** Modify `plugins/codex/scripts/session-lifecycle-hook.mjs` (L184–189). Test `tests/session-lifecycle-hook.test.mjs` (L16–45).

- [ ] **Step 1: Failing rows.** Append to `cases` (after L22):

```js
    // Never examined the tree (refused, or the kill threw): a dead root proves nothing — the broker teardown's rule.
    ["win32", { attempted: false, delivered: false, reason: "identity-unavailable" }, true, /left job-1 running: identity-unavailable/],
    ["win32", () => { throw new Error("powershell crashed"); }, true, /left job-1 running: kill-failed/],
    // Proven not ours, or gone without orphans: a stale record, the reaper's domain.
    ["win32", { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }, false, null],
    ["win32", { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, false, null]
```
and at L35 replace `terminateRecordedProcessImpl: () => outcome` with `terminateRecordedProcessImpl: typeof outcome === "function" ? outcome : () => outcome`.

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/session-lifecycle-hook.test.mjs` → FAIL on the identity-unavailable and throwing rows (`remaining` is `[]`).
- [ ] **Step 3: Implement.** Replace L184–189:

```js
        // A dead root settles it on posix. On win32 an outcome that says nothing
        // about the tree keeps the record whatever the root did — a refusal
        // (broker not excludable, identity-unavailable), a kill that threw
        // (kill-failed), survivors, an unverified kill — the broker teardown's
        // rule; the next SessionEnd judges it again (no survivor records — spec
        // §1). identity-mismatch and process-missing without survivors are settled.
        const unresolved = platform === "win32" && (refused || ["identity-unavailable", "kill-failed"].includes(reason) || (outcome?.survivors?.length ?? 0) > 0 || outcome?.unverified === true);
```

- [ ] **Step 4:** re-run → all nine rows and the other five tests pass.
- [ ] **Step 5: Commit** `git add plugins/codex/scripts/session-lifecycle-hook.mjs tests/session-lifecycle-hook.test.mjs && git commit -m "fix(hooks): SessionEnd keeps a win32 job whose kill was refused or threw"`.

### Task 3 (Opus): `appServerExited` on the worker's terminal record; `workerProved` requires it

**Files:** Modify `lib/app-server.mjs` (L325–351, L411–422), `lib/codex.mjs` (L838–867), `lib/tracked-jobs.mjs` (L231–234, L249), `lib/job-control.mjs` (after L335), `codex-companion.mjs` (L54, L594, L646, L732, L1376). Test `tests/app-server.test.mjs`, `tests/tracked-jobs.test.mjs`, `tests/job-control.test.mjs`.

- [ ] **Step 1: Failing tests.** `tests/app-server.test.mjs`: at L156 `const closed = await client.close();` and after L160 `assert.deepEqual(closed, { exited: true }, "a killed child's exit is observed");`; L188 → `assert.deepEqual(await client.close(), { exited: false });`, L190 → `assert.deepEqual(await client.close(), { exited: false }, "memoized");` (keep `started` between). Append:

```js
test("a broker client's close() reports its connection released", async () => {
  const client = new BrokerCodexAppServerClient(process.cwd(), { brokerEndpoint: "unix:/nonexistent.sock" });
  client.handleExit(null);
  assert.deepEqual(await client.close(), { exited: true });
  assert.deepEqual(await client.close(), { exited: true }, "the closed branch answers the same");
});
```
`tests/tracked-jobs.test.mjs` after L427:

```js
test("runTrackedJob records whether the app-server exit was observed; a silent runner records false", async () => {
  const workspace = makeTempDir();
  for (const [id, reported, expected] of [["job-exit-seen", true, true], ["job-exit-unseen", false, false], ["job-exit-unsaid", undefined, false]]) {
    const job = { id, status: "queued", workspaceRoot: workspace, logFile: null };
    seedJob(workspace, job);
    await runTrackedJob(job, async () => ({ exitStatus: 0, payload: {}, rendered: "ok\n", summary: "ok", appServerExited: reported }));
    assert.equal(readJobFile(resolveJobFile(workspace, id)).appServerExited, expected, id);
    assert.equal(listJobs(workspace).find((entry) => entry.id === id).appServerExited, expected, id);
  }
});
```
`tests/job-control.test.mjs`: add `isWorkerProvedRecord` to the L11 import; after L151:

```js
test("isWorkerProvedRecord also needs the app-server exit observed; a pre-1.4.2 record without the field counts", () => {
  const done = { status: "failed", phase: "failed", workerClosed: true };
  assert.equal(isWorkerProvedRecord({ ...done, appServerExited: true }), true);
  assert.equal(isWorkerProvedRecord(done), true, "v1.4.1 record");
  assert.equal(isWorkerProvedRecord({ ...done, appServerExited: false }), false, "close deadline passed, child alive");
  assert.equal(isWorkerProvedRecord({ status: "failed", appServerExited: true }), false, "crash guard / reaper: no marker");
});
```

- [ ] **Step 2:** `node --import ./tests/test-env.mjs --test tests/app-server.test.mjs tests/tracked-jobs.test.mjs tests/job-control.test.mjs` → FAIL (`undefined` from `close()`, field missing, import missing).
- [ ] **Step 3: Implement.** `app-server.mjs` `closeOnce`: after the `try/finally` (L336–350) add

```js
    // What close() saw, not what it asked for: `exitPromise` also settles on a
    // spawn 'error' or a JSONL parse error while the child is still running.
    return { exited: !this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null };
```
Broker `close()` (L411–422) becomes:

```js
  // A broker client owns no process: releasing the socket is its whole exit.
  async close() {
    if (!this.closed) {
      this.closed = true;
      if (this.socket) {
        this.socket.end();
      }
    }
    await this.exitPromise;
    return { exited: true };
  }
```
`codex.mjs`: above `withAppServer` add the helper; L842–844 become `const result = await fn(client);` + `return withCloseOutcome(result, await client.close());`; L860–865 become the retry block below.

```js
// The result carries what the client's close() observed (direct: the child's
// exit; broker: the socket released). Non-object results pass through.
function withCloseOutcome(result, closed) {
  return result && typeof result === "object" ? { ...result, appServerExited: closed?.exited === true } : result;
}
```
```js
    const directClient = await CodexAppServerClient.connect(cwd, { ...clientOptions, disableBroker: true });
    let result;
    try {
      result = await fn(directClient);
    } catch (retryError) {
      await directClient.close();
      throw retryError;
    }
    return withCloseOutcome(result, await directClient.close());
```
`codex-companion.mjs`: add `appServerExited: result.appServerExited,` after `resolved: result.resolved,` at L594, L646 and L732. `tracked-jobs.mjs`: replace L231–234 with

```js
        // `runner()` resolved, so withAppServer already awaited client.close().
        // `workerClosed`: that close returned. `appServerExited`: it saw the
        // direct child exit (a broker connection always counts); a close that hit
        // its 5 s deadline with the child alive records false, and so does a
        // runner that does not say. Only this cooperative write sets either
        // (crash guard and reaper never do).
        workerClosed: true,
        appServerExited: execution.appServerExited === true,
```
and after L249 add `appServerExited: execution.appServerExited === true,`. `job-control.mjs` after L335:

```js
// The worker's own terminal record whose close also saw the app-server exit.
// `false` = the close deadline passed with the child alive; a pre-1.4.2 record
// has no field and counts (its `workerClosed` was the v1.4.1 proof).
export function isWorkerProvedRecord(stored) {
  return isWorkerTerminalRecord(stored) && stored.appServerExited !== false;
}
```
Companion: import `isWorkerProvedRecord` (L46–59 block); at L1376 replace `isWorkerTerminalRecord(` with `isWorkerProvedRecord(`.

- [ ] **Step 4:** the three files pass; `npm run build` (typecheck of `app-server.mjs`/`codex.mjs`) exits 0.
- [ ] **Step 5: Commit** `git add plugins/codex/scripts/lib/app-server.mjs plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/lib/tracked-jobs.mjs plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/codex-companion.mjs tests/app-server.test.mjs tests/tracked-jobs.test.mjs tests/job-control.test.mjs && git commit -m "fix(cancel): a vanished win32 worker counts as closed only when its app-server exit was observed"`.

### Task 4 (Opus): brokered cancel waits for the worker's own terminal record; direct cancel skips the interrupt

**Files:** Modify `lib/codex.mjs` (L368–408, L594–604, L684, L765), `lib/tracked-jobs.mjs` (L24–47, L84–111), `lib/job-control.mjs` (L446–452), `codex-companion.mjs` (L10–23, L1330–1398). Test `tests/fake-codex-fixture.mjs` (after L316, L758), `tests/job-control.test.mjs`, `tests/runtime.test.mjs` (after L48, L2123–2185, L3886–3943, L4340–4397, new posix twin after L2185).

- [ ] **Step 1: Fixture knob and diagnostics.** Fixture, after L316 (plain text inside the template, no `${`):

```js
// Test knob: answer but ignore only the first N turn/interrupt requests this
// app-server sees (the turn keeps running); later ones are honoured.
const IGNORE_FIRST_INTERRUPTS = Number(process.env.FAKE_CODEX_IGNORE_FIRST_INTERRUPTS || 0);
let interruptsSeen = 0;
```
L758 becomes (keep the tab indentation):
```js
	        interruptsSeen += 1;
	        const pending = IGNORE_INTERRUPT || interruptsSeen <= IGNORE_FIRST_INTERRUPTS ? null : interruptibleTurns.get(message.params.turnId);
```
`runtime.test.mjs` after L48 (the 3919–3928 pattern, shared):
```js
// Read only on failure: which record a cancel found, who wrote it, and the job-log tail.
function jobDiagnostics(repo, jobId) {
  try {
    const record = readPersistedJob(repo, jobId);
    const log = fs.readFileSync(record.logFile, "utf8").split("\n").slice(-20).join("\n");
    return `record: ${JSON.stringify({ status: record.status, phase: record.phase, transport: record.transport, workerClosed: record.workerClosed, appServerExited: record.appServerExited, errorMessage: record.errorMessage })}\njob log tail:\n${log}`;
  } catch (error) {
    return `(job record unreadable: ${error.message})`;
  }
}
```

- [ ] **Step 2: Failing tests.**
(a) `job-control.test.mjs` after L96:
```js
test("renderCancelPending says a brokered turn that did not end leaves the job running", () => {
  const rendered = renderCancelPending({ pending: true, reason: "turn-not-interrupted", survivors: [] }, 4300, "job-1");
  assert.deepEqual(rendered.json, { jobId: "job-1", status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(rendered.logLine, "cancellation not confirmed: worker pid 4300 left running (turn-not-interrupted)");
  assert.match(rendered.text, /the shared runtime has not ended the turn, so the worker was not stopped; the job stays running\. Re-run cancel or wait for result\./);
  assert.equal(rendered.diagnostic, null);
});
```
(b) L2123 test: title → `"cancel interrupts a brokered task and records cancelled only after the worker's own terminal record"`; L2148 → `if (job?.status === "running" && job.threadId && job.turnId && job.transport) {`; after L2152 `assert.equal(runningJob.transport, "broker");`; after L2163:
```js
  const stored = readPersistedJob(repo, jobId);
  assert.equal(stored.status, "cancelled", jobDiagnostics(repo, jobId));
  assert.deepEqual([stored.workerClosed, stored.appServerExited], [true, true], jobDiagnostics(repo, jobId));
  const log = fs.readFileSync(stored.logFile, "utf8");
  assert.ok(log.includes("Turn interrupted.") && log.indexOf("Turn interrupted.") < log.indexOf("Cancelled by user."), `the turn ended before the cancel wrote:\n${log}`);
```
(c) Posix twin, new after L2185:
```js
// The turn lives in the shared runtime, not in the worker: a cancel whose
// interrupt the runtime ignores must not claim success and must not kill the
// worker (the turn would keep running and the reaper would fail the job).
test("a brokered cancel whose interrupt is ignored stays pending and kills nothing; the next cancel ends the turn", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const running = await waitFor(() => { const job = readPersistedJob(repo, jobId); return job.status === "running" && job.pid && job.turnId ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));
  assert.equal(running.transport, "broker", jobDiagnostics(repo, jobId));

  const first = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(first.status, 1, `cancel said: ${first.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.deepEqual(JSON.parse(first.stdout), { jobId, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(running.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readPersistedJob(repo, jobId).status, "running", jobDiagnostics(repo, jobId));
  assert.match(fs.readFileSync(running.logFile, "utf8"), /left running \(turn-not-interrupted\)/);

  const second = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, `${second.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${second.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterrupted, true);
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled", jobDiagnostics(repo, jobId));
  await waitFor(() => !isAlive(running.pid));
});
```
(d) Replace L3886–3943 (direct transport; the SIGTERM-immune worker and its late-write guard are kept):
```js
// Direct transport (a cold --resume-last owns its app-server): cancel sends no
// turn/interrupt — no second client can reach that app-server, and the old
// attempt could start a codex of its own — and kills the worker's group. The
// worker ignores SIGTERM and outlives the kill as its app-server dies; its late
// write must not replace the acknowledged `cancelled` record.
test("a direct cancel skips the interrupt, and the cancellation survives a worker that finishes after it", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // Only the task worker ignores SIGTERM; the broker and fake codex keep the default.
  const preload = path.join(binDir, "worker-ignores-sigterm.mjs");
  fs.writeFileSync(preload, 'if (process.argv.includes("task-worker")) process.on("SIGTERM", () => {});\n');
  const env = buildEnv(binDir, {
    FAKE_CODEX_TURN_DELAY_MS: "20000",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim()
  });
  const launch = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "--prompt-stdin"], { cwd: repo, env, input: "cancel me late\n" });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const running = await waitFor(() => { const job = readPersistedJob(repo, jobId); return job.status === "running" && job.pid && job.turnId ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  assert.equal(running.transport, "direct", jobDiagnostics(repo, jobId));
  const startsBefore = JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts;

  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, `${cancelled.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${cancelled.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterruptAttempted, false, "a direct job's app-server is the worker's own");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastInterrupt ?? null, null, "no turn/interrupt was sent");
  assert.equal(fakeState.appServerStarts, startsBefore, "cancel started no codex of its own");

  await waitFor(() => !isAlive(running.pid));
  const stored = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).job.status, "cancelled", jobDiagnostics(repo, jobId));
});
```
(e) L4340 (win32 direct): after L4352 `assert.equal(running.transport, "direct");`; after L4357 `assert.equal(JSON.parse(cancel.stdout).turnInterruptAttempted, false, "a direct job's app-server is the worker's own");`.
(f) L4362 (win32 brokered). Title/options → `"a brokered cancel on Windows kills nothing until the turn ends, leaves the shared broker and its subtree alive, and the same app-server serves the next job", { skip: !IS_WIN, timeout: 180_000 }`. L4365: `FAKE_CODEX_IGNORE_INTERRUPT: "1"` → `FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1"` (comment: `// The broker's app-server ignores only the first interrupt: the first cancel must stay pending, the second ends the turn; the "quick C" timeout interrupt is the third and is honoured.`). L4370 → `const running = await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.status === "running" && j.turnId ? j : null; });` + `assert.equal(running.transport, "broker", jobDiagnostics(repo, jobA));`. L4379–4380 become:
```js
  const pending = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(pending.status, 1, `cancel said: ${pending.stdout.trim()}\n${jobDiagnostics(repo, jobA)}`);
  assert.deepEqual(JSON.parse(pending.stdout), { jobId: jobA, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(withPid.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readPersistedJob(repo, jobA).status, "running", jobDiagnostics(repo, jobA));
  assert.equal(isAlive(broker.pid), true, "the shared broker is untouched by a pending cancel");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "and so is its subtree");
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobA)}`);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled", jobDiagnostics(repo, jobA));
```
L4381–4396 stay (the worker exits on its own; broker, subtree, `appServerStarts` 1, same broker pid).

- [ ] **Step 3:** `node --import ./tests/test-env.mjs --test tests/job-control.test.mjs tests/runtime.test.mjs` → FAIL: render tail missing; `transport` undefined; the twin's first cancel answers `cancelled` (exit 0); 3888's `turnInterruptAttempted` is `true`.
- [ ] **Step 4: Implement.** `codex.mjs`: L684 → `export const TURN_INTERRUPT_ACK_MS = 10000;`. In `createTurnCaptureState` after `onProgress: options.onProgress ?? null` (L407) add `,` + `// "broker" | "direct": recorded with the turn so cancel knows who owns the runtime.` + `transport: options.transport ?? null`. L765 → `const state = createTurnCaptureState(threadId, { ...options, transport: client.transport });`. L599–602 object gains `transport: state.transport`.
`tracked-jobs.mjs`: after L30 `transport: value.transport === "broker" || value.transport === "direct" ? value.transport : null,`; after L41 `transport: null,`; after L87 `let lastTransport = null;`; after L111:
```js
    // Arrives with `turnId` in the same event, so both land in one patch.
    if (normalized.transport && normalized.transport !== lastTransport) {
      lastTransport = normalized.transport;
      patch.transport = normalized.transport;
      changed = true;
    }
```
`job-control.mjs` `renderCancelPending`: after L449 (`? \`worker pid ${pid} exited but part …\``) insert
```js
    : decision.reason === "turn-not-interrupted"
    ? "the shared runtime has not ended the turn, so the worker was not stopped; the job stays running."
```
`codex-companion.mjs`: add `TURN_INTERRUPT_ACK_MS,` to the L10–23 import. Replace L1330–1357 with the block below (L1338–1345 interrupt log unchanged, shown as `…`), and add the helper after `handleCancel`:
```js
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  // A direct worker owns its app-server: a second client cannot reach it (it
  // would start a codex of its own), and the kill below takes it down.
  const direct = (existing.transport ?? job.transport ?? null) === "direct";

  const interrupt = direct
    ? { attempted: false, interrupted: false, transport: "direct", detail: "direct transport: the kill stops the worker's own app-server" }
    : await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) { … }

  // Only a pid that is provably still this job's worker is signalled (#743).
  let { pid, identity } = resolveJobPid(workspaceRoot, job);
  // Brokered, or recorded before v1.4.2 (no `transport`): the turn runs in the
  // shared runtime, so a dead worker would not stop it. Only a terminal record
  // ends the wait; polled outside the state lock, which the worker's own
  // terminal write takes. No turn recorded → nothing to wait for (v1.4.1 path).
  let turnEnded = false;
  if (!direct && turnId) {
    const stored = interrupt.interrupted ? await waitForTerminalRecord(workspaceRoot, job.id, TURN_INTERRUPT_ACK_MS) : null;
    if (!stored) {
      emitCancelPending({ pending: true, reason: "turn-not-interrupted", survivors: [] }, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
      process.exitCode = 1;
      return;
    }
    // Caused by this cancel only when the worker itself wrote it; a crash-guard
    // or reaper record is kept by commitCancel. Either way the worker is done
    // with the job: nothing is killed.
    turnEnded = isWorkerTerminalRecord(stored);
    pid = null;
    identity = null;
  }
  // (keep the win32 comment of L1349–1352)
  if (process.platform === "win32") {
    withStateLock(workspaceRoot, () => finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded, options }));
  } else {
    finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded, options });
  }
}

// Polls the job file until a terminal record appears, or `null` once the window closes.
async function waitForTerminalRecord(workspaceRoot, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = readStoredJob(workspaceRoot, jobId);
    if (stored && stored.status !== "queued" && stored.status !== "running") {
      return stored;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
```
L1362 → `function finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded = false, options }) {`. In L1398 replace `causedByCancel: interrupt.interrupted === true || (kill.attempted === true && kill.delivered === true)` with `causedByCancel: turnEnded || (kill.attempted === true && kill.delivered === true)` — a brokered cancel caused the finish only when the worker's own record ended the wait; an acknowledged interrupt alone proves nothing.
- [ ] **Step 5:** `node --import ./tests/test-env.mjs --test tests/job-control.test.mjs tests/tracked-jobs.test.mjs tests/runtime.test.mjs` → pass. Premise changed, still green: L1992 (brokered cancel after `turn/started` now kills nothing; the worker exits on its own, the `finally` SIGKILL covers a hang), L3844 (awaited job, same). Rows 1: L1860, L1942, L2064, L2112, L4160 unchanged.
- [ ] **Step 6: Commit** `git add plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/lib/tracked-jobs.mjs plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/codex-companion.mjs tests/fake-codex-fixture.mjs tests/job-control.test.mjs tests/runtime.test.mjs && git commit -m "fix(cancel): a brokered cancel waits for the worker's own terminal record; a direct cancel skips the interrupt"`.

### Task 5 (Sonnet): minors and docs

**Files:** `lib/job-control.mjs` L352, `tests/job-control.test.mjs` L172, `README.md` (L236, L377), `docs/windows.md` (L9, L13, L25), `CHANGELOG.md` + `plugins/codex/CHANGELOG.md`.

- [ ] **Step 1: Label.** L352 `"interrupt not acknowledged"` → `"not caused by this cancel"`; test L172 → `["cancel: record already failed, kept (not caused by this cancel)"]`. Run `tests/job-control.test.mjs` → pass.
- [ ] **Step 2: README.** After L236 (`Cancels an active background Codex job.`) add a paragraph:
  "A job whose turn runs through the shared broker is cancelled by interrupting the turn: `/codex:cancel` waits up to 10 s for the job's own final record and then answers `cancelled`. If the turn does not end (the runtime ignored or refused the interrupt), it answers `cancellationPending` with `reason: turn-not-interrupted` and exit 1, stops nothing, and the job stays `running`; re-run the cancel or wait for the turn. A job that owns its app-server (a cold `--resume-last`, `transport: direct` in `status --json`) is stopped by stopping its worker, without a turn interrupt (`turnInterruptAttempted: false`)."
  In L377 replace `Constrained Language Mode); \`SessionEnd\` keeps a record whose kill outcome is unknown (\`kept=true\`) and re-judges it next time.` with `Constrained Language Mode), or with \`reason: turn-not-interrupted\` while a brokered job's turn is still running (see \`/codex:cancel\` above); \`SessionEnd\` keeps a record whose kill outcome is unknown (\`kept=true\`), including a refused or failed kill whose worker has already exited, and re-judges it next time.` Then `node --import ./tests/test-env.mjs --test tests/commands.test.mjs tests/docs-contracts.test.mjs` → pass.
- [ ] **Step 3: `docs/windows.md`.** L9: after `the worker itself recorded a closed exit` insert ` and, as of v1.4.2, an observed app-server exit (\`job.appServerExited\`, see Limits)`; replace `unless the cancel's own interrupt was acknowledged or its kill delivered, in which case` with `unless this cancel caused it — for a brokered job, the worker's own final record appeared while the cancel waited after its acknowledged interrupt (v1.4.2); otherwise, a delivered kill — in which case`. L13: replace from `On every platform, a brokered` through `unless the app-server's exit was observed.` with:
  "On every platform (v1.4.2), a brokered `/codex:cancel` confirms the turn, not the worker: it sends `turn/interrupt`, waits up to 10 s for the worker's own final record, and records `cancelled` only then; otherwise it answers `cancellationPending` (`turn-not-interrupted`), stops nothing, and the job stays `running` until the turn ends on its own or the shared broker is shut down (`SessionEnd`); a turn that ends on its own inside the wait is recorded `cancelled`. Jobs record their transport (`job.transport`); a job without it (started before 1.4.2) is treated as brokered, so a pre-1.4.2 direct job cannot be cancelled until its turn ends. A direct job's cancel sends no interrupt and stops the worker with its own app-server. A vanished-root direct job is cancelled only when its final record carries `appServerExited: true` (the worker's close saw its app-server child exit; `false` when the 5 s close deadline passed with the child alive); on Windows that child is `cmd.exe` running the `codex.cmd` shim, so its exit is evidence, not proof, that the shim's `node`/`codex` descendants exited."
  L25 Code path: add `plugins/codex/scripts/codex-companion.mjs` (cancel), `plugins/codex/scripts/lib/app-server.mjs` (close outcome), `plugins/codex/scripts/session-lifecycle-hook.mjs`; design: add `docs/superpowers/specs/2026-09-29-codex-plugin-cc-v1.4.2-design.md`.
- [ ] **Step 4: CHANGELOG.** Insert above `## 1.4.1` (1.4.1 is left as history, like 1.4.0 → 1.4.1; controller may rule otherwise), then `cp CHANGELOG.md plugins/codex/CHANGELOG.md`:
```markdown
## 1.4.2 — 2026-09-30

### Fixed
- A brokered `/codex:cancel` (every platform) no longer reports `cancelled` while the shared runtime keeps running the turn: it sends `turn/interrupt`, waits up to 10 s for the worker's own final record, and only then records `cancelled`; if the turn does not end it answers `cancellationPending` with `reason: "turn-not-interrupted"` (exit 1), kills nothing and leaves the job `running` (killing the worker left the turn running in the broker). A direct job's cancel no longer sends `turn/interrupt` (a second client could not reach the worker's own app-server and could start a stray `codex app-server`) and kills the worker as before (`turnInterruptAttempted: false`).
- Windows: a direct job whose worker vanished before the kill is cancelled only when its final record also says the app-server's exit was observed; a close that hit its 5 s deadline with the child alive leaves the cancel `cancellationPending` for the reaper.
- Windows `SessionEnd`: a job whose kill was refused (`identity-unavailable`) or threw (`kill-failed`) is kept even when its worker already exited, the rule the broker teardown uses; `identity-mismatch` and `process-missing` without survivors still drop it.
- A background worker's pid sidecar is written only while its job is queued or running, under the state lock: a cancel during the identity probe no longer gets the sidecar written back.

### Changed
- `status --json` / `result --json` job records carry `transport` (`broker`/`direct`, set when the turn starts) and, on the worker's own final record, `appServerExited`.

### Known limitations
- A brokered turn that never ends after `turn/interrupt` keeps the job `running`: `/codex:cancel` answers `turn-not-interrupted` until the turn ends on its own or the shared broker is shut down (`SessionEnd`); a turn that ends on its own during the 10 s wait is recorded `cancelled` (spec §Limits)
- Jobs started before 1.4.2 have no `transport` and are treated as brokered: a pre-1.4.2 direct job cannot be cancelled until its turn ends (spec §Limits)
- Windows: on the direct transport the observed app-server child is `cmd.exe` running the `codex.cmd` shim; its exit is evidence, not proof, that the shim's descendants exited (spec §Limits)
```
- [ ] **Step 5: Commit** (gate chain) `git add plugins/codex/scripts/lib/job-control.mjs tests/job-control.test.mjs README.md docs/windows.md CHANGELOG.md plugins/codex/CHANGELOG.md && git commit -m "docs: v1.4.2 cancel semantics, SessionEnd rule, changelog"`.

### Task 6 (controller): gate, reviews, adversarial pass, release

- [ ] **Step 1:** Fable review after each of T1–T5 (`superpowers:requesting-code-review`, `model: fable`; T5 docs diff may use Sonnet); rulings and evidence in `.superpowers/sdd/2026-09-29-codex-plugin-cc-v1.4.2/progress.md`. Final whole-branch pass with `pr-review-toolkit`.
- [ ] **Step 2:** Whole-branch gate: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && claude plugin validate . --strict` → exit 0.
- [ ] **Step 3: Adversarial gate.** `/codex:adversarial-review --base main --effort max`; save `adv-1.4.2-passN.json`. The brief quotes the stop rule verbatim:
  > Each pass brief must tag findings that already existed in the previous release (`pre-existing vX.Y`) and separate **blocking** classes — a foreign process killed; a live broker without a record and then killed; loss of a live broker's record; cancel reporting success on an unconfirmed tree; a cancelled job that still runs — from residual ones. A fix wave opens only for a blocking class that this release introduced or first exposed. Pre-existing semantics, and findings whose premise is "a process suspended for seconds" or "two consecutive disk-write failures", are parked with a ruling as a documented limit (spec `## Limits`, CHANGELOG "Known limitations") and go to the next release. Cap: 5 passes per release; every further pass needs an explicit user decision.

  Parked findings → spec `## Limits` + CHANGELOG "Known limitations" + a spec revision-log row.
- [ ] **Step 4: Release** per `docs/RELEASING.md`: step 0 (claim, stop rule closed, revision tables current, `npm audit --omit=dev` 0); step 1 `npm run bump-version -- 1.4.2 && npm run check-version` (the `## 1.4.2` heading already exists from T5); step 2 gate + PR against `main`, CI line in the ledger as `CI <run-id> <sha>: rc=<n>; <job>: …` (`gh run watch <id> --exit-status; rc=$?`); steps 3–4 tag, `npm pack`, GitHub Release — **only after the user's explicit go**; step 5 local installs; step 6 smoke, archive the SDD directory to `docs/superpowers/reports/v1.4.2/`, `agent-work release --stopped`.

### Critical Files for Implementation
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.2/plugins/codex/scripts/codex-companion.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.2/plugins/codex/scripts/lib/codex.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.2/plugins/codex/scripts/lib/tracked-jobs.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.2/plugins/codex/scripts/lib/app-server.mjs
- /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.2/tests/runtime.test.mjs