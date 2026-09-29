# Adversarial fix wave 4 report

B1: kill script shields an unrecorded app-server-broker.mjs child (one filtered CommandLine query per admitted non-excluded child), reports it as SURVIVOR with exit 243. B2: `finishedBeforeCancel` (job-control) keeps a terminal record on win32 (exit 0, cancellationPending false); `workerFinished` removed. B3: failed broker start waits <=1 s for exit, clears the provisional record only when exited, else stderr line. S1: leftRunning log is unsuppressed (posix identical).
Docs: README Windows, spec rev. 13, CHANGELOG (both copies).
Tests: process script-text, job-control (table + finishedBeforeCancel), broker-stale-pid (record kept for a SIGTERM-ignoring child; cleared case covered by existing tests). Implementation was written before the tests in this wave (not strict red-first).
Concerns: Windows runtime test ~2133 relies on the worker's stored status being "cancelled" after an acknowledged interrupt; not verifiable on macOS, CI will show. handleCancel branch is win32-guarded and not runtime-tested here. README Windows sentence about "records cancelled only when the worker wrote its final record" was removed as no longer true.
