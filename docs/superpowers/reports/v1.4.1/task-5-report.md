# Task 5 report

Commit 7591f28 (single commit, pushed). Gate: `npm run check` exit 0 (398 tests, 390 pass, 0 fail, 8 skipped incl. the 6 new Windows E2E) then sleep 10, pgrep=0, commit.

Implemented steps 1-11: reaper win32 batch (tracked-jobs), cancelDecision/brokerExclusion/renderCancelPending/emitCancelPending (job-control) + cancel rewiring, hook (killStepMs, exported cleanupSessionJobs, direct-run guard, keepOnUnknown teardown, kept in log line), teardownBrokerSession {signalled,reason,kept}, broker HANG_ON_SHUTDOWN knob, runtime win32 expectations (Step 8, skips lifted at 2004/4115, isAlive helper), cimTree helper, six Windows E2E tests.
Tests added: 4 reaper (tracked-jobs), new tests/job-control.test.mjs (6), new tests/session-lifecycle-hook.test.mjs (3), teardown keep table (broker-stale-pid), deepEqual sites updated.
TDD: reaper tests confirmed RED (probe list empty) before impl. Others (job-control, hook, teardown) were written after the implementation in the same pass - no separate RED run, except the hook test that exposed the deviation below.

Deviations / concerns:
1. Brief's cleanupSessionJobs contradicts its own test: with a broker record lacking a win32 identity and a dead worker pid, the brief code drops the record (dead root clears reason). Added `refused` (win32 && broker && exclude===null) to `unresolved` so the record is kept; stderr then says "tree survivors: unverified".
2. Direct-execution guard compares realpath of argv[1] (symlinked plugin dirs would otherwise run no hook). Small hardening beyond the brief.
3. Windows E2E tests are unverified locally; controller must check CI.
4. Existing tracked-jobs:490 test already had the win32 expectation.

## Fix round 1
F1 pass only recordedBroker (loadBrokerSession result) to cleanupSessionJobs; env-fallback placeholder no longer refuses kills. Test: broker null -> kill attempted with exclude []. F2 outcome?.survivors. F3 stderr captured in refusal case. F4 refusal logs "tree: refused (broker record without identity)". No helper extracted (call site trivial). Gate exit 0, 391 pass.
