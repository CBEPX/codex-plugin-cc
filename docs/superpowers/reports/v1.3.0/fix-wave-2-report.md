# v1.3.0 fix wave 2 — report (base 14378ed)

Status: DONE. Commits (release/v1.3.0, not pushed):
- faa5cfb fix(cancel): only acknowledge a delivered kill and keep the cancelled record (G1)
- fe8edf7 fix(broker): kill a fresh unready broker as a process group (G2)
- 85fbc6a fix(reaper): fail a legacy job whose pid now runs an unrelated process (G3)
- 3cf11e1 fix(setup): validate the stored gate effort against a new gate model (G4)
- b20c7b3 docs: v1.3.0 changelog for undelivered cancel and legacy-job reconciliation (both CHANGELOG copies, two bullets under 1.3.0 Fixed)
- 4ccb675 test(cancel): describe the refused-cancel fixture as a foreign companion pid (comment-only; made after the gate run, re-ran that test: pass 1 fail 0)

## G1 — cancel acknowledged an undelivered kill
Change:
- `lib/process.mjs` `terminateProcessTree` posix: any error from `kill(-pid)` (ESRCH = pid leads no group) falls back to `kill(pid, "SIGTERM")`; only ESRCH from that returns `{attempted:true, delivered:false, method:"process"}`. (The previous non-ESRCH fallback is the same path, so the branch collapsed.)
- `codex-companion.mjs` `handleCancel`: pending branch is `pid && (!kill.attempted || !kill.delivered) && isPidAlive(pid) === true`; reason is `kill.reason` when not attempted, else `"not-delivered"`; same text/exit 1/JSON as the refused case.
- `lib/tracked-jobs.mjs` `runTrackedJob`: both terminal writes (success and catch) go through `writeTerminalUnlessCancelled`, which reads the stored record and writes inside one `withStateLock`; a stored `cancelled` is kept and a log line is appended (the worker's "Final output" block still goes to the log only).
Tests:
- tests/process.test.mjs "terminateProcessTree falls back to the pid when it is not a process-group leader" (calls `[[-4242,"SIGTERM"],[4242,"SIGTERM"]]`, delivered, method `process`) and "... reports not delivered only when the pid itself is gone".
- tests/runtime.test.mjs "an acknowledged cancellation survives a worker that finishes after it": real background worker (fake codex, `FAKE_CODEX_TURN_DELAY_MS=3000`); a `NODE_OPTIONS=--import` preload makes only the `task-worker` process ignore SIGTERM, so it outlives the delivered cancel, finishes its interrupted turn and exits; stored status must stay `cancelled`. Without the preload the worker dies on SIGTERM and the test could not go RED.
RED: process tests `ℹ pass 2 / ℹ fail 2` (the 2 new); runtime test `actual: 'failed', expected: 'cancelled'`.
GREEN: `ℹ pass 5 / ℹ fail 0` (both files, pattern); cancel-pattern sweep across all test files `pass 24 fail 0`; tracked-jobs+process `pass 37 fail 0`.
Not covered end-to-end: the pending-on-undelivered branch in `handleCancel` (a live worker whose kill reports `delivered:false` is not practical to force); the brief marks it optional.

## G2 — fresh-broker cleanup left the app-server descendant
Change (`lib/broker-lifecycle.mjs`, unready fresh-broker branch): when `child.exitCode === null && child.signalCode === null` (no await in between), call `killProcess(child.pid)` (default `terminateProcessTree`, group kill of the detached leader); only if it throws or returns `delivered:false` fall back to `child.kill("SIGTERM")`. An exited child is still never signalled. `teardownBrokerSession` now gets no pid/killer (files only) — no numeric kill by stored identity is left on this path.
Tests (tests/broker-stale-pid.test.mjs):
- "ensureBrokerSession kills a fresh broker that never becomes ready": the never-listens script now spawns a descendant (same group) and records its pid; asserts the recording killer got exactly `[child.pid]` and that both the child and the descendant are gone.
- "ensureBrokerSession never signals the pid of a fresh broker that already exited": unchanged, still asserts `killed` is `[]`.
RED: `actual: [], expected: [ 87246 ]`. GREEN: pattern `pass 2 fail 0`; whole file `pass 27 fail 0`.

## G3 — refused legacy cancel could not converge on a recycled pid
Change (`lib/tracked-jobs.mjs` `reapDeadJobs`): when the job has a pid but no identity and platform is not win32, read `processCommandLineImpl(pid, { timeoutMs: min(2000, remaining) })` (default `processCommandLine`); a non-empty string without `codex-companion.mjs` → `markJobDead(..., "worker exited before completing (worker pid N now belongs to an unrelated process)")`. Null/unreadable/throwing → job left alone. Nothing is signalled. New options `processCommandLineImpl`, `platform`.
Tests (tests/tracked-jobs.test.mjs): unrelated daemon → failed with that exact message; companion command line → running; null → running.
RED: `ℹ pass 2 / ℹ fail 1` (`actual: 'running'`). GREEN: file `pass 26 fail 0`.
Ripple (test fixtures only, no product code): fixtures that stood in for a live identity-less worker with a bare `node -e setInterval` command line would now be reaped as unrelated. They were given a companion-shaped command line: tracked-jobs tests "leaves a running job with a live pid untouched" / "never touches a live worker or its request payload" (inject `processCommandLineImpl`), runtime "cancel stops an active background job and marks it cancelled" and "cancel through the no-identity command-line fallback refuses a foreign pid..." (stranger now `codex-companion.mjs task-worker --job-id task-other`: still a companion, not this job's worker, so the refusal path is still exercised), broker-stale-pid "session end keeps the broker while another session's foreground job is running" (`codex-companion.mjs task`).

## G4 — model-only gate update bypassed effort validation
Change (`codex-companion.mjs` `handleSetup`): with `--review-gate-model` given and `--review-gate-effort` absent, the stored `stopReviewGateEffort` is validated via `normalizeReasoningEffort(storedEffort, effectiveModel)` before any `setConfig` (null effort or inherit model → no check). The error names the model's supported efforts. The effort-given case was already validated against the effective model.
Test (tests/runtime.test.mjs) "setup rejects a gate model that cannot run the stored gate effort and writes nothing": `--review-gate-model astra --review-gate-effort ultra`, then `--review-gate-model spark` → non-zero, stderr `not supported by gpt-5.3-codex-spark. gpt-5.3-codex-spark supports: `, stored model still `gpt-6-astra`, effort still `ultra`.
RED: `Expected "actual" to be strictly unequal to: 0` (actual 0). GREEN: pattern `pass 2 fail 0`.
Note (applies to all items): the per-item RED/GREEN pattern runs for G1–G3 were plain `node --test` without `--import ./tests/test-env.mjs`; none of those tests touches the model catalogue, and the final `npm test` (hermetic) is the confirmation. Runtime tests must run with `--import ./tests/test-env.mjs` (as `npm test` does); without it the model catalogue comes from the host `~/.codex/models_cache.json`, which lacks spark, and both gate-effort tests pass/fail by accident.

## Self-review
- Signals without proof — every product caller of `terminateProcessTree` (`rg -n "terminateProcessTree|killProcess\b" plugins/`):
  - `lib/process.mjs:179` `terminateRecordedProcess` default `terminateImpl` — only after identity match or (no identity) command-line match; its callers: `codex-companion.mjs:1337` (cancel), `session-lifecycle-hook.mjs:146` (SessionEnd worker cleanup), `broker-lifecycle.mjs:336` (`teardownBrokerSession`).
  - `broker-lifecycle.mjs:218/246` stale-broker replacement → `teardownBrokerSession` → `terminateRecordedProcess` (only when `liveOwned`).
  - `session-lifecycle-hook.mjs:297` `killProcess: terminateProcessTree` → `teardownBrokerSession` → `terminateRecordedProcess`.
  - `broker-lifecycle.mjs:286` G2: live, unreaped child handle (`exitCode`/`signalCode` null, no await between) — the one allowed exception.
  - `lib/app-server.mjs:291` win32 only, live `this.proc` handle (unchanged).
  G3 never signals.
- G2 topology: `spawnBrokerProcess` spawns with `detached: true` (broker-lifecycle.mjs:133, own group leader); `lib/app-server.mjs:241` spawns `codex app-server` without `detached`, so it stays in the broker's group and the group kill reaches it.
- G1 cancelled-check runs inside `withStateLock`, same lock the cancel write uses.
- G4 validates before any write.
- Test output: no stray lines besides test results; no leaked processes (below).

## Gate (verbatim)
```
$ npm test > /tmp/npm-test-fix2.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix2.log; test "$st" -eq 0
ℹ tests 299
ℹ pass 299
ℹ fail 0
(exit 0)
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
$ npm run build
> @cbepx/codex-plugin-cc@1.3.0 build
> tsc -p tsconfig.app-server.json
(exit 0)
$ npm run check-version
> node scripts/bump-version.mjs --check
All version metadata matches 1.3.0.
$ claude plugin validate . --strict
Validating marketplace manifest: /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.3.0/.claude-plugin/marketplace.json
✔ Validation passed
```
