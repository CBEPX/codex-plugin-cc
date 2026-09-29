# adv-fix-1 report

F1 (fail-open broker record): `saveBrokerSession` now writes `broker.json.<pid>.tmp` then renames. New `brokerPresence(workspaceRoot, env)` in lib/job-control.mjs (record | "unknown" when BROKER_ENDPOINT_ENV set | null); `brokerExclusion("unknown") === null`; `handleCancel` and `handleSessionEnd` (win32) use it; refusal log is `tree: refused (broker record unreadable or without identity)`.
RED: job-control tests failed on missing `brokerPresence` export; hook tests failed on the new wording; atomic test failed (`the record is swapped in by one rename`). GREEN after implementation.

F2 (cancel race): `cancelDecision` on win32 returns `{pending:true, reason:"process-missing", survivors:[]}` for `kill.reason === "process-missing"` regardless of alive; linux unchanged. The old table row (win32 process-missing, dead -> not pending) was replaced by the new win32 row plus a linux row. `renderCancelPending` renders it with the generic text (test added). The Windows E2E "root died before cancel" is unaffected: the reaper fails the job before cancel runs.

F3: README Windows section: dead root with survivors is failed by the reaper in the same SessionEnd (or next status); re-judging applies to refused/unverified/timed-out kills; added a sentence on the presumed broker. CHANGELOG untouched.

Gate: `npm run check` 403 tests, 395 pass, 0 fail, 8 skipped (skips are Windows-only).
Files: plugins/codex/scripts/lib/{broker-lifecycle,job-control}.mjs, plugins/codex/scripts/{codex-companion,session-lifecycle-hook}.mjs, README.md, tests/{job-control,session-lifecycle-hook,broker-stale-pid}.test.mjs.

## Wave 2

W1: `saveBrokerSession` renames via `retryOnWindows` (EPERM/EBUSY/EACCES); injectable `renameImpl`/`platform`; test: EPERM once on win32 succeeds on retry, linux rethrows.
W2: `cancelDecision` takes `interrupted`; win32 + not attempted (except no-pid) + dead root is pending with `kill.reason` unless the interrupt was acknowledged; `handleCancel` passes `interrupt.interrupted === true`. Table rows added; runtime tests ~2006 and ~2133 hold by reading (kill delivered / interrupt acknowledged).
W3: `brokerPresence` returns "unknown" when `broker.json` exists but did not load; `loadBrokerSession` reads with `retryOnWindows`; `resolveBrokerStateFile` exported. Test: corrupt broker.json.
W4: `brokerPresence(root, env, { record })` used by the hook (single read); `process-missing` cancel text updated; README table row and Windows paragraph updated.
RED confirmed for the new tests before implementation (missing options/behaviour). Gate: 410 tests, 400 pass, 0 fail, 10 skipped, exit 0.
