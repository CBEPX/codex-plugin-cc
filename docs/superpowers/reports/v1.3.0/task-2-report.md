# Task 2 report: turn/start without turn.id does not hang capture (#781)

Status: DONE. Commit 73509cc `fix(runtime): gate turn notification buffering on turn start, not on turn id`.

## Implemented
- `plugins/codex/scripts/lib/codex.mjs`: `started: false` in `createTurnCaptureState` (and `started: boolean` in the `TurnCaptureState` typedef); the notification handler in `captureTurn` buffers on `!state.started` instead of `!state.turnId`; `state.started = true` is set after the response is processed and before the buffered notifications are replayed. The Task 1 `case "error"` branch was not touched.
- `tests/fake-codex-fixture.mjs`: `turn-start-without-id` behavior. The `turn/start` response returns `{ status: "inProgress", items: [] }`. The Task 1 blocks after that line are intact.
- `tests/runtime.test.mjs`: test "task completes when the turn/start response carries no turn id (#781)", verbatim from the brief.

## TDD evidence
RED: `node --import ./tests/test-env.mjs --test --test-name-pattern "#781" tests/runtime.test.mjs`
-> failed at `assert.equal(result.error, undefined, "must not hang")` with actual `Error: spawnSync node ETIMEDOUT`. This was expected: with no turnId the handler buffered every notification forever, so `turn/completed` was never applied.

GREEN: same command -> `ℹ tests 1 / ℹ pass 1 / ℹ fail 0`.

## Gate
- `npm test` -> `ℹ tests 246 / ℹ pass 246 / ℹ fail 0`, exit 0 (245 base + 1).
- `sleep 10; pgrep -f codex-plugin-test- | wc -l` -> 0.
- `npm run build` -> exit 0.

## Self-review
- Edge case: a response with `turn.status !== "inProgress"` and no id still takes the existing `completeTurn(state, response.turn)` path, unchanged. `started` only gates buffering.
- Routing: while `threadTurnIds` has no entry for the root thread, `belongsToTurn` accepts any turnId, so live and replayed `turn/started`/`turn/completed` reach the capture. Once `turn/started` arrives, `applyTurnNotification` records the real id.
- Diff is minimal: 5 lines in codex.mjs, 1 in the fixture, 11 in the test.

## Concerns
None.
