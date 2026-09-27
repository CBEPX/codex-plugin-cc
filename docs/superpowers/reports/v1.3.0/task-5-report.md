# Task 5 report — stop-review gate

Status: DONE_WITH_CONCERNS (minor deviations from the brief, listed below)
Commit: cac1b2b feat(stop-gate): pin model/effort, bound rounds by default, name signal and escape hatch; drop hooks.json description

## Implemented
- `codex-companion.mjs`: `setup --review-gate-model <model|inherit> --review-gate-effort <effort|inherit>` (brief code verbatim; aliases via `normalizeRequestedModel`, effort via `normalizeReasoningEffort`, invalid effort -> exit 1 with the usual message); `buildSetupReport` returns `reviewGateModel`/`reviewGateEffort`; `printUsage` updated.
- `lib/render.mjs`: `- review gate model/effort: <model|inherit> / <effort|inherit>` under the review-gate line.
- `commands/setup.md`: extended `argument-hint`; flags already pass through `--args-stdin` (checked manually: `sol`/`high` stored and rendered).
- `stop-review-gate-hook.mjs`: `DEFAULT_MAX_ROUNDS = 3` (unset/invalid -> 3, explicit `0` -> unbounded); `runStopReview(cwd, input, config)` appends `--model`/`--effort` from config; new `result.signal` branch; every review-failure reason (timeout, signal, non-zero exit with or without detail, invalid JSON, empty output, unexpected answer) ends with `Disable with /codex:setup --disable-review-gate.`
- `hooks.json`: top-level `description` removed (#459).
- README: model/effort pinning, default of 3 rounds, `CODEX_REVIEW_GATE_MAX_ROUNDS=0` = unbounded, escape-hatch text.

## Deviations from the brief
1. Timeout constant. The brief's `STOP_REVIEW_TIMEOUT_MS = env ? … : …` line and `(ms/60000).toFixed(1)` message would break the existing test "stop gate script timeout is shorter…" (it asserts the literal `const STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_TIMEOUT_MINUTES * 60 * 1000;` and `${STOP_REVIEW_TIMEOUT_MINUTES} minutes`). I kept both unchanged and added a separate test-only `STOP_REVIEW_TIMEOUT_OVERRIDE_MS` from `CODEX_STOP_REVIEW_TIMEOUT_MS`.
2. Timeout message. With an 800 ms override, `toFixed(1)` would print "0.0 minutes", and the ETIMEDOUT branch runs before the signal branch, so the brief's code would not match the brief's own regex. The timeout reason is now `timed out after <13 minutes | N ms> and was terminated by signal SIGKILL. Run /codex:review --wait manually. Disable with …`. The new test matches through its `terminated by signal SIGKILL` alternative.
3. The existing `setup command can offer Codex install…` test pinned the old `argument-hint` exactly. I updated its regex to the new hint.

## Tests / TDD evidence
RED: `node --import ./tests/test-env.mjs --test --test-name-pattern "stop gate|stop hook|hooks keep" tests/runtime.test.mjs tests/commands.test.mjs` -> tests 11, pass 7, fail 4 (description present; setup exit 1 on unknown flag; decisions `[block,block,block,block]`; reason was the BLOCK finding, not a timeout/signal).
GREEN: same pattern plus "setup command" -> 12/12 pass after the argument-hint regex update.
Full gate: `npm test` -> tests 256, pass 256, fail 0 (253 + 3 new); `sleep 10; pgrep -f codex-plugin-test- | wc -l` -> 0 (the SIGKILLed 60 s fake turn does not linger: the broker's 5 s idle timeout reaps it); `npm run build` -> exit 0.

## Files changed
README.md, plugins/codex/commands/setup.md, plugins/codex/hooks/hooks.json, plugins/codex/scripts/codex-companion.mjs, plugins/codex/scripts/lib/render.mjs, plugins/codex/scripts/stop-review-gate-hook.mjs, tests/commands.test.mjs, tests/runtime.test.mjs

## Self-review
- All six failure paths carry the escape hatch. Two reasons do not: a Codex `BLOCK:` finding, which is a real review result rather than a gate failure, and "could not parse hook input". Neither is on the brief's list.
- The model/effort values survive `setup --json` round trips, and `inherit` clears to null (both tested). A `setup` without the flags leaves the stored values untouched.
- An explicit `CODEX_REVIEW_GATE_MAX_ROUNDS=0` keeps the `maxRounds > 0` guard, so the gate stays unbounded. No dedicated test covers this.

## Concerns
- The deviations above (timeout wording/override, argument-hint test regex) — controller may want to confirm.
- No test covers explicit `CODEX_REVIEW_GATE_MAX_ROUNDS=0`. The code path is unchanged from before.
