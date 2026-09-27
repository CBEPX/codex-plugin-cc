# Task 9 report: process identity on posix (#743)

Status: DONE_WITH_CONCERNS (the concerns are listed at the end; none block the gate)
Commit: `59208db fix(process): identity-checked kills and reaping on posix; identity in pid sidecar, job records and broker.json`

## What was implemented

- `lib/process.mjs`
  - `runCommand` now returns `status: result.status ?? null`. A timed-out command has no exit status, so it no longer reads as exit 0. Callers that compare against 0 (`binaryAvailable`, `processCommandLine`, `terminateProcessTree`, `runCommandChecked`, `git.mjs`) already treat `null` as a failure.
  - `getProcessIdentity(pid, { platform, timeoutMs = 10000, runCommandImpl, readFileSyncImpl })`:
    - linux: `linux:<starttime>`, taken from field 22 of `/proc/<pid>/stat`, which is index 19 after the last `)`.
    - darwin: `ps -o lstart=,comm= -p <pid>` with `shell: false` and `env: {…, LC_ALL: "C", TZ: "UTC"}`, formatted as `darwin:<lstart>|<comm>`.
    - win32: `null`.
    - The result for the process's own pid is cached.
    - A `timeoutMs` ≤ 0 returns `null` without probing, because `spawnSync` treats `timeout: 0` as unbounded.
  - `terminateRecordedProcess(pid, { identity, commandLineMatch, terminateImpl, … })` returns `{ attempted, delivered, reason }`, where `reason` is one of `identity-match | command-line-match | identity-mismatch | identity-unavailable | no-pid`. It accepts `terminateImpl` (default `terminateProcessTree`) so teardown can pass its pid-only `killProcess`. When an injected terminator returns something other than an object, the call counts as `{attempted:true, delivered:true}`.
  - `workerCommandLine(jobId)` is the `task-worker.*--job-id <id>(\s|$)` fallback regex. Cancel and the hook share it.
  - `processCommandLine` passes `shell: false`.
- `lib/state.mjs`
  - The sidecar is written as `{"pid":N,"identity":…}`. The reader also accepts the v1.2.x bare integer.
  - `updateJobPid(cwd, jobId, pid, identity = null)` patches `pidIdentity` into the index.
  - `resolveJobPid` now returns `{ pid, identity }`. All three callers were updated.
  - The ticket/choosing owner record carries `identity` on posix (`null` on win32).
  - `judgeLockEntry` returns ABANDONED for a live owner whose identity is readable and differs, with a 2 s probe. An identity it cannot read leaves the entry HELD. The code carries the `// ponytail: win32 lock entries stay PID-liveness only` comment.
- `lib/tracked-jobs.mjs`
  - `runTrackedJob` records `pidIdentity`. Every `pid: null` now has a matching `pidIdentity: null`, including in `markJobDead`.
  - `reapDeadJobs(…, { getProcessIdentityImpl })` handles three cases:
    - A live process whose identity mismatches is marked dead with `worker exited before completing (pid reused: N now belongs to another process)`.
    - A probe that throws or returns `null` leaves the job alone.
    - The probe runs with `min(2000, remainingMs())`.
- `codex-companion.mjs`
  - `enqueueBackgroundTask` records `getProcessIdentity(child.pid)`.
  - `handleCancel` uses `terminateRecordedProcess`. When it does not attempt a kill, it writes `worker pid N left running: <reason>` to the job log, appends the same line to the rendered text, and returns it as `workerLeftRunning` in the JSON payload.
  - The queued and cancelled records mirror `pidIdentity: null`.
- `lib/broker-lifecycle.mjs`
  - The `broker.json` validator rejects a non-string `pidIdentity`.
  - `ensureBrokerSession` captures the identity immediately after the spawn, before the readiness wait. It uses that identity both in the saved session and in the teardown when readiness fails. The stale-record teardown passes `existing.pidIdentity`.
  - `teardownBrokerSession({ …, pidIdentity })` routes through `terminateRecordedProcess`: `ownsProcess` becomes `commandLineMatch` and `killProcess` becomes `terminateImpl`. It keeps the `killProcess &&` gate and the try/catch, and returns `{ signalled, reason }`.
  - `ownsBrokerProcess` takes an optional 4th `commandLine` argument, so it no longer runs a second `ps` call.
- `session-lifecycle-hook.mjs`
  - `cleanupSessionJobs` kills through `terminateRecordedProcess`. Each probe's timeout is `min(2000, remainingMs())`, and the kill is skipped below `MIN_STEP_MS`.
  - The teardown receives `pidIdentity` and `timeoutMs: stepBudget(2000)`.
  - The decision line now prints `reason=…`.

## Deviations from the brief (and why)

1. **The runtime e2e test was rewritten.** The brief's test cannot pass with a consistent implementation, for two reasons:
   - `handleCancel` calls `resolveCancelableJob`, which calls `reapDeadJobs` first. Under the binding reaper rule, a tampered identity gets the job reaped as `pid reused` before cancel ever sees it, and cancel then exits with "No active job".
   - The test tampered the sidecar and the job file but not `state.json`, and `resolveJobPid` reads the index job's `pid`/`pidIdentity`.

   The replacement covers the #743 scenario directly. It seeds a legacy record with no identity whose pid belongs to an unrelated live `node -e` process. The reaper keeps the job (liveness only). Cancel's command-line fallback misses, so the output reads `worker pid N left running: identity-mismatch`, and the test asserts that the process is still alive. A second e2e test covers the identity-match path: a real background worker's sidecar holds `{pid, identity}` that equals `getProcessIdentity(pid)`, and cancel kills the worker without printing "left running".
2. **The reap message was changed** to contain the literal `pid reused`, which the brief's own test asserts. The brief's wording, `pid N reused`, does not match `/pid reused/`.
3. **The darwin parse uses an anchored C-locale regex, not a split at the last space.** On this Mac:
   - Without pinning, `lstart` is localized (`воскресенье, 27 сентября 2026 г. …`). A recorder and a checker running with different locale or TZ settings would never agree. For the reaper and the lock that would mean false "pid reused" results.
   - `comm` is a full executable path that can contain spaces.

   Verified here: `darwin:Sun Sep 27 17:54:01 2026|node` for `process.pid`, and a Chrome helper whose `comm` is `/Applications/Google Chrome.app/…/Google Chrome Helper (Renderer)` stays whole. The brief's fixture still yields `darwin:Mon Sep 27 10:00:00 2026|node`.
4. **Existing tests were updated to the new shapes:**
   - `resolveJobPid` assertions now compare against `{pid, identity}`.
   - The legacy "cancel stops an active background job" sleeper now runs with `task-worker --job-id task-live` args, so the command-line fallback matches.
   - The two SessionEnd foreground-job tests seed `pidIdentity` (the record shape since v1.3.0).
5. **Carry-over from Task 4 was applied.** A `recordingKill` helper forwards any pid other than `process.pid` to the real `terminateProcessTree` in the three `ensureBrokerSession` tests, and #749 gained the "alive but foreign" case.

## Tests and TDD evidence

RED, before the implementation:
```
node --import ./tests/test-env.mjs --test tests/process.test.mjs tests/tracked-jobs.test.mjs tests/state.test.mjs
SyntaxError: ... does not provide an export named 'getProcessIdentity'   (x3)  → tests 3, pass 0, fail 3
--test-name-pattern "identity|…|malformed|#749|#753|#768" tests/broker-stale-pid.test.mjs
not ok 5 - loadBrokerSession ignores a malformed record instead of trusting it
not ok 6 - SessionEnd leaves a recorded broker pid alone when its identity no longer matches (#743)
```
GREEN:
```
process + tracked-jobs + state: # tests 66, pass 66, fail 0
broker-stale-pid + runtime (identity|recycled|sidecar|left running|malformed|#749|#753|#768|cancel): # tests 15, pass 15, fail 0
npm test: ℹ tests 286 ℹ pass 286 ℹ fail 0   (267 at base + 19 new)
sleep 10; pgrep -f codex-plugin-test- | wc -l → 0
npm run build → exit 0
```
The first full run showed one failure: `task logs subagent reasoning and messages with a subagent prefix`. It is a pre-existing flake. I extracted HEAD with `git archive` into the scratchpad and ran that test 10 times there: it failed 2/10. The final full run passed.

## Files changed
- plugins/codex/scripts/lib/process.mjs
- plugins/codex/scripts/lib/state.mjs
- plugins/codex/scripts/lib/tracked-jobs.mjs
- plugins/codex/scripts/lib/broker-lifecycle.mjs
- plugins/codex/scripts/codex-companion.mjs
- plugins/codex/scripts/session-lifecycle-hook.mjs
- tests/process.test.mjs, tests/tracked-jobs.test.mjs, tests/state.test.mjs, tests/broker-stale-pid.test.mjs, tests/runtime.test.mjs

## Self-review
- Interface list: complete. `resolveJobPid` has three callers (reaper, cancel, hook), and all three destructure `{pid, identity}`.
- Every `pid: null` has a matching `pidIdentity: null`: 7 places in tracked-jobs and 3 in the companion.
- SessionEnd budget:
  - Reaper probes are ≤ 2 s and clamped by `remainingMs`.
  - Cleanup probes are ≤ 2 s, clamped, and skipped below 100 ms.
  - The teardown probe is `stepBudget(2000)`; it was previously `stepBudget(5000)` for the command-line probe.
- Linux field index: 22 is index 19 after `) `. The tests check this with a `comm` that contains `(node (x))`.
- No processes are left behind after the suite (pgrep result: 0).

## Concerns
1. **win32 behavior change.** `teardownBrokerSession` no longer signals without an identity on win32 (`identity-unavailable`), as the design requires. Before this change, `ownsBrokerProcess` answered `true` there and teardown killed the process unconditionally. On win32 a freshly spawned broker that misses its readiness window is therefore no longer killed by `ensureBrokerSession`. The windows CI leg is `continue-on-error`, and CIM identity is planned for v1.4.0.
2. **Legacy foreground records.** v1.2.x foreground job records that have no identity and are still running during an upgrade are not killed at SessionEnd. Their command line (`codex-companion.mjs task …`) contains no job id, so the fallback regex cannot prove them. This fails safe.
3. **Lock-wait cost.** `judgeLockEntry` runs one `ps` call per poll for each foreign live entry that carries an identity. That happens only on darwin, and only while the lock is blocked.
4. **Cancel still marks the job cancelled** when it leaves the worker running. That behavior already existed for a failed kill; the only change is that it is now reported.
5. **Pre-existing flake.** The `subagent prefix` runtime test failed 2/10 runs at base.

## Fix report 1 (coordinator ruling on concern 1)

Commit: `69f958d fix(broker): a freshly spawned broker that never becomes ready is killed regardless of identity`

What changed:
- The not-ready branch in `ensureBrokerSession` now calls `killProcess(child.pid)` directly, on every platform, inside a try/catch. It then calls `teardownBrokerSession` without a pid, which only cleans up the files. That pid comes from the child handle, not from a stored record, so it cannot have been recycled.
- Every pid that comes from a stored record still goes through `terminateRecordedProcess`.
- `ensureBrokerSession` accepts `getProcessIdentityImpl`, which is used when the spawned child's identity is captured. The only purpose is to let the test simulate an identity that cannot be read.

Covering test: `ensureBrokerSession kills a fresh broker that never becomes ready` in `tests/broker-stale-pid.test.mjs`.
- The fake broker script never listens.
- The test passes `timeoutMs: 300`, `getProcessIdentityImpl: () => null` and a recording `killProcess` that forwards to `terminateProcessTree`.
- It asserts that the fresh pid was signalled exactly once, that no session was saved, and that the child is gone.

RED: the old routing, with only the injection point added, gives `not ok 1 … the fresh child must be signalled`. That RED run orphaned one `never-listens.mjs` process, which I killed by hand. The count is now 0.

GREEN:
- `node --import ./tests/test-env.mjs --test --test-name-pattern "ensureBrokerSession|fresh" tests/broker-stale-pid.test.mjs` → tests 4, pass 4, fail 0.
- `npm test` → tests 287, pass 287, fail 0.
- `pgrep -f codex-plugin-test-` → 0.
- `npm run build` → exit 0.

Concern 1 is resolved. Concerns 2 and 3 are in the ledger, per the ruling.
