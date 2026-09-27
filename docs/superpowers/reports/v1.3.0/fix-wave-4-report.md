# v1.3.0 fix wave 4 — report (base 0b89636)

Commits on `release/v1.3.0` (not pushed):
- `2a3a428` fix(process): pass spawnSync only integer timeouts >= 1 (I1)
- `eef98a7` fix(process): report a linux zombie's command line as <defunct> (I2)

## I1 — non-integer probe timeouts skip the kill

Change:
- `lib/process.mjs` `runCommand`: `timeout: Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : undefined`. This is the root fix. It also covers `tracked-jobs.mjs` 423/435, where `Math.min(IDENTITY_PROBE_MS, remainingMs())` could be 0 (which means unbounded) or negative (which throws).
- `session-lifecycle-hook.mjs`: `Math.floor(...)` at the worker probe (`probeMs`) and at the broker teardown (`stepBudget(IDENTITY_PROBE_MS) / 2`).
- `stop-review-gate-hook.mjs`: this is the plugin's only other `spawnSync` with a timeout. Its env override `CODEX_STOP_REVIEW_TIMEOUT_MS` could be fractional (for example 0.5), so it is clamped the same way. The brief did not ask for this. I added it to satisfy the self-review rule "every spawnSync timeout is an integer >=1 or undefined". It is a one-line change with no dedicated test.

Tests:
- `tests/process.test.mjs` "runCommand clamps a fractional, zero or negative timeout to an integer >= 1". With `timeoutMs: 500.5`, `node -e ""` exits 0. With 0, 0.4 and -5, a 5 s sleeper is killed (`status === null`) in under 4 s.
  - RED: `RangeError [ERR_OUT_OF_RANGE] ... Received 500.5`.
  - GREEN: pass.
- `tests/broker-stale-pid.test.mjs` "session end stops foreground workers on an odd budget". It sets `CODEX_COMPANION_SESSION_END_BUDGET_MS=1001` and uses 6 foreground worker stand-ins. It asserts: exit 0, no `kill-failed`, no `SessionEnd left`, and the state jobs are `[]`. The remaining budget is measured by the wall clock, so a single probe gets an odd half only about 50% of the time. Six workers make the failure all but certain, but not deterministic.
  - RED: failed 2 of 3 runs (`SessionEnd left task-own-odd-c running: kill-failed`, ...).
  - GREEN: passed 5 of 5 runs.
  - The deterministic RED is the unit test above.

## I2 — Linux zombies are never reaped

Change:
- `lib/process.mjs` `processCommandLine` linux branch. When `/proc/<pid>/cmdline` is empty, it reads `/proc/<pid>/stat` through the same `readFileSyncImpl`. It then takes the state character at `lastIndexOf(")") + 2`:
  - `Z` or `X` → `"<defunct>"`.
  - Any other state, or a stat that cannot be read (the outer catch) → `null`.
- No `isZombie` export, since keeping the check inline was clearer. I updated the doc comment.
- None of the consumers can signal on `"<defunct>"`:
  - `workerCommandLine` regex: no match, so `identity-mismatch`.
  - `ownsBrokerProcess`: needs `app-server-broker.mjs`.
  - The reaper's legacy rule: a non-empty string without `codex-companion.mjs` → `markJobDead`. This reconciles the job only; nothing is signalled.

Tests:
- `tests/process.test.mjs` "processCommandLine reports a linux zombie as <defunct> and nothing else". It covers:
  - Empty cmdline with stat Z or X (the `comm` field contains parentheses) → `"<defunct>"`.
  - Stat S or R → null.
  - Stat that throws → null.
  - The existing assertions (`""` → null, throw → null) still pass.
  - RED: `actual: null, expected: '<defunct>'`.
  - GREEN: pass.
- `tests/tracked-jobs.test.mjs` "reapDeadJobs fails a legacy running job whose worker is a zombie". It uses `processCommandLineImpl: () => "<defunct>"` and expects `failed` with the "now belongs to an unrelated process" message. This test passed before the fix, because the reaper rule already existed. It locks in the reaper side; the process test above is the RED for I2.

## Self-review
- spawnSync timeouts: `runCommand` passes either undefined or an integer >= 1. The stop gate passes an integer >= 1. There are no other `spawnSync` calls with a timeout in `plugins/codex/scripts` (checked with `rg`).
- The zombie sentinel is returned only for state Z or X. A live process whose cmdline is empty (for example a kernel thread in state S) returns null.
- Existing fixtures pass (309/309). No leaked processes (count 0 below).
- No CHANGELOG change: both items harden entries already listed.

## Gate (verbatim)
```
$ npm test > /tmp/npm-test-fix4.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix4.log; test "$st" -eq 0
ℹ tests 309
ℹ pass 309
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
Validating marketplace manifest: .../release-v1.3.0/.claude-plugin/marketplace.json
✔ Validation passed
```
