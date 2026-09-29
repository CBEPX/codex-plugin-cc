# Adversarial fix wave 10 — report

Status: DONE. Commit `5bd3bda` on `release/v1.4.1` (pushed; parent 15cae71).
Gate: `npm run check` green, 445 tests / 434 pass / 0 fail / 11 skipped; leak check 0.

## Changes

- **W1 self-registration** — `registerBrokerProcess(cwd, endpoint, pid, pidIdentity, opts)` (broker-lifecycle.mjs) merges `{pid, pidIdentity}` into the record through `writeBrokerSessionIf` (endpoint-guarded; state and other fields untouched; a null probe keeps an existing identity for the same pid). `writeBrokerSessionIf` now accepts `next` as a function of the current record. `app-server-broker.mjs` calls `registerOwnSessionRecord()` in the `server.listen` callback: identity probed before the lock, lock wait bounded by `OWN_RECORD_CLEAR_WAIT_MS` (1.5 s), failure logged. Stale path: a past-grace `replacing` record now gets the same retry window as a `starting` one before settling (previously it only had the 150 ms probe); an answering endpoint always goes to adopt.
- **W2/W3 shared `reserveAndTerminate(claim, terminate, restore)`** (inside `ensureBrokerSessionLocked`): reserve with a full-claim compare → fence under the lock (`sameClaim(current, reserved) && withinGrace(replacingAt)`) → kill outside the lock → clear or restore guarded by `sameClaim(current, reserved)`. Outcomes `changed | fenced | kept | cleared`. Stale path: claim = the record it read, restore = that record. abandonStart: claim = the last record the start wrote (`claimed`: pid-null → pid → identity record), restore = `{...starting, pid: child.pid, pidIdentity}` computed after the kill; `changed` → no kill, one stderr line, `null`. An already-exited child keeps the old path (files + endpoint-guarded clear).
- **W4** — after the readiness wait, `platform === "win32" && !pidIdentity` → one stderr line and `null`; the record stays `starting` with its pid. A later call's adopt promotes it once `record.pidIdentity` (from registration) or the probe gives an identity.
- **W5** — `adoptOrRetry` reads the record and probes outside the lock, then `writeBrokerSessionIf(sameClaim(current))` for the ready save; a failed compare → `retryClaim`. Behaviour otherwise the same as the wave-9 `adopt`.
- Clock seam `options.nowImpl` (`startedAt`, `replacingAt`, every `withinGrace`).
- `clearBrokerSessionIfNonce` was removed (no callers left). Its unit test now covers `registerBrokerProcess` (endpoint guard, state kept).
- Docs: spec §3.4 rev. 19 appended; README «### Windows» gets one sentence; both CHANGELOG copies get one identical line under Changed (`check-changelog` OK).

## Tests (tests/broker-stale-pid.test.mjs)

New tests: the real broker registers pid+identity into a pre-existing pid-null starting record (state and startedAt kept); a past-grace pid-null record whose endpoint answers is adopted, not settled; a promotion during the readiness wait → no kill, ready record intact, `null` (W2); a reservation aged past the grace by an injected clock → kill impl never called, nothing restored (W3); a fresh win32 start with a null probe → `null` and `starting` with pid, still `starting` on a second null probe, promoted on success (W4); no `.ticket` exists during the adopt probe (W5); `registerBrokerProcess` unit.
Adjusted: "refuses a ready save after a replacer reserved" now expects no kill (the other caller owns the teardown). "retries a failed ready-record save once" now uses the real identity probe, because the broker registers its real identity and a stub `x:pid` would read as a changed claim.

## Deviations / concerns

1. The post-kill clear and restore are guarded by the **full reservation** (`sameClaim`, nonce included), not the nonce alone. A broker that binds after a pid-null reservation registers a pid into the `replacing` record. With a nonce-only guard, that record would be cleared or overwritten. With the full guard it is kept. On posix, the no-kill teardown has already unlinked the socket, so the broker's idle timer ends it. On win32 the pipe still answers, so the broker is adopted once the grace has passed. This is a stricter form of the ruled nonce guard.
2. On win32, registration runs `getProcessIdentity(process.pid)` (PowerShell, ≤ 10 s) synchronously in the listen callback. It runs after bind, so readiness probes still connect, but the broker's event loop is blocked for that time. The first request can stall by that much. A future change could make it async.
3. abandonStart compares the full claim, identity included. The starter and the broker must derive the same identity for the same pid (true for the real `getProcessIdentity`). A starter whose own probe differed would refuse its kill and leave the broker `starting` with a record naming it. That is fail-safe, not a leak.
4. Residual: a child that never binds, whose pid save and kept-restore both fail, still sits behind a pid-null record that is settled after the grace. Nothing can register it. It stays open by design (W1 covers bound brokers only).
5. Error handling changed. The failed-start kept-save used to be `try/catch` → log. The reservation now writes before the kill, through the plain helper. A non-lock write error (such as disk full) now throws out of `ensureBrokerSession` and fails the request, with the child alive. It no longer degrades to the direct transport. The wave-9 stale reservation already behaves this way.
6. Test gaps: the `|| replacing` wait branch has no test. That is a past-grace `replacing` record whose broker answers only after the 150 ms probe; the W1 stale test answers inside that probe. The W1 registration test polls for 5 s. `buildEnv` inherits `process.env`, so the PowerShell pass-through variables are present, but a slow Windows runner could still exceed 5 s. Watch Windows CI for that test.

## Follow-up (commit `ad170be`, pushed)

- The W1 ruling was changed. The broker now registers only `pid: process.pid` and runs no identity probe. `registerBrokerProcess(cwd, endpoint, pid, options)` keeps `pidIdentity` when the record already names the same pid, and drops it when the record names another pid. The unit test covers both cases. In the broker test, the pid is now written while `pidIdentity` stays `null`. Spec rev. 19, both CHANGELOG copies and the win32 comment in `ensureBrokerSession` were updated. The identity comes from the starter's probe, or from the next caller's adopt probe, which runs outside the lock. This removes concern 2 above.
- The W1 registration test uses a `waitFor` helper with a 30 s default. It is copied from `tests/runtime.test.mjs`, because `broker-stale-pid.test.mjs` had no such helper.
- Gate: 445 tests / 434 pass / 0 fail / 11 skipped; leak check 0.
