# Task 1 report: terminal turn errors (#698, #757, #775)

Status: DONE_WITH_CONCERNS. Commit: bc77209 `fix(runtime): terminal error notifications, errorMessage on silent turn failure, fileChange guard`

## What I implemented (per the brief)
- `lib/codex.mjs` `applyTurnNotification` `case "error"`: when `willRetry !== true` the turn now ends via `completeTurn(state, { id, status: "failed", error })`. When `willRetry === true` it emits a "(retrying)" progress line and the turn continues. A late `turn/completed` does nothing because `completeTurn` returns early once `state.completed` is set.
- `describeStartedItem` `fileChange`: `item.changes` is now checked with `Array.isArray` before it is read.
- `runAppServerTurn` result: added `turnStatus: turnState.finalTurn?.status ?? null`. I did not add it to the review result.
- `codex-companion.mjs` task result: added `failureMessage` for a non-zero exit. It is `error.message`, then `stderr`, then `Codex turn ended with status "<status>"`. The summary on failure now comes from `failureMessage` instead of `rawOutput`.
- `lib/render.mjs` `pushJobDetails`: for failed jobs with an `errorMessage`, adds the line `  Error: <errorMessage>` under Summary. This follows the controller ruling. I used the same two-space indent as the other detail lines instead of a literal `- Error:`.
- Fixture: added the behaviours `error-notification`, `error-notification-retry`, `file-change-no-changes` and `turn-failed-silently`.

## Deviations from the brief's verbatim text
1. **`tests/helpers.mjs`**: `run()` ignored `options.timeout`, so the brief's `timeout: 15000` did nothing. During the first RED run the #698 test hung until I killed it. I added `timeout: options.timeout` to the spawnSync options.
2. **Fixture text literal**: the fixture source is written inside an outer template literal, so the brief's `"{\n  \"error\"...}"` would have produced invalid generated JS. I replaced it with `JSON.stringify({ error: "quota exhausted" }, null, 2)`. The generated string is the same.
3. **Fixture placement**: `payload` is computed *after* the `send(... buildTurn(turnId) ...)` line, not before it. I put the new branches after the `payload` computation.
4. **#698 test**: with `--json`, progress is not written to stderr and the JSON payload has no error field, so `assert.match(result.stderr, ...)` could never pass. I ran the test without `--json` and it now asserts `status 1`, `result.error === undefined`, stdout matching `/Selected model is at capacity/` and stderr matching `/Codex error: Selected model is at capacity/`. I did not change the JSON schema.
5. **#757 test**: the status report never prints `Status: failed`. The job line is `- <id> | failed | rescue | Codex Task`. I changed the assertion to `/\| failed \|/`.

## TDD evidence
RED (after the timeout fix): `node --import ./tests/test-env.mjs --test --test-name-pattern "#698|will retry|#775|#757" tests/runtime.test.mjs` gave pass 1, fail 3:
- #698: `Error: spawnSync node ETIMEDOUT`. The companion hangs because no turn/completed arrives.
- #775: `TypeError: Cannot read properties of undefined (reading 'length')`.
- #757: the status output contained `Summary: {`.
- The retry test already passed, as expected: it only protects against a regression.

GREEN: the same command gave pass 4, fail 0.

Full gate:
- `npm test`: tests 243, pass 243, fail 0, exit 0.
- `sleep 10; pgrep -f codex-plugin-test- | wc -l`: 0.
- `npm run build`: OK.

## Files changed
- plugins/codex/scripts/lib/codex.mjs
- plugins/codex/scripts/codex-companion.mjs
- plugins/codex/scripts/lib/render.mjs
- tests/fake-codex-fixture.mjs
- tests/helpers.mjs
- tests/runtime.test.mjs

## Self-review / concerns
- **Retry leaves `state.error` set** (brief-verbatim code). After a retried error and a successful turn, `result.error.message` is still populated. The task then succeeds (exit 0) with a non-null `errorMessage` on the job record, and `failureMessage` is passed to `renderTaskResult`. The rendered foreground output is still clean: I ran a probe without `--json` and it printed only the answer. The same stale-error behaviour existed before this change. The fix is one line: set `state.error` only in the terminal branch, or clear it on a completed `turn/completed`. The controller needs to decide.
- **`Error:` line reach**: `pushJobDetails` is also used by the queue/overview renderers (render.mjs ~339/349/359), so failed jobs show the Error line there too. In the #757 case it repeats the Summary text exactly. No existing test broke.
- The commit trailer `Claude Fable 5.1` follows the controller brief. The harness reminder named a different model string.

## Fix report (coordinator rulings 1 and 2)
Commit: a second commit, `fix(runtime): retried errors leave no errorMessage; status prints Error only when it adds information`.

1. **Retried errors**: in `lib/codex.mjs` `case "error"`, `state.error` is now set only on the terminal branch. The `willRetry: true` branch emits progress and breaks. I extended the "will retry" test to check that exit is 0 and that the persisted job has `status: "completed"` and `errorMessage: null` (via `readPersistedJob`).
   - This assertion passed *before* the fix too. `tracked-jobs.mjs` already writes `errorMessage: null` for every non-failed completion, so the stale `state.error` never reached the stored record.
   - The leak was only internal: `failureMessage` was passed to `renderTaskResult`. It would only have become visible for a retried turn that succeeded with an empty `rawOutput`.
   - The new assertion is a regression guard. It could not be made RED end to end.
2. **Error line**: `pushJobDetails` now prints `  Error:` only when the job is failed, its trimmed `errorMessage` is non-empty, and it differs from the trimmed summary. I added a unit test to `tests/render.test.mjs` covering three cases: a duplicate is suppressed, a distinct message is shown, and a completed job never shows the line.
   - RED: `node --import ./tests/test-env.mjs --test --test-name-pattern "prints Error only" tests/render.test.mjs` gave fail 1 ("expected to not match /Error:/"). GREEN: pass 1.
   - The #757 test does not depend on the duplicate. It matches via the Summary line and needed no change.

Covering tests: `node --import ./tests/test-env.mjs --test --test-name-pattern "#698|will retry|#757|status" tests/runtime.test.mjs tests/render.test.mjs` gave tests 15, pass 15, fail 0.

Full gate:
- `npm test`: tests 244, pass 244, fail 0.
- `pgrep`: 0.
- `npm run build`: OK.

## Fix report, review round 1 (a subagent's terminal error failed the main turn)
Commit: `fix(runtime): a subagent's terminal error does not fail the main turn`.

- **`lib/codex.mjs` `case "error"`**: when a terminal error (not retried) arrives on a thread other than the main one, the handler now does what the `turn/completed` branch does for subagents:
  - emits `Subagent <labelForThread> error: <message>`;
  - calls `activeSubagentTurns.delete(threadId)` and `scheduleInferredCompletion(state)`;
  - breaks.

  Only the main thread sets `state.error` and calls `completeTurn`.
- **Deviation**: an error that has *no* `threadId` still counts as terminal for the main turn. The condition is `errorThreadId && errorThreadId !== state.threadId`. A strict mirror would treat a missing id as a subagent error, and the #698 hang would come back.
- **Fixture**: a new behaviour, `subagent-error`, reuses the `with-subagent` flow. Instead of the subagent's `turn/completed` it sends `error` with `{ threadId: subThread.id, turnId: subTurnId, willRetry: false, error: { message: "subagent at capacity" } }`. The main thread then sends its final message and `turn/completed` as usual.
- **Test**: "a subagent's terminal error does not fail the main turn". It checks that `result.error` is undefined, that the exit code is 0, that stderr mentions "subagent at capacity", and that the persisted job has `status: "completed"` and `errorMessage: null`.
  - RED before the fix: `node --import ./tests/test-env.mjs --test --test-name-pattern "subagent's terminal" tests/runtime.test.mjs` gave fail 1 (`actual: 1`, the exit status).
  - GREEN after the fix: pass.

Covering tests: `node --import ./tests/test-env.mjs --test --test-name-pattern "#698|will retry|subagent" tests/runtime.test.mjs` gave tests 7, pass 7, fail 0.

Full gate:
- `npm test`: tests 245, pass 245, fail 0.
- `sleep 10; pgrep -f codex-plugin-test- | wc -l`: 0.
- `npm run build`: OK.
