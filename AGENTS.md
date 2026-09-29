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
- Pushing a work branch under an active claim is fine; merging, tagging, publishing a release and posting upstream comments each need the user's explicit go.
- Maintainers claim the work item with the `agent-work` tool before writing and release the claim at the end of the stage (see `docs/agent/process.md`); contributors without it open a draft PR first.
- README describes behaviour by observable outputs (flags, `status --json` / `result --json` fields, exit codes, decision lines, error text). Function names and `scripts/lib/...` paths belong in `docs/*.md`.
- The `codex@cbepx` plugin is installed from the marketplace cache per Claude config dir; the working tree is not what `/codex:*` runs. After a release: `claude plugin marketplace update cbepx && claude plugin update codex@cbepx` in each config dir, then restart the session.

## Read on demand

- [docs/agent/process.md](docs/agent/process.md) — stages, mandatory skills per stage, model roles, adversarial-gate stop rule, SDD ledger and evidence rules, `agent-work` claims, upstream comments.
- [docs/agent/testing-and-ci.md](docs/agent/testing-and-ci.md) — gate sequence, timing rules for slow hosted runners, CI watching, PowerShell lessons.
- [docs/agent/windows-threat-model.md](docs/agent/windows-threat-model.md) — the five-point checklist for any Windows spawn change.
- [docs/agent/docs.md](docs/agent/docs.md) — README rule, spec/plan templates, CHANGELOG copies.
- [docs/RELEASING.md](docs/RELEASING.md) — release procedure, steps 0–6.
