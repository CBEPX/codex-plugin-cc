# Adversarial fix wave 13 report

Commit 8348e51 (pushed). `runTrackedJob`'s cooperative terminal writes (normal completion/failed-exit path) set `workerClosed: true` on job file and index. Ordering verified: `runner()` resolves only after `withAppServer` awaited `client.close()`, so no second patch write was needed. The thrown-runner catch path, the crash guard and the reaper never set it. `isWorkerTerminalRecord` = terminal && `workerClosed === true` (prefix predicate and the unused DEAD_WORKER_MESSAGE import dropped). Legacy records fail closed.
Tests: isWorkerTerminalRecord table, commitCancel keep-rule rows (crash-guard, unmarked, marked), runTrackedJob marker (absent inside runner, present after; absent on throw), crash-guard record has no marker. Gate: 453 tests, 442 pass, 0 fail, 11 skipped.
Docs: spec rev. 22 (§3.4), README, both CHANGELOGs identical.
Concern: the ordering test observes "no marker inside the runner", not the close call itself (close is inside withAppServer, not injectable at this layer).
