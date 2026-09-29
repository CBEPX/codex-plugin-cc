# Adversarial fix wave 9 — report

Commit: 15cae71 on release/v1.4.1 (pushed). Gate: npm run check green — 439 tests, 428 pass, 0 fail, 11 skipped; 0 leftover test processes.

## R1 — no pid-null starting record for a live broker
- Pre-spawn save carries `startedAt` (epoch ms); identity saves inherit it.
- `abandonStart` keeping a live child saves `{ ...starting, pid: child.pid, pidIdentity (may be null) }` endpoint-guarded (replaces the old identity-only save; a save error is logged).
- `STARTING_GRACE_MS = 60_000` (exported). The stale path keeps a pid-null `starting` record inside the grace and returns null (one stderr line) after the usual wait window; older or no `startedAt` → the existing settle path.
- `describeBrokerRecordProblem` checks that `startedAt`/`replacingAt` are finite numbers when present.
- Tests: young → null and kept; old → replaced; failed pid save plus a surviving child → record names its pid, identity, starting and startedAt.

## R2 — teardown reserved under the lock
- One locked helper `writeBrokerSessionIf(cwd, matches, next|null, { waitMs, loadBrokerSessionImpl, saveImpl })`. It backs `clearBrokerSessionIfEndpoint`, the new exported `clearBrokerSessionIfNonce`, the reservation, the restore, `saveClaimed`, the abandonStart save and the adoption promote.
- `sameClaim` compares endpoint, pid, pidIdentity, state and replacer.
- The stale path reserves the record (`state: "replacing"`, `replacer: randomUUID()`, `replacingAt`) when the claim is unchanged, kills outside the lock and clears only by nonce. A changed record takes the retry path (3 attempts). A record that is gone goes on to the claim block.
- `saveClaimed` refuses `replacing`, so the starter goes to abandonStart. `teardownBrokerSession` keeps `replacing` (`reason: "replacing"`). The stale path gives a `replacing` record the same grace from `replacingAt` and does not wait on its endpoint.
- Tests: a reservation before the starter's saves → the starter's saves are refused, the verified failed-start kill runs and the start returns null; the nonce clear removes only its own nonce; a record another claim wrote during the kill survives, and the retry adopts it; teardown keeps replacing.

## R3 — adopt-and-promote
- The fast path and the post-wait path call `adoptOrRetry`. Ready and legacy records are returned without the lock, as before.
- For starting (and replacing past its grace), under the lock: the identity is probed when missing, and the record is promoted to `ready` claim-guarded and returned. On win32 with no identity (or no pid) the record is kept and the call returns null with one stderr line. On posix a pid-less starting record that answers is returned unchanged.
- Tests: promotion to ready with identity (saved); win32 without identity → null, record kept exactly.

## Minors
- The hook's final clear uses `waitMs: stepBudget(STATE_LOCK_STEP_MS)` and catches only `STATE_LOCK_TIMEOUT_CODE`.
- The broker's `clearOwnSessionRecord` uses `waitMs: 1500` (`OWN_RECORD_CLEAR_WAIT_MS`) and logs any failure to the broker log.
- `state` (and replacer) are now part of the claim comparison.

## Docs
Spec §3.4 has a rev. 18 paragraph appended. CHANGELOG is unchanged.

## Decisions beyond the rulings (flag for review)
1. An unverified stale kill (`kept`) restores the reserved record to its prior claim, nonce-guarded. Otherwise it would stay `replacing` and SessionEnd would keep it for good. This matches the pre-wave-9 "kept" behaviour.
2. A `replacing` record whose endpoint answers: inside the grace → direct transport (null); past the grace → adopted and promoted like `starting`.
3. On win32, a pid-less starting record whose endpoint answers now returns null. The existing test "waits for a starting record's broker instead of replacing it" expects null on win32 (the record is kept). This follows R3 ("identity cannot be obtained on win32"), but it is a behaviour change on Windows CI.
4. The reservation is written from the snapshot (`{ ...existing, ... }`) under a full-claim match, so the non-claim fields are the same.
5. The starter's own identity save (endpoint+pid guard) can briefly move an adopted `ready` record back to `starting` until its ready save. This is harmless because the next adoption promotes it again.

No tests were added for the two minors (hook waitMs/typed catch, broker bounded wait); both are one-line changes.
