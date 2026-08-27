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

Run: `CLAUDE_PLUGIN_DATA=/tmp/leak npm test 2>&1 | grep -E 'ℹ (pass|fail)'`
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

Run: `CLAUDE_PLUGIN_DATA=/tmp/leak npm test 2>&1 | grep -E 'ℹ (tests|pass|fail)'`
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

Run: `npm test 2>&1 | grep -E 'ℹ (tests|pass|fail)|^not ok'`
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

- [ ] **Step 2: Test** — `npm test … | grep ℹ` → `fail 0`.

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

Run: `npm test … | grep -E 'ℹ|^not ok'` → `fail 0`; `tests/app-server.test.mjs` present and passing.

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

Run: `grep -l '^!`' plugins/codex/commands/*.md`
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

- [ ] **Step 2: Test** → `fail 0`.

- [ ] **Step 3: Smoke**

Run: `node plugins/codex/scripts/codex-companion.mjs task --help 2>&1 | head -3; echo "exit=$?"`
Expected: usage text on stderr, non-zero exit, **no** Codex thread started.

---

### Task 6: Merge hook hardening — #672, #668, #682, #396 — and fix the stop-gate timeout collision

**Files:** (via merge) `plugins/codex/hooks/hooks.json` (SessionStart timeout 5→30), `plugins/codex/scripts/session-lifecycle-hook.mjs` (`appendEnvVar` idempotent), `plugins/codex/scripts/stop-review-gate-hook.mjs` (fail closed on malformed stdin; `CODEX_REVIEW_GATE_MAX_ROUNDS`), `README.md`, tests.
- Modify (hand): `plugins/codex/scripts/stop-review-gate-hook.mjs` — `STOP_REVIEW_TIMEOUT_MS`.

**Interfaces:**
- Produces: `STOP_REVIEW_TIMEOUT_MS = 13 * 60 * 1000` (< hooks.json `Stop.timeout: 900`), so the script's own timeout message renders before Claude Code kills the hook.

- [ ] **Step 1: Merge**

```bash
for n in 672 668 682 396; do git fetch upstream pull/$n/head:pr/$n && git merge --no-ff --no-edit pr/$n || break; done
```
Possible conflict in `stop-review-gate-hook.mjs` between #682 (`runStopReview` input validation) and #396 (round cap in `main`) — different functions, keep both.

- [ ] **Step 2: Failing test for the timeout ordering**

Append to `tests/commands.test.mjs`:

```js
test("stop gate script timeout is shorter than the Stop hook timeout", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const stopTimeoutSeconds = hooks.hooks.Stop[0].hooks[0].timeout;
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs"), "utf8");
  const match = source.match(/const STOP_REVIEW_TIMEOUT_MS = (\d+) \* 60 \* 1000;/);
  assert.ok(match, "STOP_REVIEW_TIMEOUT_MS must be expressed as N * 60 * 1000");
  assert.ok(Number(match[1]) * 60 < stopTimeoutSeconds, "script timeout must be below the hook timeout");
});
```
(`fs`, `path`, `PLUGIN_ROOT` are already imported/defined at the top of `tests/commands.test.mjs`.)

- [ ] **Step 3: Run it — expect FAIL** (`15 * 60 < 900` is false).

Run: `npm test 2>&1 | grep -B2 -A6 'stop gate script timeout'`

- [ ] **Step 4: Fix**

In `plugins/codex/scripts/stop-review-gate-hook.mjs` change `const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;` to `const STOP_REVIEW_TIMEOUT_MS = 13 * 60 * 1000;`.

- [ ] **Step 5: Test** → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/stop-review-gate-hook.mjs tests/commands.test.mjs
git commit -m "fix(stop-gate): keep script timeout below the Stop hook timeout" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Per-thread `config` overrides — model, effort, and repeatable `--config key=value`

Why: `ReviewStartParams` has no model/effort (#476/#651), `thread/start.model` is not reliably honoured (#408), but `ThreadStartParams.config` / `ThreadResumeParams.config` are. One place (`buildThreadParams`/`buildResumeParams`) fixes review + adversarial + task, and `--config` replaces the 555-line `CODEX_PLUGIN_CC_ARGS` PR (#419) for the per-run case.

**Files:**
- Modify: `plugins/codex/scripts/lib/codex.mjs` — `buildThreadParams` (line ~62), `buildResumeParams` (line ~73), `runAppServerReview` (pass `effort`, `config` into `startThread`), `runAppServerTurn` (pass `config` into `startThread`/`resumeThread`).
- Modify: `plugins/codex/scripts/codex-companion.mjs` — `MODEL_ALIASES`; `handleReviewCommand` (accept `--effort`, `--config`); `handleTask` (accept `--config`); `printUsage`.
- Modify: `tests/fake-codex-fixture.mjs` — record `lastThreadStart.config` (already records `lastThreadStart` after #688; add `config` if the fixture strips it).
- Test: `tests/runtime.test.mjs`.

**Interfaces:**
- Consumes: `normalizeRequestedModel(model)`, `normalizeReasoningEffort(effort)` (existing, codex-companion.mjs ~103/~115), `parseArgs(argv, { valueOptions, repeatableOptions? })` — check `lib/args.mjs` after #547: if it has no repeatable-value support, collect `--config` manually as shown below.
- Produces:
  - `buildThreadConfig({ model, effort, config })` → `{ model?, model_reasoning_effort?, ...config } | null` (exported from `lib/codex.mjs`).
  - `runAppServerReview(cwd, { model, effort, config, … })`, `runAppServerTurn(cwd, { model, effort, config, … })`.
  - CLI: `review|adversarial-review [--effort <e>] [--config key=value]...`, `task [--config key=value]...`.
  - `MODEL_ALIASES`: `spark→gpt-5.3-codex-spark`, `sol→gpt-5.6-sol`, `luna→gpt-5.6-luna`, `terra→gpt-5.6-terra`, `mini→gpt-5.4-mini`.

- [ ] **Step 1: Failing unit test for `buildThreadConfig`**

Create `tests/thread-config.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildThreadConfig } from "../plugins/codex/scripts/lib/codex.mjs";

test("buildThreadConfig returns null when nothing is set", () => {
  assert.equal(buildThreadConfig({}), null);
});

test("buildThreadConfig maps model and effort to Codex config keys", () => {
  assert.deepEqual(buildThreadConfig({ model: "gpt-5.6-sol", effort: "max" }), {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "max"
  });
});

test("buildThreadConfig merges explicit overrides and parses JSON-ish values", () => {
  assert.deepEqual(
    buildThreadConfig({ effort: "high", config: { "sandbox_workspace_write.network_access": "true", model_provider: "ollama" } }),
    { model_reasoning_effort: "high", "sandbox_workspace_write.network_access": true, model_provider: "ollama" }
  );
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildThreadConfig` not exported).

Run: `node --import ./tests/test-env.mjs --test tests/thread-config.test.mjs`

- [ ] **Step 3: Implement in `lib/codex.mjs`** (Serena: `replace_symbol_body` on `buildThreadParams` and `buildResumeParams`, `insert_before_symbol` `buildThreadParams` for the helper)

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

export function buildThreadConfig({ model, effort, config } = {}) {
  const merged = {};
  if (model) {
    merged.model = model;
  }
  if (effort) {
    merged.model_reasoning_effort = effort;
  }
  for (const [key, value] of Object.entries(config ?? {})) {
    merged[key] = parseConfigValue(value);
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
and in `buildResumeParams` add the same `config: buildThreadConfig(options),` line next to `sandbox`.

- [ ] **Step 4: Thread the options through** — in `runAppServerReview` the `startThread(client, cwd, { model: options.model, sandbox: "read-only", … })` call gets `effort: options.effort, config: options.config`; in `runAppServerTurn` both `resumeThread(...)` and `startThread(...)` calls get `effort: options.effort, config: options.config` (keep the existing `effort` on `turn/start` too — harmless and covers models that read it there).

- [ ] **Step 5: Unit test passes**

Run: `node --import ./tests/test-env.mjs --test tests/thread-config.test.mjs` → 3 pass.

- [ ] **Step 6: Failing runtime test — review honours `--effort`/`--config`, task honours `--config`**

Append to `tests/runtime.test.mjs` (helpers `makeTempDir`, `installFakeCodex`, `initGitRepo`, `run`, `buildEnv`, `SCRIPT` exist at the top of the file):

```js
test("review forwards effort and config overrides into thread/start config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run(
    "node",
    [SCRIPT, "review", "--wait", "--model", "sol", "--effort", "max", "--config", "model_provider=ollama", "--config", "foo.bar=3"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "max",
    model_provider: "ollama",
    "foo.bar": 3
  });
});

test("task forwards config overrides into thread/start config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--effort", "max", "--config", "model_provider=ollama", "diagnose"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_reasoning_effort: "max", model_provider: "ollama" });
});
```

- [ ] **Step 7: Run — expect FAIL** (unknown flag `--effort` on review after #547's guard / `config` undefined).

- [ ] **Step 8: Implement CLI side in `codex-companion.mjs`**

Aliases:
```js
const MODEL_ALIASES = new Map([
  ["spark", "gpt-5.3-codex-spark"],
  ["sol", "gpt-5.6-sol"],
  ["luna", "gpt-5.6-luna"],
  ["terra", "gpt-5.6-terra"],
  ["mini", "gpt-5.4-mini"]
]);
```
Config collection helper (insert after `normalizeReasoningEffort`):
```js
function collectConfigOverrides(argv) {
  const config = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const inline = token.startsWith("--config=") ? token.slice("--config=".length) : null;
    if (token !== "--config" && inline === null) {
      rest.push(token);
      continue;
    }
    const pair = inline ?? argv[++index];
    const eq = pair?.indexOf("=") ?? -1;
    if (eq <= 0) {
      throw new Error(`--config expects key=value, got "${pair ?? ""}".`);
    }
    config[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { config, argv: rest };
}
```
In `handleReviewCommand(argv, config)` (first lines): `const overrides = collectConfigOverrides(argv); argv = overrides.argv;` then add `"effort"` to the `valueOptions` list of its `parseArgs` call, compute `const effort = normalizeReasoningEffort(options.effort);` next to the existing `const model = normalizeRequestedModel(options.model);` (added by #688), and pass `effort, config: overrides.config` into the request object that reaches `runAppServerReview`/`runAppServerTurn` (follow the `model` field — wherever `model` is placed into the review request, place `effort` and `config` beside it; `executeReviewRun` forwards the request to `runAppServerReview(cwd, { model: request.model, … })` — add `effort: request.effort, config: request.config` there and in `executeTaskRun`).
In `handleTask(argv)`: same `collectConfigOverrides` prologue; put `config: overrides.config` into the task request next to `effort`.
`printUsage()`: add `[--effort <…>] [--config key=value]...` to the review/adversarial-review lines and `[--config key=value]...` to the task line; add `sol|luna|terra|mini` next to `spark` in `--model <model|spark>` hints.

- [ ] **Step 9: Fixture** — if `tests/fake-codex-fixture.mjs` `thread/start` handler stores only selected fields into `lastThreadStart`, make it store the whole params object (`state.lastThreadStart = params;`).

- [ ] **Step 10: Test** → `fail 0`.

- [ ] **Step 11: Docs** — `plugins/codex/commands/{review,adversarial-review}.md` `argument-hint`: add `[--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--config key=value]`; `rescue.md` + `task` line: `[--model <model|spark|sol|luna|terra|mini>]`, `[--config key=value]`; `skills/codex-cli-runtime/SKILL.md`: one line "`--config key=value` (repeatable) forwards a `config.toml` override to the Codex thread (`thread/start.config`), e.g. `--config model_provider=ollama`". README "Notes" bullet for aliases + `--config`. Update `tests/commands.test.mjs` regexes that assert the old `--model <model\|spark>` text if they now fail.

- [ ] **Step 12: Commit**

```bash
git add plugins/codex tests README.md
git commit -m "feat: per-thread config overrides (--config), effort on reviews, gpt-5.6 model aliases" -m "Model and reasoning effort are sent via thread/start.config (ReviewStartParams has no such fields; thread/start.model is unreliable). Closes upstream #476 #651 #468 #408 for this fork." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Rescue agent — inherit the session model, current model names, agent-compat routing hint

**Files:**
- Modify: `plugins/codex/agents/codex-rescue.md` (frontmatter `model`, prose)
- Modify: `plugins/codex/skills/codex-cli-runtime/SKILL.md`
- Test: `tests/commands.test.mjs`

**Interfaces:**
- Produces: agent frontmatter `model: inherit`; SKILL.md sentences the test asserts (below).

- [ ] **Step 1: Failing test** — append to `tests/commands.test.mjs`:

```js
test("rescue agent inherits the session model and points Codex at agent-compat routing", () => {
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "codex-rescue.md"), "utf8");
  const runtimeSkill = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "codex-cli-runtime", "SKILL.md"), "utf8");
  assert.match(agent, /^model: inherit$/m);
  assert.doesNotMatch(agent, /^model: sonnet$/m);
  assert.match(runtimeSkill, /Map `sol` to `--model gpt-5\.6-sol`/i);
  assert.match(runtimeSkill, /\$agent-compat:skill-router/);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Edit `agents/codex-rescue.md`** — frontmatter `model: sonnet` → `model: inherit`. (Forwarding a prompt needs no cheaper model; `sonnet` silently downgraded rescue runs while the session ran Fable/Opus.)

- [ ] **Step 4: Edit `skills/codex-cli-runtime/SKILL.md`** — in "Command selection", after the existing line `Map \`spark\` to \`--model gpt-5.3-codex-spark\`…` add:

```
- Map `sol` to `--model gpt-5.6-sol`, `luna` to `--model gpt-5.6-luna`, `terra` to `--model gpt-5.6-terra`, `mini` to `--model gpt-5.4-mini`.
- If the request names an uncommon domain (private infra runbooks, vendor-specific tooling), prepend to the task text: "If a matching skill is not already loaded, run `$agent-compat:skill-router` to find a reviewed playbook before starting." (Codex has the agent-compat plugin installed; it routes to reviewed route-only skills offline.)
```

- [ ] **Step 5: Test** → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/agents/codex-rescue.md plugins/codex/skills/codex-cli-runtime/SKILL.md tests/commands.test.mjs
git commit -m "feat(rescue): inherit session model; gpt-5.6 aliases; agent-compat routing hint" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
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
2. `/codex:rescue --model sol --effort max Strictly read-only: summarize the last commit` — completes and the **agent returns the Codex text**, not "Async agent launched"; `/codex:status --all` shows the job with `model: gpt-5.6-sol`, `effort: max`.
3. `node ~/.claude/plugins/cache/cbepx/codex/1.1.0/scripts/codex-companion.mjs review --wait --effort xhigh --config model_reasoning_summary=detailed` — review runs; job log shows the config in the thread start (`codex` logs) — verify with `--json`.
4. `node … task --effort supreme x` → `Unsupported reasoning effort "supreme". Use one of: … max, ultra.`
5. `/codex:setup --enable-review-gate` in a scratch repo, make an edit, stop → gate runs and finishes < 15 min or reports its own timeout message.
6. `npm test` inside the Claude session → `fail 0`.
