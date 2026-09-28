# Task 1 report — Windows-обвязка тестов (класс A)

Status: DONE_WITH_CONCERNS (Windows behaviour unverified locally; Step 0 inventory pending from CI)
Commit: 11f6652 `test: make the suite runnable on Windows (LF, explicit runner, env/mode/signal expectations)`
Product code (`plugins/codex/**`) untouched.

## Infrastructure / helper changes
- `.gitattributes`: `* text=auto eol=lf` (repo already LF: `git ls-files --eol` shows 0 `i/crlf`).
- `scripts/run-tests.mjs` (new): readdir `tests/*.test.mjs` (sorted) → `node --import ./tests/test-env.mjs --test <extra args> <files>`; exits with child status. NOTE: extra args are placed **before** the file list (brief said after) — node treats anything after the first file as script argv, so `--test-name-pattern` would be ignored otherwise.
- `package.json`: `test` → `node scripts/run-tests.mjs`; `prebuild` `mkdir -p` → `node -e "require('fs').mkdirSync(...,{recursive:true})"`. Only one test script exists, so no other lists to make explicit.
- `tests/helpers.mjs`: `IS_WIN`, `homeEnv(home)` → `{ HOME, USERPROFILE }`; `run()` default `shell: options.shell ?? false` (explicit `shell: true` still honoured for future `.cmd` targets).
- All `run("node", …)` / `spawn("node", …)` in tests → `process.execPath` (205 run sites + 3 spawn sites; perl, incl. multi-line calls).
- `tests/test-env.mjs`: model catalog path via `fileURLToPath`.
- `tests/commands.test.mjs`: `read(relativePath, root = PLUGIN_ROOT)` normalises `\r\n`→`\n`; all text (md/mjs) reads route through it (JSON reads left as-is).
- `tests/runtime.test.mjs`: transfer tests (4) use `...homeEnv(home)`.
- `tests/broker-endpoint.test.mjs`: unix expectation built from host `path.join`.
- `tests/state.test.mjs` "concurrent writers never leave a torn state.json": writer source written to a temp `writer.mjs`; spawn `error` rejects; asserts exit `{ code: 0, signal: null }`.

## Win32 skips / guards (6 skipped tests + 2 guarded asserts + 1 win32 branch)
Skipped with `{ skip: IS_WIN }`:
1. runtime: "setup is ready without npm when Codex is already installed and authenticated" — node.exe cannot be isolated from npm portably; adding Node dir to PATH brings npm back.
2. app-server: "close() bounds an app-server that ignores SIGTERM" — SIGTERM-immune child not modelled (kill = TerminateProcess).
3. app-server: "close() stays bounded when it is called twice" — same.
4. broker-idle-timeout: "broker exits on SIGTERM even when a client never answers the FIN" — graceful SIGTERM clean exit (code 0) not modelled.
5. broker-idle-timeout: "a second shutdown trigger does not exit before the first has cleaned up" — graceful SIGTERM + `pgrep`.
6. broker-stale-pid: "session end reaps a SIGKILLed background worker instead of keeping its broker alive" — scenario kills the worker's process group via `kill(-pid)` (POSIX-only). The reaping invariant itself is platform-neutral; could be re-enabled on win32 with `kill(pid)` once identity lands (v1.4.1).
Guarded (`if (!IS_WIN)` on the assertion only, rest of the test runs):
- state: "job request payloads are written owner-only…" mode `0o600`.
- runtime: legacy-queued redaction test, payload file mode `0o600`.
Already skipped on win32 before this task (unchanged): state ~533/~688/~864/~870/~877, broker-stale-pid ~98/~857/~1091/~1242/~1271/~1289, runtime cancel/foreign-pid tests.
Classified as neutral and kept: broker-stale-pid "keeps the broker while another session's foreground job is running" (kill(-pid) only in try/catch cleanup with kill(pid) fallback); other broker-idle-timeout tests.

Win32 expectation branch (Step 7):
- runtime "cancelling an awaited job ends the await with exit 1…": `cancel` now passes `--json`; on win32 asserts `status 1` + `cancellationPending: true`, awaits the child and returns. POSIX path unchanged (status 0, await exit 1, job `cancelled`). No expected code/signal was replaced for POSIX.

## Gate (macOS, Node 24.14.0)
```
ℹ tests 314
ℹ pass 314
ℹ fail 0
ℹ skipped 0
status=0
```
- `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0
- `npm run build` → exit 0 (prebuild ran the new mkdir + generate-ts).
- `node scripts/run-tests.mjs --test-name-pattern "splitRawArgumentString"` → Node 24: tests 16 / pass 16; Node 18.20.8 (scratchpad via `N_PREFIX`, default Node untouched): tests 314, pass 2, skipped 312 (Node 18 reports filtered tests as skipped).

## Concerns
- Step 0 (fresh Windows inventory on current SHA) not yet available; reconcile when the controller forwards it.
- Win32 cancel branch assumes the v1.3.0 cancellationPending path; not verified on Windows.
- runtime ~3916 cleanup `kill(-sleeper.pid)` has no `kill(pid)` fallback; on Windows the detached, unref'd sleeper may leak (no hang). Left as-is.

---

## Follow-up 1 — commit a99878c `test: never throw from process-group cleanup in tests`
- `rg -n 'kill\(-' tests/`: cleanups lacking a `kill(pid)` fallback got one in a nested try/catch: `broker-stale-pid` impostor cleanup (~133), `runtime` sidecar `finally` (~2015), `runtime` queued sleeper `t.after` (~3916). Other sites already had the fallback. `broker-stale-pid` ~483 `process.kill(-running.pid)` is the test action, not cleanup (test is skipped on win32).
- Awaited-cancel test: a job can only be cancelled once, so a second text-mode cancel is impossible. POSIX now uses the original text call and asserts `/cancelled/i` on stdout (rendered path covered); `--json` is passed only on win32 for the structured `cancellationPending` check.

## Follow-up 2 — Step 0 inventory reconciliation (run 36355425528, head 39507d0) — commit 96696ba
Node 18: zero tests ran (cmd.exe does not expand the glob) → fixed by `scripts/run-tests.mjs`. Node 24: died with ENAMETOOLONG → fixed by the temp-module writer. Node 22: 28 failures:

| # | Test | Class | Resolution |
|---|------|-------|-----------|
| 1 | close() bounds an app-server that ignores SIGTERM | d | skip IS_WIN |
| 2 | close() stays bounded when it is called twice | d | skip IS_WIN |
| 3 | createBrokerEndpoint uses Unix sockets on non-Windows platforms | a | expectation via host `path.join` (kept, not skipped) |
| 4 | broker exits on SIGTERM even when a client never answers the FIN | d | skip IS_WIN |
| 5 | a second shutdown trigger does not exit before the first has cleaned up | d | skip IS_WIN (graceful SIGTERM + pgrep) |
| 6 | session end reaps a SIGKILLed background worker… | b/d | skip IS_WIN (kill(-pid) scenario; reaping needs identity) |
| 7 | ensureBrokerSession kills a live unreachable broker… | b | win32: `killed` = [] (identity-less record never signalled) |
| 8 | ensureBrokerSession re-verifies a legacy broker's ownership… | b | win32: kill-time recheck assertion guarded (refused before recheck); `killed` [] still asserted |
| 9 | review command uses AskUserQuestion… | a | CRLF `read()` |
| 10 | adversarial review command uses AskUserQuestion… | a | CRLF `read()` |
| 11 | rescue and agent payload blocks are a single node call… | a | CRLF `read()` ("must contain a fenced bash block") |
| 12 | setup is ready without npm… | a | skip IS_WIN (PATH isolation) |
| 13–16 | transfer ×4 | a | `homeEnv()` (USERPROFILE) |
| 17 | cancel stops an active background job and marks it cancelled | b | win32: exit 1 + `{status:"running", cancellationPending:true, reason:"identity-unavailable"}` |
| 18 | cancel sends turn interrupt… before killing a brokered task | b | win32 with exit 1: same pending payload; interrupt delivery (`lastInterrupt`) still asserted on all platforms |
| 19 | session end fully cleans up jobs for the ending session | b | win32: stderr `SessionEnd left review-running running: identity-unavailable`, record + job file kept |
| 20 | session end preserves background jobs and their broker… | b | win32: stderr line for review-foreground, foreground record kept; background invariants asserted on all platforms |
| 21 | setup rejects a gate effort the gate model does not support… | a | `fileURLToPath` catalogue path |
| 22 | setup rejects a gate model that cannot run the stored gate effort… | a | `fileURLToPath` |
| 23 | task --model sol resolves through the model catalogue… | a | `fileURLToPath` |
| 24 | task --args-stdin keeps shell metacharacters inside the prompt… | c | **expected red until Task 4/5** (product: `$SHELL`/backslash handling) — untouched |
| 25 | an active v1.1.1 record keeps its real --config… | a | mode-bit assert guarded |
| 26 | cancelling an awaited job ends the await with exit 1… | b | win32 branch (cancellationPending + exit 1) |
| 27 | job request payloads are written owner-only… | a | mode-bit assert guarded |
| 28 | concurrent writers never leave a torn state.json | a | temp-module writer |

Expected red on Windows after this task: #24 only (plus anything new the next Windows run surfaces, which by construction would be unclassified here). Not verified on Windows — needs the next CI run.

Win32 skip count unchanged: 6 newly skipped tests (list above); class-B tests use win32 branches, not skips.

### Gate after both follow-ups (macOS, Node 24)
```
ℹ tests 314
ℹ pass 314
ℹ fail 0
ℹ skipped 0
status=0
```
leak check 0; `npm run build` exit 0.

---

## Fix round 1 (Windows CI run 36356506497 on 96696ba: 314 / 281 pass / 3 fail / 30 skipped) — commit f85a3fb
1. `concurrent writers never leave a torn state.json for a reader` → `{ skip: IS_WIN }` with comment "Windows refuses rename over an open reader (EPERM); product retry lands in Task 7, which un-skips this." Product untouched. Win32 skip count is now **7**.
2. `session end fully cleans up jobs for the ending session`: root cause was the fixture, not the branch choice. The worker (sleeper) is alive at SessionEnd, so on win32 the refused kill keeps the record (stderr + ids matched in CI). The record then lost its `status` because `activeWorkspaceJobs` → `reapDeadJobs` read the job file `{ id: "review-running" }` (no status) as *terminal on disk* and `markJobDeadLocked` upserted `status: undefined` into the index. Fix: the fixture's running job file now carries `status: "running"`, as a live worker's own file does (POSIX path unaffected: that file is removed with the killed job either way). Win32 branch now asserts exactly: stderr `SessionEnd left review-running running: identity-unavailable`, ids `["review-other","review-running"]`, kept record `{ status: "running", pid: sleeper.pid }`, job file present.
3. Static-review minors: awaited-cancel win32 branch now `deepEqual`s the whole payload `{ jobId, status: "running", cancellationPending: true, reason: "identity-unavailable" }`; report header fixed (6 → at that time; 7 after item 1).
4. Remaining expected red on Windows: `task --args-stdin keeps shell metacharacters…` (Task 4).

Gate (macOS, Node 24): tests 314 / pass 314 / fail 0 / skipped 0, exit 0; leak check 0; `npm run build` exit 0.
