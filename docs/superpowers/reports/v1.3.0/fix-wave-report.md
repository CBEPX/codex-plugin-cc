# v1.3.0 fix wave report (base 734f17a)

Status: DONE

## Commits (734f17a..HEAD)

- 9237cd4 fix(codex): name the main turn from turn/started when turn/start carries no id (#781)  (F1 + C error comment)
- 88853b3 fix(broker): never signal an exited fresh child or an unverified legacy pid  (A1, A2, C compare-before-delete, C fresh-broker test cleanup)
- 41ca814 fix(cancel): keep the job running when the worker kill was refused  (A3, C rename of runtime test)
- 6685f03 fix(state): bound lock identity probes by the acquisition deadline  (A4)
- ec3e295 fix(setup): validate the gate effort against the gate model before any write  (F2)
- c81c4b5 docs: v1.3.0 fix-wave wording (fallback root, cancel, alias resolution, triage)  (F3 + C docs + C triage)
- 14378ed test(cancel): give the queued-window worker a provable identity  (follow-up to A3, see below)

All test runs below use `node --import ./tests/test-env.mjs --test ...` (or plain `node --test`, where marked), from the worktree root.

## A1 — fresh broker that fails readiness (broker-lifecycle.mjs)

Change: after `waitForBrokerEndpoint` fails, nothing is signalled if `child.exitCode !== null || child.signalCode !== null`.
A live child is killed with `child.kill("SIGTERM")`; only if that throws or returns false does the numeric kill run, through
`teardownBrokerSession({ pid: child.pid, pidIdentity, killProcess, ownsProcess: ownsProcessImpl })`, i.e. `terminateRecordedProcess`
with identity (or `ownsBrokerProcess` command-line match when no identity). The injected `killProcess` is the fallback terminator.
File cleanup is one teardown call.

Tests (tests/broker-stale-pid.test.mjs):
- new "ensureBrokerSession never signals the pid of a fresh broker that already exited" (script `process.exit(0)`, 500 ms readiness, asserts `killed` is `[]`).
- existing "ensureBrokerSession kills a fresh broker that never becomes ready" kept for the stays-alive script. It now captures the spawned pid through the `getProcessIdentityImpl` spy (the handle kill no longer goes through `killProcess`), asserts the child is gone, and has `finally` SIGKILL cleanup (C item).

RED (`node --test --test-name-pattern="ensureBrokerSession" tests/broker-stale-pid.test.mjs`):
```
✔ ensureBrokerSession kills a fresh broker that never becomes ready (380.403167ms)
✖ ensureBrokerSession never signals the pid of a fresh broker that already exited (525.192708ms)
✖ ensureBrokerSession re-verifies a legacy broker's ownership after the readiness retry (793.531083ms)
ℹ pass 4
ℹ fail 2
```
GREEN (same command):
```
✔ ensureBrokerSession kills a fresh broker that never becomes ready (379.730958ms)
✔ ensureBrokerSession never signals the pid of a fresh broker that already exited (531.96725ms)
✔ ensureBrokerSession re-verifies a legacy broker's ownership after the readiness retry (805.60175ms)
ℹ pass 6
ℹ fail 0
```
Not covered by a test: the handle-kill-failed fallback branch (a live child whose `kill()` returns false is not practical to create).

## A2 — legacy broker.json ownership re-checked at kill time

Change: teardown after the retry gets `ownsProcess: ownsProcessImpl` (default `ownsBrokerProcess`) instead of `() => true`.
Test: new "ensureBrokerSession re-verifies a legacy broker's ownership after the readiness retry": `ownsProcessImpl` is true on
the first call only, and the test asserts `probes >= 2` and `killed` is `[]`. RED and GREEN are in the A1 output above.

C (done): after teardown, `clearBrokerSession(cwd)` runs only if `loadBrokerSession(cwd)?.endpoint === existing.endpoint`.

## A3 — cancel with a refused kill (codex-companion.mjs handleCancel)

Change: if `pid && !kill.attempted && isPidAlive(pid) === true`, cancel no longer writes the cancelled record and no longer removes
the sidecar or request file. It appends `cancellation not confirmed: worker pid N left running (<reason>)` to the job log and prints
that line plus `The turn interrupt was sent; the job stays running until the worker exits. Re-run cancel or wait for result.`
It sets exit code 1. The `--json` payload is `{ jobId, status: "running", cancellationPending: true, reason }`. The dead-pid and
kill-attempted paths are unchanged.

Test: the runtime test for the stranger pid with no identity is renamed "cancel through the no-identity command-line fallback
refuses a foreign pid and keeps the job running" (C item). It now also writes a pid sidecar and asserts:
- text cancel and `--json` cancel both exit 1, with the exact JSON payload;
- `status` still shows running;
- the sidecar still exists;
- the stranger is still alive;
- after the stranger is SIGKILLed, `status` reports a non-running terminal state.

RED (`--test-name-pattern="no-identity command-line fallback" tests/runtime.test.mjs`):
```
✖ cancel through the no-identity command-line fallback refuses a foreign pid and keeps the job running (477.01125ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  0 !== 1
```
GREEN:
```
✔ cancel through the no-identity command-line fallback refuses a foreign pid and keeps the job running (797.6625ms)
ℹ pass 1
ℹ fail 0
```
Follow-up (14378ed): the first full gate run failed "cancel removes the private request payload of a job killed in the queued
window" (`1 !== 0`). That test used a sleeper with no identity and no matching command line, so it only passed because of the
A3 bug. It now records `pidIdentity: getProcessIdentity(sleeper.pid)` and is skipped on win32, where no identity exists and a live
worker now correctly keeps the job running. After this change it passes.

## A4 — lock identity probes bounded by the deadline (state.mjs)

Change:
- `LOCK_IDENTITY_PROBE_MS` is now 500.
- `acquireTicket` computes the deadline before the self-probe.
- The self-probe uses `min(500, waitMs)`, is skipped (not cached) when under 50 ms, and its result is cached per probe implementation, including a null.
- `judgeLockEntry` probes with `min(500, deadline - now)` and skips the probe (entry HELD) when under 50 ms left. Blockers judged after the deadline therefore cost no probe, and the loop's deadline check ends the wait.
- `withStateLock(..., { getProcessIdentityImpl })` is injectable.

Test (tests/state.test.mjs): new "slow identity probes stay inside the lock wait budget". It seeds 4 live blocker tickets (pid = the
runner, identity strings) and injects a probe that sleeps `min(300, timeoutMs)` and returns null. With `waitMs: 400` it expects
`STATE_LOCK_TIMEOUT_CODE`, and the elapsed time must be under 900 ms.

RED (`--test-name-pattern="slow identity probes" tests/state.test.mjs`):
```
✖ slow identity probes stay inside the lock wait budget (98.862458ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception.
```
(Before the fix the probe could not be injected. The real probe read a mismatching identity and evicted the blockers, so the RED
shows the injection and bounding were missing, not a slow wait itself.)

GREEN:
```
✔ slow identity probes stay inside the lock wait budget (519.3955ms)
```
Full `tests/state.test.mjs`: 32/32 pass.

## F1 — turnId from turn/started (#781) (codex.mjs)

Change: in `turn/started`, when the notification's thread is the main thread and `!state.turnId`, set `state.turnId` from it
(`threadTurnIds` was already set there). The stale `failTurnOnTimeout` comment is rewritten, and so is the C `case "error"` comment:
the protocol requires `threadId`, and a notification without one never passes `belongsToTurn`.

Test: the job record's `turnId` was already filled through the progress callback, so an assertion on it passed before the fix.
The real gap was the timeout interrupt, so the new test is "a timed-out turn whose turn/start carried no id is still interrupted
(#781)". It uses `turn-start-without-id`, `FAKE_CODEX_TURN_DELAY_MS=5000` and `--turn-timeout-ms 500`. It asserts exit 1,
`fakeState.lastInterrupt.turnId` set, and the persisted job's `turnId` equal to it.

RED (`node --test --test-name-pattern="#781" tests/runtime.test.mjs`):
```
✔ task completes when the turn/start response carries no turn id (#781) (1250.482708ms)
✖ a timed-out turn whose turn/start carried no id is still interrupted (#781) (6123.988583ms)
  AssertionError: 0 !== 1   (no interrupt was sent; the turn ran to completion)
```
GREEN:
```
✔ task completes when the turn/start response carries no turn id (#781) (1269.825291ms)
✔ a timed-out turn whose turn/start carried no id is still interrupted (#781) (1751.161875ms)
ℹ pass 2
ℹ fail 0
```

## F2 — setup gate model/effort validated before any write (codex-companion.mjs handleSetup)

Change: `newModel` and `newEffort` are normalised first. The effort is validated with
`normalizeReasoningEffort(effort, newModel ?? config.stopReviewGateModel ?? null)`, where an explicit `--review-gate-model inherit`
means no model. Only after that are the gate on/off, model and effort writes done.

Test: new "setup rejects a gate effort the gate model does not support and writes nothing". `setup --review-gate-model spark
--review-gate-effort ultra --json` must exit non-zero, stderr must match `not supported by gpt-5.3-codex-spark. gpt-5.3-codex-spark
supports: `, and a later `setup --json` must show `reviewGateModel` and `reviewGateEffort` both null.

RED: `AssertionError: Expected "actual" to be strictly unequal to: 0`
GREEN: `✔ setup rejects a gate effort the gate model does not support and writes nothing` (together with `✔ stop gate forwards the configured model and effort to the review task (#769)`).

## F3 + docs C items

- Both CHANGELOGs: the fallback-root limitation now says that when `CLAUDE_PLUGIN_DATA` is unset (the SessionStart hook normally sets it inside Claude Code), the root hashes `CLAUDE_PLUGIN_ROOT`, whose path includes the plugin version. Job and broker state is therefore orphaned on every plugin update, not only when upgrading from v1.2.x. The #743 entry now describes the new pending-cancel outcome.
- `agents/codex-rescue.md` and `skills/codex-cli-runtime/SKILL.md`: no hardcoded `spark -> gpt-5.3-codex-spark`. Aliases pass through unchanged and resolve via the catalogue (primary sort by `priority`, newest family on ties).
- README: "lowest priority number first".
- `tests/commands.test.mjs`: the assertions are updated to the new text, and new `doesNotMatch(/gpt-5\.3-codex-spark/)` checks cover the agent and the skill. 22/22 pass.
- Triage: all 29 listed issues/PRs are changed `planned v1.3.0` -> `fixed-in v1.3.0`. The upstream-comment index gets a `fixed-in 1.3.0` section; `#463` stays `planned v1.3.0`.

## Optional C items

All done: error comment, compare-before-delete, fresh-broker test `finally` + runtime test rename, rescue/skill/README docs, triage.

## Self-review

- Kill sites (`rg` for `terminateProcessTree(|killProcess(|.kill(`):
  - `app-server.mjs terminateChild` acts only on a live child handle.
  - Broker fresh child: handle kill, or a proven fallback.
  - Broker stale record, SessionEnd and cancel all go through `terminateRecordedProcess` with identity or a real command-line matcher.
- SessionEnd budget: lock probes are now bounded by the remaining wait.
- Test output: no warnings in `/tmp/npm-test-fix.log`. `pgrep` returns 0.

## Gate (verbatim)

```
$ npm test > /tmp/npm-test-fix.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix.log; test "$st" -eq 0; echo "exit=$?"
ℹ tests 292
ℹ pass 292
ℹ fail 0
exit=0

$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0

$ npm run build
> @cbepx/codex-plugin-cc@1.3.0 build
> tsc -p tsconfig.app-server.json
build=0

$ npm run check-version
> @cbepx/codex-plugin-cc@1.3.0 check-version
> node scripts/bump-version.mjs --check
All version metadata matches 1.3.0.
check-version=0

$ claude plugin validate . --strict
Validating marketplace manifest: .../release-v1.3.0/.claude-plugin/marketplace.json
✔ Validation passed
validate=0
```
(The first gate run failed 1 test, the queued-window one; see A3 follow-up. The run above is after 14378ed.)

## Concerns

- A1: the fallback branch (handle kill fails on a live child) has no dedicated test.
- A3 on win32: identity is always unavailable there, so cancel of a live worker now always ends as pending (exit 1, job stays running) until v1.4.0. This matches the ruling, but it is a visible behaviour change on Windows. The queued-window test is skipped there.
- A4 RED shows the missing injection/bounding rather than a measured multi-second wait (pre-fix code could not take a slow probe).
