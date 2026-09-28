# Task 6 report: bounded hook stdin + stop-gate prompt via stdin

Commit: `03151c9` on `release/v1.4.0` (base 75d9684). Step 3 (Codex second pass) skipped as instructed.

## Changes per file

- `plugins/codex/scripts/lib/hook-input.mjs` (new): `readHookInput({ timeoutMs = 2000, maxBytes = 1 MiB, stdin = process.stdin })` → `{ input, error }`. Streams `data` through `StringDecoder("utf8")`, counts bytes; EOF → parse whole input (empty → `{}`, preserving the old behaviour); deadline → accept if the buffer already parses to a JSON object, else `timeout`; bytes > `maxBytes` → stop, `overflow`, no parse; bad JSON / non-object → `invalid-json`. On finish: `clearTimeout`, remove the three listeners, `pause()` + `destroy()`. `CODEX_HOOK_STDIN_TIMEOUT_MS` (>0) overrides the deadline (tests).
- `plugins/codex/scripts/stop-review-gate-hook.mjs`: local sync reader removed; `main` is async and uses `readHookInput()` inside the existing fail-closed block (see table). New `gateEnabledForProject()` reads `stopReviewGate` for `CLAUDE_PROJECT_DIR || process.cwd()` (unreadable config → treated as enabled). Review prompt passed as `task --json [--model] [--effort] --prompt-stdin` with `input: prompt` to `spawnSync`, not argv. Top-level `main().catch(...)` keeps `exitCode = 1` semantics.
- `plugins/codex/scripts/session-lifecycle-hook.mjs`: local sync reader removed; `readHookInput({ timeoutMs: 1000 })`; on any error prints `[codex] <event> hook skipped: <code>: <message>` to stderr and returns without cleanup (no `{}` substitution).
- `plugins/codex/scripts/lib/fs.mjs`: `readStdinIfPiped()` is a `readSync` loop into a 64 KiB buffer, accumulating chunks; `EAGAIN` → `Atomics.wait` 20 ms and retry, up to 50 consecutive (counter resets on a successful read); exhaustion throws `stdin stayed unreadable (EAGAIN); refusing to use a partial input.`; `EOF` error code (Windows pipes) ends the read. Marked with a `ponytail:` comment.
- `tests/hook-input.test.mjs` (new): the six brief cases (a)–(f) via `PassThrough`, plus one `readStdinIfPiped` test (100 ms gaps → whole input; 1500 ms gaps → throws, the exhaust half skipped on win32 where pipes do not EAGAIN).
- `tests/runtime.test.mjs`: `runHookWithOpenStdin` helper (`spawn`, stdin never ended, `t.after` SIGKILL if still alive, wall-clock); tests: gate off + open stdin (empty and complete-JSON-without-EOF) → exit 0, no decision, < 3 s; gate on + open empty stdin → block matching `/hook input did not arrive/`, < 3 s; 300 KB `last_assistant_message` → `fakeState.lastTurnStart.prompt` contains it whole. All with `CODEX_HOOK_STDIN_TIMEOUT_MS=200` and explicit `CLAUDE_PROJECT_DIR`.
- `tests/commands.test.mjs`: "SessionEnd hook timeout stays above…" also extracts `readHookInput({ timeoutMs: N })` from the hook source and asserts `timeout*1000 > budget + N` (15000 > 12000 + 1000).
- `README.md`: one sentence in the review-gate section on the stdin deadlines (1 s SessionEnd before its budget, 2 s Stop) and gate-off/gate-on behaviour. CHANGELOG untouched.

## Stop hook decision table

| Read outcome | Gate state (workspace of CLAUDE_PROJECT_DIR / cwd) | Decision |
|---|---|---|
| EOF + valid JSON object | any | existing gate logic (unchanged) |
| EOF + empty input (`{}`) | any | existing gate logic (unchanged) |
| deadline, buffer already a complete JSON object | any | accepted as success → existing gate logic |
| `invalid-json` (incl. non-object JSON) | any | block, original reason verbatim: "The stop review gate could not read or parse hook input; refusing to fail open." |
| `overflow` | any | block: "…could not read hook input (hook input exceeded 1048576 bytes); refusing to fail open. Disable with /codex:setup --disable-review-gate." |
| `timeout`, 0 bytes | off / unset | allow (no stdout) — #530 |
| `timeout`, 0 bytes | on | block: "…could not read hook input (hook input did not arrive within N ms); refusing to fail open. Disable with …" |
| `timeout`, 0 bytes | config unreadable | block (fail-closed: treated as on) |
| `timeout`, >0 bytes (partial) | any | block: "…(hook input was incomplete after N ms (B bytes))…" |
| stdin `error` event | any | handled as the deadline (same rows as above) |

The `stop_hook_active` guard, round cap and existing reasons are untouched; they run only after a successful read.

## Gate (verbatim)

`npm run check` → exit 0, Node v24.14.0.

```

> @cbepx/codex-plugin-cc@1.3.0 check
> npm run check-version && npm run check:changelog && npm run lint && npm run build && npm run typecheck:tests && npm test


> @cbepx/codex-plugin-cc@1.3.0 check-version
...
✔ runTrackedJob records the worker identity and clears it with the pid (419.234417ms)
ℹ tests 341
ℹ suites 0
ℹ pass 340
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 169174.217667
exit=0
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
```

The `skipped 1` is pre-existing; none of the new tests carries `skip` (only the exhaust half of the EAGAIN test is conditionally not run on win32, inside a passing test).

TDD: before implementation, `stays above`, `#530` and `never arrives` failed (the `#530` one in 72 ms — `readFileSync(0)` threw on the open non-blocking pipe, i.e. the EAGAIN bug itself); the 300 KB test was already green on darwin (macOS ARG_MAX 1 MiB) — it guards Linux (128 KiB per argv string) and Windows (32 KiB command line).

Node ≥18: only `StringDecoder`, timers, `stream.off`, `destroy?.()`, `fs.readSync`, `SharedArrayBuffer` + `Atomics.wait` on the main thread — nothing Node-24-only.

## Deviations

1. `error.bytes` added to the `timeout` error object — the brief's "timeout with empty buffer" rule cannot be evaluated by the caller without it.
2. Gate-off check is falsy `!stopReviewGate` (matches the hook's existing `if (!config.stopReviewGate)`), not strict `=== false`; an unset gate allows on an empty timeout, consistent with the non-timeout path.
3. EAGAIN retries are 50 **consecutive** (reset on each successful read), not 50 total.
4. The read-error path in `session-lifecycle-hook.mjs` applies to SessionStart too (shared `main`), with the same 1 s deadline.
5. EOF with empty input still yields `{}` (existing behaviour) rather than `invalid-json`.
6. A stdin stream `error` is mapped to the deadline outcome, so it surfaces as `timeout`; with the gate on it still blocks (no fail-open).
7. One extra test beyond the brief's list (`readStdinIfPiped` EAGAIN).

## Fix round 1

Changes (each of 1–4 and 7 with a test that failed first):

1. `hook-input.mjs`: a stdin `error` is a fourth outcome, `{ input: null, error: { code: "read-error", message } }`, whatever was buffered (supersedes deviation 6). Test: complete object then `destroy(new Error("EIO"))` → `read-error`.
2. `hook-input.mjs`: the deadline path flushes `decoder.end()` before the completeness check, so a held partial UTF-8 sequence becomes U+FFFD and `{}` + `0xc3` is `timeout`, `bytes: 3`.
3. `stop-review-gate-hook.mjs` `gateEnabledForProject`: reads `resolveStateFile(...)` itself; missing file → off, stored `config.stopReviewGate` falsy → off, any read/parse throw → on. `loadState` unchanged. Test: corrupt `state.json` + open stdin → block naming "hook input did not arrive".
4. `hook-input.mjs` `finish`: after removing `onError`, a no-op `error` listener stays so a failing `destroy()` cannot become an unhandled error. Test: custom `Readable` whose `destroy` calls back with an error.
5. `session-lifecycle-hook.mjs`: `timeoutMs: process.argv[2] === "SessionEnd" ? 1000 : 5000` (supersedes deviation 4's shared 1 s). `tests/commands.test.mjs` regex follows the new expression; the `15 s > 12 s + 1 s` assertion is unchanged.
6. `tests/runtime.test.mjs`: open-stdin tests carry `{ timeout: 30_000 }`; the helper SIGKILLs the child from an unref'd 20 s timer.
7. `stop-review-gate-hook.mjs`: `overflow` with the gate off allows (a disabled gate never blocked); gate on still blocks. Test: 1.1 MiB `last_assistant_message`, gate off → exit 0 and no decision; gate on → block (≈1.6 s, no env override needed).
8. EAGAIN test gap 1500 → 2500 ms; README names the always-blocked case (gate on, host never delivers stdin) and `/codex:setup --disable-review-gate`, and lists the 5 s SessionStart deadline.

Stop-hook decision table ("gate" = `gateEnabledForProject()`; unreadable/corrupt state = on):

| error code | gate | buffer | decision |
|---|---|---|---|
| none (parsed) | any | complete | normal path (gate off → allow; on → review) |
| timeout | off | 0 bytes | allow |
| timeout | on | 0 bytes | block |
| timeout | any | >0 bytes, incomplete | block |
| overflow | off | >1 MiB | allow |
| overflow | on | >1 MiB | block |
| invalid-json | any | complete at EOF | block |
| read-error | any | any | block |

Gate: `npm run check` → exit 0 (346 tests, 345 pass, 1 pre-existing skip); `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0.
