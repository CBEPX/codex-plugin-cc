# Adversarial fix wave 6 report

Base: 7f765b4. One commit. The gate ran `npm run check && sleep 10 && leak=0 && git add … && git commit`. The pre-gate full run passed: 424 tests, 413 pass, 0 fail, 11 skipped.

## W1: the claim is made inside the lock (pass-5 #1)
- `ensureBrokerSession` re-reads `broker.json` inside `withStateLock`.
  - If any record is there (starting or ready), it does not spawn. It removes its unused session dir and re-enters the stale/wait path for that record.
  - That re-entry is bounded: new `attempt` argument, `CLAIM_ATTEMPTS = 3`, then `null` with one stderr line.
- The identity save and the ready save go through `saveClaimed`. It takes the lock and saves only while the record on disk still has this start's `endpoint` and `pid`. Otherwise it logs one line and skips the save. The endpoint is unique per mkdtemp session dir, so it serves as the claim nonce.
- The pid save sits in the same lock section as the starting write.
- Test: "claims inside the lock: a start that finds a record there does not spawn".
  - A second `ensureBrokerSession` is launched from the first call's `createBrokerEndpoint` seam, which runs between the first call's read and its lock.
  - Asserts: one spawn, and both calls return the same endpoint.
  - RED: 2 spawns. GREEN: 1.

## W2: starting records are kept at SessionEnd; presence is read under the lock (pass-5 #2)
- The hook re-reads the broker record just before `teardownBrokerSession`.
  - The re-read record is used only if its endpoint equals the one the handshake went to.
  - If the record is gone, the hook falls back to the snapshot.
  - `starting: Boolean(record) && pid === null`.
- `teardownBrokerSession({ starting: true })` returns `{ signalled:false, reason:"starting", kept:true }` and unlinks nothing, on every platform. The reason-enum comment was updated.
- `cleanupSessionJobs` takes `deps.loadBroker` (a getter) and calls it inside its `withStateLock`. `deps.broker` remains as a fallback. The hook passes `() => brokerPresence(cwd, process.env)` on win32.
- Tests:
  - teardown `starting` unit test (win32 and linux; files kept).
  - hook: "keeps a starting broker record and its files".
  - hook: "re-reads the broker record right before teardown". A stub rewrites the record with a live idler's pid and identity during the handshake. The idler is killed and the record cleared.
  - cleanup: `loadBroker` is called while a lock ticket is held.
  - All were RED before the change.
- Test changed: the test at `broker-stale-pid.test.mjs` ~685 ("retries a busy answer") now uses a dead pid (plus `win32:1` on Windows). A pid-less record is now a starting record and is kept.

## W3: a failed start is cleared only after exit (pass-5 #3)
- After the verified kill (called directly, with `commandLineMatch: () => !exited()`), the start polls up to 2 s (`FAILED_START_EXIT_WAIT_MS`) for the child's exit.
  - Exited: files are removed (`teardownBrokerSession` with no pid) and the record is cleared under the lock if it is still this start's.
  - Alive: record and files are kept, the identity probe is retried once if the first probe returned null (claim-guarded save), and one stderr line is written.
- Test: the old "delivered" test was rewritten as "clears a failed start only once its child exited".
  - Exits: the injected kill really kills the child; the record and log file are gone.
  - Alive: the kill is a no-op; the record is kept with the retried identity, the log file is present, and there are 2 probes.

## W4: the 241 orphan block (pass-5 #4 and the re-review)
- (i)/(ii) The kill-tree BFS is now a PowerShell function, `Walk($top, $topStart)`, used by both paths:
  - the kill path: `$tree = @($root) + @(Walk $target (Micro $root.StartTime))`;
  - the 241 path: `Walk $target $floor`.
  - The orphan report is therefore transitive and time-ordered, and it skips the verified `$exclude` pair exactly as the BFS does. The filtered direct-children query is gone.
  - Script-text asserts cover the shared walk, the exclusion check inside `Walk`, `$queue += $cid`, no `Kill()`, and no `-Filter` in the 241 block.
- (iii) The limitation is documented in spec §1 (out of scope), §5 (risk) and the README Windows section: a descendant whose intermediate parent died too cannot be seen.
- (iv) Diagnosis: the test spawned the "orphan" grandchild without `detached`. On Windows, libuv assigns every non-detached child to the parent's kill-on-job-close Job Object, so `parent.kill()` took the grandchild down with it. The script then found no descendants and printed nothing, which gives `process-missing` with no survivors, exactly the CI result. The script's query typing and µs floor are not implicated.
  - The production broker is spawned `detached: true` and so survives.
  - Fix: the grandchild is spawned with `detached:true` and `unref()`.
  - The test now asserts the orphan is alive before the kill.
  - It wraps the real `runCommand` through `runCommandImpl`, so the failure message carries the script's exit, stdout and stderr, plus both pids and identities.
  - The test is still `{ skip: !IS_WIN }`.

## W5: `commitCancel` (pass-5 #5)
- A terminal record is kept if the reaper wrote it: `errorMessage.startsWith(DEAD_WORKER_MESSAGE)`, now exported from tracked-jobs. This applies whatever `causedByCancel` is.
- Otherwise the rule is unchanged: a terminal record is overwritten only when this cancel caused it.
- The log reason is `written by the reaper` or `interrupt not acknowledged`.
- Test: a table test covering the reaper message (bare and with a suffix) × causedByCancel, and the worker's own record × causedByCancel. RED on the missing export; GREEN after.

## W6: docs
- Both CHANGELOG copies:
  - The stale "Changed" sentence was replaced: a vanished root with no orphan evidence is cancelled; with orphans it stays pending; a reaper failure is kept; the worker's own record after an ACKed interrupt or a delivered kill becomes cancelled.
  - The "Fixed" bullet was aligned with W1–W3 and W5.
  - `check-changelog` passes.
- Spec rev. 15: date line, §1, §3.4 step 1 and step 3, the "Broker start window" and "Cancel outcome" paragraphs, §5, and §6 items 5–7.
- README: the Windows paragraph was updated.

## Concerns
1. W5 uses `startsWith`, not `===`. The reaper writes two suffixed variants ("(pid reused: …)", "(… unrelated process)"). Strict equality would let a cancel overwrite those, which goes against the ruling's rationale. This widens the ruling in line with its intent; it needs your sign-off.
2. The identity and ready saves now take the state lock. A win32 cancel holds that lock for up to about 4.5 s, and the default wait is 5 s. A start that overlaps a cold cancel could see a lock timeout thrown from `ensureBrokerSession`; before this change these saves were unlocked.
3. The W4 script change, the live orphan test, and the W2 hook re-read test on win32 can only be confirmed on Windows CI. PowerShell cannot be run on this host.
4. The W1 retry re-enters the whole function, so a start that loses the claim three times returns `null` and the caller falls back to a direct app-server.
