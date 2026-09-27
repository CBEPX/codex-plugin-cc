# Fix Wave 5 Report — broker.json unlink race

## Bug

`clearBrokerSession(cwd)` in `plugins/codex/scripts/lib/broker-lifecycle.mjs` guarded
`fs.unlinkSync(stateFile)` with an `fs.existsSync(stateFile)` pre-check. The check and
the unlink are not atomic: the broker's own SIGTERM handler
(`app-server-broker.mjs` → `clearOwnSessionRecord`, which also calls
`clearBrokerSession`) can delete the same `broker.json` between the check and the
unlink in the SessionEnd hook. When the hook loses that race, `unlinkSync` throws
`ENOENT`, escapes to the hook's top-level catch, and the hook exits 1 — observed once
in the full suite in "setup reuses an existing shared app-server without starting
another one" (`tests/runtime.test.mjs`).

## Fix

- `clearBrokerSession(cwd)`: dropped the `existsSync` pre-check; now
  `try { fs.unlinkSync(stateFile) } catch (error) { if (error?.code !== "ENOENT") throw error; }`.
  No `unlinkImpl` injection was added — the task made it optional and the test in
  section 3(b) does not need it.
- `teardownBrokerSession`: the `pidFile` and `logFile` unlinks got the same
  try/catch-ENOENT treatment (previously bare `existsSync` + `unlinkSync`, so a
  non-ENOENT error there would already have thrown — that is unchanged). The unix
  socket path unlink dropped its `existsSync` guard; it already sat inside a bare
  `catch { /* ignore */ }` that swallowed every error code including ENOENT and
  EPERM, so its behavior for non-ENOENT errors is unchanged too.
  `rmdirSync(sessionDir)` was untouched — it already had its own try/catch ignoring
  non-empty/missing directories.

## Tests added (`tests/broker-stale-pid.test.mjs`)

1. `clearBrokerSession on a workspace with no broker.json returns without throwing`
2. `clearBrokerSession tolerates a broker that already cleared its own record` — saves
   a session, clears it once, then calls `clearBrokerSession` a second time in a row
   (no monkeypatching) and asserts no throw.
3. `teardownBrokerSession tolerates a pidFile, logFile, and sessionDir the broker
   already removed` — `sessionDir` is removed before the call; asserts the return
   value is exactly `{ signalled: false, reason: "no-pid" }`.

**All three passed before the fix too**, and this is expected, not a gap: a sequential
double-call (test 2) can't reproduce the two-process TOCTOU window — the pre-fix
`existsSync` guard already handles "call again after it's already gone." Tests 1 and 3
were flagged by the task as likely pre-existing passes for the same reason (missing
files were already `existsSync`-guarded). Reproducing the actual race would need an
injected `unlinkImpl` to simulate deletion between check and call, which the task
explicitly marked optional; it was not added. The three tests stand as regression
guards on the contract (no-arg-file / repeated-clear / already-removed-teardown
inputs never throw), not as a red/green demonstration of the race itself.

Targeted run before the fix:
```
node --import ./tests/test-env.mjs --test --test-name-pattern "clearBrokerSession|teardownBrokerSession" tests/broker-stale-pid.test.mjs
→ tests 3, pass 3, fail 0   (all green pre-fix, as expected — see above)
```
Targeted run after the fix: same, tests 3 / pass 3 / fail 0.

## Full gate (one run, all green)

Command run:
```
npm test > /tmp/npm-test-fix5.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix5.log; test "$st" -eq 0
```
(An `echo "EXIT_STATUS=$st"` was added after the `rg` line purely to surface the exit
code in the tool output; it does not change what the task's command asserts.)

Result:
```
ℹ tests 312
ℹ pass 312
ℹ fail 0
EXIT_STATUS=0
```
No `not ok` lines. Single run — no rerun was needed.

Follow-up checks, all clean:
- `sleep 10; pgrep -f codex-plugin-test- | wc -l` → `0`
- `npm run build` → `tsc -p tsconfig.app-server.json` completed with no output/errors
- `npm run check-version` → `All version metadata matches 1.3.0.`
- `claude plugin validate . --strict` → `✔ Validation passed`

## Semantics disclosure (non-blocking)

Dropping `existsSync` on `pidFile`/`logFile` changes one corner case:
`fs.existsSync` returns `false` on *any* stat error on the path (e.g. `EACCES` or
`ENOTDIR` on a parent directory), which was silently skipped before. Now such an
error surfaces from `fs.unlinkSync` with a code other than `ENOENT` and propagates
out of `teardownBrokerSession` (→ hook exit 1), whereas before it was silently
skipped by the `existsSync` guard. A direct `EPERM` on the file itself is unchanged
in both old and new code (unlink was always attempted and always threw). This is not
expected to matter in practice — these paths live in a broker-owned tmp session
directory this same process created — but is named here per the "don't change
semantics for other error codes" instruction. Windows handling remains out of scope
(v1.4.0), unchanged.

## Commit

`fix(broker): tolerate a broker that already cleared its own record during teardown`
— single commit, ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
Files: `plugins/codex/scripts/lib/broker-lifecycle.mjs`,
`tests/broker-stale-pid.test.mjs`. No CHANGELOG change made.

## Follow-up: best-effort pid/log cleanup (coordinator request)

The coordinator flagged that `pidFile`/`logFile` unlinks in `teardownBrokerSession`
were still ENOENT-only, while the socket-path unlink right beside them already sits
under a catch-all (and upstream #633/#626 report EPERM on Windows for exactly this
kind of cleanup unlink). Both are best-effort cleanup, not a contract the hook can
fail on, so they now swallow every unlink error:

```js
// Best-effort: a self-cleaning broker or a locked file must not fail the hook.
if (pidFile) {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
    // upstream #633/#626 report EPERM here on Windows).
  }
}
// (same for logFile)
```

`clearBrokerSession` is unchanged — it stays ENOENT-only, since `broker.json` is the
ownership record itself, not a best-effort side file; a non-ENOENT failure to remove
it should still surface.

New test added: `teardownBrokerSession swallows unlink failures on pidFile and
logFile as best-effort cleanup` — `pidFile` points into a directory that does not
exist (ENOENT) and `logFile`'s parent path component is a regular file (ENOTDIR, not
ENOENT), asserting the call returns `{ signalled: false, reason: "no-pid" }` without
throwing.

Targeted run (`--test-name-pattern "teardownBrokerSession|clearBrokerSession"`):
tests 4, pass 4, fail 0 (including the pre-existing three).

Full gate re-run, same five commands, all green on first run:
```
npm test > /tmp/npm-test-fix5b.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix5b.log; test "$st" -eq 0
→ ℹ tests 313 / ℹ pass 313 / ℹ fail 0 / exit 0, no `not ok` lines
sleep 10; pgrep -f codex-plugin-test- | wc -l → 0
npm run build → clean
npm run check-version → All version metadata matches 1.3.0.
claude plugin validate . --strict → ✔ Validation passed
```

Commit: `fix(broker): best-effort pid/log cleanup during teardown` — single commit,
ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Same two files
touched. No CHANGELOG change made.
