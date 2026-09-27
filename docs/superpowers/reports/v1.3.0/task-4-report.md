# Task 4 report: broker teardown without leaks (#753/#762/#768/#749)

Status: DONE_WITH_CONCERNS (one small deviation in a test, see below)
Commit: 5f4085e on release/v1.3.0

## Implemented (plugins/codex/scripts/lib/broker-lifecycle.mjs)
- Imports `isPidAlive`, `terminateProcessTree` from process.mjs.
- `ownsBrokerProcess` is now exported (body unchanged).
- `teardownBrokerSession` takes a new `ownsProcess` option (default `ownsBrokerProcess`) and uses it for the identity check.
- `ensureBrokerSession` takes new options: `killProcess` (default `terminateProcessTree`), `isAliveImpl` (default `isPidAlive`), `ownsProcessImpl` (default `ownsBrokerProcess`) and `retryTimeoutMs` (default `STALE_BROKER_RETRY_MS` = 2000).
  - If the existing record is not ready and its pid is alive and owned, the probe is retried for `retryTimeoutMs`. If it becomes ready, the existing session is returned without a kill. Otherwise teardown runs with `killProcess` and `ownsProcess: () => true`, because ownership was already checked.
  - If the pid is dead or foreign, teardown runs with `pid: null` and `killProcess: null`. The files are cleaned up and no signal is sent.
  - If a fresh spawn never becomes ready, the new child is killed with the resolved `killProcess`. Before this change the default was `null`, which leaked the broker in production.
- Controller ruling: in `waitForBrokerEndpoint`, the per-attempt timer now calls `finish(connected)`.
- Structural difference from the brief: I wrote the brief's `stillDown` expression as `if (liveOwned) { ready = await waitForBrokerEndpoint(...).catch(() => false); if (ready) return existing; }`. The behavior is the same.

## Tests (tests/broker-stale-pid.test.mjs)
- Added `ensureBrokerSession` to the import.
- Added `waitForBrokerEndpoint reads a connected probe whose close is slow as ready`: a fake socket emits `connect` but never `close`, and the result must be `true` in under 1.5 s.
- Added the three tests from the brief (#753/#762, #749, #768). Tests 1 and 2 match the brief verbatim.
- Deviation in the #768 test: the brief's code waits 300 ms *before* calling `server.listen` and `ensureBrokerSession`. That means the socket is already listening when the first probe runs, so the test would pass with or without the fix. I moved the 300 ms delay to after `ensureBrokerSession` starts, which matches the controller's note that the server listens ~300 ms after the save. I also passed `env: buildEnv(binDir)`, added `once("error", reject)` on listen, and wrote a `finally` that awaits `sessionPromise` and SIGTERMs any spawned broker. Without these, the first RED run leaked a real broker, because the old code's teardown removed the session dir, listen failed with EACCES, and the spawned broker was left alive.

## TDD evidence
RED command: `node --import ./tests/test-env.mjs --test --test-name-pattern "ensureBrokerSession|slow" tests/broker-stale-pid.test.mjs`
- slow-close: actual false, expected true
- #753/#762: `killed` actual [], expected [pid]
- #768: failed (the old code tore down the dir and replaced the broker)
- #749: passed at RED, which is expected because the old teardown already checked ownership
- pass 1 / fail 3; no leftover processes after the hardened test.

GREEN, same command: pass 4 / fail 0; `pgrep -fl codex-plugin-test-` found nothing.

## Full gate
`npm test > /tmp/npm-test-t4.log 2>&1` gave `ℹ tests 253`, `ℹ pass 253`, `ℹ fail 0`, exit 0. Base was 249, plus 4 new tests.
`sleep 10; pgrep -f codex-plugin-test- | wc -l` gave 0. `npm run build` exited 0. The existing SessionEnd tests pass unchanged.

## Self-review
- A pid that is alive but not ours (command line mismatch) makes `ownsProcessImpl` return false, so `liveOwned` is false and there is no signal. This goes through the same code path as a dead pid. Only the dead-pid case has a direct test.
- A live owned broker that answers within the retry window is returned as-is and is not killed (#768 test).
- If a fresh spawn is not ready, the child it spawned is killed with the default `terminateProcessTree`.
- Task 9 injection points are in place: `ownsProcess` (teardown), `isAliveImpl`, `ownsProcessImpl` and `killProcess` (ensure).

## Concerns
- The #768 test differs from the brief's code, for the reasons above.
- `app-server.mjs` now gets `terminateProcessTree` by default through `ensureBrokerSession(cwd, { env })`. This is intended for #753.
