# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

DO-NOT-SHIP at 14378ed. A2 and A4 passed adversarial probes. A1 prevents stale-PID signalling but regresses process-tree cleanup; A3 remains incomplete. Four material findings follow.

Findings:
- [high] Cancel acknowledges termination when no signal was delivered (plugins/codex/scripts/codex-companion.mjs:1331-1336)
  Reproduction: cancel a verified foreground worker whose PID is not a process-group leader. A real process canary returned attempted:true, delivered:false after kill(-pid) raised ESRCH, while the worker remained alive. This guard checks only attempted, so cancel reports cancelled with exit 0 and removes the sidecar. Running the actual cancel and tracked-job functions with memory-backed state then reproduced cancelled → completed when the surviving worker finished. An interrupted direct-runtime turn can therefore continue after cancellation was acknowledged.
  Recommendation: Handle undelivered termination as pending; fall back to the verified individual PID when its group is absent, and protect terminal cancellation from subsequent worker writes.
- [medium] Fresh-broker cleanup leaves app-server descendants alive (plugins/codex/scripts/lib/broker-lifecycle.mjs:282-298)
  Reproduction: keep broker initialization pending with an app-server child that survives stdin EOF, then fail readiness. A real detached-process canary showed ensureBrokerSession returning null after the broker exited from SIGTERM while its child remained alive; numeric tree teardown was never called. child.kill signals only the broker, and app-server-broker.mjs installs cleanup handlers after awaiting initialization. Deleting the session files then leaves an untracked runtime; repeated startup failures can accumulate these processes.
  Recommendation: Preserve verified process-tree termination while the broker is still identifiable, with bounded waiting and escalation. Add a readiness-failure regression containing a surviving descendant.
- [medium] Refused legacy cancellation cannot converge while a recycled PID lives (plugins/codex/scripts/lib/tracked-jobs.mjs:394-405)
  Reproduction: seed a running legacy job without pidIdentity whose PID now belongs to an unrelated long-lived daemon. Three cancel/reap cycles consistently returned cancellationPending with exit 1, retained the running record and sidecar, and sent no signals. The reaper skips ownership verification without identity, so the positively mismatched command line never retires the stale job. No worker remains to publish a result; thread resume stays blocked until the unrelated daemon exits.
  Recommendation: Distinguish unavailable ownership evidence from a readable, positively mismatched command line. Reconcile the latter as a dead worker without signalling the foreign process.
- [medium] Changing only the gate model bypasses effort compatibility validation (plugins/codex/scripts/codex-companion.mjs:335-340)
  Reproduction using the committed model fixture: configure astra/ultra, then run setup --review-gate-model spark. Both calls succeed, persisting gpt-5.3-codex-spark with ultra. The next gate task rejects that combination before review starts. Validation runs only when an effort flag is supplied, so changing the model ignores the existing saved effort. The simultaneous invalid-flags case correctly writes nothing, but ordinary model-only updates still break an enabled gate.
  Recommendation: Validate the effective model and effective effort, including retained configuration values, before applying any setup writes.

Next steps:
- Fix these cases and add lifecycle regressions before shipping.
- Verified: exited fresh children and unowned fallbacks receive no numeric signal; legacy teardown rechecks ownership after retry. Two simulated 400 ms lock acquisitions ended at 425 ms, cached the failed self-probe, and issued no zero-timeout subprocess probes. Buffered and later subagent-first notifications both interrupted only the main turn.
- 15 targeted tests passed. Full filesystem-writing tests were not run. Process canaries were cleaned up; HEAD and the clean worktree remained unchanged.

Reasoning:
- **Checking local project instructions**
- **Reading review guidance**
- **Preparing separate static reads**
- **Reading instructions and source**
- **Inspecting truncated output**
- **Checking foreground cancellation**
- **Building in-memory VM probes**
- **Preparing VM test harness**
- **Checking timeout-boundary handling**
- **Classifying PID identity states**
- **Reading resolveCancelableJob source**
- **Building an in-memory test harness**
- **Preparing VM source harness**
- **Storing reusable harness prefix**
- **Checking worker exit**
- **Preparing broker process test**
- **Building broker VM mock**
- **Adding state helpers**
- **Preparing in-memory filesystem**
- **Reviewing diff regressions**
- **Checking review-gate setup**
- **Verifying A4 boundary**
- **Probing the model**
- **Strengthening orphan-process reproduction**
- **Testing detached-process cleanup**
- **Re-running with a keeper**
- **Adding a timeout guard**
- **Checking child process identity**
- **Testing child group handling**
- **Selecting independent tests**
- **Inspecting branch diff**
- **Verifying process teardown**
- **Checking descendant cleanup**
- **Checking process-group ownership**
- **Preparing process-group teardown**
- **Checking targeted test results**
- **Checking source line references**
- **Checking process-tree cleanup**
- **Checking positive test evidence**

Codex session ID: 01a0e442-a901-7351-85aa-4d9895aec097
Resume in Codex: codex resume 01a0e442-a901-7351-85aa-4d9895aec097
