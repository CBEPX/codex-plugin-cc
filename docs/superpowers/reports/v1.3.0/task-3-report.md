# Task 3 report: bounded broker connects (#773), honest `status --wait` (#774)

Commit: e06cadb fix(broker): bound hung connects; status --wait exits 1 on timeout

## Implemented (per brief, verbatim logic)
- `lib/broker-lifecycle.mjs`: `waitForBrokerEndpoint(endpoint, timeoutMs = 2000, options = {})` with optional `options.connectImpl` (default `net.createConnection`). Each attempt bounded by `min(500, remaining)` ms; on expiry the socket is destroyed and the attempt resolves false. A `settled` guard + `clearTimeout` in `finish` clears the timer on connect/close/error. Existing phantom-client comment kept. `sendBrokerShutdown`/`connectToEndpoint` untouched. Two-arg callers (Task 4) still work.
- `lib/app-server.mjs`: `BrokerCodexAppServerClient` exported; `initialize()` takes `options.connectImpl` and `options.connectTimeoutMs` (default 2000); timer rejects with `Error` `code: "ETIMEDOUT"` and destroys the socket; cleared on `connect` and `error`. `data`/`close` handlers unchanged.
- `lib/codex.mjs` `withAppServer`: `ETIMEDOUT` added to the direct-retry codes, still gated on `brokerRequested`.
- `codex-companion.mjs` `handleStatus`: on `snapshot.waitTimedOut`, text output appends `Timed out after <N>s while the job was still running.` (N = max(1, round(timeoutMs/1000))), `process.exitCode = 1`. JSON snapshot unchanged.
- README `/codex:status` section: one paragraph documenting `status <id> --wait` exit 1 on timeout (incl. `--json`).

## Tests
- New: `tests/broker-stale-pid.test.mjs` (#773 hung probe), `tests/app-server.test.mjs` (ETIMEDOUT), `tests/runtime.test.mjs` (#774; waits for the job via `result --wait` so no worker is left).
- Changed: existing `status --wait times out cleanly when a job is still active` (runtime.test.mjs) asserted exit 0 for `--json`; the brief's code sets exit 1 in both modes, so the assertion is now `1` with a comment. Payload assertions unchanged.

## TDD evidence
RED: `node --import ./tests/test-env.mjs --test --test-name-pattern "#773|ETIMEDOUT|#774" tests/broker-stale-pid.test.mjs tests/app-server.test.mjs tests/runtime.test.mjs`
→ tests 3, pass 0, fail 3: #773 `destroyed >= 1` false (connectImpl ignored, no attempt timeout); app-server first failed on missing export, after exporting the class it failed with `Error: connect ENOENT /nonexistent.sock` instead of ETIMEDOUT (connectImpl ignored); #774 exit 0 instead of 1. All expected.
GREEN: same command → tests 3, pass 3, fail 0 (ETIMEDOUT 202 ms, #773 652 ms, #774 5.5 s).

## Gate
`npm test` → ℹ tests 249, pass 249, fail 0 (246 base + 3); `pgrep -f codex-plugin-test- | wc -l` after 10 s → 0; `npm run build` → exit 0.

## Self-review
- Probe timers cleared on every settle path; broker client timer cleared on connect/error. If a socket closed before connect without error (does not happen with net sockets), the timer would still fire and reject — acceptable, not a hang.
- ETIMEDOUT retry only when a broker was requested.
- No `rg`-banned tools, no `git add -A`, no push.

## Concerns
- Behavior change: `status <id> --wait --json` now exits 1 on timeout (brief's code, unconditional). Updated the one pre-existing test that asserted 0. No internal skill/command consumes that exit code (checked with rg). If JSON mode should keep exit 0, move `process.exitCode = 1` under `!options.json` and revert that assertion.
