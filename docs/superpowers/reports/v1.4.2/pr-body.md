Release v1.4.2 — a brokered cancel confirms the turn; close reports the app-server exit.

Scope (the two limits parked from v1.4.1 adversarial pass 13 plus two gaps beside them): brokered `/codex:cancel` waits up to 10 s for the worker's own final record after `turn/interrupt` and otherwise answers `cancellationPending` (`turn-not-interrupted`) without killing; direct jobs skip the interrupt (`transport` recorded at `turn/started`; the direct path needs file and index to agree); `appServerExited` on the worker's final record (direct `close()` reports an observed exit vs the 5 s deadline) and the Windows vanished-root proof requires it; Windows `SessionEnd` keeps refused/thrown kills even with a dead root; pid sidecar written only for active jobs under the lock; job-file reads retry on Windows.

- Spec: `docs/superpowers/specs/2026-09-29-codex-plugin-cc-v1.4.2-design.md` (rev. 4)
- Plan: `docs/superpowers/plans/2026-09-29-codex-plugin-cc-v1.4.2.md`
- CHANGELOG `## 1.4.2 — 2026-09-30` (Fixed / Changed / Known limitations)

Gates: `npm run check` 466 tests (455 pass, 11 skipped), 0 leaked test processes, `claude plugin validate . --strict`, `npm audit --omit=dev` 0; CI 10/10 on `9f8058c`, `6693de3` and the release SHA `5e45e86` (run 36635024275, rc=0); Codex adversarial review: pass 1 → one blocking-class finding (forged `transport: direct` in the job file bypassed the wait) fixed in `9f8058c`, pass 2 SHIP; Claude (Fable) reviews per task and whole-branch approved with nits, applied.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
