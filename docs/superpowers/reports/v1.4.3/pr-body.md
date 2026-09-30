Release v1.4.3 — internal restructure, no behaviour change (roadmap row 2d).

Scope: one home per duplicated helper in `plugins/codex/scripts` (`nowIso`, `readStoredJob`, `readJsonOrNull`, `shorten`, `looksLikeVerificationCommand`, pending-cancel text, env-based session filter, `buildJsonRpcError`); the queued/running status comparisons go through `lib/job-status.mjs`; dead `fs.mjs` exports and unused symbols removed with eslint `no-unused-vars` enabled; shared test helpers in `tests/helpers.mjs`; `tests/runtime.test.mjs` split into seven files (same 143 tests; local suite roughly twice as fast); new `job-status`, `module-boundaries` and render/session-filter unit tests.

- Plan: `docs/superpowers/plans/2026-09-30-codex-plugin-cc-v1.4.3.md`
- CHANGELOG `## 1.4.3 — 2026-09-30` (`### Internal`)

Gates: `npm run check` (475 tests, 464 pass, 11 skipped), 0 leaked test processes, `claude plugin validate . --strict`, `npm audit --omit=dev` 0; CI 10/10 on every pushed stage and on the release SHA `9d2d4ac` (run 36674667612, rc=0); reviews: Claude (Fable) per stage + whole-branch, `pr-review-toolkit` code-reviewer + test analyzer, ponytail over-engineering review, Codex built-in review — all findings applied or ruled in the ledger; no adversarial pass (no runtime behaviour change).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
