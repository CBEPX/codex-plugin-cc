# Fix wave 6: buffered thread/started replay

Commit: d966259 `fix(runtime): replay buffered thread/started like the live handler so subagent labels survive` (release/v1.3.0, not pushed).

## Change
- `plugins/codex/scripts/lib/codex.mjs` `captureTurn`: new local `routeNotification(message)`. It applies `thread/started` / `thread/name/updated` unconditionally, otherwise applies the message if `belongsToTurn` and forwards it to `previousHandler` if not. The live handler (after `state.started`) and the buffered replay loop both call it. `case "error"` was not touched.
- `tests/fake-codex-fixture.mjs`: `FAKE_CODEX_SUBAGENT_EARLY_STARTED=1` knob. For `with-subagent`, it creates the sub-thread and sends its `thread/started` before the `turn/start` response line, so the message is always buffered. The later block reuses that sub-thread and does not send `thread/started` a second time.
- `tests/runtime.test.mjs`: new test "task keeps the subagent label when thread/started arrives before the turn/start response" asserts `Starting subagent design-challenger via collaboration tool: wait.` and `Subagent design-challenger:`.
- CHANGELOG.md + plugins/codex/CHANGELOG.md (identical), 1.3.0 Fixed: "Subagent labels no longer depend on notification timing: buffered `thread/started` notifications are applied on replay."

## RED (before the fix, 3/3 runs)
```
ℹ pass 0
ℹ fail 1
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Starting subagent design-challenger via collaboration tool: wait\./. Input:
    '[...] Starting subagent thr_2 via collaboration tool: wait.\n' +
```
(All three runs gave the same result.)

## GREEN (after the fix, 3/3 runs)
```
ℹ pass 1
ℹ fail 0
```

## Original flaky test, 10 runs after the fix
Command: `for i in $(seq 1 10); do node --import ./tests/test-env.mjs --test --test-name-pattern "subagent prefix" tests/runtime.test.mjs 2>&1 | rg -e "ℹ fail"; done`
```
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
ℹ fail 0
```

## Gate (verbatim)
`npm test > /tmp/npm-test-fix6.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix6.log; test "$st" -eq 0`
```
ℹ tests 314
ℹ pass 314
ℹ fail 0
exit=0
```
`sleep 10; pgrep -f codex-plugin-test- | wc -l` → `0`
`npm run build` → `tsc -p tsconfig.app-server.json` with no errors
`npm run check-version` → `All version metadata matches 1.3.0.`
`claude plugin validate . --strict` → `✔ Validation passed`

## Concerns
None. Order within the buffer is preserved. A buffered `thread/started` for an unrelated thread is now applied to this turn's state and no longer forwarded to `previousHandler`. The live handler already did this, so the behaviour is the same as before for live messages.
