# codex-plugin-cc fork v1.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `codex@cbepx` v1.1.0 — upstream 1.0.6 plus the drift fixes Claude Code actually hit in Aug 2026 (effort `max`, model/effort really reaching Codex, per-run config overrides, approval for `--write`, MCP elicitation, rescue agent returning a result, commands that pass the auto-mode classifier, sane hook timeouts) — installable from `CBEPX/codex-plugin-cc`.

**Architecture:** Fork keeps upstream layout (`.claude-plugin/marketplace.json` + `plugins/codex/`) so `git merge upstream/main` stays cheap. Community PRs that are MERGEABLE and small are merged as branches (`git fetch upstream pull/N/head`), preserving authorship. Model/effort/config overrides are sent per thread via `thread/start.config` / `thread/resume.config` (protocol-confirmed: `ThreadStartParams.config?: {[key]: JsonValue}`; `ReviewStartParams` has no model/effort — the review thread's config is the only route). No broker changes.

**Tech Stack:** Node ≥18.18 (dev on 24.14), ESM `.mjs`, `node --test`, fake Codex fixture (`tests/fake-codex-fixture.mjs`), `gh` CLI, Serena MCP for symbol edits.

**Spec:** memory `codex-plugin-cc-fork-backlog` (ranked backlog) + `~/.claude/plans/claude-code-structured-crystal.md` §Step 7. Usage evidence: 21 Aug-2026 sessions; 11/12 rescue-agent calls returned a placeholder; `max` rejected → `xhigh` forced; `/codex:status` inline `!` body blocked by classifier twice.

## Global Constraints

- Repo: `/Users/g.mehrenin/project/personal/codex-plugin-cc`, remotes `origin=CBEPX/codex-plugin-cc`, `upstream=openai/codex-plugin-cc`. Work on branch `release/v1.1.0` from `main` (= upstream `db52e28`, 1.0.6).
- Plugin name stays `codex` (so `/codex:*`, `codex:codex-rescue`, `Skill(codex:rescue)` keep working); marketplace name becomes `cbepx`.
- `npm test` must be green after every task. Baseline: 91 tests. Tests must pass **inside a Claude Code session** (Task 0 isolates leaked `CLAUDE_PLUGIN_DATA`/`CODEX_COMPANION_*` env).
- Node `>=18.18.0` in `package.json` engines — no Node-22-only APIs.
- Commit messages: conventional (`feat:`, `fix:`, `chore:`, `merge:`), trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Merge mechanics for upstream PRs (same every time): `git fetch upstream pull/N/head:pr/N && git merge --no-ff --no-edit pr/N`; on conflict, keep BOTH sides for test-file insertions (they add independent `test(...)` blocks at the same anchor), then `npm test`.
- Test gate command (never mask the exit status behind a pipe): `npm test > /tmp/npm-test.log 2>&1; status=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test.log; test "$status" -eq 0` — the `test` at the end is the gate. Same for smoke commands: capture `status=$?` before formatting output.
- Tooling rule (user): never use `grep`/`egrep`/`fgrep` — use ripgrep `rg` (or an equivalent) in every command, script, test and brief; e.g. `rg -n 'pattern' file`, `... | rg -e 'ℹ (tests|pass|fail)' -e '^not ok'`.
- Amended 2026-08-27 14:30 after a Codex adversarial review of this plan (13 findings; rulings in the SDD ledger). Tasks 5–8 carry the amendments.
- Not in scope (backlog v1.2+): lifecycle/broker leak (#540/#543/#425/#376/#457), structured `--json` (#593), sandbox from config.toml (#646), `--profile` flag (covered by `--config`), Windows.

---

### Task 0: Branch + hermetic test env + CI on push

**Files:**
- Create: `tests/test-env.mjs`
- Modify: `package.json` (scripts.test)
- Modify: `.github/workflows/pull-request-ci.yml` (trigger)

**Interfaces:**
- Produces: `npm test` == `node --import ./tests/test-env.mjs --test tests/*.test.mjs`; env vars `CLAUDE_PLUGIN_DATA`, `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_TRANSCRIPT_PATH`, `CODEX_COMPANION_APP_SERVER_ENDPOINT`, `CLAUDE_ENV_FILE`, `CODEX_PLUGIN_CC_ARGS` are always unset when tests start.

- [ ] **Step 1: Branch**

```bash
cd /Users/g.mehrenin/project/personal/codex-plugin-cc && git checkout -b release/v1.1.0 main
```

- [ ] **Step 2: Reproduce the failure (inside Claude Code the env leaks)**

Run: `CLAUDE_PLUGIN_DATA=/tmp/leak npm test > /tmp/npm-test.log 2>&1; status=$?; rg -e 'ℹ (pass|fail)' /tmp/npm-test.log; echo status=$status`
Expected: `ℹ fail 4` (state.test.mjs `resolveStateDir uses a temp-backed per-workspace directory` and 3 siblings).

- [ ] **Step 3: Write `tests/test-env.mjs`**

```js
// Hermetic test environment: strip host-session variables that Claude Code /
// the plugin's own SessionStart hook export, so tests see a clean machine.
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_PLUGIN_CC_ARGS"
]) {
  delete process.env[name];
}
```

- [ ] **Step 4: Wire it into `package.json`**

Replace `"test": "node --test tests/*.test.mjs"` with `"test": "node --import ./tests/test-env.mjs --test tests/*.test.mjs"`.

- [ ] **Step 5: Verify**

Run: `CLAUDE_PLUGIN_DATA=/tmp/leak npm test > /tmp/npm-test.log 2>&1; status=$?; rg -e 'ℹ (tests|pass|fail)' /tmp/npm-test.log; echo status=$status`
Expected: `ℹ tests 91`, `ℹ pass 91`, `ℹ fail 0`.

- [ ] **Step 6: CI also on push to main/release branches**

In `.github/workflows/pull-request-ci.yml` replace
```yaml
on:
  pull_request:
```
with
```yaml
on:
  pull_request:
  push:
    branches: [main, "release/**"]
```

- [ ] **Step 7: Commit**

```bash
git add tests/test-env.mjs package.json .github/workflows/pull-request-ci.yml
git commit -m "chore(test): hermetic test env; run CI on push" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: Merge upstream PR #616 — accept `max`/`ultra` reasoning efforts

**Files:** (via merge) `plugins/codex/scripts/codex-companion.mjs` (`VALID_REASONING_EFFORTS`, usage text, error text), `plugins/codex/commands/rescue.md`, `plugins/codex/skills/codex-cli-runtime/SKILL.md`, `README.md`, `tests/commands.test.mjs`, `tests/runtime.test.mjs`.

**Interfaces:**
- Produces: `normalizeReasoningEffort("max") === "max"`; error text `Unsupported reasoning effort "X". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`

- [ ] **Step 1: Merge**

```bash
git fetch upstream pull/616/head:pr/616 && git merge --no-ff --no-edit pr/616
```
Expected: clean merge (PR is MERGEABLE against main).

- [ ] **Step 2: Test**

Run: `npm test > /tmp/npm-test.log 2>&1; status=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test.log; test "$status" -eq 0`
Expected: `ℹ fail 0`, tests ≥ 94 (adds `task forwards max/ultra reasoning effort…` ×2 and `task rejects an unknown reasoning effort`).

- [ ] **Step 3: Smoke the real error path**

Run: `node plugins/codex/scripts/codex-companion.mjs task --effort supreme x 2>&1 | head -2`
Expected: `Unsupported reasoning effort "supreme". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`

(No extra commit — the merge commit is the commit.)

---

### Task 2: Merge #688 — normalize `--model` aliases on review/adversarial-review

**Files:** (via merge) `codex-companion.mjs` `handleReviewCommand` (calls `normalizeRequestedModel(options.model)`), `tests/fake-codex-fixture.mjs` (+`lastThreadStart`), `tests/runtime.test.mjs`.

- [ ] **Step 1: Merge**

```bash
git fetch upstream pull/688/head:pr/688 && git merge --no-ff --no-edit pr/688
```
Likely conflict: `tests/runtime.test.mjs` around the anchor `test("task forwards model selection and reasoning effort to app-server turn/start"` — both #616 and #688 append tests after it. Resolution: keep both blocks in either order, remove markers.

- [ ] **Step 2: Test** — gate command from Global Constraints → `fail 0`.

- [ ] **Step 3: Commit if you resolved a conflict**

```bash
git add tests/runtime.test.mjs && git commit --no-edit
```

---

### Task 3: Merge #426 (approval `on-request` for `--write`) and #501 (accept MCP elicitations)

**Files:** (via merge) `codex-companion.mjs` `executeTaskRun` (+`approvalPolicy`), `lib/codex.mjs` `runAppServerTurn` (passes `approvalPolicy` into `startThread`/`resumeThread`), `lib/app-server.mjs` (`item/tool/requestUserInput`/elicitation requests answered instead of `-32601`), `tests/fake-codex-fixture.mjs`, `tests/runtime.test.mjs`, new `tests/app-server.test.mjs`.

**Interfaces:**
- Produces: `runAppServerTurn(cwd, { approvalPolicy: "on-request" | "never", … })`; `buildThreadParams` already honours `options.approvalPolicy`.

- [ ] **Step 1: Merge #426**

```bash
git fetch upstream pull/426/head:pr/426 && git merge --no-ff --no-edit pr/426
```
Likely conflict: `tests/fake-codex-fixture.mjs` near line 313 (`rl.on("line"…` handler — #688 added `lastThreadStart`, #426 adds approval bookkeeping). Keep both.

- [ ] **Step 2: Test, commit resolution if any.**

- [ ] **Step 3: Merge #501**

```bash
git fetch upstream pull/501/head:pr/501 && git merge --no-ff --no-edit pr/501
```

- [ ] **Step 4: Test**

Run: gate command from Global Constraints → `fail 0`; `tests/app-server.test.mjs` present and passing.

---

### Task 4: Merge #608 (rescue agent awaits the result) and #690 (explicit Bash blocks in commands)

**Files:** (via merge) `plugins/codex/agents/codex-rescue.md`, `plugins/codex/skills/codex-cli-runtime/SKILL.md`, `plugins/codex/commands/{cancel,result,status,transfer}.md`, `tests/commands.test.mjs`.

- [ ] **Step 1: Merge both**

```bash
git fetch upstream pull/608/head:pr/608 && git merge --no-ff --no-edit pr/608
git fetch upstream pull/690/head:pr/690 && git merge --no-ff --no-edit pr/690
```
Possible conflict in `tests/commands.test.mjs` (both #616 and #608 edit the `rescue command absorbs continue semantics` assertions) — keep the #608 assertion lines and the #616 `max|ultra` regex.

- [ ] **Step 2: Verify the command bodies no longer use inline `` !` `` **

Run: `rg -l '^!`' plugins/codex/commands/`
Expected: no output.

- [ ] **Step 3: Test** → `fail 0`.

---

### Task 5: Merge #547 (`--help`/unknown flags are errors), #645 + #644 (job records store resolved model/effort/sandbox; log reasoning start)

**Files:** (via merge) `codex-companion.mjs` (`normalizeArgv`, every `handleX` gains an unknown-flag guard), `lib/args.mjs` (`parseArgs` strict mode), new `tests/args.test.mjs`; `lib/codex.mjs` (`runAppServerReview`/`runAppServerTurn` return `resolved: {model, effort, sandbox}`), `lib/tracked-jobs.mjs`, fixture, `tests/runtime.test.mjs`.

- [ ] **Step 1: Merge in this order** (645 is the largest, last):

```bash
for n in 547 644 645; do git fetch upstream pull/$n/head:pr/$n && git merge --no-ff --no-edit pr/$n || break; done
```
Expected conflicts (all keep-both): `codex-companion.mjs` `handleReviewCommand` (547 adds a guard at the top, 688 changed the model line — keep both), `tests/runtime.test.mjs` test insertions, `tests/fake-codex-fixture.mjs` line ~313/347 (approval + lastThreadStart + 645's resolved-settings echo).

**Semantic conflict checklist for #645 (Git may auto-merge these silently — verify by reading, not by trusting a clean merge):**
- `plugins/codex/scripts/lib/codex.mjs` `runAppServerTurn`: #645 rewrites the `const response = await startThread(...)` / `resumeThread(...)` hunks from a base that has no `approvalPolicy`; #426 added `approvalPolicy: options.approvalPolicy` to BOTH calls. After the merge both calls must still pass `approvalPolicy` (`rg -n approvalPolicy plugins/codex/scripts/lib/codex.mjs` must show it inside `runAppServerTurn` for start AND resume).
- `tests/fake-codex-fixture.mjs`: the `thread/start` / `thread/resume` handlers must simultaneously keep `lastThreadStart`/`lastThreadResume` (#688), the approval bookkeeping (#426), and #645's resolved-settings response.
- Run the PR-specific tests by name after the merge, not only the suite total: `node --import ./tests/test-env.mjs --test --test-name-pattern 'approval|on-request|alias|resolved|model selection' tests/runtime.test.mjs` → all pass.

- [ ] **Step 2: Test** → `fail 0` (gate command from Global Constraints) and the name-pattern run above.

- [ ] **Step 3: Smoke**

Run: `node plugins/codex/scripts/codex-companion.mjs task --help 2>&1 | head -3; echo "exit=$?"`
Expected: usage text on stderr, non-zero exit, **no** Codex thread started.

---

### Task 6: Merge hook hardening — #672, #668, #682, #396 — and fix the stop-gate timeout collision

**Files:** (via merge) `plugins/codex/hooks/hooks.json` (SessionStart timeout 5→**60** — #672's test asserts exactly 60; do not "resolve" it to another value), `plugins/codex/scripts/session-lifecycle-hook.mjs` (`appendEnvVar` idempotent), `plugins/codex/scripts/stop-review-gate-hook.mjs` (fail closed on malformed stdin; `CODEX_REVIEW_GATE_MAX_ROUNDS`), `README.md`, tests.
- Modify (hand): `plugins/codex/scripts/stop-review-gate-hook.mjs` — timeout constants, `spawnSync` options, timeout message.

**Interfaces:**
- Produces: `STOP_REVIEW_TIMEOUT_MINUTES = 13`, `STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_TIMEOUT_MINUTES * 60 * 1000` (< hooks.json `Stop.timeout: 900`); the `spawnSync` call uses `timeout: STOP_REVIEW_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024`; the user-facing timeout message says `${STOP_REVIEW_TIMEOUT_MINUTES} minutes` (no literal "15 minutes" anywhere in the file).

- [ ] **Step 1: Merge**

```bash
for n in 672 668 682 396; do git fetch upstream pull/$n/head:pr/$n && git merge --no-ff --no-edit pr/$n || break; done
```
#682 (`runStopReview` input validation) and #396 (round cap in `main`) both touch the stop hook's `main` flow — likely a clean textual merge, but verify the combined behaviour by reading: malformed stdin must be rejected BEFORE any round-state mutation, and the round counter must increase only on a real `block`. If #396's counter increments before #682's validation runs, reorder so validation comes first.

- [ ] **Step 2: Failing test for the timeout ordering and message**

Append to `tests/commands.test.mjs`:

```js
test("stop gate script timeout is shorter than the Stop hook timeout and its message matches", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const stopTimeoutSeconds = hooks.hooks.Stop[0].hooks[0].timeout;
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs"), "utf8");
  const minutes = source.match(/const STOP_REVIEW_TIMEOUT_MINUTES = (\d+);/);
  assert.ok(minutes, "STOP_REVIEW_TIMEOUT_MINUTES must be a named constant");
  assert.match(source, /const STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_TIMEOUT_MINUTES \* 60 \* 1000;/);
  assert.ok(Number(minutes[1]) * 60 < stopTimeoutSeconds, "script timeout must be below the hook timeout");
  assert.doesNotMatch(source, /15 minutes/);
  assert.match(source, /\$\{STOP_REVIEW_TIMEOUT_MINUTES\} minutes/);
  assert.match(source, /killSignal: "SIGKILL"/);
  assert.match(source, /maxBuffer: 16 \* 1024 \* 1024/);
});
```
(`fs`, `path`, `PLUGIN_ROOT` are already imported/defined at the top of `tests/commands.test.mjs`.)

- [ ] **Step 3: Run it — expect FAIL** (no `STOP_REVIEW_TIMEOUT_MINUTES`, literal "15 minutes" present at ~line 116).

Run: `node --import ./tests/test-env.mjs --test --test-name-pattern 'stop gate script timeout' tests/commands.test.mjs`

- [ ] **Step 4: Fix**

In `plugins/codex/scripts/stop-review-gate-hook.mjs`: replace `const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;` with
```js
const STOP_REVIEW_TIMEOUT_MINUTES = 13;
const STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_TIMEOUT_MINUTES * 60 * 1000;
```
In the `spawnSync(process.execPath, [...], { ... timeout: STOP_REVIEW_TIMEOUT_MS ... })` call add `killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024` (the default 1 MiB `maxBuffer` kills a chatty child; `SIGTERM` can be ignored, `SIGKILL` cannot). Replace the literal `15 minutes` in the timeout message (~line 116) with `${STOP_REVIEW_TIMEOUT_MINUTES} minutes` (make that string a template literal if it isn't).

- [ ] **Step 5: Test** → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/stop-review-gate-hook.mjs tests/commands.test.mjs
git commit -m "fix(stop-gate): keep script timeout below the Stop hook timeout" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Per-thread `config` overrides — model, effort, and repeatable `--config key=value`

Why: `ReviewStartParams` has no model/effort (#476/#651), `thread/start.model` is not reliably honoured (#408), but `ThreadStartParams.config` / `ThreadResumeParams.config` are. One place (`buildThreadParams`) fixes review + adversarial + task, and `--config` replaces the 555-line `CODEX_PLUGIN_CC_ARGS` PR (#419) for the per-run case.

Codex-review rulings baked in (ledger 2026-08-27): (a) **resume never mirrors `--effort` into `thread/resume.config`** — on a cold resume `config.model_reasoning_effort` counts as a model override and cancels the persisted `model`/`model_provider` (app-server `has_model_resume_override`), so `task --resume-last --effort max` would silently switch models; effort on resume goes only through the existing `turn/start.effort`. Explicit `--config` pairs DO pass on resume (user asked for them). (b) **precedence**: generic `--config` first, dedicated `--model`/`--effort` override it, so `review` and `task` behave identically. (c) **native review sets `review_model` too**: Codex's `/review` honours a separate `review_model` override, so `--model` on `review` must set both `config.model` and `config.review_model`. (d) **parsing happens once, after `normalizeArgv`**, inside `parseArgs` (slash commands deliver `"$ARGUMENTS"` as ONE argv element; #547 makes unknown options errors) — a pre-pass collector cannot see `--config` and would then be rejected. (e) **prompt-taking commands stop option parsing at the first positional** (`task`, `adversarial-review` focus text): `task --effort max investigate ls -R usage` must keep `-R` in the prompt (#547 regression).

**Files:**
- Modify: `plugins/codex/scripts/lib/args.mjs` — `parseArgs` gains `repeatableOptions` and `stopAtFirstPositional`.
- Modify: `plugins/codex/scripts/lib/codex.mjs` — `buildThreadConfig` (new, exported), `buildThreadParams`, `buildResumeParams`, `runAppServerReview`, `runAppServerTurn`.
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `MODEL_ALIASES`; `parseConfigOverrides` (new); `handleReviewCommand`; `executeReviewRun`; `handleTask`; `buildTaskRequest`; `executeTaskRun`; `printUsage`.
- Modify: `tests/fake-codex-fixture.mjs` — store full `thread/start`/`thread/resume` params; compute the response's `model`/`reasoningEffort` from `params.model ?? params.config?.model` and `params.config?.model_reasoning_effort`.
- Test: `tests/args.test.mjs` (exists after #547), `tests/thread-config.test.mjs` (new), `tests/runtime.test.mjs`.

**Interfaces:**
- Consumes: `normalizeRequestedModel(model)`, `normalizeReasoningEffort(effort)` (codex-companion.mjs ~103/~115); `normalizeArgv(argv)` (codex-companion.mjs ~140, splits a single `"$ARGUMENTS"` string); `parseArgs(argv, { valueOptions, booleanOptions?, … })` in `lib/args.mjs` as left by #547 — read it first.
- Produces:
  - `parseArgs(argv, { …, repeatableOptions: ["config"], stopAtFirstPositional: true })` → `options.config` is `string[]` (each `key=value`), `--config=key=value` accepted, `--` ends option parsing, and with `stopAtFirstPositional` every token from the first positional on is a positional (no option parsing inside the prompt).
  - `parseConfigOverrides(list: string[])` → `Record<string,string>`; throws `--config expects key=value, got "<x>".` when `=` is missing or the key is empty; later duplicates win.
  - `buildThreadConfig({ model, effort, config, reviewModel })` → `{ ...config(parsed), model?, review_model?, model_reasoning_effort? } | null` (exported from `lib/codex.mjs`); dedicated keys are written AFTER the generic map.
  - `buildThreadParams(cwd, options)` → adds `config: buildThreadConfig(options)`; `buildResumeParams(threadId, cwd, options)` → adds `config: buildThreadConfig({ config: options.config })` (no model, no effort).
  - `runAppServerReview(cwd, { model, effort, config, … })` starts its thread with `{ model, effort, config, reviewModel: model }`; `runAppServerTurn(cwd, { model, effort, config, … })` passes `{ model, effort, config }` to `startThread` and `{ config }` to `resumeThread` (plus `effort` on `turn/start` as today).
  - CLI: `review|adversarial-review [--effort <e>] [--config key=value]...`, `task [--config key=value]...`.
  - `MODEL_ALIASES`: `spark→gpt-5.3-codex-spark`, `sol→gpt-5.6-sol`, `luna→gpt-5.6-luna`, `terra→gpt-5.6-terra`, `mini→gpt-5.4-mini`.

- [ ] **Step 1: Failing unit tests for `buildThreadConfig`**

Create `tests/thread-config.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildThreadConfig } from "../plugins/codex/scripts/lib/codex.mjs";

test("buildThreadConfig returns null when nothing is set", () => {
  assert.equal(buildThreadConfig({}), null);
  assert.equal(buildThreadConfig({ config: {} }), null);
});

test("buildThreadConfig maps model, review model and effort to Codex config keys", () => {
  assert.deepEqual(buildThreadConfig({ model: "gpt-5.6-sol", effort: "max", reviewModel: "gpt-5.6-sol" }), {
    model: "gpt-5.6-sol",
    review_model: "gpt-5.6-sol",
    model_reasoning_effort: "max"
  });
});

test("buildThreadConfig lets dedicated flags win over generic overrides and parses JSON-ish values", () => {
  assert.deepEqual(
    buildThreadConfig({
      effort: "max",
      config: { model_reasoning_effort: "low", "sandbox_workspace_write.network_access": "true", model_provider: "ollama", n: "3" }
    }),
    { "sandbox_workspace_write.network_access": true, model_provider: "ollama", n: 3, model_reasoning_effort: "max" }
  );
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildThreadConfig` not exported).

Run: `node --import ./tests/test-env.mjs --test tests/thread-config.test.mjs`

- [ ] **Step 3: Implement in `lib/codex.mjs`** (Serena: `insert_before_symbol` `buildThreadParams` for the helpers, `replace_symbol_body` on `buildThreadParams` and `buildResumeParams`)

```js
function parseConfigValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function buildThreadConfig({ model, effort, config, reviewModel } = {}) {
  const merged = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    merged[key] = parseConfigValue(value);
  }
  if (model) {
    merged.model = model;
  }
  if (reviewModel) {
    merged.review_model = reviewModel;
  }
  if (effort) {
    merged.model_reasoning_effort = effort;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    config: buildThreadConfig(options),
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}
```
In `buildResumeParams` add `config: buildThreadConfig({ config: options.config }),` next to `sandbox` — **only** the generic overrides; never `model`/`effort` (resume ruling above).

- [ ] **Step 4: Thread the options through `lib/codex.mjs`** — `runAppServerReview`: the `startThread(client, cwd, { model: options.model, sandbox: "read-only", … })` call gets `effort: options.effort, config: options.config, reviewModel: options.model`. `runAppServerTurn`: the `startThread(...)` call gets `effort: options.effort, config: options.config`; the `resumeThread(...)` call gets `config: options.config` only. Keep `effort: options.effort ?? null` on `turn/start` as today.

- [ ] **Step 5: Unit test passes**

Run: `node --import ./tests/test-env.mjs --test tests/thread-config.test.mjs` → 3 pass.

- [ ] **Step 6: Failing parser tests** — append to `tests/args.test.mjs` (created by #547; it imports `parseArgs` from `../plugins/codex/scripts/lib/args.mjs`):

```js
test("parseArgs collects repeatable options and honours -- and --opt=value", () => {
  const { options, positionals } = parseArgs(
    ["--config", "a=1", "--config=b=x=y", "--model", "sol", "--", "--not-an-option", "tail"],
    { valueOptions: ["model"], repeatableOptions: ["config"] }
  );
  assert.deepEqual(options.config, ["a=1", "b=x=y"]);
  assert.equal(options.model, "sol");
  assert.deepEqual(positionals, ["--not-an-option", "tail"]);
});

test("parseArgs with stopAtFirstPositional keeps option-looking prompt words", () => {
  const { options, positionals } = parseArgs(
    ["--effort", "max", "investigate", "ls", "-R", "usage", "--model", "x"],
    { valueOptions: ["effort", "model"], stopAtFirstPositional: true }
  );
  assert.equal(options.effort, "max");
  assert.equal(options.model, undefined);
  assert.deepEqual(positionals, ["investigate", "ls", "-R", "usage", "--model", "x"]);
});

test("parseArgs rejects a repeatable option without a value", () => {
  assert.throws(() => parseArgs(["--config"], { repeatableOptions: ["config"] }), /--config/);
});
```

- [ ] **Step 7: Run — expect FAIL.** `node --import ./tests/test-env.mjs --test tests/args.test.mjs`

- [ ] **Step 8: Extend `parseArgs` in `lib/args.mjs`** — read the post-#547 implementation first and add, following its existing style: `config.repeatableOptions` (array of names; each occurrence pushes onto `options[name]`, `--name=value` form included, missing value throws the same error shape #547 uses for missing values), a `--` sentinel (everything after it is positional), and `config.stopAtFirstPositional` (once a token is not an option, all remaining tokens are positionals). Do not change behaviour for callers that pass neither new key.

- [ ] **Step 9: Parser tests pass.**

- [ ] **Step 10: Failing runtime tests** — append to `tests/runtime.test.mjs` (helpers `makeTempDir`, `installFakeCodex`, `initGitRepo`, `run`, `buildEnv`, `SCRIPT` exist at the top of the file):

```js
function seededRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("review forwards model, review_model, effort and config overrides into thread/start config", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run(
    "node",
    [SCRIPT, "review", "--wait", "--model", "sol", "--effort", "max", "--config", "model_provider=ollama", "--config", "foo.bar=3"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, {
    model_provider: "ollama",
    "foo.bar": 3,
    model: "gpt-5.6-sol",
    review_model: "gpt-5.6-sol",
    model_reasoning_effort: "max"
  });
});

test("review accepts slash-command style single-string arguments", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run("node", [SCRIPT, "review", "--wait --effort xhigh --config model_provider=ollama"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_provider: "ollama", model_reasoning_effort: "xhigh" });
});

test("task forwards config overrides and keeps option-looking prompt words", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--effort", "max", "--config", "model_provider=ollama", "investigate", "ls", "-R", "usage"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_provider: "ollama", model_reasoning_effort: "max" });
  assert.match(JSON.stringify(fakeState.lastTurnStart.input), /investigate ls -R usage/);
});

test("task --resume-last never puts model or effort into thread/resume config", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const first = run("node", [SCRIPT, "task", "--model", "sol", "--effort", "high", "first"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);
  const second = run("node", [SCRIPT, "task", "--resume-last", "--effort", "max", "--config", "model_provider=ollama", "again"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(second.status, 0, second.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadResume.config, { model_provider: "ollama" });
  assert.equal(fakeState.lastTurnStart.effort, "max");
});

test("task --background stores config overrides in the job request", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--background", "--json", "--config", "model_provider=ollama", "bg"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const jobId = JSON.parse(result.stdout).jobId;
  const done = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(done.status, 0, done.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_provider: "ollama" });
});
```
(If the fixture's existing `thread/resume` handler does not record `lastThreadResume`, or `status --wait --json` has a different output shape, adapt the test to what `tests/runtime.test.mjs` already does for `--resume-last` and `--background` — copy the surrounding test's mechanics, keep these assertions.)

- [ ] **Step 11: Run — expect FAIL.**

- [ ] **Step 12: Implement the CLI side in `codex-companion.mjs` — exact call chain (do every item):**

1. `MODEL_ALIASES`:
```js
const MODEL_ALIASES = new Map([
  ["spark", "gpt-5.3-codex-spark"],
  ["sol", "gpt-5.6-sol"],
  ["luna", "gpt-5.6-luna"],
  ["terra", "gpt-5.6-terra"],
  ["mini", "gpt-5.4-mini"]
]);
```
2. Insert after `normalizeReasoningEffort`:
```js
function parseConfigOverrides(list = []) {
  const config = {};
  for (const pair of list) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--config expects key=value, got "${pair}".`);
    }
    config[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return config;
}
```
3. `handleReviewCommand(argv, config)` (~line 712): its `parseArgs(normalizeArgv(argv), { valueOptions: [...] })` call gets `"effort"` added to `valueOptions`, `repeatableOptions: ["config"]`, and — for the adversarial variant, which takes focus text — `stopAtFirstPositional: true` (native `review` takes no positionals; keep strict there). Next to `const model = normalizeRequestedModel(options.model);` add `const effort = normalizeReasoningEffort(options.effort);` and `const configOverrides = parseConfigOverrides(options.config);`. Put `effort` and `config: configOverrides` into the request object built at ~line 742 (the one that already carries `model`).
4. `executeReviewRun(request)` (~line 358): pass `effort: request.effort, config: request.config` into BOTH the native call `runAppServerReview(cwd, { model: request.model, … })` (~line 370) and the adversarial call `runAppServerTurn(cwd, { model: request.model, … })` (~line 411).
5. `handleTask(argv)` (~line 767): `parseArgs` call gets `repeatableOptions: ["config"]` and `stopAtFirstPositional: true`; compute `const configOverrides = parseConfigOverrides(options.config);`; pass `config: configOverrides` into BOTH the background request (~line 793) and the foreground request (~line 811).
6. `buildTaskRequest(...)` (~lines 604–613): add `config` to its parameters and to the returned object (otherwise the stored background job loses it; `handleTaskWorker` ~line 875 already spreads the stored request).
7. `executeTaskRun(request)` (~line 485): pass `config: request.config` into `runAppServerTurn`.
8. `printUsage()`: add `[--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--config key=value]...` to the review/adversarial-review lines, `[--config key=value]...` to the task line, and `sol|luna|terra|mini` next to `spark` in every `--model <model|spark>` hint.

- [ ] **Step 12b: Decline form-mode MCP elicitations (Codex merge-review finding)** — #501 auto-accepts every `mcpServer/elicitation/request` with `content: null`; for `params.mode === "form"` or `"openai/form"` the app-server contract requires structured content, so the tool call fails or proceeds without the requested values. First append to `tests/app-server.test.mjs` (it already exercises `handleServerRequest` for the URL case — copy its mechanics):

```js
test("form-mode elicitation requests are declined instead of accepted with empty content", () => {
  // Arrange exactly like the existing accept test, but with params.mode = "form".
  // Assert the reply is { action: "decline" } (no content), and that mode "url" still gets { action: "accept", content: null, _meta: null }.
});
```
Fill the body by mirroring the existing test's setup for the request/response capture. Then in `plugins/codex/scripts/lib/app-server.mjs` `handleServerRequest`: when `message.params?.mode === "form" || message.params?.mode === "openai/form"` respond with `{ action: "decline" }`; keep the accept path for every other mode. Run: `node --import ./tests/test-env.mjs --test tests/app-server.test.mjs` → all pass.

- [ ] **Step 13: Fixture** — in `tests/fake-codex-fixture.mjs`: `thread/start` stores the full params as `state.lastThreadStart = params` (keep whatever #688/#426/#645 already record alongside), `thread/resume` stores `state.lastThreadResume = params`; the `ThreadStartResponse`/`ThreadResumeResponse` it fabricates derive `model` from `params.model ?? params.config?.model ?? <its current default>` and `reasoningEffort` from `params.config?.model_reasoning_effort ?? <current default>` so #645's `resolved` reflects config precedence.

- [ ] **Step 14: Test** → `fail 0` (gate command).

- [ ] **Step 15: Docs** — `plugins/codex/commands/{review,adversarial-review}.md` `argument-hint`: add `[--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--config key=value]`; `rescue.md` + `task` line: `[--model <model|spark|sol|luna|terra|mini>]`, `[--config key=value]`; `skills/codex-cli-runtime/SKILL.md`: one line "`--config key=value` (repeatable) forwards a `config.toml` override to the Codex thread (`thread/start.config`; on `--resume-last` only these overrides are sent, model/effort are not re-applied), e.g. `--config model_provider=ollama`". README "Notes" bullet for aliases + `--config` + the resume rule. Update `tests/commands.test.mjs` regexes that assert the old `--model <model\|spark>` text if they now fail.

- [ ] **Step 16: Commit**

```bash
git add plugins/codex tests README.md
git commit -m "feat: per-thread config overrides (--config), effort on reviews, gpt-5.6 model aliases" -m "Model and reasoning effort are sent via thread/start.config (ReviewStartParams has no such fields; thread/start.model is unreliable). Closes upstream #476 #651 #468 #408 for this fork." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `/codex:rescue` returns a result — synchronous path without `Agent`, visible failures, model aliases, agent-compat hint

Why (Codex-review ruling): since Claude Code 2.1.232 every `Agent` subagent runs in the background and the caller gets "Async agent launched…" — the 11/12 placeholder results in Aug 2026 were host behaviour, not the plugin's `task --background`. #608 (merged in Task 4) only makes the agent's inner Bash foreground; it cannot make the outer `Agent` synchronous. So the default (`--wait`) rescue path must not go through `Agent` at all: the slash command runs the companion inline via Bash — `task --background` (returns a job id immediately, keeps the 10-min Bash cap out of the way), then `status <id> --wait` in ≤9-minute slices until the job finishes, then `result <id>`. `Agent` is used only when the user asks for `--background`. Separately, the agent's "if Bash fails return nothing" rule turned auth/timeout failures into silent losses — failures must be visible.

**Files:**
- Modify: `plugins/codex/commands/rescue.md` (body: inline synchronous flow; `Agent` only for `--background`)
- Modify: `plugins/codex/agents/codex-rescue.md` (remove `model:` line; failure reporting)
- Modify: `plugins/codex/skills/codex-cli-runtime/SKILL.md` (aliases; failure rule; agent-compat hint)
- Test: `tests/commands.test.mjs`

**Interfaces:**
- Consumes: companion CLI `task --background --json` → stdout JSON with `jobId`; `status <jobId> --wait --timeout-ms <ms> --json` (exits 0 when the job reached a terminal state, non-zero on wait timeout — check `handleStatus` in `codex-companion.mjs` for the exact exit code and reuse it); `result <jobId>`.
- Produces: `commands/rescue.md` body below; `agents/codex-rescue.md` without a `model:` key (omission = inherit, and the docs say `CLAUDE_CODE_SUBAGENT_MODEL`/per-call `model` can still override — do not claim otherwise); SKILL.md sentences the test asserts.

- [ ] **Step 1: Failing test** — first open `tests/commands.test.mjs` and find the assertions #608/#616 left for the rescue command, agent and skill (`rescue command absorbs continue semantics`); update any assertion that contradicts the new contract (e.g. regexes requiring the `Agent` tool for the default path, or `return nothing`) rather than deleting the test. Then append:

```js
test("rescue runs synchronously through the companion and uses Agent only for --background", () => {
  const rescue = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", "rescue.md"), "utf8");
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "codex-rescue.md"), "utf8");
  const runtimeSkill = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "codex-cli-runtime", "SKILL.md"), "utf8");
  assert.match(rescue, /task --background --json/);
  assert.match(rescue, /status "\$JOB" --wait --timeout-ms 540000/);
  assert.match(rescue, /result "\$JOB"/);
  assert.match(rescue, /Only when the request contains `--background`.*Agent/s);
  assert.doesNotMatch(agent, /^model:/m);
  assert.doesNotMatch(agent, /return nothing/i);
  assert.match(agent, /exit status and stderr/i);
  assert.doesNotMatch(runtimeSkill, /return nothing/i);
  assert.match(runtimeSkill, /Map `sol` to `--model gpt-5\.6-sol`/i);
  assert.match(runtimeSkill, /\$agent-compat:skill-router/);
});
```

- [ ] **Step 2: Run — expect FAIL.** `node --import ./tests/test-env.mjs --test --test-name-pattern 'rescue' tests/commands.test.mjs`

- [ ] **Step 3: Rewrite `plugins/codex/commands/rescue.md`** — keep the frontmatter's `description` and `allowed-tools: Bash(node:*), AskUserQuestion, Agent`; set `argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--config key=value]... [what Codex should investigate, solve, or continue]"`. Body:

````markdown
Delegate the request to Codex through the shared companion runtime. Default is synchronous: the user gets Codex's answer in this turn.

1. Strip `--wait` if present (it is the default). If the request contains `--resume`, use `task --resume-last`; if `--fresh`, use a fresh `task`; otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json` and follow its recommendation. Pass `--model`, `--effort` and every `--config key=value` through unchanged. Never add `--write` unless the user explicitly asked Codex to modify files.

2. Start the job and wait for it, in ≤9-minute slices so the Bash tool's 10-minute cap never kills a long run:

```bash
JOB=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --json <flags> "<request text>" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).jobId))')
until node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$JOB" --wait --timeout-ms 540000 --json >/dev/null; do :; done
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$JOB"
```
Run the `until` loop as one Bash call with `timeout: 600000`; if it returns because Bash timed out, run the same `until … done` line again — the job keeps running in the background. Show the `result` output to the user verbatim, then add your own assessment.

3. Only when the request contains `--background`: invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`, prompt = the raw request minus `--background`) and tell the user the job id will arrive as a completion notification; they can also run `/codex:status` and `/codex:result <job-id>`.

Do not call `Skill(codex:rescue)` from here (it re-enters this command). If any Bash step exits non-zero, show its stderr to the user — never report "no result".
````

- [ ] **Step 4: Edit `agents/codex-rescue.md`** — delete the `model: sonnet` line entirely. Replace the sentence that says to return nothing when the Bash call fails with: "If the Bash call fails or Codex cannot be invoked, return the command's exit status and stderr verbatim so the failure is visible; never return an empty result." Also (Codex merge-review P1): the agent's single foreground `task` Bash call dies at the Bash tool's 10-minute cap even when the agent itself runs in the background, losing long results and leaving stale jobs. Replace the "exactly one foreground Bash call" instruction with the same detached pattern the slash command uses — `task --background --json` to get `jobId`, then `status "$JOB" --wait --timeout-ms 540000 --json` in a loop until it exits 0, then `result "$JOB"` — and delete the rule that forbids the agent from polling `status`/`result` (it may poll its own job only). Update the corresponding `tests/commands.test.mjs` assertions (the #608 regexes about the foreground inner Bash call) to the new contract. Add to the Step 1 test: `assert.match(agent, /task --background --json/); assert.match(agent, /status "\$JOB" --wait --timeout-ms 540000/); assert.doesNotMatch(agent, /Do not .*poll status/i);`

- [ ] **Step 5: Edit `skills/codex-cli-runtime/SKILL.md`** — (a) after the line `Map \`spark\` to \`--model gpt-5.3-codex-spark\`…` add `- Map \`sol\` to \`--model gpt-5.6-sol\`, \`luna\` to \`--model gpt-5.6-luna\`, \`terra\` to \`--model gpt-5.6-terra\`, \`mini\` to \`--model gpt-5.4-mini\`.`; (b) replace the "return nothing" failure rule with the same visible-failure sentence as the agent; (c) add under "Command selection": `- If the request names an uncommon domain (private infra runbooks, vendor-specific tooling), prepend to the task text: "If a matching skill is not already loaded, run \`$agent-compat:skill-router\` to find a reviewed playbook before starting." (Codex has the agent-compat plugin installed; it routes to reviewed route-only skills offline.)`

- [ ] **Step 6: Test** → `fail 0` (gate command). Also `rg -n 'return nothing' plugins/codex` → no output.

- [ ] **Step 7: Commit**

```bash
git add plugins/codex/commands/rescue.md plugins/codex/agents/codex-rescue.md plugins/codex/skills/codex-cli-runtime/SKILL.md tests/commands.test.mjs
git commit -m "feat(rescue): synchronous inline path (no Agent), visible failures, gpt-5.6 aliases, agent-compat hint" -m "Claude Code >=2.1.232 runs every Agent subagent in the background, so the default rescue path now drives the companion directly: task --background, status --wait slices, result." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Release v1.1.0 — marketplace `cbepx`, CHANGELOG, version bump, tag, install

**Files:**
- Modify: `.claude-plugin/marketplace.json` (`name: "cbepx"`, `owner: {name: "CBEPX", url: "https://github.com/CBEPX"}`, version)
- Modify: `plugins/codex/.claude-plugin/plugin.json` (version via `npm run bump-version`; keep `name: "codex"`)
- Modify: `package.json` (`name: "@cbepx/codex-plugin-cc"`, version)
- Modify: `README.md` (fork notice at top)
- Create: `CHANGELOG.md` (repo root; upstream has none)
- Test: `tests/bump-version.test.mjs` (existing — must stay green), `tests/commands.test.mjs`

- [ ] **Step 1: Failing test — marketplace identity**

Append to `tests/commands.test.mjs`:

```js
test("marketplace is published under cbepx while the plugin keeps the codex name", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(marketplace.name, "cbepx");
  assert.equal(marketplace.owner.name, "CBEPX");
  assert.equal(plugin.name, "codex");
  assert.equal(marketplace.plugins[0].name, "codex");
  assert.equal(marketplace.plugins[0].version, plugin.version);
});
```
(`ROOT` is defined at the top of `tests/commands.test.mjs` as the repo root; if it is named differently there, use that name.)

- [ ] **Step 2: Run — expect FAIL** (`openai-codex`).

- [ ] **Step 3: Bump + rename**

```bash
npm run bump-version -- 1.1.0 && npm run check-version
```
Then edit `.claude-plugin/marketplace.json`: `"name": "cbepx"`, `"owner": { "name": "CBEPX", "url": "https://github.com/CBEPX" }`, `metadata.description`: `"CBEPX fork of the OpenAI Codex plugin for Claude Code: max/ultra effort, per-thread config overrides, gpt-5.6 aliases, rescue agent fixes."`. `package.json` `"name": "@cbepx/codex-plugin-cc"`.

- [ ] **Step 4: `CHANGELOG.md`**

```markdown
# Changelog

## 1.1.0 — 2026-08-27

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 1.0.6 (`db52e28`). Marketplace `cbepx`, plugin name unchanged (`codex`).

### Merged from upstream pull requests
- #616 accept `max` and `ultra` reasoning efforts
- #688 resolve model aliases on `review` / `adversarial-review`
- #426 `on-request` approval policy for `--write` task runs
- #501 answer MCP elicitation requests instead of rejecting them
- #608 rescue agent awaits the delegated result instead of returning a placeholder
- #690 explicit Bash blocks in `status`/`result`/`cancel`/`transfer` commands (pass permission classifiers)
- #547 `task --help` and unknown flags are CLI errors, never a prompt
- #645 / #644 job records store resolved model/effort/sandbox; reasoning start is logged
- #672 SessionStart hook timeout raised; #668 idempotent `CLAUDE_ENV_FILE` exports; #682 stop gate fails closed on malformed input; #396 `CODEX_REVIEW_GATE_MAX_ROUNDS`

### Fork changes
- Model and reasoning effort are sent per thread via `thread/start.config` (`model`, `model_reasoning_effort`); `--effort` now works on `review` and `adversarial-review`.
- Repeatable `--config key=value` on `task`, `review`, `adversarial-review` forwards any `config.toml` override to the thread.
- Model aliases: `sol`, `luna`, `terra`, `mini` (plus `spark`).
- Rescue agent: `model: inherit`; skill mentions `$agent-compat:skill-router` for uncommon domains.
- Stop-gate script timeout (13 min) is below the hook timeout (15 min).
- Hermetic test environment; CI on push.

## 1.0.6 and earlier
See upstream releases: https://github.com/openai/codex-plugin-cc/releases
```

- [ ] **Step 5: README fork notice** — insert after the first heading:

```markdown
> **CBEPX fork.** Install with `claude plugin marketplace add CBEPX/codex-plugin-cc` then `claude plugin install codex@cbepx`. Differences from upstream are listed in [CHANGELOG.md](CHANGELOG.md). Upstream: openai/codex-plugin-cc.
```

- [ ] **Step 6: Test** → `fail 0` (including `bump-version.test.mjs`).

- [ ] **Step 7: Validate the plugin manifest**

Run: `claude plugin validate . --strict 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 8: Commit, tag, push**

```bash
git add -A && git commit -m "chore(release): v1.1.0 — cbepx marketplace, changelog" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag -a v1.1.0 -m "v1.1.0"
git push -u origin release/v1.1.0 --tags
```

- [ ] **Step 9: Merge to main via PR on the fork** (keeps CI history)

```bash
gh pr create -R CBEPX/codex-plugin-cc --base main --head release/v1.1.0 --title "release: v1.1.0" --body "$(sed -n '3,40p' CHANGELOG.md)"
```
Wait for CI (`gh pr checks --watch`), then `gh pr merge --merge` and `git checkout main && git pull`.

- [ ] **Step 10: Switch the local Claude Code install**

```bash
claude plugin marketplace add CBEPX/codex-plugin-cc
claude plugin install codex@cbepx -y
claude plugin disable codex@openai-codex
```
Then in `~/.claude/settings.json` confirm `enabledPlugins["codex@cbepx"] === true` and `codex@openai-codex === false` (uninstall the upstream copy only after one successful `/codex:status` from the new install).

---

## Verification (end-to-end, in a fresh Claude Code session inside `~/project/infra` or any git repo)

1. `/codex:status` — renders (command body is an explicit Bash block; no classifier prompt).
2. `/codex:rescue --model sol --effort max Strictly read-only: summarize the last commit` — the answer arrives **in the same turn** (inline companion path, no `Agent`); `/codex:status --all` shows the job with `model: gpt-5.6-sol`, `effort: max` (resolved fields from #645).
3. `node ~/.claude/plugins/cache/cbepx/codex/1.1.0/scripts/codex-companion.mjs review --wait --model sol --effort xhigh --json` → the job record's resolved model is `gpt-5.6-sol` and effort `xhigh` even with a conflicting `review_model` set in `~/.codex/config.toml` for the test (set it temporarily, then remove).
4. Cold resume: `task --model sol --effort high "first"` then `task --resume-last --effort max "again"` → `status --json` of the second job still reports model `gpt-5.6-sol` (not the config default) and effort `max`.
5. `node … task --effort supreme x` → `Unsupported reasoning effort "supreme". Use one of: … max, ultra.`; `task --effort max investigate ls -R usage` → prompt reaches Codex intact (no `Unknown option: -R`).
6. `/codex:setup --enable-review-gate` in a scratch repo, make an edit, stop → gate runs and finishes < 13 min or reports its own "13 minutes" timeout message.
7. `npm test` inside the Claude session → `fail 0` (exit-status-checked, never via a pipe).
