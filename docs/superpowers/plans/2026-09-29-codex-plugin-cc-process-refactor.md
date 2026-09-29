# Process, rules and docs refactor (roadmap row 2c) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the project's working rules out of private plan files and ledgers into a short `AGENTS.md` with linked topic files, put the README on a diet by moving internals into `docs/`, extend `docs/RELEASING.md` with the pre-release and post-release steps that v1.4.1 actually needed, and pin the result with a docs-contract test.

**Architecture:** Docs and tests only. Nothing under `plugins/codex/`, `package.json`, `.github/` or `CHANGELOG.md` changes (no runtime behaviour, no release). Rules live in `AGENTS.md` (≤ 50 lines, read by Claude Code through `CLAUDE.md` = `@AGENTS.md` and by Codex directly) plus `docs/agent/*.md`, which are read on demand. README describes behaviour by observable outputs only; internals move to `docs/windows.md` and `docs/state-and-lifecycle.md`. `tests/docs-contracts.test.mjs` is auto-discovered by `scripts/run-tests.mjs` and reuses the `read()` CRLF helper pattern from `tests/commands.test.mjs`.

**Tech Stack:** Markdown, Node 18 `node:test` (zero dependencies), `rg`.

**Spec:** the roadmap plan section «Рефакторинг после v1.4.1 → Р1/Р2» (private plan file) and this document; the rules' source text is the 12 execution constraints + the model-role table reproduced verbatim in Task 1 and Task 2 below.

**Ponytail level:** lite — build what is asked; each task names its lazier alternative.

## Global Constraints

- Branch `chore/process-rules`, worktree `.worktrees/chore-process`, draft PR #10, agent-work claim `2a034298-bb95-4e3f-9f15-706ac4f6a971` (paths: `AGENTS.md`, `CLAUDE.md`, `docs`, `README.md`, `tests/docs-contracts.test.mjs`, `.gitignore`). Run `~/.local/bin/agent-work check --forge github.com --claim-id 2a034298-bb95-4e3f-9f15-706ac4f6a971 --session $(cat .superpowers/sdd/2026-09-29-process-refactor/agent-work-session)` before each write batch.
- Never `grep`; use `rg`. Never `git add -A`. Push only when the controller says so.
- Gate before every commit, chained with `&&` on exit codes only: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit …`. `npm run check` needs the `codex` CLI on `PATH` (build step) and takes ~5 min.
- Must stay byte-identical: the README strings pinned by `tests/commands.test.mjs` (`!codex login`, `offer to install Codex for you`, `/codex:setup --enable-review-gate` / `--disable-review-gate`, the `task --await` exit-code sentences 0/1/3 and `result` 0/3, the fork install lines `/plugin marketplace add CBEPX/codex-plugin-cc` + `/plugin install codex@cbepx`, no line containing `Upstream:` install text). Run `node --import ./tests/test-env.mjs --test tests/commands.test.mjs` after every README edit.
- `docs/RELEASING.md` steps 1–5 and their command blocks stay verbatim (the notes template and `release-verify.yml` depend on them); only step 0 and step 6 are added.
- Every existing modal verb (`may`, `might`, `could`, `must`, `must not`) in moved text is kept; moved text is moved, not rewritten — only headings are added.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A README sentence that a test in `tests/commands.test.mjs` pins gets moved to `docs/` → that test fails. Task 4 runs the test after each move.
2. A relative link or `#anchor` in a moved section now points to a heading that lives in another file → the new contract test must catch it (Task 5 checks links and anchors across README, AGENTS.md, docs/agent, docs/*.md).
3. CRLF checkouts on the Windows CI matrix: the contract test must normalise `\r\n` (reuse the `read()` pattern) and must not depend on `AGENTS.md` line endings.
4. `AGENTS.md` growing past 50 lines over time → pinned by the contract test.
5. A rule appearing in two topic files with drifting wording → Task 6 verifies each of the 12 constraints has exactly one home (`rg` by key phrase).

---

### Task 1: `AGENTS.md`, `CLAUDE.md`, `docs/agent/process.md`

**Files:**
- Create: `AGENTS.md`, `CLAUDE.md`, `docs/agent/process.md`
- Test: none yet (Task 5 pins size and links)

**Interfaces:**
- Produces: the four topic-file names that `AGENTS.md` links: `docs/agent/process.md`, `docs/agent/testing-and-ci.md`, `docs/agent/windows-threat-model.md`, `docs/agent/docs.md` (Task 2 creates the last three), plus `docs/RELEASING.md`.

- [ ] **Step 1: Write `CLAUDE.md`** — exactly one line, no trailing text:

```
@AGENTS.md
```

- [ ] **Step 2: Write `AGENTS.md`** (≤ 45 lines; keep it to this content):

```markdown
# codex-plugin-cc — agent rules

CBEPX fork of the Codex plugin for Claude Code (`plugins/codex/`). Node.js 18.18+ ESM, zero runtime
dependencies, portable across macOS, Linux and native Windows. Fix shared behaviour at the earliest
common boundary (usually `plugins/codex/scripts/lib/`); never add caller-specific workarounds.

## Commands

- `npm run check` — the full gate (version metadata, changelog, lint, build/typecheck, test typecheck, tests). `npm run build` needs the `codex` CLI on `PATH`.
- Leak check after the suite: `sleep 10; [ "$(pgrep -f codex-plugin-test- | wc -l)" = 0 ]` (CI runs `node scripts/check-leaks.mjs`).
- `claude plugin validate . --strict` before a release commit.

## Hard rules

- Search with `rg`, never `grep`/`egrep`/`fgrep`. Never `git add -A`.
- Commit only through an `&&` chain on exit codes: `npm run check && <leak check> && git add <files> && git commit`. Never judge a gate by matching log text.
- Work in a worktree under `.worktrees/`; `main` is the release base and the review base (`--base main`).
- Do not push, merge, tag, release or post upstream comments without the user's explicit instruction.
- Claim the work item with `agent-work` before writing; check the claim before each write batch; release it at the end of the stage.
- README describes behaviour by observable outputs (flags, `status --json` / `result --json` fields, exit codes, decision lines, error text). Function names and `scripts/lib/...` paths belong in `docs/*.md`.
- The `codex@cbepx` plugin is installed from the marketplace cache per Claude config dir; the working tree is not what `/codex:*` runs. After a release: `claude plugin marketplace update cbepx && claude plugin update codex@cbepx` in each config dir, then restart the session.

## Read on demand

- `docs/agent/process.md` — stages, mandatory skills per stage, model roles, adversarial-gate stop rule, SDD ledger and evidence rules, upstream comments.
- `docs/agent/testing-and-ci.md` — gate sequence, timing rules for slow hosted runners, CI watching, PowerShell lessons.
- `docs/agent/windows-threat-model.md` — the five-point checklist for any Windows spawn change.
- `docs/agent/docs.md` — README rule, spec/plan templates, CHANGELOG copies.
- `docs/RELEASING.md` — release procedure, steps 0–6.
```

- [ ] **Step 3: Write `docs/agent/process.md`** with these sections (English; keep the wording of the rules below, they are the translated constraints 2, 4, 5, 6, 10 and the roles table):

```markdown
# Process

## Stages and mandatory tools

| Stage | Mandatory skill / tool | Output |
|---|---|---|
| Brainstorm | `superpowers:brainstorming` | roadmap section |
| Spec | `superpowers:brainstorming` design → written spec; second opinion `/codex:rescue --effort xhigh` (read-only) | `docs/superpowers/specs/<date>-<topic>-design.md` |
| Plan | `superpowers:writing-plans` | `docs/superpowers/plans/<date>-codex-plugin-cc-vX.Y.Z.md` |
| Claim | `agent-work claim --target <PR url>` before any write; `check` before each batch | claim id in the ledger |
| Implement | `superpowers:subagent-driven-development` + `superpowers:test-driven-development`; `superpowers:systematic-debugging` on any failure | commits, `task-N-brief.md` / `task-N-report.md` |
| Task review | `superpowers:requesting-code-review` (Fable); `pr-review-toolkit` agents on the final whole-branch pass | review note in the ledger |
| Adversarial gate | `/codex:adversarial-review --base main --effort max` | `adv-<version>-passN.json`, fix-wave reports |
| Verify | `superpowers:verification-before-completion`; consult `advisor` before each wave and before declaring done | ledger evidence line (below) |
| Release | `docs/RELEASING.md` steps 0–6 | tag, GitHub Release |
| Archive | RELEASING step 6; `agent-work release --stopped`; `session-handoff` if the session ends mid-stage | `docs/superpowers/reports/vX.Y.Z/` |

## Model roles

| Role | Model | Scope |
|---|---|---|
| Controller | Claude Fable 5.1 (the session) | decomposition, specs and plans, ledger rulings, sign-off, release, upstream texts |
| Implementation by transcription | Claude Sonnet (`model: sonnet`) | tasks whose plan already contains the code and tests; docs; CI yaml; fix waves with exact rulings |
| Implementation by judgement | Claude Opus (`model: opus`) | `broker-lifecycle.mjs`, `state.mjs`, `process.mjs` kill script, hooks — races and state machines; fix waves without ready code |
| Code review | Claude Fable (`model: fable`) for every task review and scoped re-review; Sonnet/Haiku only for docs diffs | after each task and each fix wave, before the adversarial gate |
| Pre-ship gate | Codex `/codex:adversarial-review --base main --effort max`, the user's default model (`gpt-6-sol` from `~/.codex/config.toml`) | mandatory on every release branch |
| Second pass / root cause | Codex `/codex:rescue --effort xhigh` (default model, read-only) | independent diagnosis when the root cause is not yet proven |
| Cheap review | Codex default model with lower `--effort` (medium/low); never `--model gpt-5.5`; `spark` is unavailable on ChatGPT accounts, `gpt-6-astra` is rate-limited | docs-only and mechanical diffs |

## Adversarial-gate stop rule

Each pass brief must tag findings that already existed in the previous release (`pre-existing vX.Y`) and separate **blocking** classes — a foreign process killed; a live broker without a record and then killed; loss of a live broker's record; cancel reporting success on an unconfirmed tree; a cancelled job that still runs — from residual ones. A fix wave opens only for a blocking class that this release introduced or first exposed. Pre-existing semantics, and findings whose premise is "a process suspended for seconds" or "two consecutive disk-write failures", are parked with a ruling as a documented limit (spec `## Limits`, CHANGELOG "Known limitations") and go to the next release. Cap: 5 passes per release; every further pass needs an explicit user decision.

## SDD ledger and evidence

- `.superpowers/sdd/<plan>/progress.md` is the only source of rulings during a release; briefs, reports, `adv-*-passN.json` and `review-<a>..<b>.diff` live beside it. At archive time everything except `*.diff` and `*.log` moves to `docs/superpowers/reports/vX.Y.Z/` with private paths replaced.
- A CI line in the ledger has the form `CI <run-id> <sha>: rc=<n>; <job>: <assertion text | n pass/m fail/k skip>`, where `rc` comes from `gh run watch <id> --exit-status; rc=$?`. Never write "all green" without `rc=0` and the job list.
- A claim about code ("keep rule unchanged") must quote the diff hunk or name the test that proves it.
- A failing assertion in a lifecycle test must print the stored record and the job-log tail, so a CI-only failure can be read from the job log.

## Ports and upstream

- Upstream PRs target v1.0.6; take the test and the intent, re-implement against the fork. `git merge pr/N` only when the touched area is byte-identical to upstream. Keep `Co-authored-by:` of ported PR authors.
- State-file moves must keep a compatibility read of the old location.
- Upstream comments are outward-facing: draft into `docs/superpowers/triage/upstream-comments-vX.Y.Z.md`, wait for the user's approval, then `gh issue comment` — one comment per issue, English, linking the fork release. Mark the file as posted afterwards.
```

- [ ] **Step 4: Commit** (gate chain as in Global Constraints):

```bash
git add AGENTS.md CLAUDE.md docs/agent/process.md && git commit -m "docs(agent): add AGENTS.md, CLAUDE.md and the process rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Lazier alternative: one 120-line `AGENTS.md` with everything inline — rejected, both Claude and Codex would pay for it every turn.

---

### Task 2: `docs/agent/testing-and-ci.md`, `docs/agent/windows-threat-model.md`, `docs/agent/docs.md`

**Files:**
- Create: the three files above.

- [ ] **Step 1: `docs/agent/testing-and-ci.md`**

```markdown
# Testing and CI

## Gate and commit

`npm run check` (check-version, check:changelog, lint, build, typecheck:tests, tests) → exit 0; then `sleep 10; [ "$(pgrep -f codex-plugin-test- | wc -l)" = 0 ]`. Commit only through an `&&` chain on these exit codes; never through `;` or a log match (v1.4.0 shipped two commits with a red gate that way). `claude plugin validate . --strict` before a release commit.

## Timing tests on slow hosted runners

GitHub Windows runners run 2–3× slower for hours at a time (the same test: 6.6 s vs 33 s on identical code). Rules: no absolute `< N ms` assertion under 10 s; waiting windows are relative to the fixture parameter (`< fakeTurnMs`); `waitFor` defaults to 30 s; the broker idle timeout in tests that pause between commands is ≥ 15 s; every test with an open stdin or a child process sets `{ timeout }` and a `t.after` that SIGKILLs. A single red Windows or macOS job: rerun first (`gh run rerun --failed`) and compare durations; bisect only on a reproduction.

## Evidence in tests

A failing assertion on a job's outcome prints the stored record and the job-log tail (read only on failure, like the broker-log tail in `tests/broker-stale-pid.test.mjs`). The v1.4.1 macOS failure was solved only once the test printed them.

## Watching CI

Concurrency cancels the previous run on every push: look only at the HEAD run. Capture `gh run watch <id> --exit-status; rc=$?` in a variable, never through an `echo` chain. Job logs of a finished job in a still-running run: `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<id>/logs`.

## PowerShell on Windows (v1.4.1 lessons)

The clean child environment must pass `LOCALAPPDATA` and `PSModuleAnalysisCachePath` through (otherwise every start costs 22–33 s: a short-lived process never persists the module-analysis cache). Use `Get-CimInstance -ClassName Win32_Process -Property …` (provider-side projection; `Select-Object` still computes `CommandLine`). Enumerating `Win32_Process` on a hosted runner takes 30–50 s: the leak-step budget is ≥ 180 s. The broker never probes its own identity (it blocks its event loop while the starter waits for the endpoint). `node:readline` splits JSONL on U+2028/U+2029: read frames on `\n` only.
```

- [ ] **Step 2: `docs/agent/windows-threat-model.md`**

```markdown
# Windows spawn threat model

Any change to how the plugin spawns a process on Windows must satisfy all five points, and the Codex review brief for such a change must list them verbatim (v1.4.0 needed six adversarial passes; each found a new executable-substitution path):

(a) In-box tools only by absolute path under `%SystemRoot%\System32\…` (`systemExe`; PowerShell: `System32\WindowsPowerShell\v1.0\powershell.exe`, `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`).
(b) A bare name resolves only through `resolveExecutable` (fs lookup over absolute `PATH` entries × `PATHEXT`; no `where.exe`, no cwd, no relative entries) and fails with `ENOENT` without spawning.
(c) `.cmd` shims run through `cmd.exe /d /s /v:off /c` with double-caret escaping, a filtered `PATH` and `NoDefaultCurrentDirectoryInExePath=1`.
(d) No console-output decoding: request only ASCII/numeric fields from external tools (protocol lines `^[A-Z]+( \d+)*$`, no trimming).
(e) `%VAR:a=b%` substitution inside a `.cmd` argument is a documented ceiling; CR/LF in an argument is refused.

Windows CI must run the round trip with a planted `node.cmd` / `codex.cmd` / `powershell.cmd` in the cwd and in a relative `PATH` entry. Worked example: spec `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` §2 "Trust boundary".
```

- [ ] **Step 3: `docs/agent/docs.md`**

```markdown
# Documentation rules

## README

README describes behaviour by observable outputs only: command flags, `status --json` / `result --json` fields, exit codes, decision lines (`kept=true`, `process-missing`, `identity-unavailable`, `cancellationPending`, `survivors`), error text. Function names and `plugins/codex/scripts/...` paths go to `docs/*.md`, each ending with a "Code path" line. The strings that `tests/commands.test.mjs` pins must stay in README.

## Specs and plans

Header: title + `Date: … (rev. N, YYYY-MM-DD)` only. Sections: Goal, Trust boundary, Design, Testing, Limits, Rollout. The revision history is a `## Revision log` table at the end (`rev | date | trigger | change`). CHANGELOG "Known limitations" bullets end with `(spec §Limits)`. Applies to new specs; older specs are not rewritten.

## CHANGELOG

The heading format `## X.Y.Z — YYYY-MM-DD` is checked by `scripts/check-changelog.mjs`. `plugins/codex/CHANGELOG.md` must stay byte-identical to `CHANGELOG.md` (`cp CHANGELOG.md plugins/codex/CHANGELOG.md`) until the copy is removed in a code release.
```

- [ ] **Step 4: Commit** (gate chain; files: the three docs).

Lazier alternative: fold the three files into `process.md` — rejected only for the threat model, which is pasted into Codex briefs verbatim; `testing-and-ci.md` and `docs.md` could be sections, kept separate for linkability.

---

### Task 3: `docs/RELEASING.md` steps 0 and 6

**Files:**
- Modify: `docs/RELEASING.md` (insert before `## 1.`; append after `## 5.`; steps 1–5 verbatim)

- [ ] **Step 1: Insert step 0** right after the intro paragraph and before `## 1. Prepare the release branch`:

```markdown
## 0. Before the release branch is bumped

- Draft PR against `main` is the work item (issues are disabled); claim it with `agent-work claim --target <PR url>`.
- The adversarial gate is closed per `docs/agent/process.md` (stop rule): every parked finding is listed in the spec `## Limits` section and in the CHANGELOG "Known limitations" bullets.
- Spec and plan revision tables are current; the CHANGELOG section for the new version exists.
- `npm audit --omit=dev` reports 0 vulnerabilities; the CI matrix is green on the exact SHA that will be tagged.
```

- [ ] **Step 2: Append step 6** after step 5:

```markdown
## 6. After the release

- Update the local installs (step 5) in every Claude config directory (`CLAUDE_CONFIG_DIR=~/.claude …` for the primary one), restart the session, then smoke the installed plugin: `/codex:status`, `/codex:rescue --effort low Strictly read-only: reply PONG` (sync and `--background`), `/codex:review --background` → `/codex:result`. Record smoke-review findings in the ledger as inputs for the next release.
- Archive the SDD directory: everything under `.superpowers/sdd/<plan>/` except `*.diff` and `*.log` goes to `docs/superpowers/reports/vX.Y.Z/` (`progress.md` becomes `sdd-ledger.md`; adversarial passes under `adversarial/`); replace private paths (`/Users/<name>/…` → `<repo>/`) before committing.
- Upstream comments: draft into `docs/superpowers/triage/upstream-comments-vX.Y.Z.md`, post only after the user's approval (one comment per issue), then mark the file as posted.
- `agent-work release --stopped --gate "<release summary>"`; remove the release worktree.
```

- [ ] **Step 3: Commit** (gate chain).

Lazier alternative: a checklist in `process.md` and RELEASING untouched — rejected, the release runner reads RELEASING top to bottom.

---

### Task 4: README diet, `docs/windows.md`, `docs/state-and-lifecycle.md`

**Files:**
- Modify: `README.md` (sections «### Windows» lines ~388–398, the two FAQ entries at ~361–381, «## Development» ~400–422, the link at line 335)
- Create: `docs/windows.md`, `docs/state-and-lifecycle.md`
- Test: `tests/commands.test.mjs` (existing; must stay green)

- [ ] **Step 1: Move the Windows internals.** Cut README «### Windows» paragraphs 1–4 (the `As of v1.4.0 …`, `As of v1.4.1 …`, `Limits: …` and `Requirements: …` paragraphs, plus the `When CLAUDE_PLUGIN_DATA is not set …` paragraph) into `docs/windows.md` under these headings, text verbatim: `# Windows` → `## Spawn path (v1.4.0)` (paragraph 1) → `## Verified kills from stored records (v1.4.1)` (paragraph 2) → `## Limits` (paragraph 3) → `## Requirements` (paragraph 4) → `## State directory fallback` (the `CLAUDE_PLUGIN_DATA` paragraph) → `## Code path` with one line: `` `plugins/codex/scripts/lib/process.mjs` (launcher, identity probe, kill script), `plugins/codex/scripts/lib/broker-lifecycle.mjs` (broker state machine), `plugins/codex/scripts/lib/job-control.mjs` (cancel decision); design: `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md`. ``
- [ ] **Step 2: Replace README «### Windows»** with:

```markdown
### Windows

Requirements: `cmd.exe` and Windows PowerShell 5.1 (both ship with Windows; no Store `pwsh` needed); `codex` and `npm` on the Windows `PATH` as `.cmd`/`.exe`. Kills from stored records (`/codex:cancel`, `SessionEnd` cleanup, broker teardown) verify the process before killing it. `/codex:cancel` answers `cancelled`, or `cancellationPending` with `survivors` (pid and identity) when part of the tree outlived the kill, or `identity-unavailable` when the process could not be verified (for example while the shared broker is still starting, or under PowerShell Constrained Language Mode); `SessionEnd` keeps a record whose kill outcome is unknown (`kept=true`) and re-judges it next time. Details, limits and the state-directory fallback: [docs/windows.md](docs/windows.md).
```

- [ ] **Step 3: Move the two FAQ bodies** («A command failed with "Timed out … waiting for the Codex state lock"» and «A command failed with a raw `EACCES` or `EIO` …») verbatim into `docs/state-and-lifecycle.md` under `# State and lifecycle` → `## "Timed out … waiting for the Codex state lock"` → `## Raw EACCES / EIO from the state directory` → `## Code path` (`plugins/codex/scripts/lib/state.mjs` (ticket lock, atomic writes), `plugins/codex/scripts/lib/tracked-jobs.mjs` (reaper)). In README keep each FAQ heading with two sentences (the first sentence of the original body, then `See [docs/state-and-lifecycle.md](docs/state-and-lifecycle.md).`).
- [ ] **Step 4: Fix the anchor** at README line 335: `#what-does-the-review-gate-do` → `#enabling-review-gate`.
- [ ] **Step 5: Development section:** keep the four command bullets; replace the coverage sentence with `thresholds live in `.c8rc.json` (88% lines and statements, 78% branches, 95% functions)`; add a final bullet: `` Working rules for agents and maintainers: `AGENTS.md` and `docs/agent/`. ``
- [ ] **Step 6: Run the pinned README tests:** `node --import ./tests/test-env.mjs --test tests/commands.test.mjs` → pass. `wc -l README.md` ≈ 300.
- [ ] **Step 7: Commit** (gate chain).

Lazier alternative: move only «### Windows» and leave the FAQ — acceptable if time is short; the FAQ move is the smaller half.

---

### Task 5: `tests/docs-contracts.test.mjs`

**Files:**
- Create: `tests/docs-contracts.test.mjs` (auto-discovered; must pass `eslint .` and `npm run typecheck:tests`)

- [ ] **Step 1: Write the test** (reuse the `read()` pattern; GitHub slug = lowercase, strip everything except `\w`, spaces and `-`, spaces → `-`):

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function slug(heading) {
  return heading.trim().toLowerCase().replace(/[`*]/g, "").replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

function headingSlugs(text) {
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
}

const DOCS = ["AGENTS.md", "README.md", ...fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`), ...fs.readdirSync(path.join(ROOT, "docs", "agent")).map((f) => `docs/agent/${f}`)];

test("every plugin command has a README section", () => {
  const readme = read("README.md");
  for (const file of fs.readdirSync(path.join(ROOT, "plugins", "codex", "commands"))) {
    const name = file.replace(/\.md$/, "");
    assert.match(readme, new RegExp(`^### \`/codex:${name}\``, "m"), `README lacks a section for /codex:${name}`);
  }
});

test("AGENTS.md stays short and CLAUDE.md imports it", () => {
  assert.ok(read("AGENTS.md").split("\n").length <= 50, "AGENTS.md must stay under 50 lines");
  assert.equal(read("CLAUDE.md").trim(), "@AGENTS.md");
});

test("relative links and anchors in the docs resolve", () => {
  for (const doc of DOCS) {
    const text = read(doc);
    const own = headingSlugs(text);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [file, anchor] = target.split("#");
      const resolved = file ? path.resolve(ROOT, path.dirname(doc), file) : null;
      if (file) assert.ok(fs.existsSync(resolved), `${doc}: missing link target ${target}`);
      if (anchor !== undefined) {
        const slugs = file ? headingSlugs(fs.readFileSync(resolved, "utf8").replace(/\r\n/g, "\n")) : own;
        assert.ok(slugs.has(anchor), `${doc}: missing anchor #${anchor} in ${file || doc}`);
      }
    }
  }
});

test("README describes behaviour by observable outputs, not code paths", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /scripts\/lib\//, "README must not name scripts/lib paths");
  assert.doesNotMatch(readme, /\b[a-z][A-Za-z]+\(\)/, "README must not name functions");
});
```

- [ ] **Step 2: Run it:** `node --import ./tests/test-env.mjs --test tests/docs-contracts.test.mjs` → expected: all four pass (the anchor test would have failed before Task 4 step 4). If the last test flags a legitimate `word()` in README, replace that README wording, not the test.
- [ ] **Step 3: Commit** (gate chain).

Lazier alternative: only the link/anchor test — the other three are ~15 lines and guard the two rules most likely to erode.

---

### Task 6: Gate, review, PR

- [ ] **Step 1:** `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && claude plugin validate . --strict` → all exit 0.
- [ ] **Step 2:** `git diff --stat main -- plugins/codex package.json .github CHANGELOG.md` → empty.
- [ ] **Step 3:** each of the 12 constraints has exactly one home: for each key phrase (`git add -A`, `Co-authored-by`, `earliest common boundary`, `< N ms`, `%VAR:a=b%`, `pre-existing`, `--exit-status`, `PSModuleAnalysisCachePath`, `compatibility read`, `one comment per issue`, `claude plugin update codex@cbepx`, `marketplace cache`) `rg -l "<phrase>" AGENTS.md docs/agent` lists one file.
- [ ] **Step 4:** push (controller's call), CI green on all 10 jobs (`rc=0` recorded in the ledger), reviews: Fable whole-branch, `pr-review-toolkit:comment-analyzer` on the moved docs, Codex default model with `--effort medium` docs-only pass; PR #10 → ready; merge is the user's decision.
