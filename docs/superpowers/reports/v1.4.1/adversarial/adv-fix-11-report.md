# Adversarial fix wave 11 report

B1: `ensureBrokerSessionLocked` probes the identity of a pid-bearing identity-less starting/replacing record (`probeBefore`) before the readiness check (fast and wait paths share the one `pre`). `adoptOrRetry(record, pre)` probes again after the answer; promotes only when both are equal and non-null, else keeps the record and returns null with one stderr line. If `pre` does not match the reloaded record's pid, it goes through `retryClaim`. Applies on every platform (not only win32); sameClaim ready save unchanged.
First probe null: the second probe still runs (stated choice); result null.
Tests: 3 new (equal, differing, first null) in tests/broker-stale-pid.test.mjs; existing adoption tests pass. Tests were written together with the code, not red-first.
Minors: README Limits wording; stale comment fixed; `waitFor` exported from tests/helpers.mjs, imported in runtime and broker-stale-pid tests; spec rev. 20 sentence.

CI-timing items (follow-up commit, the main commit was already pushed as b694d37):
(2) tests/process.test.mjs: the three live win32 kill tests now use timeoutMs 30_000 and test timeout 90_000 (breaker was already reset at the start of each).
(1) NOT changed: "session end re-reads the broker record right before teardown" is in tests/broker-stale-pid.test.mjs (not session-lifecycle-hook.test.mjs). The 5 s ceilings on that path are production bounds in session-lifecycle-hook.mjs (BROKER_HANDSHAKE_STEP_MS 5000, killStepMs win32 4000 within a 12 s budget), not a test wait; the test's own wait is 10 s. Without the CI log I cannot tell which one tripped; a test-side fix would need a product override knob or the CI stderr line (`cleanup.stderr` is in the assertion message). Needs a decision.
