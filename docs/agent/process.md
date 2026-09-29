# Process

## Stages and mandatory tools

| Stage | Mandatory skill / tool | Output |
|---|---|---|
| Brainstorm | `superpowers:brainstorming` | roadmap section |
| Spec | `superpowers:brainstorming` design → written spec; second opinion `/codex:rescue --effort xhigh` (read-only) | `docs/superpowers/specs/<date>-<topic>-design.md` |
| Plan | `superpowers:writing-plans` | `docs/superpowers/plans/<date>-codex-plugin-cc-<vX.Y.Z or topic>.md` |
| Claim | Maintainer tooling: `agent-work claim --target <PR url>` (the `~/.local/bin/agent-work` cooperative-claim CLI; issues are disabled, the PR is the work item) before any write; `check` before each batch; `release --stopped` at the end of the stage. Contributors without the tool: open a draft PR first | claim id in the ledger |
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
