Internal restructure with no behaviour change: one home per duplicated helper, a shared test harness, `tests/runtime.test.mjs` split by command family, and two new guard tests.

### Highlights
- `plugins/codex/scripts`: duplicated helpers consolidated (`nowIso`, `readStoredJob`, `readJsonOrNull`, `shorten`, `looksLikeVerificationCommand`, the pending-cancel text, the env-based session filter, `buildJsonRpcError`); the queued/running status comparisons go through `lib/job-status.mjs`; dead `fs.mjs` exports and unused symbols removed (eslint `no-unused-vars` is now on).
- Tests: shared harness helpers in `tests/helpers.mjs`; `tests/runtime.test.mjs` split into seven `runtime-*.test.mjs` files (same 143 tests), which roughly halves the local suite's wall time; new `job-status` and `module-boundaries` unit tests (leaf modules, hook allow-lists, the single `job-control → codex` edge); render helpers and the session filter gain direct tests.

### Compatibility
- No CLI, hook, record or state-format change. Nothing for callers to do.

### Validation
- Exact tag target: `9d2d4ac2a5ded3c3468da5cb7202e872093a458c`
- Local gate: 475 tests (464 pass, 11 skipped), 0 leaked test processes, `npm run build`, `npm run check-version`, `claude plugin validate . --strict`
- GitHub CI: run on `9d2d4ac` — https://github.com/CBEPX/codex-plugin-cc/actions/runs/36674667612 (10/10 jobs green)
- Review: Claude (Fable) per-stage and whole-branch reviews — approved with nits, applied; `pr-review-toolkit` code-reviewer and test analyzer, ponytail over-engineering review — applied; Codex review (default model) — no actionable regression; no adversarial pass (no behaviour change)
- Runtime dependency audit: `npm audit --omit=dev` reports 0 vulnerabilities

### Artifact
- `cbepx-codex-plugin-cc-1.4.3.tgz` + `SHA256SUMS`
