### Task 5: Callers на win32 — reaper batch, cancel survivors, бюджеты, сохранение записей, runtime-ожидания, Windows E2E

**Files:**
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs:380-440` (`reapDeadJobs`: win32 batch)
- Modify: `plugins/codex/scripts/lib/job-control.mjs` (новые `cancelDecision`, `brokerExclusion`; `readStoredJob` там уже объявлена — не импортировать её из `state.mjs`)
- Modify: `plugins/codex/scripts/codex-companion.mjs:1340-1365` (cancel: `exclude` через `brokerExclusion`, survivors в ответе/логе на win32)
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs` (константы ~22–45; `cleanupSessionJobs` ~98–166 → `export`; teardown ~298–322; существующий `main().catch((error) => { process.stderr.write(…); process.exit(1); })` (~347–350) целиком, без изменений, оборачивается в `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { … }` с `import { pathToFileURL } from "node:url"` — иначе `import` модуля из теста читал бы hook stdin; `.catch` остаётся, чтобы ошибка записи state по-прежнему печаталась одной строкой с exit 1, а не unhandled rejection; `hooks.json` вызывает файл напрямую, поведение хука при прямом запуске не меняется)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:342-380` (`teardownBrokerSession`: опции `platform`, `keepOnUnknown`, `terminateRecordedProcessImpl`; поле `kept`)
- Modify: `plugins/codex/scripts/app-server-broker.mjs` (~294–315, `broker/shutdown`: тестовый knob `CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN=1`)
- Modify: `tests/tracked-jobs.test.mjs:408,417,424` (явный `platform: "linux"`) и `:490` («runTrackedJob records the worker identity…»: на win32 ожидать `^win32:\d+$`, равный `getProcessIdentity(process.pid)` того же процесса, вместо `null`), `tests/broker-stale-pid.test.mjs:1365,1381` (`deepEqual` + `kept: false`)
- Modify: `tests/runtime.test.mjs` (Step 8); `tests/helpers.mjs` (`cimTree`)
- Test: новые тесты в `tests/tracked-jobs.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/runtime.test.mjs`, `tests/job-control.test.mjs` (`cancelDecision`, `renderCancelPending`, `emitCancelPending`), новый `tests/session-lifecycle-hook.test.mjs`; `tests/runtime.test.mjs:1922` (legacy win32 `deepEqual` без `survivors`: поле добавляется в JSON только когда список непуст, поэтому ожидание остаётся верным)

**Interfaces (Consumes):** `getProcessIdentities`, `terminateRecordedProcess` win32 (`process-missing`, `survivors: [{pid, identity}]`, `unverified`, `exclude: [{pid, identity}]` — Task 4 fix round 1, spec §3.4 rev. 12; `excludePids` no longer exists). **Produces:**
- `reapDeadJobs(…, { getProcessIdentitiesImpl })` (только win32-ветка).
- `export function cancelDecision({ pid, kill, alive, platform })` → `{ pending: boolean, reason: string|null, survivors: [{pid, identity}] }` (`lib/job-control.mjs`); на posix `survivors` всегда `[]`, причины как в v1.4.0.
- `teardownBrokerSession(…, { platform, keepOnUnknown, terminateRecordedProcessImpl })` → `{ signalled, reason, kept }`; `export function killStepMs(platform)` в хуке.
- Никаких новых полей в записях job'ов: survivors живут только в ответе `cancel` (win32, когда непусто), в логе job'а и в stderr SessionEnd (spec §3.6).

- [ ] **Step 1: failing tests** (reaper; в файле, где уже тестируется `reapDeadJobs`, тем же способом подготовки записей):

```js
test("reapDeadJobs on win32 probes the live identities in one batch after the cheap checks and fails only the reused pid", () => {
  const workspace = makeTempDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore" });
  try {
    const jobs = [
      { id: "job-a", status: "running", pid: process.pid, pidIdentity: "win32:1" },
      { id: "job-b", status: "running", pid: child.pid, pidIdentity: "win32:2" },
      { id: "job-c", status: "completed", pid: 1, pidIdentity: "win32:9" }
    ];
    for (const job of jobs) writeJobFile(workspace, job.id, job);
    const probes = [];
    const reaped = reapDeadJobs(workspace, jobs, {
      platform: "win32",
      getProcessIdentitiesImpl: (pids) => { probes.push([...pids].sort((a, b) => a - b)); return new Map(pids.map((pid) => [pid, pid === process.pid ? "win32:1" : "win32:other"])); }
    });
    assert.deepEqual(probes, [[process.pid, child.pid].sort((a, b) => a - b)], "one probe, only for records that passed the terminal/liveness checks");
    assert.equal(reaped.find((j) => j.id === "job-a").status, "running");
    assert.equal(reaped.find((j) => j.id === "job-b").status, "failed");
    assert.match(reaped.find((j) => j.id === "job-b").errorMessage, /pid reused/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("reapDeadJobs on win32 leaves every job alone when the batch answers nothing", () => {
  const workspace = makeTempDir();
  const jobs = [{ id: "job-x", status: "running", pid: process.pid, pidIdentity: "win32:1" }];
  writeJobFile(workspace, "job-x", jobs[0]);
  const reaped = reapDeadJobs(workspace, jobs, { platform: "win32", getProcessIdentitiesImpl: () => new Map() });
  assert.equal(reaped[0].status, "running");
});

test("reapDeadJobs on posix keeps its per-pid probe and per-pid budget", () => {
  const seen = [];
  let clock = 0;
  reapDeadJobs(makeTempDir(), [{ id: "j", status: "running", pid: process.pid, pidIdentity: "x:1" }], {
    platform: "linux",
    remainingMs: () => 1500 - clock,
    getProcessIdentityImpl: (pid, opts) => { seen.push(opts.timeoutMs); clock += 700; return "x:1"; },
    getProcessIdentitiesImpl: () => assert.fail("posix must not batch")
  });
  assert.deepEqual(seen, [1500]);
});

// A 2 s budget is shorter than a cold PowerShell start (up to 3 s): the probe
// times out, the launcher's breaker opens for a minute, and the cancel that
// follows is refused as identity-unavailable without ever running.
test("reapDeadJobs on win32 gives the batch probe a cold-start budget bounded by the deadline", () => {
  const seen = [];
  const impl = (pids, opts) => { seen.push(opts.timeoutMs); return new Map(pids.map((p) => [p, null])); };
  const jobs = [{ id: "j", status: "running", pid: process.pid, pidIdentity: "win32:1" }];
  reapDeadJobs(makeTempDir(), jobs, { platform: "win32", getProcessIdentitiesImpl: impl });
  reapDeadJobs(makeTempDir(), jobs, { platform: "win32", getProcessIdentitiesImpl: impl, remainingMs: () => 1500 });
  assert.deepEqual(seen, [6000, 1500]);
});
```

- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement reaper** — `tracked-jobs.mjs`: импорт `getProcessIdentities` из `./process.mjs` рядом с `getProcessIdentity`; в JSDoc над функцией (`tracked-jobs.mjs:374`) в тип `options` добавить `getProcessIdentitiesImpl?: typeof getProcessIdentities` (иначе `npm run typecheck` даёт TS2339); рядом с `IDENTITY_PROBE_MS` (~371) добавить `const WIN32_BATCH_PROBE_MS = 6000; // one cold PowerShell start (≤3 s) with margin`; `reapDeadJobs` целиком (изменения: опция `getProcessIdentitiesImpl`, `probeMs`, `liveIdentityCandidate`, `batch`, ветка `actual`):

```js
export function reapDeadJobs(workspaceRoot, jobs, options = {}) {
  const {
    lockWaitMs,
    remainingMs,
    getProcessIdentityImpl = getProcessIdentity,
    getProcessIdentitiesImpl = getProcessIdentities,
    processCommandLineImpl = processCommandLine,
    platform = process.platform
  } = options;
  const waitFor = () => {
    if (!remainingMs) {
      return lockWaitMs;
    }
    const left = Math.max(0, remainingMs());
    return lockWaitMs === undefined ? left : Math.min(lockWaitMs, left);
  };
  const probeMs = () => (remainingMs ? Math.min(IDENTITY_PROBE_MS, remainingMs()) : IDENTITY_PROBE_MS);
  // One PowerShell for the whole batch may start cold (up to 3 s on a slow
  // runner); a budget under that trips the launcher's breaker and blocks the
  // next minute of kills. Still bounded by the caller's deadline.
  const batchProbeMs = () => (remainingMs ? Math.min(WIN32_BATCH_PROBE_MS, remainingMs()) : WIN32_BATCH_PROBE_MS);
  // The jobs the identity probe can judge: still running by the index and on
  // disk, with a live pid that carries an identity — the same tests the loop
  // below applies, so the batch never probes a pid the loop would not.
  const liveIdentityCandidate = (job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return null;
    }
    const stored = readStoredJobOrNull(workspaceRoot, job.id);
    if (stored && stored.status !== "running" && stored.status !== "queued") {
      return null;
    }
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (!pid || !identity || isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return null;
    }
    return { pid, identity };
  };
  // win32: one PowerShell for every candidate instead of one per job — a cold
  // start costs up to 3 s against a 12 s SessionEnd. posix probes stay per job
  // (a /proc read or one ps). A batch that fails judges nothing.
  // ponytail: each win32 candidate's job file is read twice (here and in the loop).
  let batch = new Map();
  if (platform === "win32") {
    const candidatePids = [...new Set(jobs.map(liveIdentityCandidate).filter(Boolean).map((candidate) => candidate.pid))];
    if (candidatePids.length > 0 && !(remainingMs && remainingMs() < REAP_MIN_STEP_MS)) {
      try {
        batch = getProcessIdentitiesImpl(candidatePids, { platform, timeoutMs: batchProbeMs() });
      } catch {
        batch = new Map();
      }
    }
  }
  const deferred = [];
  const reaped = jobs.map((job) => {
    if (remainingMs && remainingMs() < REAP_MIN_STEP_MS) {
      // Left as-is for the next run — say so, or a job that is dead but still
      // listed as running looks like a live one to whoever reads the decision.
      deferred.push(job.id);
      return job;
    }
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }
    const stored = readStoredJobOrNull(workspaceRoot, job.id);
    if (stored && stored.status !== "running" && stored.status !== "queued") {
      // Terminal on disk: markJobDead keeps the real result and reconciles it
      // into the index rather than failing the job.
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    // The queued record carries no pid of its own — the parent records it in an
    // atomic sidecar instead of rewriting the worker's job file.
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    // Alive is not enough: the pid may now belong to another process (#743).
    // A probe that fails or times out proves nothing, so the job is left alone.
    if (pid && identity) {
      let actual = null;
      if (platform === "win32") {
        actual = batch.get(pid) ?? null;
      } else {
        try {
          actual = getProcessIdentityImpl(pid, { timeoutMs: probeMs() });
        } catch {
          actual = null;
        }
      }
      if (actual && actual !== identity) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (pid reused: ${pid} now belongs to another process)`, waitFor());
      }
    } else if (pid && platform !== "win32") {
      // A legacy record has no identity; a readable command line that is plainly
      // not a companion is proof enough to stop waiting on it. Nothing is signalled.
      let commandLine = null;
      try {
        commandLine = processCommandLineImpl(pid, { timeoutMs: probeMs() });
      } catch {
        commandLine = null;
      }
      if (typeof commandLine === "string" && commandLine && !commandLine.includes("codex-companion.mjs")) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (worker pid ${pid} now belongs to an unrelated process)`, waitFor());
      }
    }
    return job;
  });
  if (deferred.length > 0) {
    process.stderr.write(`[codex] Reaper ran out of budget; not judged this run: ${deferred.join(", ")}.\n`);
  }
  return reaped;
}
```

  Старые inject-тесты (`tests/tracked-jobs.test.mjs:408,417,424`) получают явный `platform: "linux"`; тест `:490` на win32 ожидает `^win32:\d+$` (см. Files).

- [ ] **Step 4: `cancelDecision` + cancel** (`lib/job-control.mjs`):

```js
// What cancel does with a kill outcome. posix keeps its v1.4.0 answer; win32
// treats survivors and an unverified attempt as "not cancelled": the job stays
// running and the survivors are reported, never followed by a record (spec §1).
export function cancelDecision({ pid, kill, alive, platform = process.platform }) {
  if (!pid) {
    return { pending: false, reason: null, survivors: [] };
  }
  const win32Unknown = platform === "win32" && kill.attempted && (kill.survivors?.length > 0 || kill.unverified === true);
  const stillHere = (!kill.attempted || !kill.delivered) && alive === true;
  if (!stillHere && !win32Unknown) {
    return { pending: false, reason: null, survivors: [] };
  }
  const reason = kill.attempted ? (platform === "win32" ? "kill-failed" : "not-delivered") : kill.reason;
  return { pending: true, reason, survivors: platform === "win32" ? (kill.survivors ?? []) : [] };
}
```

  Тест-таблица (`tests/process.test.mjs` или `tests/job-control.test.mjs`): `[{attempted:true,delivered:true}, alive:false] → not pending`; `[{attempted:true,delivered:false,survivors:[{pid:4301,identity:"win32:7"}]}, alive:false, win32] → pending "kill-failed" survivors [{4301,…}]`; то же на `linux` → not pending (posix как v1.4.0); `[{attempted:false,reason:"identity-unavailable"}, alive:true] → pending "identity-unavailable"`; `[{attempted:true,delivered:false,unverified:true}, alive:false, win32] → pending`; `[{attempted:false,reason:"process-missing"}, alive:false] → not pending`; `[{attempted:true,delivered:false}, alive:true, linux] → pending "not-delivered"`.
  В `lib/job-control.mjs` рядом с `cancelDecision` (строки ниже — полностью, без сокращений; текст pending и строка лога скопированы из `codex-companion.mjs:1348–1353` v1.4.0 байт-в-байт):

```js
// Pending cancel, rendered once for the three sinks. On posix `survivors` is
// always [] and `reason` is v1.4.0's, so json/text/logLine are byte-identical
// to v1.4.0 there; only win32 adds a survivors suffix and a stderr diagnostic.
export function renderCancelPending(decision, pid, jobId) {
  const survivors = decision.survivors ?? [];
  const pending = `cancellation not confirmed: worker pid ${pid} left running (${decision.reason})`;
  const survivorText = survivors.map((s) => `${s.pid}:${s.identity ?? "unknown"}`).join(" ");
  const suffix = survivors.length > 0
    ? ` worker tree survivors: ${survivorText}`
    : decision.reason === "kill-failed" ? " (unverified)" : "";
  return {
    json: { jobId, status: "running", cancellationPending: true, reason: decision.reason, ...(survivors.length > 0 ? { survivors } : {}) },
    text: `${pending}\nThe turn interrupt was sent; the job stays running until the worker exits. Re-run cancel or wait for result.\n`,
    logLine: `${pending}${suffix}`,
    diagnostic: survivors.length > 0 ? `[codex] worker tree survivors: ${survivorText}\n` : null,
  };
}

// The caller's side of a pending cancel: one JSON document or the text on
// stdout, the diagnostic (if any) on stderr, one line in the job log.
export function emitCancelPending(decision, pid, jobId, { json, appendLog, stdout = process.stdout, stderr = process.stderr }) {
  const rendered = renderCancelPending(decision, pid, jobId);
  appendLog(rendered.logLine);
  if (rendered.diagnostic) {
    stderr.write(rendered.diagnostic);
  }
  stdout.write(json ? `${JSON.stringify(rendered.json, null, 2)}\n` : rendered.text);
  return rendered;
}
```

  В `lib/job-control.mjs` (рядом с `cancelDecision`): `export function brokerExclusion(broker) { if (!broker) return []; const identity = typeof broker.pidIdentity === "string" && /^win32:\d+$/.test(broker.pidIdentity) ? broker.pidIdentity : null; return Number.isInteger(broker.pid) && broker.pid >= 1 && identity ? [{ pid: broker.pid, identity }] : null; }` — `[]` без брокера, `null` когда брокер записан, но исключить его нельзя (нет `win32:`-identity или pid), иначе одна пара. Тест: `[]`/`null`/пара для трёх входов.

  В `codex-companion.mjs` (~1340): импортировать `loadBrokerSession` (`./lib/broker-lifecycle.mjs`), `cancelDecision`, `emitCancelPending` и `brokerExclusion` (`./lib/job-control.mjs`); заменить существующую строку `const kill = terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id) });` (1342) и блок `if (pid && (!kill.attempted || !kill.delivered) && isPidAlive(pid) === true) { … }` (1346–1356) — вместе, чтобы `kill` объявлялся один раз — на:

```js
  const broker = process.platform === "win32" ? loadBrokerSession(workspaceRoot) : null;
  const exclude = brokerExclusion(broker);
  // A broker record without a win32 identity cannot be excluded safely: refuse
  // rather than risk killing the shared broker under the worker (spec §3.4 rev. 12).
  const kill = broker && exclude === null
    ? { attempted: false, delivered: false, reason: "identity-unavailable" }
    : terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id), exclude: exclude ?? [] });
  // A worker we may not signal, or whose signal reached nothing, but that is
  // still alive is not cancelled: the job stays running, and the sidecar stays
  // so a later cancel or the reaper can still find it.
  const decision = cancelDecision({ pid, kill, alive: isPidAlive(pid) });
  if (decision.pending) {
    emitCancelPending(decision, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
    process.exitCode = 1;
    return;
  }
```

  (`JSON.stringify(rendered.json, null, 2)` + `\n` = то, что `outputResult` печатал через `console.log`, поэтому posix-вывод `cancel --json` не меняется; существующие posix-тесты cancel и legacy win32-тест `runtime.test.mjs:1922` проходят без правок.)

  Тесты (`tests/job-control.test.mjs`, рядом с таблицей `cancelDecision`):
  - `renderCancelPending({ pending: true, reason: "kill-failed", survivors: [{ pid: 4301, identity: "win32:7" }] }, 4300, "job-1")` → `json.survivors` deepEqual списку, `logLine` заканчивается на ` worker tree survivors: 4301:win32:7`, `diagnostic === "[codex] worker tree survivors: 4301:win32:7\n"`;
  - `renderCancelPending({ pending: true, reason: "kill-failed", survivors: [] }, 4300, "job-1")` → нет поля `survivors`, `logLine` заканчивается на ` (unverified)`, `diagnostic === null`;
  - `renderCancelPending({ pending: true, reason: "not-delivered", survivors: [] }, 4300, "job-1")` → `json` deepEqual `{ jobId: "job-1", status: "running", cancellationPending: true, reason: "not-delivered" }`, `logLine === "cancellation not confirmed: worker pid 4300 left running (not-delivered)"`, `diagnostic === null` (posix v1.4.0);
  - `emitCancelPending` с survivors и `json: true` и подменёнными writer'ами (`{ write: (chunk) => out.push(chunk) }` для stdout/stderr, `appendLog: (l) => log.push(l)`): `out` — ровно один chunk, `JSON.parse(out[0])` возвращает объект с `survivors`; `err` — ровно один chunk `[codex] worker tree survivors: 4301:win32:7\n`; `log` — одна строка с суффиксом survivors; тот же вызов с `json: false` → `out[0]` равен `rendered.text`, stderr тот же. Это и есть доказательство, что диагностика никогда не попадает в stdout; существующий `runtime.test.mjs:1954` (identity-mismatch без survivors) остаётся как posix-регрессия.

- [ ] **Step 5: хук** — `session-lifecycle-hook.mjs`: импорт `pathToFileURL` из `node:url`; после константы `IDENTITY_PROBE_MS` (~45):

```js
// Kill budget per job: a Windows kill is one PowerShell run (pin, verify, kill
// the tree, wait) and needs more than a posix signal plus probe.
export function killStepMs(platform = process.platform) {
  return platform === "win32" ? 4000 : IDENTITY_PROBE_MS;
}
```

  `cleanupSessionJobs` целиком (изменения: `export`, `deps`, `killStepMs(platform)`, `outcome` до `try`, `excludePids`, `unresolved`):

```js
export function cleanupSessionJobs(cwd, sessionId, lockWaitMs, remainingMs, deps = {}) {
  const { platform = process.platform, terminateRecordedProcessImpl = terminateRecordedProcess, broker = null } = deps;
  const exclude = brokerExclusion(broker);
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // One locked read-modify-write: the jobs this decides to stop and the list it
  // writes back have to come from the same snapshot, or another session's job —
  // created between the read and the write — is dropped from the index and its
  // files are pruned with it.
  withStateLock(workspaceRoot, () => {
    const state = loadState(workspaceRoot);
    const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    if (sessionJobs.length === 0) {
      return;
    }

    // A record is only dropped once its worker is stopped or provably gone; one
    // this hook refused to signal, failed to signal or never reached stays, so
    // the worker is not orphaned and `activeWorkspaceJobs` still sees it.
    const kept = new Set();
    for (const job of sessionJobs) {
      // Background jobs are explicitly dispatched to outlive the session that
      // started them. Leave them running and leave their state entry intact so
      // any session in the workspace can still poll for status/results.
      if (job.background) {
        continue;
      }
      const stillRunning = job.status === "queued" || job.status === "running";
      if (!stillRunning) {
        continue;
      }
      // Only a pid still provably this job's process is signalled (#743). posix
      // proves it with up to two probes; win32 pins, verifies and kills the tree
      // in one PowerShell run, so its step is longer (killStepMs).
      const probeMs = Math.floor(Math.min(killStepMs(platform), remainingMs() / 2));
      let reason = "budget-exhausted";
      let outcome = null;
      if (probeMs >= MIN_STEP_MS) {
        let pid;
        try {
          const recorded = resolveJobPid(workspaceRoot, job);
          pid = recorded.pid;
          // The shared broker can be this worker's child on Windows: never in its
          // tree — and only a broker with a verified identity can be excluded.
          outcome = platform === "win32" && broker && exclude === null
            ? { attempted: false, delivered: false, reason: "identity-unavailable" }
            : terminateRecordedProcessImpl(pid, {
                identity: recorded.identity,
                commandLineMatch: workerCommandLine(job.id),
                timeoutMs: probeMs,
                exclude: exclude ?? []
              });
          reason =
            outcome.reason === "no-pid" || (outcome.attempted && outcome.delivered)
              ? null
              : outcome.attempted
                ? platform === "win32"
                  ? outcome.reason
                  : "not-delivered"
                : outcome.reason;
        } catch {
          reason = "kill-failed";
        }
        // A dead root settles it on posix. On win32 a tree with survivors, or a
        // kill whose outcome is unknown, keeps the record whatever the root did:
        // the next SessionEnd judges it again (no survivor records — spec §1).
        const unresolved = platform === "win32" && ((outcome?.survivors?.length ?? 0) > 0 || outcome?.unverified === true);
        if (reason && isPidAlive(pid) === false && !unresolved) {
          reason = null;
        }
        if (unresolved) {
          reason = reason ?? "kill-failed";
          process.stderr.write(
            `[codex] SessionEnd left ${job.id} tree survivors: ${(outcome.survivors ?? []).map((s) => `${s.pid}:${s.identity ?? "unknown"}`).join(" ") || "unverified"}\n`
          );
        }
      }
      if (reason) {
        kept.add(job.id);
        process.stderr.write(`[codex] SessionEnd left ${job.id} running: ${reason}\n`);
      }
    }

    saveState(workspaceRoot, {
      ...state,
      jobs: state.jobs.filter((job) => job.sessionId !== sessionId || job.background || kept.has(job.id))
    });
  }, { waitMs: lockWaitMs });
}
```

  В `handleSessionEnd` (~218) вызов становится `cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV], stepBudget(STATE_LOCK_STEP_MS), remainingMs, { broker: process.platform === "win32" ? brokerSession : null });` (`brokerSession` объявлен выше; импорт `brokerExclusion` из `./lib/job-control.mjs`). Teardown (~298–322):

```js
  const teardown = teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    pidIdentity,
    killProcess: terminateProcessTree,
    // posix halved: a broker gone from its group is re-proved with a second
    // probe. win32: one PowerShell run does verify and kill, hence the kill step.
    timeoutMs: process.platform === "win32" ? stepBudget(killStepMs()) : Math.floor(stepBudget(IDENTITY_PROBE_MS) / 2),
    // An unknown outcome keeps the broker's records for the next SessionEnd.
    keepOnUnknown: true
  });
  // Every branch of this hook says what it decided: when a broker outlives a
  // SessionEnd the only question worth asking is which of these paths ran.
  process.stderr.write(
    `[codex] Broker teardown: endpoint=${brokerEndpoint ?? "none"} pid=${pid ?? "none"} signalled=${teardown.signalled} reason=${teardown.reason} kept=${teardown.kept} busyRetries=${busyRetries} budgetExhausted=false\n`
  );

  // A replacement broker can have started — and recorded itself — while this one
  // was shutting down. Clearing unconditionally would delete the live broker's
  // ownership record, which is exactly what the broker's own endpoint-guarded
  // `clearOwnSessionRecord` avoids on its side. A kept record is kept here too.
  if (!teardown.kept && loadBrokerSession(cwd)?.endpoint === brokerEndpoint) {
    clearBrokerSession(cwd);
  }
```

  Конец файла (~347–350): существующий `main().catch(...)` без изменений внутри `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { … }`.

  Бюджет: на win32 kill каждого job'а ≤ `min(4000, remaining/2)` — с 12 s хватает на два job'а и teardown; остальное — `budget-exhausted` как сегодня.

  Тесты (`tests/session-lifecycle-hook.test.mjs`, новый; импорт `{ cleanupSessionJobs, killStepMs }` из `../plugins/codex/scripts/session-lifecycle-hook.mjs`, `{ loadState, upsertJob }` из `../plugins/codex/scripts/lib/state.mjs`, `makeTempDir` из `./helpers.mjs`; записи сажаются через `upsertJob` как в примерах ниже — дополнительных обязательных полей он не требует):

```js
test("killStepMs gives a Windows kill one PowerShell run's worth of budget", () => {
  assert.equal(killStepMs("win32"), 4000);
  assert.equal(killStepMs("linux"), 2000);
});

test("SessionEnd keeps a job whose tree left survivors and drops one whose kill settled", () => {
  const cases = [
    ["win32", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 4301, identity: "win32:7" }] }, true, /tree survivors: 4301:win32:7/],
    ["win32", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }, true, /tree survivors: unverified/],
    ["linux", { attempted: true, delivered: false, reason: "not-delivered" }, false, null],
    ["win32", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }, false, null],
    ["win32", { attempted: false, delivered: false, reason: "no-pid" }, false, null]
  ];
  // A pid that is provably dead: a child that has already exited (reaped by
  // spawnSync), so no table row depends on which pids the host happens to use.
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
  for (const [platform, outcome, keptExpected, stderrPattern] of cases) {
    const repo = makeTempDir();
    const sessionId = "session-1";
    upsertJob(repo, { id: "job-1", status: "running", sessionId, background: false, pid: deadPid, pidIdentity: platform === "win32" ? "win32:1" : "linux:1" });
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      cleanupSessionJobs(repo, sessionId, 1000, () => 8000, { platform, terminateRecordedProcessImpl: () => outcome, broker: { pid: 555, pidIdentity: "win32:1" } });
    } finally {
      process.stderr.write = original;
    }
    const remaining = loadState(repo).jobs.map((job) => job.id);
    assert.deepEqual(remaining, keptExpected ? ["job-1"] : [], `${platform} ${JSON.stringify(outcome)}`);
    if (stderrPattern) {
      assert.match(written.join(""), stderrPattern);
    }
  }
});

test("SessionEnd passes the verified broker as the excluded subtree and refuses without its identity", () => {
  const repo = makeTempDir();
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  let seen = null;
  cleanupSessionJobs(repo, "s", 1000, () => 8000, { platform: "win32", broker: { pid: 555, pidIdentity: "win32:1" }, terminateRecordedProcessImpl: (pid, options) => { seen = options; return { attempted: true, delivered: true, method: "handle", reason: "identity-match" }; } });
  assert.deepEqual(seen.exclude, [{ pid: 555, identity: "win32:1" }]);
  assert.ok(seen.timeoutMs <= 4000 && seen.timeoutMs >= 100);
  // A recorded broker without identity: the kill is not even attempted; the job is kept.
  const repo2 = makeTempDir();
  upsertJob(repo2, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  cleanupSessionJobs(repo2, "s", 1000, () => 8000, { platform: "win32", broker: { pid: 555, pidIdentity: null }, terminateRecordedProcessImpl: () => assert.fail("must not kill") });
  assert.deepEqual(loadState(repo2).jobs.map((job) => job.id), ["job-1"]);
});
```

  (Импорт `spawnSync` из `node:child_process`.)

- [ ] **Step 6: `teardownBrokerSession` kept** — `broker-lifecycle.mjs` (`process` уже импортирован; `terminateRecordedProcess` тоже), функция целиком:

```js
export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  pidIdentity = null,
  killProcess = null,
  timeoutMs = undefined,
  ownsProcess = ownsBrokerProcess,
  platform = process.platform,
  keepOnUnknown = false,
  terminateRecordedProcessImpl = terminateRecordedProcess
}) {
  let signalled = false;
  let reason = "no-pid";
  let outcome = null;
  if (Number.isFinite(pid) && killProcess) {
    try {
      outcome = terminateRecordedProcessImpl(pid, {
        identity: pidIdentity,
        commandLineMatch: (commandLine) => ownsProcess(pid, endpoint, timeoutMs, commandLine),
        timeoutMs,
        terminateImpl: (target) => killProcess(target)
      });
      signalled = outcome.attempted && outcome.delivered;
      reason = outcome.reason;
    } catch {
      // Ignore missing or already-exited broker processes.
      reason = "kill-failed";
    }
  }

  // win32 only: an outcome that proves nothing about the broker — no probe, a
  // kill that did not verify, survivors — keeps every record when the caller
  // asks (SessionEnd), so the next SessionEnd can try again. A missing or
  // foreign process is a settled answer and is cleaned up as before; a dead
  // root does not settle an unknown outcome.
  const unknown =
    platform === "win32" &&
    (["identity-unavailable", "kill-failed"].includes(reason) || outcome?.unverified === true || (outcome?.survivors?.length ?? 0) > 0);
  const kept = keepOnUnknown && !signalled && unknown;
  if (kept) {
    return { signalled, reason, kept };
  }

  // Best-effort: a self-cleaning broker or a locked file must not fail the hook.
  if (pidFile) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
      // upstream #633/#626 report EPERM here on Windows).
    }
  }

  if (logFile) {
    try {
      fs.unlinkSync(logFile);
    } catch {
      // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
      // upstream #633/#626 report EPERM here on Windows).
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown
      // (this already swallowed ENOENT, and every other error, before this fix).
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }

  return { signalled, reason, kept: false };
}
```

  `ensureBrokerSession` вызывает teardown **без** `keepOnUnknown` (stale replacement не меняется). Обновить `deepEqual` в `tests/broker-stale-pid.test.mjs:1365,1381` (`kept: false`). Тесты (`tests/broker-stale-pid.test.mjs`, рядом с существующими teardown-тестами; `sessionDir` через `makeTempDir()`, `pidFile`/`logFile` — файлы в нём, `killProcess: () => {}`):

```js
test("teardownBrokerSession keeps the records on Windows when the outcome is unknown and asked to", () => {
  const cases = [
    ["win32", true, { attempted: false, delivered: false, reason: "identity-unavailable" }, true],
    ["win32", true, { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 7, identity: "win32:9" }] }, true],
    ["win32", true, { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }, true],
    ["win32", true, { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, false],
    ["win32", true, { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }, false],
    ["win32", false, { attempted: false, delivered: false, reason: "identity-unavailable" }, false],
    ["linux", true, { attempted: false, delivered: false, reason: "identity-unavailable" }, false]
  ];
  for (const [platform, keepOnUnknown, outcome, keptExpected] of cases) {
    const sessionDir = makeTempDir();
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    fs.writeFileSync(pidFile, "999999");
    fs.writeFileSync(logFile, "");
    const result = teardownBrokerSession({ pidFile, logFile, sessionDir, pid: 999999, pidIdentity: "win32:1", killProcess: () => {}, timeoutMs: 1000, platform, keepOnUnknown, terminateRecordedProcessImpl: () => outcome });
    assert.equal(result.kept, keptExpected, `${platform} keepOnUnknown=${keepOnUnknown} ${JSON.stringify(outcome)}`);
    assert.equal(result.reason, outcome.reason);
    assert.equal(fs.existsSync(pidFile), keptExpected, "records survive exactly when kept");
    assert.equal(fs.existsSync(logFile), keptExpected);
  }
  // No pid at all is settled: nothing to keep.
  const sessionDir = makeTempDir();
  assert.deepEqual(teardownBrokerSession({ pidFile: null, logFile: null, sessionDir, pid: null, killProcess: () => {}, platform: "win32", keepOnUnknown: true }), { signalled: false, reason: "no-pid", kept: false });
});
```

- [ ] **Step 7: broker knob** — в обработчике `broker/shutdown` (`app-server-broker.mjs` ~306–314) сразу **после** блока `if (busy) { … continue; }` и **перед** существующей строкой `send(socket, { id: message.id, result: {} });` (ответ отправляется один раз — либо knob'ом, либо существующей строкой):

```js
          // Test knob (Windows E2E only): acknowledge the shutdown and stay up,
          // so SessionEnd has to go through the recorded-pid kill path.
          if (process.platform === "win32" && process.env.CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN === "1") {
            send(socket, { id: message.id, result: {} });
            process.stderr.write("[broker] test knob: acknowledged shutdown, staying up\n");
            continue;
          }
```

  Только для тестов; README не упоминать.
- [ ] **Step 8: runtime win32-ожидания** — `tests/runtime.test.mjs`: ~1914–1920 оставить (legacy без identity); ~2167 `cancel sends turn interrupt`: убрать `IS_WIN && status === 1`; ~2436–2476 «session end preserves background jobs»: убрать win32-ветку; ~3885–3895 turn-timeout/cancel: убрать `if (IS_WIN)`, общий путь `status 0`, `/cancelled/i`, `assert.equal(await exited, 1)`; «session end fully cleans up jobs»: без win32-ветки; снять skip с 2004 (regex → `/^(linux|darwin|win32):/`) и 4115; оставить skip на 1954 и 3906. На уровне модуля: `import { isPidAlive } from "../plugins/codex/scripts/lib/process.mjs"; const isAlive = (pid) => isPidAlive(pid) === true;` (локальный одноимённый helper — переименовать).
- [ ] **Step 9: helper `cimTree`** (`tests/helpers.mjs`, только для Windows-тестов; бросает при ошибке, а не возвращает `[]`):

```js
// Every pid under `rootPid` by ParentProcessId (BFS), with a coarse executable
// class — for Windows-only tests that assert a whole tree died or survived.
// Runs through the plugin's own launcher (validated root, clean env, System32
// cwd, -EncodedCommand) and speaks its protocol: `NODE <pid>`, `CMD <pid>` or
// `OTHER <pid>` per node, nothing else. Throws when the enumeration fails or the
// output is not clean: a silent [] would make "everything is gone" vacuously true.
export function cimTree(rootPid, env = process.env) {
  const script = `$ErrorActionPreference = 'Stop'; $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name); $q = @(${rootPid}); $seen = @{}; while ($q.Count -gt 0) { $p = $q[0]; $q = @($q | Select-Object -Skip 1); if ($seen.ContainsKey($p)) { continue }; $seen[$p] = $true; $row = $all | Where-Object { $_.ProcessId -eq $p } | Select-Object -First 1; if ($row) { $w = if ($row.Name -match '^(?i)node\\.exe$') { 'NODE' } elseif ($row.Name -match '^(?i)cmd\\.exe$') { 'CMD' } else { 'OTHER' }; [Console]::Out.WriteLine($w + ' ' + [int]$row.ProcessId) }; foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) { $q += [int]$c.ProcessId } }`;
  resetWindowsIdentityCircuit();
  const run = runPowerShell(script, { env, timeoutMs: 20000 });
  const lines = run.unavailable || run.status !== 0 ? null : parseProtocolLines(run.stdout);
  if (lines === null) {
    throw new Error(`cimTree failed: status ${run.status} unavailable ${run.unavailable} timedOut ${run.timedOut}\n${run.stdout}`);
  }
  return lines.map((line) => {
    const row = /^(NODE|CMD|OTHER) (\d+)$/.exec(line);
    if (!row) {
      throw new Error(`cimTree: unexpected line ${JSON.stringify(line)}`);
    }
    return { pid: Number(row[2]), name: row[1] === "NODE" ? "node.exe" : row[1] === "CMD" ? "cmd.exe" : "other" };
  });
}
```

  (`tests/helpers.mjs` импортирует `runPowerShell`, `parseProtocolLines`, `resetWindowsIdentityCircuit` из `../plugins/codex/scripts/lib/process.mjs`; `resetWindowsIdentityCircuit` перед вызовом — чтобы breaker, сработавший в предыдущем тесте, не превратил enumeration в ложный throw. Имена `node.exe`/`cmd.exe` сохранены ради существующих `/^cmd\.exe$/i` в Step 10.)

- [ ] **Step 10: Windows-only E2E** (`{ skip: !IS_WIN, timeout: 90_000 }`, `tests/runtime.test.mjs`; `ROOT` — уже объявленный локально в `tests/runtime.test.mjs:25` (helpers его не экспортирует); импорты `cimTree`, `upsertJob`, `loadBrokerSession`, `resolveStateDir`, `pathToFileURL`; `SESSION_HOOK` уже есть; во всех тестах `t.after` для root регистрируется **сразу после получения pid**, для дерева — сразу после `cimTree`):

```js
test("cancel on Windows kills a direct worker and the codex.cmd tree under it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // A cold resume owns its own app-server, so the tree hangs under the worker, not the broker.
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pidIdentity && j.threadId && j.turnId ? j : null; });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  const tree = cimTree(running.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(tree.some((n) => /^cmd\.exe$/i.test(n.name)) && tree.filter((n) => /^node\.exe$/i.test(n.name)).length >= 2, `expected worker → cmd.exe → node.exe, got ${JSON.stringify(tree)}`);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => (tree.every((n) => !isAlive(n.pid)) ? "gone" : null));
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled");
});

test("cancel on Windows leaves the shared broker and its subtree alive, and the same app-server serves the next job", { skip: !IS_WIN, timeout: 120_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold A"], { cwd: repo, env });
  const jobA = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.status === "running" && j.turnId ? j : null; });
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, "worker A started the shared broker");
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  const brokerTree = cimTree(broker.pid);
  t.after(() => { for (const { pid } of brokerTree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(brokerTree.some((n) => /^cmd\.exe$/i.test(n.name)), `expected the app-server tree under the broker, got ${JSON.stringify(brokerTree)}`);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  // The broker is A's child by ParentProcessId on Windows; the kill must skip its whole subtree.
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => (!isAlive(withPid.pid) ? "gone" : null));
  assert.equal(isAlive(broker.pid), true, "the shared broker survives a worker kill");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "the broker's subtree survives");
  // The same app-server still serves: the fake holds every turn 60 s, so bound the next job by the turn timeout
  // and prove it went through the existing app-server (no second start) rather than a direct fallback.
  const next = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "3000", "--json", "quick C"], { cwd: repo, env, timeout: 60000 });
  assert.equal(next.error, undefined);
  assert.equal(next.status, 1, next.stderr);
  // The foreground JSON carries only the payload; the stored job carries the outcome.
  const jobC = readPersistedJob(repo);
  assert.notEqual(jobC.id, jobA);
  assert.match(jobC.errorMessage ?? "", /turn timed out after 3000 ms/, "the next job really ran a turn (and hit its budget)");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1, "no second app-server was started for the next job");
  assert.equal(fakeState.lastTurnStart?.prompt, "quick C", "the turn went through the existing app-server");
  assert.equal(loadBrokerSession(repo)?.pid, broker.pid, "no replacement broker was started");
});

test("a root that died before cancel is failed by the reaper on Windows; nothing is signalled by number", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.turnId ? j : null; });
  const tree = cimTree(withPid.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  process.kill(withPid.pid, "SIGKILL");
  await waitFor(() => (!isAlive(withPid.pid) ? "dead" : null));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0, "the reaper already failed the job; cancel has nothing active to signal");
  assert.equal(readPersistedJob(repo, jobId).status, "failed");
  // The orphaned children are the documented limitation here: nothing is touched by number.
  assert.ok(tree.filter((n) => n.pid !== withPid.pid).some((n) => isAlive(n.pid)));
});

test("a reused-looking identity is never signalled on Windows: the reaper fails the job and cancel reports it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pidIdentity ? j : null; });
  upsertJob(repo, { id: jobId, pidIdentity: "win32:1" });
  const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0);
  assert.equal(isAlive(withPid.pid), true, "the process holding the pid is a stranger to this record and must stay");
  const stored = readPersistedJob(repo, jobId);
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage ?? "", /pid reused/);
});

test("SessionEnd tears down a broker that acknowledged shutdown but stayed up, by its recorded identity", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { CODEX_COMPANION_SESSION_ID: "sess-win", CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const broker = await waitFor(() => loadBrokerSession(repo));
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  assert.match(broker.pidIdentity ?? "", /^win32:\d+$/);
  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "sess-win" }) });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stderr, /Broker teardown: .*signalled=true reason=identity-match/);
  await waitFor(() => (!isAlive(broker.pid) ? "gone" : null));
  assert.equal(loadBrokerSession(repo), null);
});

test("a planted PowerShell in the workspace or a relative PATH entry is never what the identity probe runs", { skip: !IS_WIN, timeout: 90_000 }, () => {
  const repo = makeTempDir(); fs.mkdirSync(path.join(repo, "tools"));
  const marker = path.join(repo, "HIJACKED");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(repo, "powershell.exe"));
  for (const planted of ["powershell.cmd", path.join("tools", "powershell.cmd"), path.join("tools", "powershell.exe.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), `@echo off\r\necho x> "${marker}"\r\n`);
  }
  const testEnvUrl = pathToFileURL(path.join(ROOT, "tests", "test-env.mjs")).href;
  const processUrl = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "process.mjs")).href;
  const probe = run(process.execPath, ["--import", testEnvUrl, "-e", `import(${JSON.stringify(processUrl)}).then(m => console.log(m.getProcessIdentity(process.pid) ?? 'null'))`], {
    cwd: repo, env: { ...process.env, PATH: `.;tools;${process.env.PATH}`, PSModulePath: path.join(repo, "tools") }
  });
  assert.match(probe.stdout.trim(), /^win32:\d+$/, probe.stderr);
  assert.equal(fs.existsSync(marker), false);
});
```

- [ ] **Step 11: gate + commit** `feat(runtime): Windows workers and brokers are killed from their records; survivors are reported, unknown outcomes are kept`. Push; контроллер диспатчит CI — Windows-джобы зелёные с leak-шагом 0 = доказательство Task 3–5.

---

