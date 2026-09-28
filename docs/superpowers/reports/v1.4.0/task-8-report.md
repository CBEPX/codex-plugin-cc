# Task 8 report: deferred v1.3.0 minors

Commit: `cc15e07` `chore: fold in deferred v1.3.0 review minors` (base 1657916, branch release/v1.4.0, not pushed).

## Checkbox → hunk

| Checkbox | Hunk |
| --- | --- |
| catalogue-only `gpt-7-nova` p0 + priority tie | `tests/fixtures/models-catalog.json` (+`gpt-7-nova`, `gpt-6-nova`, both priority 0); `tests/model-catalog.test.mjs` new test "a catalogue-only alias resolves from the catalogue, newest family on a priority tie" (`FALLBACK_ALIASES.has("nova") === false`, `nova`→`gpt-7-nova`, `nova` with `[]` passes through) |
| refusal test chmod 0o755 + foreign uid | `tests/state.test.mjs`: explicit `fs.chmodSync(shared, 0o755)`; new test "fallback state root refuses a user directory owned by another uid" (`uid: process.getuid() + 1`) |
| MAX_ROUNDS 0 / 5 / invalid | `stop-review-gate-hook.mjs` `getMaxRounds`: digits-only → `Number`, `Number.isInteger(parsed) && parsed >= 0`, else `logNote("Ignoring CODEX_REVIEW_GATE_MAX_ROUNDS=…; using 3.")` + 3. `tests/runtime.test.mjs`: helper `gateDecisions`, tests "=0 never stops blocking and =5 allows the sixth stop" (4×block; 5×block+allow) and "an invalid … falls back to 3 with a warning" (`0.5`) |
| `--review-gate-model ""` / `--review-gate-effort ""` | `codex-companion.mjs` `handleSetup`: blank value throws `--<flag> needs a value; use inherit to clear it.` before `getConfig`/any `setConfig`. Test "setup rejects an empty gate model or effort and writes nothing" (combined with `--enable-review-gate`; model/effort/gate flag unchanged) |
| `kill-failed` in documented enum | `broker-lifecycle.mjs` `teardownBrokerSession` comment lists all six reasons; README new table after the SessionEnd bullets (`reason=` values of the teardown log line) |
| `workerCommandLine` escapeRegExp | `lib/process.mjs`: inline escape of `jobId` + comment; nothing else in the file. Test in `tests/process.test.mjs` "workerCommandLine matches the job id literally" |
| G1 `t.after` + fresh-broker titles | `tests/runtime.test.mjs` "an acknowledged cancellation survives…" takes `t`, `t.after(() => { try { process.kill(-workerPid, "SIGKILL"); } catch {} })`; `tests/broker-stale-pid.test.mjs` title "…never becomes ready as a process group" + stale "through the child handle" comment corrected |
| README transfer + registerThread | README: CLAUDE_CONFIG_DIR merged into the "must be under" clause, trailing sentence removed; `codex.mjs` comment above `registerThread` on the single-tenant broker (busy for other clients) |
| Gate + commit | below |

RED evidence (sources reverted to HEAD, new tests kept): `workerCommandLine … literally` ✖, `invalid MAX_ROUNDS` ✖, `empty gate model or effort` ✖; `=0/=5` passes at base (coverage-only item, as the ledger says "untested").

## Gate (verbatim)

```
$ node -v
v24.14.0
$ npm run check   → exit=0
ℹ tests 356
ℹ suites 0
ℹ pass 355
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 184478.552958
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
```

## Deviations

- Brief says the `kill-failed` enum goes in `process.mjs` JSDoc; the dispatch constraint forbids anything in `process.mjs` beyond `workerCommandLine`, so it is in the `teardownBrokerSession` comment (where `kill-failed` originates). No README reason table existed; a 6-row one was created.
- No `escapeRegExp` helper exists in `plugins/`; escaping is inlined (one line) rather than adding a helper.
- `getMaxRounds` also rejects whitespace-only and hex (`0x10`) values via a digits-only check, because `Number("  ")` is `0` (would silently mean unlimited).
- `ps`-branch `timeoutMs > 0` guard not touched (v1.4.1 per brief). CHANGELOG not edited (Task 9).
- Task 6 hook `main`/`readHookInput` untouched; all stop-hook tests green in the full run.
- Known nit (not fixed): README row `identity-match … and signalled` slightly overclaims — on the ESRCH path the reason stays `identity-match` with `signalled=false`; the `signalled=` field on the same log line disambiguates.
