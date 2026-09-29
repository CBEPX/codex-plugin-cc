Release v1.4.1 — Windows process identity and the verified kill path.

Scope: Windows kills from stored process records verify the pid by its start time and terminate the verified tree through one in-box PowerShell 5.1 run with pinned handles; batched identity probes; broker start/replace state machine; cancel proof marker `workerClosed`; U+2028/U+2029 transport fix; leak step enforced on every OS; v1.4.0 tails.

- Spec: `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` (rev. 24)
- Plan: `docs/superpowers/plans/2026-09-28-codex-plugin-cc-v1.4.1.md`
- CHANGELOG: `## 1.4.1 — 2026-09-29` (incl. Known limitations parked for v1.4.2)
- Upstream: openai/codex-plugin-cc #743 (win32), #423/#577, #336, #416, #487, #718

Gates: `npm run check` (453 tests, 442 pass, 11 skipped), 0 leaked test processes, `claude plugin validate . --strict`, `npm audit --omit=dev` (0), CI matrix 10/10 on `f0945b1` and on the release SHA; Codex adversarial review 13 passes (remaining items are pre-existing v1.4.0 semantics, documented as limits); Claude review approved.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
