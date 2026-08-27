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
- Produces:
  - `task --await [--await-timeout-ms <ms>] …` → enqueue a background job, then wait like `status <id> --wait`; when the job reaches a terminal status print exactly what `result <id>` prints and exit 0 (failed job → its error text, exit 1); when `--await-timeout-ms` (default 540000) elapses first print `Still running: job <id>. Re-run: node "<script>" result <id> --wait --timeout-ms 540000` and exit **3**; `--json` variants print the same objects `result --json`/`status --json` would.
  - `result <id> --wait [--timeout-ms <ms>]` → new: wait for terminal status (same exit-3-on-timeout contract), then print the result.
  - `--prompt-stdin` → the prompt is the raw bytes of stdin (no tokenization, trailing newline trimmed as today); mutually exclusive with `--prompt-file` and positional prompt text; mutually exclusive with `--args-stdin` (error if both).
  - Job record for awaited jobs is identical to background jobs (`kind: task`, `background: true` semantics), so `/codex:status`, `cancel`, `result` all work on it.

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

**Interfaces:** Consumes Task 1's `task --await --prompt-stdin` and `result <id> --wait`. Produces the new command body:

````markdown
1. (unchanged) resume-candidate check + AskUserQuestion; never add `--write` unless asked.
2. Run ONE Bash call (`timeout: 600000`); flags on the command line, the request prose in the quoted heredoc (fresh random suffix each call):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --await --prompt-stdin <flags> <<'CODEX_PROMPT_<random>'
<request text>
CODEX_PROMPT_<random>
```
Exit 0 → show the output verbatim, then your assessment. Exit 3 → the output ends with `Re-run: node … result <id> --wait --timeout-ms 540000` — run exactly that line (again with `timeout: 600000`) until it exits 0; never report "no result". Any other non-zero exit → show the output verbatim and stop.
3. `--background` → `Agent` `codex:codex-rescue` (agent body: the same single call with `--await`, then it may run the `result --wait` line for its own job).
````
- [ ] **Step 1: Failing tests** in `tests/commands.test.mjs`: rescue and agent bodies match `/task --await --prompt-stdin/`, contain exactly one `codex-companion.mjs` invocation per fenced block, no `mktemp`/`cat >`/`while`/`sleep` tokens, `allowed-tools: Bash(node:*), AskUserQuestion, Agent` for rescue.md; existing assertions for the old two-step flow updated (edit, don't delete).
- [ ] **Step 2: RED → rewrite the bodies → GREEN; gate; commit** `feat(rescue): single node call via task --await; Bash(node:*) grant restored`.

---

### Task 3: Lifecycle — merge #355, #425, #376; live-broker SessionEnd test

**Files:** via merges: `plugins/codex/scripts/session-lifecycle-hook.mjs`, `plugins/codex/scripts/lib/{state,tracked-jobs,job-control,codex}.mjs`, tests. Hand: `tests/broker-stale-pid.test.mjs` (+ live-broker case).

- [ ] **Step 1: Merge in order** `#355` (SessionEnd terminates only jobs owned by the ending session) → `#425` (PID liveness: `status` reaps `running` jobs whose pid is dead → `failed`) → `#376` (bounded `captureTurn` with `CODEX_COMPANION_TURN_TIMEOUT_MS`, default 0 = unbounded? — read the PR; keep upstream default). Gate after each. Expected conflicts: `session-lifecycle-hook.mjs` (v1.1.1 ownership check + #355 ownership filter — keep both: filter by session id AND verify pid ownership), `codex.mjs` `captureTurn` (fork's `withAppServer` params untouched), `tracked-jobs.mjs`/`state.mjs` (v1.1.0 private payload + redaction must survive; #425 reaping must not delete `jobs/<id>.request.json` for live jobs).
- [ ] **Step 2: Failing test — SessionEnd kills a LIVE owned broker** in `tests/broker-stale-pid.test.mjs`: spawn a broker via `ensureBrokerSession` with the fake codex, assert the pid is alive, run the SessionEnd path (`handleSessionEnd` or `teardownBrokerSession`), assert the pid is gone within 3 s and the record cleared. RED must show it failing when `ownsBrokerProcess` is stubbed to false (temporarily via env `CODEX_COMPANION_TEST_DISOWN=1` handled only in tests? — no test-only prod code: instead assert against the real path and additionally a negative case with a wrong endpoint, which already exists).
- [ ] **Step 3: Gate; commit** `fix(lifecycle): own-jobs-only SessionEnd, pid liveness reaping, bounded turns (#355 #425 #376); live-broker teardown test`.

---

### Task 4: Release v1.2.0

- [ ] `npm run bump-version -- 1.2.0 && npm run check-version`; CHANGELOG 1.2.0 (Tasks 1–3, plus "rescue bodies are single node calls; `allowed-tools` narrowed back to `Bash(node:*)`; random-delimiter guidance now only protects the prompt heredoc"); README rescue section; gate/build/validate; commit `chore(release): v1.2.0`.

## Verification
1. Fresh session: `/codex:status` (no prompt), `/codex:rescue --model sol --effort max Strictly read-only: reply PONG` → answer in the same turn via the single call; `--background` variant → agent returns the result.
2. Force exit-3: `/codex:rescue --await-timeout-ms 5000 …` on a slow prompt → hint line → rerun `result --wait` → result.
3. SessionEnd on a session with a live broker → broker gone (test + manual `pgrep`).
4. `status` on a job whose worker was `kill -9`'d → shows `failed` (PID liveness), not `running` forever.
