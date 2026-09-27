# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

DO-NOT-SHIP at 4ccb675: original G1–G4 cases pass targeted checks, but three lifecycle blockers remain. Broker/descendant teardown passed a real process-tree test; other reproductions used in-memory injection.

Findings:
- [high] PID fallback can signal a recycled, unrelated process (plugins/codex/scripts/lib/process.mjs:245-250)
  Reproduction: return a matching identity for PID 42, then simulate its exit and reuse when killImpl(-42) throws ESRCH. The fallback immediately signals positive PID 42 without rechecking ownership. Observed: one identity read, SIGTERM delivered to the unrelated owner, and {delivered:true, reason:'identity-match'}. For recorded processes without a retained child handle, this scheduling race can terminate an unrelated same-user process.
  Recommendation: Revalidate recorded identity or command-line ownership immediately before the positive-PID fallback; refuse on mismatch or unavailable proof. Preserve handle-based termination for owned children and add the PID-reuse regression.
- [high] Truncated command lines cause live legacy jobs to be reaped (plugins/codex/scripts/lib/tracked-jobs.mjs:435-440)
  processCommandLine invokes ps without -ww and inherits COLUMNS. Linux procps honors COLUMNS even for piped output ([source](https://gitlab.com/procps-ng/procps/-/raw/master/src/ps/global.c)). Reproduction: inject successful 80-column output for a live legacy companion whose long installation path pushes codex-companion.mjs beyond column 80. Through both production functions, the job became failed and its PID/request artifacts were removed despite remaining alive. Cancel then excludes it, and the thread-busy guard no longer protects its active turn.
  Recommendation: Read complete argv using ps -ww or an appropriate platform source. Treat unavailable or incomplete arguments as unknown, and test long paths with COLUMNS=80 before authorizing legacy-job reconciliation.
- [high] SessionEnd deletes tracking for workers it never stopped (plugins/codex/scripts/session-lifecycle-hook.mjs:140-146)
  The termination outcome is discarded, then the filter at line 154 removes every foreground job belonging to the session. Reproduction with the actual Windows refusal returned attempted:false/delivered:false yet removed the live job. A second injected case used seven jobs and six 2-second failed probes: the 12-second budget expired, the seventh worker was never attempted, and all seven records were removed. saveState also prunes their artifacts, leaving running work unavailable to status/cancel.
  Recommendation: Retain active jobs whose termination was refused, undelivered, or skipped for budget exhaustion. Preserve their artifacts and include them in the subsequent active-workspace decision.

Next steps:
- Fix the three paths and add regressions matching these reproductions; rerun native platform lifecycle checks.
- Worktree remained clean. Five model-catalog tests passed; the filesystem-mutating suite was not run in this read-only sandbox.

Reasoning:
- **Checking applicable guidance**
- **Checking review guidance**
- **Preparing in-memory tests**
- **Preparing results for review**
- **Processing broker and diff results**
- **Preparing data for review**
- **Reading the hook segment**
- **Inspecting app-server spawn**
- **Assessing PID reuse race**
- **Validating PID reuse finding**
- **Inspecting cancellation startup race**
- **Checking process command lines**
- **Checking command-line truncation**
- **Examining reaper timeouts**
- **Preparing quoted Node code**
- **Locating Linux ps documentation**
- **Reproducing cleanupSessionJobs behavior**
- **Checking job state retention**
- **Checking cleanup error handling**
- **Building handler test harness**
- **Building module test harness**
- **Running broker reproduction**
- **Testing child-process termination**
- **Preparing module harness**
- **Creating module loader helper**
- **Preparing state harness**
- **Testing cancellation outcomes**
- **Preparing reaper test fixtures**
- **Verifying COLUMNS behavior**
- **Checking zero-timeout SessionEnd**
- **Checking cleanup timeout budget**
- **Checking COLUMNS dependency**
- **Opening procps documentation**
- **Opening procps sources**
- **Validating PID reuse details**
- **Testing process-group handling**
- **Checking fresh-exit signaling**
- **Testing stub-handle bundle logic**
- **Checking cancellation handling**
- **Checking stale status handling**
- **Building parser regression**
- **Checking reaper assertions**
- **Verifying save-state pruning**
- **Reviewing SessionEnd cleanup**
- **Reading diff r12_1**
- **Rerunning the memory search**
- **Validating teardown findings**
- **Reviewing filesystem timeout handling**
- **Reviewing PID reuse handling**
- **Checking primary word limits**
- **Verifying targeted test coverage**
- **Checking model test results**

Codex session ID: 01a0e45e-6bbb-7041-9db2-c965ee42e64b
Resume in Codex: codex resume 01a0e45e-6bbb-7041-9db2-c965ee42e64b
