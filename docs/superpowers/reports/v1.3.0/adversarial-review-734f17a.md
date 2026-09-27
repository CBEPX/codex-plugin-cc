# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

DO-NOT-SHIP 734f17a: two paths can signal recycled PIDs, cancellation can leave workers writing, and identity probes break shutdown budgets. Twelve focused tests passed; adversarial reproductions used in-memory dependencies, not live PID reuse or Windows E2E.

Findings:
- [high] Guard fresh-broker termination against an already-exited child (plugins/codex/scripts/lib/broker-lifecycle.mjs:272-279)
  Reproduction: spawn a broker script that exits immediately, then let readiness time out. A real exited ChildProcess retained its numeric pid with exitCode=0; replaying this branch still called killProcess(pid). The readiness await gives the OS time to recycle that PID. The default terminator can then signal an unrelated process group, or taskkill an unrelated Windows process tree. Retaining the JavaScript child object does not reserve its PID.
  Recommendation: Check child.exitCode and child.signalCode after the await, use the child handle for direct termination, and revalidate ownership before numeric PID/group termination. Add an early-exit regression.
- [high] Recheck legacy broker ownership after the readiness retry (plugins/codex/scripts/lib/broker-lifecycle.mjs:244-247)
  For broker.json without pidIdentity, ownership is checked before the two-second retry, but teardown receives ownsProcess: () => true. If the broker exits and its PID is recycled during that wait, any nonempty command line passes terminateRecordedProcess. An in-memory replay changed the command from the expected broker to /bin/unrelated during retry and observed termination with reason command-line-match. This defeats the compatibility path's protection against killing unrelated processes.
  Recommendation: Preserve the real broker command-line matcher at teardown and verify ownership after the retry. Add a regression where ownership changes during the wait.
- [high] Keep unconfirmed cancellations active and recoverable (plugins/codex/scripts/codex-companion.mjs:1323-1329)
  On Windows, terminateRecordedProcess always refuses, yet cancel records cancelled and deletes the PID sidecar. Reproduction: pause a write worker after runTrackedJob records running but before thread/turn IDs exist, then cancel. No interrupt or kill occurs; the command nevertheless reports cancelled. Releasing the worker lets it continue writing and overwrite cancelled with completed. The actual functions reproduced this sequence with Windows dependencies mocked. The broker idle timeout cannot bound a connected worker or a direct resume runtime.
  Recommendation: Retain the active record and PID until termination is confirmed; report cancellation failure or pending status otherwise. Provide cooperative worker cancellation and prevent later completion from overwriting an acknowledged cancellation.
- [medium] Include every lock identity probe in the shutdown deadline (plugins/codex/scripts/lib/state.mjs:309-310)
  Each blocker gets an independent 2000 ms probe, while waitForTurn checks its deadline only between complete scans. acquireTicket also probes its own identity with the default 10000 ms timeout before starting that deadline. Reproduction: eight live blocker tickets plus timed-out probes make one scan consume 16 seconds, exceeding both SessionEnd's 12-second budget and its 15-second hook timeout. A simulated-clock replay with waitMs=100 consumed 26025 ms including the initial probe before raising CODEX_STATE_LOCK_TIMEOUT.
  Recommendation: Create one deadline before the initial identity lookup, pass remaining time into every probe, and stop scanning when it expires. Test slow probes under multiple contenders.

Next steps:
- Fix these four paths and add the described regressions before release.
- Run OS-level early-exit, Windows cancellation, and slow-probe lifecycle tests after fixes.

Reasoning:
- **Locating ancestor instructions**
- **Announcing applicable skills**
- **Preparing static commands**
- **Inspecting process runtime source**
- **Inspecting targeted process tests**
- **Testing child PID reuse**
- **Checking router response**
- **Reviewing applicable guidance**
- **Preparing in-memory harness**
- **Probing Darwin identity behavior**
- **Reviewing subprocess timeout behavior**
- **Checking threadless error handling**
- **Checking broker turn handling**
- **Reviewing targeted test diffs**
- **Checking state-root compatibility**
- **Preparing in-memory cancellation repro**
- **Assembling in-memory broker harness**
- **Running broker process repro**
- **Adapting the test harness**
- **Checking process identity**
- **Investigating ps truncation**
- **Choosing output limit**
- **Preparing a mock timing test**
- **Building mock timeout test**
- **Tracing lock identity**
- **Assessing identity race**
- **Checking retry ownership**
- **Checking timeout status handling**
- **Checking subagent errors**
- **Reviewing stale PID cleanup**
- **Fixing the harness delimiter**
- **Checking Windows replay**
- **Reviewing Windows cancel handling**
- **Reviewing hidden alias fallback**
- **Inspecting requested targets**
- **Checking Darwin process identity**
- **Checking process identity timeouts**
- **Checking process probe bounds**
- **Checking terminal error ordering**
- **Checking reaping wait bounds**
- **Preparing PID-race stress test**
- **Building timeout reproduction**
- **Checking cancellation handling**
- **Checking model-effort pairing**
- **Assessing PID collision evidence**
- **Checking process tests**
- **Capturing verified process identity**
- **Calibrating finding severity**

Codex session ID: 01a0e427-58e3-7c80-a58c-d7224699c394
Resume in Codex: codex resume 01a0e427-58e3-7c80-a58c-d7224699c394
