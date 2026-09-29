# Adversarial fix wave 12 — report

Commit: 1597765 on `release/v1.4.1` (pushed). Gate: `npm run check` green (451 tests: 440 pass, 11 skipped (Windows-only), 0 fail), no leaked test processes.

## R1 — no pid-less window after spawn; workers never run a cancelled job
- `state.mjs`: new `recordWorkerPid(cwd, jobId, pid, { getProcessIdentityImpl })` — `updateJobPid(pid, null)` first, then the probe, then `updateJobPid(pid, identity)`. `enqueueBackgroundTask` calls it (the `updateJobPid`/`getProcessIdentity` imports in the companion dropped).
- `tracked-jobs.mjs` `runTrackedJob`: the identity is probed outside the lock; under one `withStateLock` it re-reads the stored record and writes `running` (file + index) only when there is no record (foreground) or it is `queued`/`running`. A terminal record (cancelled or otherwise) is left alone: one log line, pid sidecar and request file removed, returns `null` (no throw, so the crash guard never fires; worker exits 0 like a worker whose terminal write finds `cancelled`).
- Tests: `recordWorkerPid writes the pid sidecar before the identity probe runs` (injected probe sees `{pid, identity: null}` through `resolveJobPid`); `runTrackedJob refuses a job that is already cancelled…` (runner not called, no `startedAt`, sidecar/request removed); runtime `a worker started against a cancelled job exits without running the turn` (real `task-worker` + fake codex; record stays cancelled, `appServerStarts` 0). The runtime test failed before the fix (record became `completed`).

## R2 — a vanished root is cancelled only on the worker's own proof
- `job-control.mjs`: exported `isWorkerTerminalRecord(stored)` (terminal and `errorMessage` not starting with `DEAD_WORKER_MESSAGE`); `commitCancel` uses the same predicate (behaviour unchanged). `cancelDecision` takes `workerProved` (default `false`): win32 `process-missing` without survivors is non-pending only when `workerProved`; otherwise `{ pending: true, reason: "process-missing", survivors: [], rootAlive }`.
- `finishCancel`: `workerProved` computed only on win32 with `kill.reason === "process-missing"`, from `readStoredJob` after the kill (inside the win32 state lock). posix untouched.
- `renderCancelPending`: `process-missing` with a dead root and no survivors now reads "worker pid N exited before it could be verified; the job stays running until the reaper judges it." (was "until the worker exits", false for a gone root).
- Tests: table rows `process-missing` × `workerProved` true/false/omitted, survivors + `workerProved: true` still pending, linux row unchanged; render loop extended with `process-missing`.
- runtime ~2133 (interrupt honoured → worker writes its terminal record, then exits → `workerProved` → cancelled) and ~4374 (reaper fails first, cancel never reaches the decision) hold by reasoning; assertions untouched. Windows-only paths run in CI after the push.

## Docs
Spec rev. 21 (header, §3.4 cancel outcome, §3.5 capture at spawn, §4 testing, §5 risk line); README «### Windows» clause; both CHANGELOG copies identical (`check-changelog` OK).

## Concerns
- If a concurrent poll's reaper fails the job between `resolveCancelableJob` and the kill, `workerProved` is false → the cancel answers pending with JSON `status: "running"` while the record is already `failed`. Follows the ruling; exit 1 and the next cancel/status show the truth.
- The second `updateJobPid` can recreate a sidecar after a cancel removed it (pre-existing race, now two writes); harmless — `resolveJobPid` ignores sidecars on terminal jobs and the refusing worker removes it.
