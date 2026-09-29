Roadmap row 2c: the project's working rules move out of private plan files into the repository, README stops describing internals, and the release procedure gains the steps v1.4.1 actually needed. Docs and one test only.

Changes:
- `AGENTS.md` (29 lines) + `CLAUDE.md` (`@AGENTS.md`); topic files `docs/agent/{process,testing-and-ci,windows-threat-model,docs}.md` (stages and mandatory tools, model roles, adversarial-gate stop rule, ledger evidence rule, timing rules for slow runners, Windows spawn threat model, documentation rules).
- README: Windows internals → `docs/windows.md`, state-lock / EACCES FAQ bodies → `docs/state-and-lifecycle.md` (text moved verbatim under headings); short `### Windows` with observable outcomes; dangling `#what-does-the-review-gate-do` anchor fixed; coverage numbers aligned with `.c8rc.json`.
- `docs/RELEASING.md`: step 0 (pre-release checklist) and step 6 (after the release: local installs, smoke, archive, upstream comments, claim release); steps 1–5 unchanged.
- `tests/docs-contracts.test.mjs`: every `plugins/codex/commands/*.md` has a README section; `AGENTS.md` ≤ 50 lines and `CLAUDE.md` imports it; relative links and anchors across README/AGENTS/docs resolve; README names no `scripts/lib` paths or functions.
- `.gitignore`: `.superpowers/`.
- Plan: `docs/superpowers/plans/2026-09-29-codex-plugin-cc-process-refactor.md`.

Gates: `npm run check` 457 tests (446 pass, 11 skipped), 0 leaked test processes, `claude plugin validate . --strict`; `git diff main --stat -- plugins/codex package.json .github CHANGELOG.md` empty; CI 10/10 on `cd6a358` and on the final SHA `c22e355` (run 36571503372, rc=0).
Reviews: Claude (Fable) whole-branch — approved with nits; `pr-review-toolkit:comment-analyzer` — no lost referents, wording fixes; Codex review (default model, effort medium) — two P2 wording findings. All applied in `63ad220` / `c22e355`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
