# Adversarial fix wave 5 report

Commit: 7f765b4 (pushed to origin/release/v1.4.1). Gate: `npm run check && sleep 10 && leak=0 && git add … && git commit` → exit 0 (419 tests: 408 pass, 0 fail, 11 skipped).

## (a) Marker shielding removed
- `terminateScript`: the per-child `CommandLine` query, `$shielded` and its survivor merge are gone; the verified `$exclude` pair check stays.
- Test: the script-text test now asserts `doesNotMatch /CommandLine|app-server-broker|shielded/`.
- RED: that assertion failed on the old script. GREEN: process.test.mjs 40 pass.

## (b) Start window closed by order + lock
- `ensureBrokerSession`: under `withStateLock(cwd)` it saves a starting record `{endpoint, pidFile, logFile, sessionDir, pid:null, pidIdentity:null}`, spawns, and re-saves with `pid`. If the spawn throws, the record is cleared. The identity probe runs after the lock and re-saves with `pidIdentity` at once.
- New `spawnBrokerProcessImpl` option (test seam).
- `describeBrokerRecordProblem` already accepted `pid: null`; no change there.
- Stale path: a `pid: null` record gets the same retry window as a live owned broker. If it answers it is reused; otherwise it is replaced with nothing killed.
- `handleCancel`: the tail moved into `finishCancel`. On win32 it runs inside `withStateLock(workspaceRoot)` with the default 5 s wait (the same as the existing cancel write). That lock covers `brokerPresence`, the kill (`timeoutMs: 4000`, SessionEnd's win32 step), the decision and the write. posix calls `finishCancel` directly.
- Tests:
  - "writes a starting record under the state lock before it spawns": the record at spawn equals the starting shape, `brokerExclusion` is null, and one lock ticket is held.
  - "waits for a starting record's broker instead of replacing it".
  - RED: both failed. GREEN: pass.

## (c) Orphan evidence on 241
- Script: when the root pin throws `ArgumentException`, it runs a filtered CIM query `ParentProcessId = <pid>` with `ProcessId,CreationDate`. A row is admitted when `Micro(CreationDate) ≥ Micro(FromFileTimeUtc([long]$expected))` (UTC ticks, µs-truncated).
- Each admitted row is pinned; `ArgumentException` means it is gone and is skipped. It is kept only when `Micro(pinned StartTime) == Micro(CreationDate)`, which rules out a reused pid.
- Rows are collected and printed as `SURVIVOR <pid> <filetime>` only after a complete pass. Then `$code = 241; throw 'missing'`. `$code` stays 245 during the pass, so a failed enumeration becomes `identity-unavailable`. Orphans are never killed; pinned objects are disposed in `finally`.
- JS mapping:
  - 241 with empty stdout → `process-missing`.
  - 241 with clean, unique, valid SURVIVOR-only rows → `process-missing` + `survivors`.
  - 241 with anything else → `identity-unavailable`.
  - The shared `survivorsOf` helper is also used for 243.
- `cancelDecision` on win32:
  - process-missing with survivors → pending.
  - process-missing without survivors → not pending: cancelled, and no "left running" line.
  - A refused kill with a dead root → pending (unchanged).
- `renderCancelPending`: the "root exited but part of its tree is still running" tail now covers any reason with survivors. The unreachable "exited before it could be signalled" tail was removed.
- `finishedBeforeCancel` and `workerFinished` were removed from code, tests, README and CHANGELOG.
- Tests:
  - Table rows added (valid, duplicate pid, `SURVIVOR 0 0`, trailing `OK`), plus script-text asserts for the 241 block.
  - cancelDecision table updated.
  - New live Windows test (`skip: !IS_WIN`): the parent is killed by hand, and its orphan is reported with its identity and stays alive. The existing live 241 test now asserts that there are no survivors.
- RED: cancelDecision and render tests failed; script asserts failed. GREEN: pass.

## (d) Terminal record kept — coordinator ruling D, extended (see concerns)
- New `commitCancel(workspaceRoot, job, nextJob, existing, { leftRunning, log, causedByCancel })` in job-control. It does the locked write that used to be inline. If the stored record is already terminal and this cancel did not cause it, the record is kept: the log gets `cancel: record already <status>, kept (interrupt not acknowledged)` and the stored job is returned. The command then reports the stored status with exit 0.
- The caller sets `causedByCancel = interrupt.interrupted === true || (kill.attempted && kill.delivered)`.
- The pending path (survivors, exit 1) returns before the write, as before.
- Same rule on every platform.
- Test: "commitCancel writes cancelled over an active record and keeps a terminal one" covers the active, kept and caused cases. RED: missing export. GREEN: pass.
- posix (as ruled): the kept branch is only observable in the race, and output is byte-identical otherwise. Payload key order is unchanged. The "Cancelled by user." log line is now written inside the lock.

## (e) Verified teardown of a failed broker start
- Not-ready path: the record was already re-saved with the identity after the probe. Teardown goes through `teardownBrokerSession({ pid: child.pid (null if already exited), pidIdentity, killProcess, timeoutMs: 4000, ownsProcess: () => child not exited, terminateRecordedProcessImpl })`, which calls `terminateRecordedProcess`.
  - win32: the verified tree kill.
  - posix: the group kill, proven by identity or by the unexited handle.
- The record is cleared only when the teardown is `signalled` (delivered) or the child has exited. Otherwise it is kept with its identity and one stderr line. The bounded exit wait (`BROKER_EXIT_WAIT_MS`) was removed because the decision no longer needs it.
- New `terminateRecordedProcessImpl` option on `ensureBrokerSession`.
- Tests:
  - "clears a failed start's record only when the verified teardown delivered" (delivered → cleared; not delivered → kept with `pidIdentity`; one call with that identity and `timeoutMs: 4000`). RED: failed. GREEN: pass.
  - The process-group test now uses the real identity on win32 (verified tree kill, no posix terminator call).

## Docs
- Spec rev. 14: date line, step 1 (orphan evidence), step 3 (rev. 13 shielding sentence deleted), 241 mapping, new paragraphs "Broker start window and cancel" and "Cancel outcome", §6 posix items 5–6.
- README «### Windows» and both CHANGELOG copies adjusted; `check-changelog` OK.

## Files
plugins/codex/scripts/lib/process.mjs, plugins/codex/scripts/lib/broker-lifecycle.mjs, plugins/codex/scripts/lib/job-control.mjs, plugins/codex/scripts/codex-companion.mjs, tests/process.test.mjs, tests/job-control.test.mjs, tests/broker-stale-pid.test.mjs, docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md, README.md, CHANGELOG.md, plugins/codex/CHANGELOG.md.

## Concerns
1. Deviation from ruling D, which needs sign-off: "caused by this cancel" also covers a delivered kill, not only an acknowledged interrupt. Evidence: posix `runtime.test.mjs:3881` ("an acknowledged cancellation survives a worker that finishes after it") failed in 3 of 4 runs under the interrupt-only rule. The job has no turnId yet, so no interrupt is sent. The group SIGTERM kills the broker, and the SIGTERM-ignoring worker writes `failed` before cancel's lock. With the extension: 5 of 5 pass. The pass-4 #1 case (a reaper failure on a dead worker) is still kept, because the kill is not delivered there.
2. Windows `runtime.test.mjs` ~2133 still depends on the race between the acknowledged interrupt and the kill. With ruling D the acknowledged interrupt gives `cancelled` regardless of which side wins the lock, so it should hold. Only Windows CI can confirm.
3. A win32 cancel holds the state lock for up to about 4.5 s, so other lock takers (the worker's terminal write, `status` reaping, and `ensureBrokerSession`) wait up to 5 s. If PowerShell is cold (> 4 s), the kill times out → `identity-unavailable` → pending.
4. The `handleCancel` win32 lock path and the new live orphan test only run on Windows CI.
5. First gate run failed: `broker-stale-pid.test.mjs:371` (SessionEnd keeps the broker…) read the new starting record (pid null) during the spawn window (a few ms). Two tests now wait for a record with a pid. SessionEnd reading a starting record inside that window behaves as it did for the earlier provisional record: no pid, nothing is killed. Second gate: exit 0.
