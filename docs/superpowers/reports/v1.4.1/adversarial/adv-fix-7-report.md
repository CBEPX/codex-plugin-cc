# Adversarial fix wave 7

Commit 0e2946c (pushed). Gate: 428 tests, 417 pass, 0 fail, 11 skipped.

- B1: stale path re-reads the record under withStateLock; a changed claim (pid, pidIdentity, endpoint) re-runs ensureBrokerSession (attempt+1, CLAIM_ATTEMPTS bound, then null). Ready-record save retried once after 250 ms, then the failed-start teardown (now local `abandonStart`) and null. saveClaimed catches STATE_LOCK_TIMEOUT_CODE -> false.
- S1: stale teardown uses keepOnUnknown plus new `keepOnUnknownAnyPlatform` (the win32 gate was the only thing stopping it on posix); kept -> record and files stay, one stderr line, null.
- Test hooks added: options.saveBrokerSessionImpl, options.terminateRecordedProcessImpl (stale path).
- Tests: 4 new in tests/broker-stale-pid.test.mjs. Spec §3.4 rev. 16 sentence added; CHANGELOG untouched.
- Concern: test 4 simulates the lock timeout by an injected throw, not a real cross-process lock hold. A vanished record (null on re-read) skips teardown and proceeds to spawn.
