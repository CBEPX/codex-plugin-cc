# v1.3.0 final fix wave — consolidated findings (Claude final review + Codex adversarial review of 734f17a)

All items below are required unless marked optional. Base: 734f17a. One or more commits; each ends with
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never `grep` (use `rg`), never `git add -A`, do not push,
never touch /Users/g.mehrenin/project/personal/codex-plugin-cc (live installed plugin). Work in
/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.3.0 on branch release/v1.3.0.

## A. Codex adversarial findings (DO-NOT-SHIP items)

### A1 [high] Fresh-broker termination on a possibly exited child — plugins/codex/scripts/lib/broker-lifecycle.mjs (~272-279, the not-ready branch after spawnBrokerProcess)
The child may have exited during the readiness wait; `child.pid` stays set while the OS may recycle the pid, so the numeric
`killProcess(child.pid)` (process-group kill / taskkill) can hit an unrelated process.
Fix: after the await, if `child.exitCode !== null || child.signalCode !== null` → do not signal anything (just clean up files);
otherwise terminate through the child handle first (`child.kill("SIGTERM")` — a no-op on an exited child) and only fall back to
the numeric process-group kill when the handle kill throws/returns false AND identity/ownership can be re-verified
(`terminateRecordedProcess` with `commandLineMatch: ownsBrokerProcess`-style matcher). Keep the injected `killProcess` usable by
tests (route it as the fallback terminator). Regression test: a broker script that exits immediately (exit 0) → readiness times
out → assert the recording killer was NOT called with that pid; and the existing "fresh broker that never becomes ready is
killed" test still passes for a script that stays alive but never listens.

### A2 [high] Legacy broker.json (no pidIdentity): ownership not rechecked after the 2 s readiness retry — broker-lifecycle.mjs (~244-247)
Ownership is checked before the retry, but teardown receives `ownsProcess: () => true`; if the broker exits and the pid is recycled
during the wait, any non-empty command line passes and an unrelated process is killed (`reason: command-line-match`).
Fix: pass the real matcher to teardown (the default `ownsBrokerProcess` / `ownsProcessImpl` with the endpoint), so ownership is
re-verified at kill time. Regression: inject `ownsProcessImpl` that returns true on the first call and false afterwards (command
line changed during the retry) → `killed` stays empty.

### A3 [high] `cancel` records `cancelled` and deletes the pid sidecar even when the kill was refused — plugins/codex/scripts/codex-companion.mjs handleCancel (~1323-1329)
When `terminateRecordedProcess` returns `attempted: false` (identity mismatch/unavailable, win32) and the pid is still alive, the
worker keeps running and later overwrites `cancelled` with `completed`/`failed`; the sidecar is gone so nothing can find it again.
Fix (minimal, ruling): if `!kill.attempted && isPidAlive(pid) === true` → do NOT write the cancelled record and do NOT remove the
pid sidecar; keep the job `running`; append log line `cancellation not confirmed: worker pid N left running (<reason>)`; print the
same line plus `The turn interrupt was sent; the job stays running until the worker exits. Re-run cancel or wait for result.`;
exit code 1; JSON payload `{ jobId, status: "running", cancellationPending: true, reason }`. When the pid is dead or the kill was
attempted, behaviour is unchanged. Regression: extend the existing runtime test that tampers identity (or add one) — after the
refused cancel, `status <id>` still shows running and the sidecar file still exists; after the worker finishes on its own the job
reaches a terminal state normally.

### A4 [medium] Lock identity probes not bounded by the acquisition deadline — plugins/codex/scripts/lib/state.mjs (acquireTicket self-probe ~456, judgeLockEntry ~309-310)
Self-identity probe uses the default 10 s `getProcessIdentity` timeout before the deadline starts; each blocker probe is 2 s and
the deadline is only checked between scans → with several live blockers a scan can exceed the SessionEnd 12 s budget.
Fix: create the deadline first; self-probe with `timeoutMs: Math.min(LOCK_IDENTITY_PROBE_MS, waitMs)` (LOCK_IDENTITY_PROBE_MS =
500) and cache a failed self-probe for the process (null → do not retry within this process); pass the remaining time into every
blocker probe (`min(LOCK_IDENTITY_PROBE_MS, remaining)`), skip the probe when remaining < 50 ms (treat as unavailable → HELD), and
check the deadline inside the scan loop. Regression: inject a slow `getProcessIdentityImpl` (sleep 300 ms) with 4 live blocker
entries and `waitMs: 400` → acquisition fails with `CODEX_STATE_LOCK_TIMEOUT_CODE` within ~600 ms, not seconds.

## B. Claude final-review findings

### F1 [Important] `state.turnId` never filled in on the #781 path — plugins/codex/scripts/lib/codex.mjs `case "turn/started"` (~563) and `failTurnOnTimeout` (~690)
When `turn/start` returns no id, `failTurnOnTimeout` cannot send `turn/interrupt` and the job record has no `turnId`, so cancel cannot
interrupt either. Fix: in `turn/started`, when `(message.params.threadId ?? null) === state.threadId && !state.turnId`, set
`state.turnId = message.params.turn.id` (and `threadTurnIds`). Update the stale comment in `failTurnOnTimeout` ("notifications are
still buffered"). Extend the #781 test: the persisted job (or `--json` output) has a non-null `turnId`.

### F2 [Important] `handleSetup`: gate effort not validated against the gate model; partial writes — codex-companion.mjs (~339-348)
Fix: normalize both values first (`newModel`, `newEffort`), validate `newEffort` with `normalizeReasoningEffort(effort, newModel ?? config.stopReviewGateModel ?? null)`, and only then call `setConfig` for each. Regression: `setup --review-gate-model spark --review-gate-effort ultra` exits non-zero, writes nothing (model stays unset), and the message names the supported efforts.

### F3 [must fix, docs] CHANGELOG (both copies): fallback-root known limitation understates impact
The fallback root hashes `CLAUDE_PLUGIN_ROOT`, whose path includes the plugin version, so state is orphaned on every plugin update
(only when `CLAUDE_PLUGIN_DATA` is unset — inside Claude Code the SessionStart hook normally sets it). Reword the line accordingly.

## C. Optional in the same wave (do if cheap; skip with a note otherwise)
- Minor: `codex.mjs` `case "error"` comment claiming "error without threadId stays terminal" — correct it (such a notification never reaches `applyTurnNotification`; the protocol requires `threadId`).
- Minor: `ensureBrokerSession` after the retry: `clearBrokerSession(cwd)` only if the reloaded record's `endpoint === existing.endpoint` (compare-before-delete, like SessionEnd).
- Minor: fresh-broker test (`tests/broker-stale-pid.test.mjs` ~1106) — add `finally` cleanup of the never-listens child; rename runtime test ~1917 to say it exercises the no-identity command-line fallback.
- Docs: `agents/codex-rescue.md` and `skills/codex-cli-runtime/SKILL.md` — stop hardcoding `spark → gpt-5.3-codex-spark`; say aliases resolve via the catalogue (primary sort by `priority`, newest family on ties); README "lowest priority number first". Keep `tests/commands.test.mjs` assertions green (adjust them if they pin the old text).
- Docs: `docs/superpowers/triage/2026-09-27-upstream-triage.md` — change `planned v1.3.0` → `fixed-in v1.3.0` for the issues/PRs this release closes (#698 #710 #757 #763 #775 #781 #773 #774 #753 #762 #782 #768 #749 #743 #769 #565 #548 #589 #483 #573 #459 #721 #468 #703 #485 #521 #609 #631 #683); leave the rest.

## Gate (must be verbatim in the report)
`npm test > /tmp/npm-test-fix.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix.log; test "$st" -eq 0` → fail 0;
`sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0; `npm run build`; `npm run check-version`; `claude plugin validate . --strict`.
