# codex-plugin-cc v1.1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch release that stops the process leaks (idle brokers in real use, fake app-servers/brokers in the test suite) and fixes the `rm`-alias noise in the rescue shell blocks.

**Architecture:** Merge upstream PR #457 (broker idle self-terminate; env/flag override) and reuse that mechanism in tests via a 2 s idle timeout in `buildEnv()`, gated in CI by a post-test `pgrep` check. `command rm -f --` in the four `trap` lines. Then bump 1.1.1, CHANGELOG, release.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test`, fake Codex fixture, `gh`.

**Spec:** memory `codex-plugin-cc-fork-backlog` (v1.1.1 items) — leak evidence: 3147 fake `codex app-server` processes after one day of `npm test` runs; 12 real idle brokers + app-servers days old; `trash: : path does not exist` from `trap 'rm -f …'` with the user's `rm→trash` alias.

## Global Constraints

- Repo `/Users/g.mehrenin/project/personal/codex-plugin-cc`, `origin`=CBEPX, `upstream`=openai. Branch `release/v1.1.1` from `main` (23942d7 = v1.1.0).
- Test gate: `npm test > /tmp/npm-test.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test.log; test "$st" -eq 0` (142 tests at base). `npm run build`, `npm run check-version`, `claude plugin validate . --strict` before the release commit.
- Tooling rule (user): never `grep` — ripgrep `rg` only. No `git add -A` (`.superpowers/` untracked). Commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. No push until the controller says so.
- Merge mechanics for #457: `git fetch upstream pull/457/head:pr/457 && git merge --no-ff --no-edit pr/457`; keep-both on conflicts (the fork's `withAppServer` third param and `runAppServerTurn` `disableBroker` must survive).

---

### Task 1: Merge #457 (broker idle self-terminate) + test idle timeout + CI gate + `command rm`

**Files:**
- Merge: `plugins/codex/scripts/app-server-broker.mjs`, `tests/broker-idle-timeout.test.mjs` (from PR #457)
- Modify: `tests/fake-codex-fixture.mjs` (`buildEnv`), `tests/runtime.test.mjs` (one assertion in the existing broker-reuse test), `.github/workflows/pull-request-ci.yml`, `plugins/codex/commands/rescue.md` (2 `trap` lines), `plugins/codex/agents/codex-rescue.md` (2 `trap` lines), `tests/commands.test.mjs`

**Interfaces:**
- Consumes (from #457): env `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS`, broker flag `--idle-timeout <ms>`, default 30 min; broker exits and shuts down its app-server child when no client is connected for that long.
- Produces: `buildEnv(binDir, …)` sets `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "2000"` unless the caller passes its own; CI step `sleep 5; ! pgrep -f codex-plugin-test-` after `npm test`; `trap 'command rm -f -- "$ERR" "$OUT" "$PROMPT"' EXIT` in all four shell blocks.

- [ ] **Step 1: Branch + merge #457**

```bash
git checkout -b release/v1.1.1 main
git fetch upstream pull/457/head:pr/457 && git merge --no-ff --no-edit pr/457
```
Expected conflicts: none or trivial (broker file untouched by the fork). Gate → `fail 0`; `tests/broker-idle-timeout.test.mjs` present and passing.

- [ ] **Step 2: Failing test — test brokers self-terminate**

In `tests/runtime.test.mjs`, find the existing broker-reuse test (the one asserting `appServerStarts` stays at 1 across two `task` runs, or `loadBrokerSession`); after its last companion call append:

```js
  const session = JSON.parse(fs.readFileSync(path.join(repo, ".codex-companion", "broker.json"), "utf8")); // adapt: use loadBrokerSession(repo) / the real broker.json path the fixture exposes
  const brokerPid = session.pid;
  assert.ok(brokerPid > 0);
  const deadline = Date.now() + 6000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(brokerPid, 0); await new Promise((r) => setTimeout(r, 200)); } catch { alive = false; }
  }
  assert.equal(alive, false, `broker ${brokerPid} should exit within the 2 s test idle timeout`);
```
(Make the test `async`. If the broker pid lives in `~/.claude/plugins/data` state rather than the repo, read it from `loadBrokerSession(...)` exported by `plugins/codex/scripts/lib/broker-lifecycle.mjs` — check its signature first.)

- [ ] **Step 3: Run — expect FAIL** (broker still alive: default idle timeout is 30 min).

- [ ] **Step 4: `buildEnv` sets the 2 s idle timeout** — in `tests/fake-codex-fixture.mjs` `buildEnv(binDir, overrides = {})` add `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "2000"` before spreading caller overrides (so `broker-idle-timeout.test.mjs` can still set its own value).

- [ ] **Step 5: Run — expect PASS.** Then full gate → `fail 0`. Then `sleep 5; pgrep -fl codex-plugin-test- | wc -l` → 0.

- [ ] **Step 6: CI gate** — in `.github/workflows/pull-request-ci.yml` after the `Run test suite` step add:
```yaml
      - name: No leaked test processes
        run: |
          sleep 5
          if pgrep -f codex-plugin-test- ; then echo "leaked test processes" >&2; exit 1; fi
```

- [ ] **Step 7: `command rm`** — replace all four `trap 'rm -f "$ERR" "$OUT" "$PROMPT"' EXIT` with `trap 'command rm -f -- "$ERR" "$OUT" "$PROMPT"' EXIT` (rescue.md ×2, codex-rescue.md ×2). In `tests/commands.test.mjs` add to the rescue test: `assert.match(rescue, /trap 'command rm -f -- /); assert.match(agent, /trap 'command rm -f -- /); assert.doesNotMatch(rescue, /trap 'rm -f/); assert.doesNotMatch(agent, /trap 'rm -f/);`.

- [ ] **Step 8: Gate → `fail 0`; commit**

```bash
git add tests/fake-codex-fixture.mjs tests/runtime.test.mjs tests/commands.test.mjs .github/workflows/pull-request-ci.yml plugins/codex/commands/rescue.md plugins/codex/agents/codex-rescue.md
git commit -m "fix(broker,tests): idle self-terminate via #457; 2s idle timeout in tests; CI leak gate; command rm in traps" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Release v1.1.1

**Files:** `package.json`, `package-lock.json`, `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (via `npm run bump-version -- 1.1.1`), `CHANGELOG.md`.

- [ ] **Step 1:** `npm run bump-version -- 1.1.1 && npm run check-version` (lockfile name check included since v1.1.0).
- [ ] **Step 2: CHANGELOG** — insert above `## 1.1.0`:
```markdown
## 1.1.1 — 2026-08-28

- Broker idle self-terminate (upstream #457): the shared Codex runtime exits after 30 minutes without a connected client (`CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` / `--idle-timeout`), so idle brokers and their app-server children no longer accumulate (#543).
- Test suite no longer leaks fake `codex app-server`/broker processes (2 s idle timeout in the test environment; CI fails if any `codex-plugin-test-*` process survives).
- Rescue shell blocks use `command rm -f --` in their cleanup trap (no noise from `rm` aliases such as `trash`).
```
- [ ] **Step 3:** gate, `npm run build`, `claude plugin validate . --strict`; commit `chore(release): v1.1.1`.

## Verification
1. `npm test` then `sleep 5; pgrep -f codex-plugin-test-` → nothing.
2. Real broker: run a companion `task` in a scratch repo with `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=5000`, wait 8 s → broker pid gone, its app-server gone.
3. `/codex:rescue …` in this session → no `trash:` line.
