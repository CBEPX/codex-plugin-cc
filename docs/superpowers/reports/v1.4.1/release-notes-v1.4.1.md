Windows kills from stored process records now verify the process and terminate its tree; the broker gains a start/replace state machine; a transport bug with U+2028/U+2029 is fixed.

### Highlights
- Windows: `/codex:cancel`, `SessionEnd` cleanup, stale-broker replacement and broker teardown verify the recorded pid by its start time and terminate the verified tree children-first through one in-box Windows PowerShell 5.1 run with pinned handles (no `taskkill`, no Store `pwsh`). A pid that is gone is reported as `process-missing`; orphans found are reported as `survivors` with `cancellationPending`, never marked cancelled.
- Broker lifecycle: a broker writes its record under the state lock before it spawns (`starting` → `ready`, `replacing` on a stale replacement); two racing starts settle inside the lock; a start that fails is torn down through the same verified kill; `SessionEnd` keeps records whose kill outcome is unknown (`kept=true`).
- Cancel: the worker's cooperative final record carries `workerClosed: true`; a vanished worker on Windows is recorded cancelled only on that record and an empty orphan walk. A failure the reaper recorded is always kept; any other record after the cancel's acknowledged interrupt or delivered kill becomes `cancelled`, as in v1.4.0.
- Transport: notifications containing U+2028/U+2029 no longer break the app-server connection (frames are split on `\n` only).
- CI: the "No leaked test processes" step is enforced on every OS; PowerShell launches pass `LOCALAPPDATA`/`PSModuleAnalysisCachePath` through, avoiding 20–30 s cold starts.

### Compatibility
- New job record field `job.workerClosed` (boolean) in `status --json` / `result --json`.
- On Windows, `/codex:cancel` may answer `cancellationPending` with `survivors` (pid + identity) or `identity-unavailable` (broker still starting, Constrained Language Mode); `SessionEnd` teardown lines gain `kept=`.
- Known limitations (planned for v1.4.2): a brokered cancel confirms the worker, not the turn; `workerClosed` proves the client closed, not that every descendant exited (see README «Windows»).

### Validation
- Exact tag target: `1f2d7ac915220f4fa7cc789444584db75626f79f`
- Local gate: 453 tests (442 pass, 11 skipped), 0 leaked test processes, `npm run build`, `npm run check-version`, `claude plugin validate . --strict`
- GitHub CI: run on `1f2d7ac` — https://github.com/CBEPX/codex-plugin-cc/actions/runs/36560045125 (10/10 jobs green); previous SHA `f0945b1` run 36558470385: 10/10 jobs green
- Review: Codex adversarial review — 13 passes, converged to pre-existing scope items parked per the documented limits; Claude review — APPROVED WITH NITS, applied
- Runtime dependency audit: `npm audit --omit=dev` reports 0 vulnerabilities

### Artifact
- `cbepx-codex-plugin-cc-1.4.1.tgz` + `SHA256SUMS` (same layout as v1.4.0)
