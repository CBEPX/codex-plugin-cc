A brokered cancel now confirms the turn, not just the worker; a direct close reports whether the app-server exit was observed; two Windows SessionEnd and pid-sidecar gaps closed.

### Highlights
- `/codex:cancel` on a job that runs through the shared broker sends `turn/interrupt`, then waits up to 10 s for the worker's own final record and only then records `cancelled`. If the turn does not end, it answers `cancellationPending` with `reason: "turn-not-interrupted"` (exit 1), kills nothing and leaves the job `running` (re-run the cancel or wait for the turn). A job that owns its app-server (`transport: direct`, e.g. a cold `--resume-last`) is stopped by stopping its worker, without a turn interrupt (`turnInterruptAttempted: false`). The direct path is taken only when the job file and the state index agree.
- Job records carry `transport` (`broker` / `direct`, set when the turn starts) and, on the worker's own final record, `appServerExited` (whether the direct app-server child's exit was observed before the 5 s close deadline). On Windows a vanished-root cancel is recorded `cancelled` only with `workerClosed` and an observed exit.
- Windows `SessionEnd` keeps a job whose kill was refused (`identity-unavailable`) or threw (`kill-failed`) even when its worker already exited (`kept=true`), the same rule the broker teardown uses.
- A worker's pid sidecar is written only while its job is queued or running, under the state lock; job-file reads retry `EPERM`/`EBUSY` on Windows.

### Compatibility
- New job record fields in `status --json` / `result --json`: `transport`, `appServerExited`.
- New `/codex:cancel` pending reason `turn-not-interrupted`; a brokered cancel can take up to ~10 s longer.
- Known limitations (spec §Limits, CHANGELOG): a brokered turn that never ends keeps the job `running` until it ends or the broker is shut down; jobs started before 1.4.2 have no `transport` and are treated as brokered; on Windows the observed direct child is the `codex.cmd` shim's `cmd.exe`.

### Validation
- Exact tag target: `5e45e86f1fd541ab6183f5f40392453dd807973c`
- Local gate: 466 tests (455 pass, 11 skipped), 0 leaked test processes, `npm run build`, `npm run check-version`, `claude plugin validate . --strict`
- GitHub CI: run on `5e45e86` — https://github.com/CBEPX/codex-plugin-cc/actions/runs/36635024275 (10/10 jobs green); previous SHA `9f8058c` run 36631219293: 10/10 jobs green
- Review: Codex adversarial review — pass 1 found one blocking-class item (fixed in 9f8058c), pass 2 SHIP; Claude (Fable) review per task and whole-branch — approved with nits, applied
- Runtime dependency audit: `npm audit --omit=dev` reports 0 vulnerabilities

### Artifact
- `cbepx-codex-plugin-cc-1.4.2.tgz` + `SHA256SUMS`
