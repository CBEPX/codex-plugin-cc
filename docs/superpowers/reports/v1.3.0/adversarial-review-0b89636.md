# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

DO-NOT-SHIP at 0b89636: original H1–H3 reproductions pass, but two cleanup regressions remain. Sixteen selected tests passed; in-memory fault injection reproduced both findings. Native lifecycle E2E was unavailable in the read-only sandbox.

Findings:
- [medium] Halved budgets can prevent worker termination entirely (plugins/codex/scripts/session-lifecycle-hook.mjs:145)
  On Darwin, 1001 ms remaining produces timeoutMs=500.5. Node rejects this with ERR_OUT_OF_RANGE before probing ownership; the catch logs kill-failed and preserves the live worker. Executing the hook with injected state/clock reproduced no signals and no broker shutdown, while 1000 ms successfully stopped the same worker. This also occurs under the default budget when remaining time drops below 4000 ms and is odd. The broker teardown calculation at line 314 has the same defect.
  Recommendation: Floor both halved timeout values to integer milliseconds. Add odd-budget regression coverage; an in-memory Math.floor correction restored termination in the reproduction.
- [medium] Empty Linux cmdlines strand dead legacy jobs (plugins/codex/scripts/lib/process.mjs:76-80)
  For a legacy running job without pidIdentity whose worker dies before writing terminal state and remains a zombie, /proc/PID/cmdline is empty. This now returns null, while isPidAlive still returns true; reapDeadJobs therefore preserves the record indefinitely while the zombie exists. Three injected SessionEnd passes retained running status and payload files, skipped broker shutdown, and assertThreadIsFree rejected three resume attempts. The previous ps result '[node] <defunct>' allowed legacy reconciliation to mark this job failed.
  Recommendation: Add a separate Linux process-state check so provable zombies are reconciled as dead. Preserve the conservative unknown result for unreadable or empty cmdlines belonging to live processes.

Next steps:
- Fix both regressions and rerun the odd-budget, many-job, zombie-reaping, and native lifecycle checks before shipping.

Reasoning:
- **Inspecting process lifecycle**
- **Preparing targeted reads**
- **Checking the current time**
- **Preparing in-memory tests**
- **Running targeted process tests**
- **Inspecting foreground companions**
- **Checking timeout validation**
- **Reviewing timeout handling**
- **Investigating zombie detection**
- **Writing independent H1 tests**
- **Checking process identity reuse**
- **Testing zombie handling**
- **Setting up VM loader**
- **Building VM harness**
- **Modeling process races**
- **Preparing shell script**
- **Preparing function extraction**
- **Preparing session-end hook evaluation**
- **Estimating probe-budget behavior**
- **Checking lock contention**
- **Checking short-budget cleanup**
- **Checking zombie-state handling**
- **Checking reaper outcomes**
- **Checking process identity handling**
- **Checking command-line truncation**
- **Checking kill fallbacks**
- **Checking zombie detection**
- **Checking ps identity truncation**
- **Checking process identity**
- **Checking process command output**
- **Checking local ps manual**
- **Checking local ps formatting**
- **Checking reaper budget**
- **Rechecking kill-window behavior**
- **Searching repository scripts**
- **Locating module files**
- **Checking repository call volume**
- **Reviewing test results**
- **Testing reaper cancellation**
- **Checking Node runtime**
- **Testing subprocess validation**
- **Preparing /proc zombie test**
- **Verifying clean git status**
- **Reviewing regression coverage**
- **Checking dead-worker reaping**
- **Reviewing Linux process handling**
- **Checking zombie limitation note**
- **Assessing zombie regression**
- **Finishing final review**
- **Finalizing the review finding**

Codex session ID: 01a0e477-df56-7951-9866-8d4b537a7e34
Resume in Codex: codex resume 01a0e477-df56-7951-9866-8d4b537a7e34
