# Task 1 report: Хвосты v1.4.0 — ps-guard, разбор флейка

## What was implemented

`plugins/codex/scripts/lib/process.mjs`, `processCommandLine` (posix `ps` branch,
originally lines 196–207): added a guard immediately before the `runCommandImpl("ps", …)`
call — a spent `timeoutMs` budget (`≤ 0`, defined) now returns `null` without spawning
`ps`, matching the existing pattern already used in `getProcessIdentity` a few lines
below (`spawnSync` reads a timeout of `0` as "no timeout", which would otherwise turn a
spent budget into an unbounded probe).

```js
  // A spent budget is no probe (spawnSync would read 0 as "no timeout").
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
    return null;
  }
```

Signature of `processCommandLine(pid, { timeoutMs })` is unchanged. The `win32` and
`linux` branches are unaffected — the guard sits only in the posix `ps` branch, after
both of those early returns.

## What was tested and results

New test in `tests/process.test.mjs`, added right after
`processCommandLine asks ps for unlimited width off linux`:

```js
// spawnSync reads a timeout of 0 as "no timeout": a spent budget must be no
// probe at all, not a probe with no bound.
test("processCommandLine treats a spent budget as no probe on the ps branch", () => {
  for (const timeoutMs of [0, -1]) {
    assert.equal(processCommandLine(42, { platform: "darwin", timeoutMs, runCommandImpl: () => assert.fail("must not spawn ps") }), null);
  }
  // A fractional positive budget is clamped by runCommand and still probes; an unset one probes too.
  for (const options of [{ timeoutMs: 0.3 }, {}]) {
    assert.equal(processCommandLine(42, { platform: "darwin", ...options, runCommandImpl: () => ({ status: 0, stdout: "node x\n", stderr: "", error: null }) }), "node x");
  }
});
```

Text is verbatim from the brief's Step 1.

## TDD evidence

**RED** — command:
```
node --import ./tests/test-env.mjs --test --test-name-pattern="spent budget as no probe" tests/process.test.mjs
```
Output (failing, as expected — the guard did not exist yet, so `runCommandImpl` was
called with a spent budget and the injected impl asserted):
```
✖ processCommandLine treats a spent budget as no probe on the ps branch (0.832834ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
✖ failing tests:
test at tests/process.test.mjs:197:1
✖ processCommandLine treats a spent budget as no probe on the ps branch (0.832834ms)
  AssertionError [ERR_ASSERTION]: must not spawn ps
      at runCommandImpl (file:///…/tests/process.test.mjs:199:103)
      at processCommandLine (file:///…/plugins/codex/scripts/lib/process.mjs:197:18)
```
Why expected: before Step 3, `processCommandLine`'s `ps` branch spawned unconditionally
regardless of `timeoutMs`, so the `assert.fail("must not spawn ps")` inside the injected
`runCommandImpl` fired for `timeoutMs: 0` and `timeoutMs: -1`.

**GREEN** — command:
```
node --import ./tests/test-env.mjs --test --test-name-pattern="spent budget as no probe" tests/process.test.mjs
```
Output:
```
✔ processCommandLine treats a spent budget as no probe on the ps branch (0.774458ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Full file — `node --import ./tests/test-env.mjs --test tests/process.test.mjs`:
27 tests, 26 pass, 1 skip (win32-only shim test, skipped on darwin), 0 fail.

## Gate

Command (chained on `&&` exit codes only, per the binding constraint), run twice — once
standalone before staging, once as the final commit chain:

```
npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add plugins/codex/scripts/lib/process.mjs tests/process.test.mjs && git commit -m "…"
```

Both runs: `npm run check` (check-version, check:changelog, lint, build,
typecheck:tests, full `npm test`) → 362 tests, 361 pass, 1 skip, 0 fail. `sleep 10` then
`pgrep -f codex-plugin-test-` → 0 matches both times. **Exit code: 0** on the commit
chain; commit `a7711eb` was created and the branch pushed.

## Step 6: reaper flake loop (investigation only, no code change)

Command (10 iterations, log per iteration under the SDD workspace, not `/tmp`):
```
for i in $(seq 10); do
  node --import ./tests/test-env.mjs --test --test-name-pattern="session end reaps a SIGKILLed background worker" tests/broker-stale-pid.test.mjs \
    > .superpowers/sdd/2026-09-28-codex-plugin-cc-v1.4.1/task-1-reap-$i.log 2>&1 && echo "PASS $i" || echo "FAIL $i"
done
```

Per-iteration result:

| # | Result |
|---|--------|
| 1 | PASS |
| 2 | PASS |
| 3 | PASS |
| 4 | PASS |
| 5 | PASS |
| 6 | PASS |
| 7 | PASS |
| 8 | PASS |
| 9 | PASS |
| 10 | PASS |

**10/10 green locally.** No FAIL, so no "hook said" / "broker log tail" lines to extract.
After the loop, `pgrep -fl 'codex-plugin-tes[t]-'` (bracket-split to avoid the grep
self-match) found nothing — no leaked worker/broker processes from any of the 10 runs.
Logs are kept at `.superpowers/sdd/2026-09-28-codex-plugin-cc-v1.4.1/task-1-reap-1.log`
through `task-1-reap-10.log` (that directory is already `.gitignore`d, so nothing was
staged). Per the brief, no code change was made for this step — the flake's root cause
remains for the controller to decide, outside this release's scope.

## Files changed

- `plugins/codex/scripts/lib/process.mjs` — ps-guard for a spent `timeoutMs` in
  `processCommandLine`.
- `tests/process.test.mjs` — new test for the guard.

(committed as `a7711eb fix(process): ps probe honours a spent budget`, pushed to
`origin/release/v1.4.1`)

## Self-review

- **Completeness:** every brief requirement done — Steps 1–4 (TDD), Step 5 explicitly
  skipped as instructed (leak-step stays with Task 2), Step 6 investigated with no code
  change, Step 7 gate + commit + push. Interface constraint honoured: signature
  unchanged, guard fires only when `timeoutMs` is defined and `≤ 0`.
- **Quality:** the guard's comment and shape are analogous to the existing guard in
  `getProcessIdentity` a few lines below (same file, same "spent budget is no probe"
  intent) — consistent style, no new naming, no new abstraction. Note the two are not
  identical: `getProcessIdentity` defaults an unset `timeoutMs` to `10000` before the
  `> 0` check (so it always probes with *some* bound), while `processCommandLine`
  leaves an unset budget unbounded and probes too — per the brief's Step 1 test
  (`{ timeoutMs: 0.3 }` and `{}` both still probe). Deliberate, brief-specified
  difference, not an inconsistency.
- **Discipline:** YAGNI — nothing touched outside `processCommandLine`'s ps branch and
  its test; no refactor of surrounding code; Step 5 and Step 6 left exactly as scoped
  (no CI/leak-step edits, no reaper-test code changes).
- **Testing:** RED confirmed the test would have caught the bug before the fix; GREEN
  after; full `process.test.mjs` and full `npm run check` both clean; output is
  pristine (no unexpected warnings/errors in the new test's run).

## Concerns

- None blocking. One observation for the record (not a defect): `terminateRecordedProcess`
  forwards its `options` (including a caller's spent `timeoutMs`) into
  `processCommandLine` on the command-line-fallback path (`plugins/codex/scripts/lib/process.mjs:294`).
  With this fix, a spent budget there now yields `commandLine: null` →
  `reason: "identity-mismatch"`, whereas the identity-based path reports
  `"identity-unavailable"` for the same "cannot tell" case. Both paths correctly refuse
  to authorise a kill either way (per the brief's stated interface: `timeoutMs ≤ 0` →
  `null`, no spawn), so behaviour (`signalled: false`) is correct.
  Verified with `rg -n 'identity-mismatch|identity-unavailable' plugins/ tests/`: the
  only two production callers of `processCommandLine` are
  `broker-lifecycle.mjs:325` (`ownsBrokerProcess`) and `process.mjs:294`
  (`terminateRecordedProcess`'s own fallback), and in `broker-lifecycle.mjs`'s
  `teardownBrokerSession` the `reason` value is only returned/interpolated into a
  message (`[codex] SessionEnd left … running: identity-mismatch`) or a JSON `reason`
  field for the CLI/cancel output — no production `if`/`switch`/ternary in the codebase
  branches control flow on the specific string, so no behaviour differs. The only
  visible effect is that a spent-budget refusal on the command-line-fallback path now
  reports as `identity-mismatch` text instead of `identity-unavailable` text in
  user-facing messages/JSON — a wording difference, not a functional one. No action
  taken; flagging for awareness only.
- GitHub reported one pre-existing moderate Dependabot advisory on push (unrelated to
  this change, not investigated — out of scope for this task).
