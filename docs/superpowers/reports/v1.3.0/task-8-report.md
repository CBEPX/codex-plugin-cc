# Task 8 report — private fallback state root + broker.json validation

Status: DONE. Commit: aa3209e `fix(state): private per-user, per-plugin fallback state root; validate broker.json before use`.

## Implemented
- `plugins/codex/scripts/lib/state.mjs`: removed `FALLBACK_STATE_ROOT_DIR`; added `fileURLToPath` import, `SCRIPT_ROOT` (= `plugins/codex`), exported `resolveFallbackStateRoot({ env, tmpdir, uid, pluginRoot })` per brief (`<tmpdir>/codex-companion-<uid|user>/<sha256(realpath(pluginRoot))[0:12]>`, `mkdirSync` mode 0o700, posix `statSync` owner/mode check with the exact refusal message; realpath failure keeps the given path). `resolveStateDir` calls it only when `CLAUDE_PLUGIN_DATA` is unset (ternary), so the plugin-data path never touches tmp. Cost: one mkdirSync + one statSync + one realpath.
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`: `describeBrokerRecordProblem` + `loadBrokerSession` validation per brief; returns `null` and writes one `[codex] Ignoring malformed broker.json at <path>: <why>.` line per malformed read.
  - Deviation: `parseBrokerEndpoint` messages already end in `.`; the problem string strips a trailing `.` so the note does not end in `..`.

## Tests
- `tests/state.test.mjs`: the two brief tests (import merged into the existing state.mjs import list).
- `tests/broker-stale-pid.test.mjs`: the brief test, plus stderr capture asserting exactly 4 notes with the expected prefix (keeps suite output clean and checks the once-per-read note).

RED (`node --import ./tests/test-env.mjs --test --test-name-pattern "fallback state root|malformed record" tests/state.test.mjs tests/broker-stale-pid.test.mjs`):
```
SyntaxError: The requested module '../plugins/codex/scripts/lib/state.mjs' does not provide an export named 'resolveFallbackStateRoot'
AssertionError [ERR_ASSERTION]: []   actual: [], expected: null
ℹ pass 0
ℹ fail 2
```
GREEN (same command): `ℹ pass 3 / ℹ fail 0`, no stray stderr.

Full gate: `npm test` → `ℹ tests 266 / ℹ pass 266 / ℹ fail 0`, exit 0 (263 base + 3); `pgrep -f codex-plugin-test- | wc -l` after 10 s → 0; `npm run build` → exit 0.

## Self-review
- World-accessible pre-existing dir refused with the exact message (test). Plugin-data set → fallback not called. realpath failure → given path.
- Existing `saveBrokerSession` callers in tests: all absolute paths / null pid / integer pids; `runtime.test.mjs:2756` writes only `{ endpoint }` — valid (undefined fields pass `!= null`). Full suite green.
- README has no `tmpdir`/`codex-companion` fallback mention; nothing to update.
- `state.mjs` changes confined to header constants, the new function and `resolveStateDir` (Task 9 regions untouched).

## Concerns
- None blocking. On Windows the uid segment is `user` and the mode check is skipped (per brief).

## Fix round 1 — symlinked user dir (TOCTOU)
Commit: see `git log --oneline -1` → `fix(state): refuse a symlinked fallback state root`.
- `resolveFallbackStateRoot`: `fs.statSync` → `fs.lstatSync`; refuses when `!stats.isDirectory()` in addition to the uid/mode checks; same refusal message.
- New test `fallback state root refuses a symlinked user directory` (skip win32): a 0700 directory owned by the user, `<tmp>/codex-companion-<uid>` symlinked to it, expects `/Refusing to use shared state directory/`.

RED: `node --import ./tests/test-env.mjs --test --test-name-pattern "fallback state root" tests/state.test.mjs` → `ℹ pass 2 / ℹ fail 1`, `AssertionError: Missing expected exception.`
GREEN (same command): `ℹ pass 3 / ℹ fail 0`.
Full gate: `npm test` → `ℹ tests 267 / ℹ pass 267 / ℹ fail 0`, exit 0; `pgrep -f codex-plugin-test- | wc -l` after 10 s → 0; `npm run build` → exit 0.
