# codex-plugin-cc v1.4.2 — cancel waits for the turn, close reports the exit

Date: 2026-09-29 (rev. 2, 2026-09-29)

## Goal

v1.4.2 closes the two limits v1.4.1 parked from adversarial pass 13 (v1.4.1 spec §1 "Out of scope", rev. 23 sentences, and §5 — left there as history; this spec supersedes them) and two narrow gaps found next to them:

1. A brokered `/codex:cancel` (every platform) reports `cancelled` only after the turn ended. v1.4.1 reported success once the interrupt was acknowledged or the worker kill delivered, while the app-server behind the shared broker could keep running the turn.
2. On the direct transport `workerClosed` proves that `close()` returned, not that the app-server exited (`close()` also resolves at its 5 s deadline). A win32 vanished-root cancel now also needs the exit observed.
3. Windows `SessionEnd` keeps a job whose kill was refused (`identity-unavailable`) or threw (`kill-failed`) even when its root is dead — the rule the broker teardown already uses.
4. `updateJobPid` never writes a pid sidecar back for a job that is no longer queued or running.

Success: a brokered cancel whose interrupt is ignored answers `cancellationPending` (`reason: "turn-not-interrupted"`, exit 1), kills nothing and leaves the job `running`; a later cancel whose interrupt the runtime honours answers `cancelled`; a direct job's cancel sends no interrupt (`turnInterruptAttempted: false`) and starts no `codex`; posix and windows-latest CI green, leak check 0. Base: `main` 4d7d62c (v1.4.1 + process refactor).

## Trust boundary

- No spawn path changes; `docs/agent/windows-threat-model.md` does not apply. Cancel spawns less: no interrupt client for a direct job (the v1.4.1 `reuseExistingBroker` connect started a `codex app-server` of its own when no broker was recorded).
- The two new record fields are written by the job's own worker into the private per-user state directory — the trust of `workerClosed`. A forged `transport: "direct"` only selects the kill path, which still verifies identity (#743); a forged `appServerExited` reaches exactly as far as a forged `workerClosed`.
- Fail-closed defaults: a recorded turn without `transport` is treated as brokered (no kill without the turn's end); a runner that does not report its close outcome records `appServerExited: false`; the read side tolerates only a missing field (pre-1.4.2 records).

## Design

### 3.1 Record fields

- `transport: "broker" | "direct"`. `captureTurn` hands `client.transport` to the turn state; the main thread's `turn/started` progress event carries it next to `threadId`/`turnId` (`lib/codex.mjs` L594–604), and `createJobProgressUpdater` (`lib/tracked-jobs.mjs` L84–136) writes it in the same patch as `turnId` (index and job file). Every 1.4.2 record with a `turnId` therefore has a `transport`; one without is pre-1.4.2. A busy-broker retry on the direct transport emits its own `turn/started` and overwrites both.
- `appServerExited: boolean`, on the worker's cooperative terminal record only, next to `workerClosed` (still a boolean with its v1.4.1 meaning). Direct client: `closeOnce` returns `{ exited: proc.exitCode !== null || proc.signalCode !== null }`, read after the close race — never `exitPromise`, which also settles on a spawn `'error'` or a JSONL parse error while the child runs (`lib/app-server.mjs` L128, L268–270). Broker client: `close()` returns `{ exited: true }` from both branches (its only footprint is the socket). `withAppServer` adds the value to an object result on the normal and the direct-retry path; the three executions that feed `runTrackedJob` (native review, adversarial review, task) carry it; `runTrackedJob` writes `execution.appServerExited === true`.

### 3.2 Cancel

`handleCancel` order: resolve the job (reaper first, as today) → read the record → interrupt unless `transport === "direct"` → resolve the pid → **brokered wait** → (win32) take the state lock → `finishCancel` (kill, `cancelDecision`, `commitCancel`) as in v1.4.1. The wait runs outside every lock: the worker's terminal write takes the state lock.

Brokered wait: only when a turn is recorded (`turnId`) and the transport is not `direct`. If the interrupt was acknowledged, `readStoredJob` is polled every 100 ms for up to `TURN_INTERRUPT_ACK_MS` (10 000, now exported from `lib/codex.mjs`; the window the turn timeout grants the terminal notification) until the record is terminal. A terminal record ends the wait; the worker is done with the job, so the pid is dropped and nothing is killed. `causedByCancel` is true only when that record carries the worker's `workerClosed` marker; `interrupt.interrupted` alone never counts. For a direct job and for a job without a turn, `causedByCancel` is "kill delivered", as before.

| # | transport | turn recorded | interrupt | record during the wait | kill | answer (posix and win32) |
|---|---|---|---|---|---|---|
| 1 | any | no (queued, pre-turn) | not sent (no ids) | not waited | v1.4.1 | v1.4.1 |
| 2 | `direct` | yes | skipped, `turnInterruptAttempted: false` | not waited | v1.4.1: posix group signal, win32 verified tree kill | delivered → `cancelled`; posix not delivered, root alive → pending `not-delivered`; win32 survivors/unverified → pending `kill-failed`; win32 241 → `cancelled` only with no orphans and `isWorkerProvedRecord` (3.3), else pending `process-missing` |
| 3 | `broker` or missing | yes | not acknowledged | record already terminal → row 5/6 outcome; otherwise not waited | none | pending `turn-not-interrupted`, exit 1 |
| 4 | `broker` or missing | yes | acknowledged | none within 10 s | none | pending `turn-not-interrupted`, exit 1 |
| 5 | `broker` or missing | yes | acknowledged | the worker's own (`workerClosed: true`) | none | `cancelled` (record overwritten, v1.4.0 rule), exit 0 |
| 6 | `broker` or missing | yes | acknowledged | terminal without the marker (crash guard, reaper) | none | stored status kept and reported, exit 0 |

Rows 3–4 answer `{ jobId, status: "running", cancellationPending: true, reason: "turn-not-interrupted" }`; text `cancellation not confirmed: worker pid <pid> left running (turn-not-interrupted)` + `The turn interrupt was sent; the shared runtime has not ended the turn, so the worker was not stopped; the job stays running. Re-run cancel or wait for result.`; the first line goes to the job log. Nothing is killed: a dead worker would leave the turn running in the broker, and the reaper would then fail the job. Row 6 refines the ruling "wait for the marker record": any terminal status ends the wait, so a cancel never answers "stays running" over a record that says `failed`; causation stays marker-only. On win32 rows 3–6 run before the state lock, which covers only `finishCancel`.

### 3.3 Vanished root on win32

`isWorkerProvedRecord(stored) = isWorkerTerminalRecord(stored) && stored.appServerExited !== false` (`lib/job-control.mjs`) replaces `isWorkerTerminalRecord` in the companion's `workerProved` (L1376). A direct close that hit its deadline with the child alive now leaves the cancel pending (`process-missing`) for the reaper.

### 3.4 SessionEnd (win32)

`cleanupSessionJobs` (`session-lifecycle-hook.mjs` L191): `unresolved = platform === "win32" && (refused || ["identity-unavailable", "kill-failed"].includes(reason) || (outcome?.survivors?.length ?? 0) > 0 || outcome?.unverified === true)` — the rule of `teardownBrokerSession` (`lib/broker-lifecycle.mjs` L743–745). This amends v1.4.1 spec §3.7 (L83), which kept a refusal only "while `isPidAlive(pid) !== false`": `identity-unavailable` and a thrown kill (`kill-failed`) now keep the job whatever the root did; `identity-mismatch`, and `process-missing` without survivors, with a dead root are still dropped (the reaper's domain). `budget-exhausted` and posix are unchanged.

### 3.5 `updateJobPid`

`lib/state.mjs` L717–730: one `withStateLock` section reads the indexed job; unless it is `queued` or `running`, nothing is written; otherwise the sidecar is written, and the index is patched only while `queued` (as today). `recordWorkerPid` is unchanged; its second call can no longer revive a sidecar that a cancel removed during the identity probe. `withStateLock` is re-entrant (L614–623).

### 3.6 Minors

`commitCancel`'s kept-record log reason for a non-reaper record becomes `not caused by this cancel` (was `interrupt not acknowledged`, wrong since a delivered kill counts too). The `workerClosed` comment in `runTrackedJob` (L231–233) is rewritten for both fields. No other refactoring.

## Testing

- Unit: `recordWorkerPid` with a probe that cancels the job mid-probe → no sidecar; SessionEnd table rows (identity-unavailable + dead root → kept; throwing kill + dead root → kept; identity-mismatch + dead root → dropped; process-missing without survivors + dead root → dropped); `close()` → `{ exited: true }` for a killed child, `{ exited: false }` for one that never exits (both calls), broker `{ exited: true }`; `runTrackedJob` writes `appServerExited` true / false / false (silent runner); `isWorkerProvedRecord` table; `renderCancelPending` for `turn-not-interrupted`; `commitCancel` log label.
- Runtime (fake codex; new test-only knob `FAKE_CODEX_IGNORE_FIRST_INTERRUPTS=N`: the app-server answers but ignores its first N `turn/interrupt`s): brokered, honoured interrupt → worker record first, then `cancelled`, `transport: "broker"`, `workerClosed`/`appServerExited` kept through the overwrite; brokered, first interrupt ignored → pending `turn-not-interrupted`, worker alive, record `running`, then a second cancel → `cancelled` (posix; the win32 twin also proves the broker and its subtree alive and `appServerStarts` 1); direct (`--resume-last`) → no interrupt, no extra `codex` start, kill delivered → `cancelled` kept over the SIGTERM-immune worker's late write (posix), `turnInterruptAttempted: false` on the win32 tree-kill test. Unchanged tests without a turn (queued, hand-made records) prove row 1.
- Timing rules of `docs/agent/testing-and-ci.md`: no absolute bound under 10 s, `waitFor` 30 s, `{ timeout }` + `t.after` SIGKILL, failures print the stored record and the job-log tail.

## Limits

- A brokered turn that never ends after `turn/interrupt` keeps the job `running`: every cancel answers `turn-not-interrupted` until the turn ends on its own (or the worker's `--turn-timeout-ms` fires) or the shared broker is shut down (`SessionEnd`; the idle timeout cannot fire while the worker is connected). Nothing is killed meanwhile.
- A turn that ends on its own inside the 10 s wait is recorded `cancelled` (its marker record appeared during the wait — the v1.4.0 rule for an acknowledged interrupt).
- Records without `transport` (jobs started before 1.4.2) are treated as brokered: a pre-1.4.2 direct job (cold `--resume-last`) still running after the upgrade answers `turn-not-interrupted` until its turn ends.
- win32 direct transport: the child that `close()` observes is `cmd.exe` running the `codex.cmd` shim; its exit is evidence, not proof, that the shim's `node`/`codex` descendants exited.
- A direct close that returned early because `exitPromise` settled on a spawn error or a JSONL parse error records `appServerExited: false` without escalating to SIGTERM/SIGKILL (pre-existing close behaviour); a vanished-root cancel of such a job stays pending for the reaper.
- The pending text keeps "The turn interrupt was sent;" also for a direct job whose kill failed, where none was sent (text only; the JSON is exact; posix text stays byte-identical to v1.4.1).
- A brokered cancel can take up to about 10 s longer than in v1.4.1.
- Everything v1.4.1 spec §5 parks (orphan tracking, Job Objects, Constrained Language Mode) is unchanged.

## Rollout

- posix changes (all in `/codex:cancel`, plus `updateJobPid`): a brokered cancel no longer kills the worker and may answer `turn-not-interrupted`; a direct cancel no longer sends `turn/interrupt`; `status --json`/`result --json` records gain `transport` and `appServerExited` (`enrichJob` spreads the record); a sidecar is never rewritten for an inactive job. win32 only: 3.3 and 3.4.
- Docs: README `/codex:cancel` and `### Windows`, `docs/windows.md`, CHANGELOG 1.4.2 (Fixed, Changed, Known limitations ending `(spec §Limits)`).
- Gate per `docs/agent/process.md`: Fable review per task, `/codex:adversarial-review --base main --effort max` under the stop rule (cap 5 passes), then `docs/RELEASING.md` steps 0–6.

## Revision log

| rev | date | trigger | change |
|---|---|---|---|
| 1 | 2026-09-29 | v1.4.1 adversarial pass 13 parked limits; controller rulings 1–5 | initial |
| 2 | 2026-09-29 | T4 review + implementation observations | transport kept on the final record; row 3 reads the record first; pending text without pid |
