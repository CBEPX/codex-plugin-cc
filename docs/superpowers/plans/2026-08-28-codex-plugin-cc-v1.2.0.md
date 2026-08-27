# codex-plugin-cc v1.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rescue flow a single `node` call (companion-side await), restore the narrow `Bash(node:*)` grant, close the remaining lifecycle gaps (own-jobs-only SessionEnd, PID liveness reaping, bounded turns), and add the missing live-broker SessionEnd test.

**Architecture:** New companion subcommand behaviour `task --await` (launch as a tracked background job, poll until terminal or `--await-timeout-ms`, print the result; on timeout print a resumable hint and exit 3) plus `--prompt-stdin` (raw, untokenized stdin = prompt) so a slash-command body is exactly one `node …` invocation with one quoted heredoc. Rescue command/agent bodies collapse to that call; `allowed-tools` goes back to `Bash(node:*)`. Lifecycle: cherry-pick upstream #355 (SessionEnd terminates only jobs it owns), #425 (PID liveness → reap zombie `running` jobs), #376 (bounded `captureTurn` with a configurable turn budget) — resolving against the fork's `disableBroker` cold-resume path and v1.1.1 shutdown changes.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test`, fake Codex fixture, `gh`.

**Spec:** memory `codex-plugin-cc-fork-backlog` (v1.2 items); v1.1.0/v1.1.1 review residuals (random heredoc delimiters instruction-only; `allowed-tools: Bash` too broad; no test that SessionEnd kills a live broker).

## Global Constraints

- Repo `/Users/g.mehrenin/project/personal/codex-plugin-cc`, `origin`=CBEPX, `upstream`=openai. Branch `release/v1.2.0` from `main` (6672679 = v1.1.1).
- Gate (zsh reserves `status`, use `st`): `npm test > /tmp/npm-test.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test.log; test "$st" -eq 0` → `fail 0` (150 at base); `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0; `npm run build`; `npm run check-version`; `claude plugin validate . --strict` before the release commit.
- Tooling rule (user): never `grep` — ripgrep `rg`. No `git add -A`. Trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. No push until the controller says so.
- Upstream PR merges: `git fetch upstream pull/N/head:pr/N && git merge --no-ff --no-edit pr/N`; keep-both on conflicts; the fork's `withAppServer(cwd, fn, clientOptions)`, `disableBroker` cold resume, `assertThreadIsFree`, `buildThreadConfig`, `--args-stdin`, v1.1.1 broker shutdown/ownership code must survive — verify by reading after each merge.
- Shell bodies of commands/agents: exactly one `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" …` invocation per Bash block, prose only via a quoted heredoc on stdin, flags on the command line; `allowed-tools: Bash(node:*)`.

---

### Task 1: `task --await` + `--prompt-stdin` in the companion

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `handleTask` (new options `await`, `await-timeout-ms`, `prompt-stdin`), `printUsage`, reuse `enqueueBackgroundTask`, `waitForSingleJobSnapshot`/`handleStatus` internals, `handleResult` rendering; `readTaskPrompt` (prompt from raw stdin when `--prompt-stdin`).
- Test: `tests/runtime.test.mjs`, `tests/args.test.mjs` (booleanOptions/valueOptions additions), `tests/commands.test.mjs` untouched here.

**Interfaces:**
- Consumes: `enqueueBackgroundTask(cwd, job, request)` (returns jobId; job record persisted before spawn since v1.1.0), `waitForSingleJobSnapshot(workspaceRoot, jobId, { timeoutMs, pollIntervalMs })`, `renderTaskResult(job)` / the `result` path, `isActiveJobStatus(status)`, `readStdinIfPiped()`.
- Produces (contract fixed by Codex-review rulings F1–F4, F11 — see ledger):
  - `task --await [--await-timeout-ms <ms>] …` → enqueue a background job (record identical to `--background`), then wait via the same snapshot polling `status --wait` uses; terminal → print exactly what `result <id>` prints (`resolveResultJob` + `readStoredJob` + `renderStoredJobResult`); exit 0 completed, 1 failed/cancelled; timeout (default 540000, must be a finite positive integer; `0`/negative/`NaN`/`Infinity` → usage error) → text: one line `Still running: job <id>. Re-run: node "<abs script>" result <id> --wait --timeout-ms 540000`, exit **3**; `--json`: `{ job, storedJob }` on terminal, or the `status --json` snapshot plus `"resumeCommand"` on timeout.
  - `result <id> [--wait [--timeout-ms <ms>]]` → terminal record retrieved → exit 0 even if `job.status === "failed"` (existing retrieval semantics); still `queued`/`running` without `--wait` → the hint line, exit 3; with `--wait` → same timeout contract. `status --wait` semantics unchanged (exit 0 + `waitTimedOut`).
  - `--prompt-stdin` → raw stdin, decoded UTF-8, exactly one trailing `\r?\n` removed, nothing else (no `.trim()`); the check for `--prompt-stdin` happens on the RAW argv before `applyArgsStdin` (which would otherwise consume stdin); `--prompt-stdin`+`--args-stdin`, +`--prompt-file`, +positional prompt, `--await`+`--background`, `--await-timeout-ms` without `--await` → usage errors before any stdin read (fast even with an open, empty stdin).
  - Survival caveat (documented): the detached worker survives only when the companion returns by itself (exit 3); a host process-tree kill (Claude's Bash timeout) also kills the worker.

- [ ] **Step 1: Failing runtime tests** — append to `tests/runtime.test.mjs` (use `seededRepo()`, `installFakeCodex`, `buildEnv`, `SCRIPT` helpers already in the file):

```js
test("task --await launches a tracked job, waits, and prints the result", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, "task", "--await", "--json", "--model", "sol", "--effort", "low", "--prompt-stdin"], {
    cwd: repo, env: buildEnv(binDir), input: "line one \\d+ \"quoted\" 'single'\nline two\n"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.match(out.jobId, /^task-/);
  assert.equal(out.status, "completed");
  assert.ok(typeof out.rawOutput === "string" && out.rawOutput.length > 0);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "line one \\d+ \"quoted\" 'single'\nline two");
  assert.equal(fakeState.lastTurnStart.effort, "low");
  const status = run("node", [SCRIPT, "status", out.jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(JSON.parse(status.stdout).job.status, "completed");
});

test("task --await exits 3 with a resumable hint when the await timeout elapses", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "3000" }); // add this fixture knob if absent: delays turn/start completion
  const result = run("node", [SCRIPT, "task", "--await", "--await-timeout-ms", "500", "--prompt-stdin"], { cwd: repo, env, input: "slow task\n" });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /Still running: job task-[A-Za-z0-9_-]+\. Re-run: node .*result task-[A-Za-z0-9_-]+ --wait --timeout-ms 540000/);
  const jobId = result.stdout.match(/job (task-[A-Za-z0-9_-]+)/)[1];
  const done = run("node", [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: repo, env });
  assert.equal(done.status, 0, done.stderr);
});

test("task rejects --prompt-stdin combined with --args-stdin or --prompt-file", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const r = run("node", [SCRIPT, "task", "--prompt-stdin", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "x" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prompt-stdin/);
});
```

- [ ] **Step 2: Run — expect FAIL** (`Unknown option: --await`).

- [ ] **Step 3: Implement** in `codex-companion.mjs`: add `"await"`, `"prompt-stdin"` to `handleTask`'s `booleanOptions` and `"await-timeout-ms"` to `valueOptions`; in `main()`/`applyArgsStdin` guard the mutual exclusion (`--prompt-stdin` + `--args-stdin` → throw `"--prompt-stdin cannot be combined with --args-stdin; put flags on the command line."`); `readTaskPrompt`: if `options["prompt-stdin"]` → `readStdinIfPiped()` raw (error if empty); `handleTask`: when `options.await`, build the request exactly like the background branch, `enqueueBackgroundTask`, then `await waitForSingleJobSnapshot(workspaceRoot, jobId, { timeoutMs: Number(options["await-timeout-ms"] ?? 540000), pollIntervalMs: 1000 })`; if terminal → print via the `result` renderer (`--json` → the `result --json` object plus `jobId`), exit 0/1 by job status; else print the hint and `process.exitCode = 3`. `handleResult`: add `--wait`/`--timeout-ms` using the same snapshot wait. Fixture: add `FAKE_CODEX_TURN_DELAY_MS` if no delay knob exists (sleep before emitting the turn-completed notification).

- [ ] **Step 4: Tests pass; gate → `fail 0`; commit** `feat(task): --await and --prompt-stdin; result --wait`.

---

### Task 2: Rescue bodies → single `node` call; `allowed-tools: Bash(node:*)`

**Files:** `plugins/codex/commands/rescue.md`, `plugins/codex/agents/codex-rescue.md`, `plugins/codex/skills/codex-cli-runtime/SKILL.md`, `tests/commands.test.mjs`, `README.md`, `CHANGELOG.md`.

**Interfaces:** Consumes Task 1's `task --await --prompt-stdin` (exit 0 completed / 1 failed-or-cancelled / 3 still running with a `Re-run: node "<abs>" result <id> --wait --timeout-ms 540000` hint line) and `result <id> --wait`. Codex-review rulings: the resume decision (`task-resume-candidate` + one `AskUserQuestion`) happens in the main command BEFORE the sync/background split, so the agent (which has no `AskUserQuestion`) receives an explicit `--resume-last` or `--fresh`; `--background` without an explicit `--resume` is always fresh; `--write` only when the user explicitly asked to modify files; the payload Bash block is exactly one `node …` call (the `task-resume-candidate` call before it is a separate block); the prompt heredoc keeps a high-entropy delimiter that does not occur as an exact line in the request. Produces the new command body:

````markdown
1. If the request contains `--resume`, use `--resume-last`; if `--fresh`, use a fresh task. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json`: when it reports a resumable thread ask ONCE with `AskUserQuestion` — `Continue current Codex thread` (→ `--resume-last`) / `Start a new Codex thread` (→ fresh) — otherwise fresh. This decision is made here for BOTH the synchronous and the `--background` path. Pass `--model`, `--effort`, `--config key=value` through; never add `--write` unless the user explicitly asked Codex to modify files.
2. Synchronous path (default): ONE Bash call (`timeout: 600000`); flags on the command line, the request prose in a quoted heredoc whose delimiter is `CODEX_PROMPT_` + 8 fresh random hex chars that do not appear as an exact line in the request:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --await --prompt-stdin <flags> <<'CODEX_PROMPT_<random>'
<request text>
CODEX_PROMPT_<random>
```
Exit 0 → show the output verbatim, then your assessment. Exit 3 → the output ends with `Re-run: node "…" result <id> --wait --timeout-ms 540000` — run exactly that line (again `timeout: 600000`) until it exits 0 or 1; never report "no result". Exit 1 → the job failed or was cancelled: show the output verbatim and stop.
3. `--background`: invoke the `Agent` tool with `codex:codex-rescue`, passing the request minus `--background` PLUS the explicit `--resume-last` or `--fresh` decided in step 1; tell the user the result arrives as a completion notification and via `/codex:status` / `/codex:result <id>`.
````
Agent body: the same single `task --await --prompt-stdin` call (never `task-resume-candidate`, never a resume heuristic — it must receive `--resume-last`/`--fresh` from the command), then `result <id> --wait` for its own job on exit 3; failures returned verbatim.
- [ ] **Step 1: Failing tests** in `tests/commands.test.mjs`: rescue and agent bodies match `/task --await --prompt-stdin/`; the payload fenced block contains exactly one `codex-companion.mjs` invocation and no `mktemp`/`cat >`/`while`/`sleep`/`$JOB=`; `allowed-tools: Bash(node:*), AskUserQuestion, Agent` for rescue.md; the AskUserQuestion step precedes the `--background` branch text (assert index ordering); the agent body has no `task-resume-candidate` and no `--resume-last` heuristic; the delimiter guidance sentence is present; `SKILL.md` execution rules updated to the single-call flow. Existing two-step assertions updated (edit, don't delete).
- [ ] **Step 2: RED → rewrite the bodies + SKILL.md → GREEN; gate; commit** `feat(rescue): single node call via task --await; resume decision before the background split; Bash(node:*) grant restored`.
- [ ] **Step 3: Manual permission smoke (record in the report as not automatable):** in a fresh Claude Code 2.1.247 session run `/codex:status` and `/codex:rescue --model sol --effort low Strictly read-only: reply PONG` — both must run without a permission prompt; also confirm a non-`node` command inside the same block would NOT be covered (documented expectation, no test).

---

### Task 3: Lifecycle — #355 (semantic merge), #425 (adapted reaper), bounded turns (own implementation), regression tests

Codex-review rulings (ledger F7–F10): #355 and #425 are merged as branches but each needs a semantic resolution against the fork; #376 is NOT merged — its behaviour is implemented here directly. The cached diffs are in the SDD scratchpad (`prs/pr-355.diff`, `pr-425.diff`, `pr-376.diff`); `git fetch upstream pull/N/head:pr/N` for the merges.

**Files:** `plugins/codex/scripts/session-lifecycle-hook.mjs`, `plugins/codex/scripts/codex-companion.mjs` (`enqueueBackgroundTask`, `handleTaskWorker`, `handleStatus` reaper hook, `--turn-timeout-ms`), `plugins/codex/scripts/lib/{state,tracked-jobs,job-control,codex,broker-lifecycle}.mjs`, `tests/{runtime,tracked-jobs,broker-stale-pid}.test.mjs`, `tests/fake-codex-fixture.mjs`.

**Interfaces / rulings:**
- **#355 (own-jobs-only SessionEnd):** after the merge, `handleSessionEnd` order must be: (1) `cleanupSessionJobs` — terminate this session's *foreground* jobs, keep *background* jobs (queued records gain `background: true`; the fork's `requestFile` + redacted `request` fields must survive); (2) if any owned background job is still `queued`/`running` → skip broker shutdown (early return); (3) otherwise `sendBrokerShutdown` → `teardownBrokerSession` (v1.1.1 `ownsBrokerProcess` check stays as the fallback-signal guard); (4) hook-side `clearBrokerSession(cwd)` only when the record's `endpoint` equals the one captured at step start (a replacement broker's record must survive). Document that with `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=0` a broker kept alive for a background job never exits on its own.
- **#425 (PID liveness reaper), adapted:** `enqueueBackgroundTask` records the worker pid after spawn via a narrow pid-only update (`updateJobPid(workspaceRoot, jobId, pid)` that rewrites ONLY `pid` and never `status` — no load-mutate-save of the whole record; if the worker already wrote `running`, keep it). The reaper (run by `status`, `result`, `task-resume-candidate`): a `queued`/`running` job whose `pid` is dead (`process.kill(pid, 0)` throws) → `failed` with `errorMessage: "worker exited before completing"`; after the terminal reap delete `jobs/<id>.request.json` and set `requestFile: null`; never touch a live worker or its payload; never copy an unredacted payload into `state.json`. Tests: dead-queued-before-consume (payload removed after reap), dead-running, live job with payload untouched, cancelled job, secret sentinel absent from state after reap.
- **Bounded turns (instead of #376):** `captureTurn` gets a client-side timeout: `--turn-timeout-ms <ms>` on `task`/`review`/`adversarial-review` (persisted into the worker request for background/await jobs), env `CODEX_TURN_TIMEOUT_MS` as default, `0`/unset = unbounded (preserves current behaviour). On timeout: `turn/interrupt` the thread, then return a structured failed result (`status: failed`, `errorMessage: "turn timed out after <ms> ms"`, partial `rawOutput` if any) — never an exception that only reaches stderr. `TurnStartParams` has no timeout field: do not add one to the RPC. The stop-review gate's own 13-minute limit is unaffected.
- **Regression tests (not RED-first; baseline is green):** in `tests/broker-stale-pid.test.mjs` / `tests/runtime.test.mjs`: (a) live owned broker → SessionEnd → pid gone within 3 s, record + endpoint cleared; (b) wrong/recycled pid never signalled (exists); (c) owned background job running → SessionEnd keeps the broker; after the job completes the broker idle-exits (use `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=2000` via `buildEnv` override) and only its own record is cleared; (d) a replacement broker started during the old one's shutdown keeps its record.

- [ ] **Step 1:** `git fetch upstream pull/355/head:pr/355 && git merge --no-ff --no-edit pr/355`; resolve per the #355 ruling (read the merged `handleSessionEnd` end-to-end; reorder if needed); gate.
- [ ] **Step 2:** `git fetch upstream pull/425/head:pr/425 && git merge --no-ff --no-edit pr/425`; adapt per the #425 ruling (`updateJobPid`, reaper rules, payload deletion); write the five reaper tests (RED where the behaviour is new, e.g. dead-queued-before-consume); gate.
- [ ] **Step 3:** bounded turns: failing test (fake app-server with `FAKE_CODEX_TURN_DELAY_MS=5000`, `task --turn-timeout-ms 500` → exit 1, `status` shows `failed` with the timeout message, `turn/interrupt` recorded by the fixture) → implement → GREEN; gate.
- [ ] **Step 4:** the four broker regression tests; gate; commit `fix(lifecycle): own-jobs-only SessionEnd (#355), pid-liveness reaper (#425, adapted), bounded turns; broker teardown regression tests`.

---

### Task 4: Release v1.2.0

- [ ] `npm run bump-version -- 1.2.0 && npm run check-version`; CHANGELOG 1.2.0 (Tasks 1–3, plus "rescue bodies are single node calls; `allowed-tools` narrowed back to `Bash(node:*)`; random-delimiter guidance now only protects the prompt heredoc; exit-code contract 0/1/3 for `task --await` and `result`; worker-survival caveat; `CODEX_TURN_TIMEOUT_MS`; `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=0` keeps a background-job broker alive indefinitely"); `plugins/codex/commands/result.md` argument-hint `[job-id] [--wait] [--timeout-ms <ms>]`; README task/rescue/result sections (exit codes, JSON shapes, `--prompt-stdin`, `--turn-timeout-ms`); `tests/commands.test.mjs` assertions for the hints; gate/build/validate; commit `chore(release): v1.2.0`.

## Verification
1. Fresh session: `/codex:status` (no prompt), `/codex:rescue --model sol --effort max Strictly read-only: reply PONG` → answer in the same turn via the single call; `--background` variant → agent returns the result.
2. Force exit-3: `/codex:rescue --await-timeout-ms 5000 …` on a slow prompt → hint line → rerun `result --wait` → result.
3. SessionEnd on a session with a live broker → broker gone (test + manual `pgrep`).
4. `status` on a job whose worker was `kill -9`'d → shows `failed` (PID liveness), not `running` forever.
