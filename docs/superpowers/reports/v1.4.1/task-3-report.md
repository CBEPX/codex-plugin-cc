# Task 3 report: Identity на win32 — batch-проба `getProcessIdentities`

## What was implemented

`plugins/codex/scripts/lib/process.mjs`:
- `WIN32_PROBE_BATCH = 256`, `WIN32_IDENTITY_ROW = /^ID (\d+) (\d+)$/`.
- `identityProbeScript(pids)` — the PowerShell probe: CLM guard (`exit 244`) as the first statement, `foreach (@(Get-Process -Id <a,b,...> -ErrorAction SilentlyContinue))`, `.Handle` pinned before `StartTime.ToFileTimeUtc()` is read, `Write-Output ('ID {0} {1}' -f ...)`.
- `export function getProcessIdentities(pids, options = {})` → `Map<number, string|null>`: dedups/validates pids through `isWin32Pid`, posix path loops `getProcessIdentity` per pid unchanged, win32 path sends the first 256 valid pids in one `runPowerShell` call and validates the whole answer — every line must be an `ID <pid> <filetime>` row for a pid actually sent, each pid at most once; one foreign line, one duplicate, or one out-of-batch pid voids the entire answer to `null` (fail-closed; no partial trust).
- `getProcessIdentity`'s win32 branch now delegates to `getProcessIdentities([pid], options).get(pid) ?? null`, keeping the pre-existing own-pid cache (checked/set inside the branch, mirroring the branch's own early return). The `// ponytail: CIM (CreationDate) identity lands in v1.4.0` comment is gone — this is that work.

`tests/process.test.mjs`:
- Added `getProcessIdentities` to the import list; added `spawn`, `fileURLToPath`, `pathToFileURL`, and `run` (from `./helpers.mjs`) for the win32-only sentinel test; added `ROOT`, `TEST_ENV_URL`, `PROCESS_MJS_URL` constants (helpers.mjs does not export `ROOT`, per the brief).
- Removed the stale `assert.equal(getProcessIdentity(42, { platform: "win32" }), null);` line from the existing "parses linux /proc stat and darwin ps output" test — win32 is no longer a trivial `null` and is now covered by dedicated inject-based tests below.
- Added the five brief tests verbatim (batch probe + script shape, whole-answer rejection on junk/duplicate/out-of-batch, 256-cap with no breaker trip, `getProcessIdentity` null cases, posix equivalence).
- Added one additional win32-only sentinel test (`{ skip: !IS_WIN, timeout: 60_000 }`) proving the real behaviour across two independent fresh node processes: each fresh process reports its own identity identically via `getProcessIdentities` and `getProcessIdentity` (`/^win32:\d+$/`), and both fresh processes report the *same* identity for one live child process, which differs from each fresh process's own identity. This is a deliberate extension of the brief's two-value script (own identity via batch vs. single) to a three-value script (own via batch, own via single, child via single) — the third value is the only way to compare one process's identity as read from two independent observers, which the brief's prose asks for ("its identity from two fresh processes matches and differs from their own").

## TDD evidence

RED — before implementing, running the new tests failed at module load (file-level `SyntaxError`, since the whole test file fails to parse when an import is missing — this is the expected RED for a not-yet-exported function):
```
$ node --import ./tests/test-env.mjs --test --test-name-pattern="getProcessIdentit" tests/process.test.mjs
file:///.../tests/process.test.mjs:12
  getProcessIdentities,
  ^^^^^^^^^^^^^^^^^^^^
SyntaxError: The requested module '../plugins/codex/scripts/lib/process.mjs' does not provide an export named 'getProcessIdentities'
✖ tests/process.test.mjs (27.856083ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

GREEN — after implementing `getProcessIdentities` and the win32 branch of `getProcessIdentity`:
```
$ node --import ./tests/test-env.mjs --test --test-name-pattern="getProcessIdentit" tests/process.test.mjs
✔ getProcessIdentity is stable for the same process and differs for another one (109.296ms)
✔ getProcessIdentity parses linux /proc stat and darwin ps output (0.255625ms)
✔ getProcessIdentity pins the darwin ps locale and keeps a comm path with spaces whole (0.173291ms)
✔ getProcessIdentities on win32 probes every pid in one PowerShell run and parses only protocol rows (0.748291ms)
✔ getProcessIdentities rejects the whole answer on a foreign line, a duplicate pid or an unrequested pid (0.736333ms)
✔ getProcessIdentities caps a batch at 256 Int32 pids and never marks the launcher unavailable for size (0.305292ms)
✔ getProcessIdentity on win32 is null on junk output, timeout, exit 244, a spent budget or an invalid pid (0.710458ms)
✔ getProcessIdentities on posix equals the per-pid probe (0.095667ms)
﹣ getProcessIdentity and getProcessIdentities agree on a live win32 process across fresh processes (0.098875ms) # SKIP
ℹ tests 9
ℹ pass 8
ℹ fail 0
ℹ skipped 1
```
(The win32 sentinel test correctly skips on this macOS host via `IS_WIN`.)

Full `tests/process.test.mjs` after implementation: 37 pass, 2 skip (the pre-existing `.cmd` shim test and the new win32 sentinel), 0 fail.

ESLint on both changed files: clean (`npx eslint plugins/codex/scripts/lib/process.mjs tests/process.test.mjs` — no output).

## Gate

Pre-flight baseline (`npm run check` before any edit, confirming a clean starting point): exit 0.

Gate command actually run, chained only with `&&` on exit codes, in a single call:
```
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/process.mjs tests/process.test.mjs && git commit -F <msg-file> && git status --short && git log -1 --format='%H %s'
```
Result: `npm test` reported `tests 375 / pass 373 / fail 0 / skipped 2`; `npm run check` (check-version, check:changelog, lint, build, typecheck:tests, test) exited 0; the `pgrep -f codex-plugin-test-` count was 0; the commit and status/log steps ran. **Exit code: 0.**

Commit created: `1b483f0352521e9174862d6e4abddaea0a8b8dfc` — `feat(process): Windows process identity from the process start time, batched per probe`.

Pushed: `git push origin release/v1.4.1` → `1fa1c2c..1b483f0  release/v1.4.1 -> release/v1.4.1`.

## Files changed

- `<repo>/plugins/codex/scripts/lib/process.mjs` (+66/-4: `identityProbeScript`, `getProcessIdentities`, win32 branch of `getProcessIdentity`)
- `<repo>/tests/process.test.mjs` (+112/-2: imports, removed stale assertion, five brief tests, one additional win32 sentinel test)

## Self-review findings

- Completeness: every interface the brief lists is present with the exact name/signature — `getProcessIdentities(pids, options)` → `Map`, `identityProbeScript(pids)`, the delegating win32 branch of `getProcessIdentity`. All five brief test blocks are present verbatim; `psBase` was reused from Task 2's tests, not redefined. The ponytail comment is removed.
- Quality/discipline: no new abstractions beyond what the brief specifies; `WIN32_PROBE_BATCH`/`WIN32_IDENTITY_ROW` sit next to the function that uses them, mirroring the existing file's style (constants declared just above their consumer). No changes outside the two listed files.
- Testing: RED confirmed before GREEN; full file and full gate both green; the added win32 sentinel test is a real behavioural check (two independent fresh node processes), not a rerun of a mocked path — it will only execute on an actual Windows runner.
- I hardened the win32 sentinel test beyond the brief's literal snippet after a second-opinion review (see Concerns): the child process now uses `setInterval` + `stdio: "ignore"` instead of a one-shot `setTimeout`, and each `run()` call gets an explicit `timeout: 30_000`, to remove a plausible flake source (six cold PowerShell starts racing a child that could exit on its own) on hosted Windows CI. This is a strengthening of the test, not a behavioural change to production code.

## Concerns

1. **Expected, plan-acknowledged Windows CI gap between Task 3 and Task 5.** `tests/tracked-jobs.test.mjs:490` currently reads:
   ```js
   assert.equal(running.pidIdentity, process.platform === "win32" ? null : getProcessIdentity(process.pid));
   ```
   `tracked-jobs.mjs:183` calls `getProcessIdentity(process.pid)` unconditionally when recording a job's pid. Before this task, on a real win32 host `getProcessIdentity` always returned `null`, so both sides of that assertion were `null`. After this task, on a real win32 host `getProcessIdentity(process.pid)` returns a real `win32:<filetime>` string (there is no injected fake in that test — it runs the real launcher), while the assertion still special-cases win32 to expect `null`. **This specific line will fail on an actual Windows CI runner** until it lands. This is not an oversight: `task-5-brief.md:10` explicitly assigns this exact file/line as a Task 5 modification target (`на win32 ожидать ^win32:\d+$ ... вместо null`), and the plan's pre-flight conflict scan already anticipates `getProcessIdentities` feeding Task 5's reaper. I did not touch it, since it is explicitly Task 5's file/line and doing so risks a merge conflict with that task's own edit. Flagging so the controller sequences/gates Windows CI runs accordingly (e.g. does not expect a green Windows job until Task 5 lands).
2. I could not run the win32-only tests myself (macOS host); they are proven by injected fakes in the other four tests, and the fifth (sentinel) test will only execute for real on Windows CI, per the same pattern used by Task 2's report.
3. No consumers other than `tracked-jobs.test.mjs` above call `getProcessIdentity`/`terminateRecordedProcess` with `platform: "win32"` and a real (non-injected) code path — checked via `rg -n 'platform: "win32"' tests/` — so no other latent breakage from making the win32 branch live.

## Follow-up: controller ruling — move the Task 5 `tracked-jobs.test.mjs:490` fix into Task 3

The controller ruled that concern 1 above (`tests/tracked-jobs.test.mjs:490`) moves from Task 5 into Task 3, because the session pauses after Task 3 and Windows CI must stay green in the meantime.

### What changed

`tests/tracked-jobs.test.mjs`, test "runTrackedJob records the worker identity and clears it with the pid" (~line 489-494): replaced the win32-special-cased assertion with the platform-uniform one the plan's Task 5 Files line describes — the recorded identity always equals `getProcessIdentity(process.pid)` of the same process, and on win32 it additionally matches `/^win32:\d+$/`:

```js
  assert.equal(running.pid, process.pid);
  const ownIdentity = getProcessIdentity(process.pid);
  assert.equal(running.pidIdentity, ownIdentity);
  if (process.platform === "win32") {
    assert.match(String(running.pidIdentity), /^win32:\d+$/, "a Windows worker records its start-time identity");
  }
```

`getProcessIdentity` was already imported in this file (used elsewhere for `reapDeadJobs` fakes), so no import change was needed. Rest of the test is untouched.

### Covering test

```
$ node --import ./tests/test-env.mjs --test --test-name-pattern="records the worker identity" tests/tracked-jobs.test.mjs
✔ runTrackedJob records the worker identity and clears it with the pid (346.787125ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```
Passes on this macOS host (the `if (process.platform === "win32")` branch is inert here; the equality assertion runs on every platform).

ESLint on the changed file: clean (`npx eslint tests/tracked-jobs.test.mjs` — no output).

### Gate

Same chained gate as before, in one call:
```
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add tests/tracked-jobs.test.mjs && git commit -F <msg-file> && git status --short && git log -1 --format='%H %s'
```
`npm test`: `tests 375 / pass 373 / fail 0 / skipped 2`. **Exit code: 0.**

Commit: `10e204af9e32a8cf014d2de10ff3deb59b477251` — `test(tracked-jobs): a Windows worker records its start-time identity`.

Pushed: `git push origin release/v1.4.1` → `1b483f0..10e204a  release/v1.4.1 -> release/v1.4.1`.

## Fix round 1 (2026-09-29)

Root cause: powerShellEnvironment hid LOCALAPPDATA and PSModuleAnalysisCachePath, so every PowerShell 5.1 launch re-analysed modules (22-33 s cold vs 0.3 s warm on the Windows runner); the 10 s identity probe timed out.

Changed: `powerShellEnvironment` now passes through LOCALAPPDATA and PSModuleAnalysisCachePath only when strings and `path.win32.isAbsolute`; otherwise the keys are absent. Other keys unchanged. Diagnostics removed (`git rm .github/workflows/diag-probe.yml`, `.superpowers/.../diag/probe-diag.mjs`).

RED: new test "powerShellEnvironment passes through only absolute LOCALAPPDATA and PSModuleAnalysisCachePath" with impl reverted: `node --test --test-name-pattern=powerShellEnvironment tests/process.test.mjs` failed (actual undefined, expected 'C:\\Users\\x\\AppData\\Local').
GREEN: same command with impl: 2 pass, 0 fail.
Gate: `npm run check && sleep 10 && [ pgrep count = 0 ] && git add ... && git commit` exit 0; check: 376 tests, 374 pass, 0 fail, 2 skipped.
Files: plugins/codex/scripts/lib/process.mjs, tests/process.test.mjs, deleted diag-probe.yml and probe-diag.mjs. Pushed to origin release/v1.4.1.
