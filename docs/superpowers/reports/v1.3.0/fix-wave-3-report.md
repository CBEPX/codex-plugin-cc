# v1.3.0 fix wave 3: report (base 4ccb675)

Status: DONE_WITH_CONCERNS (one small concern, see H3 (a)). Commits (release/v1.3.0, not pushed):
- 04b901b fix(process): re-verify ownership before signalling a pid that leads no group (H1)
- 1abc001 fix(process): read whole command lines, never a COLUMNS-truncated one (H2)
- 0b89636 fix(hook): SessionEnd keeps records of foreground workers it did not stop (H3), including both CHANGELOG bullets and the probe-budget halving that H1 requires (see Self-review)

## H1: positive-pid fallback after group ESRCH
Change (`lib/process.mjs`):
- `terminateProcessTree` posix: when `kill(-pid)` fails with ESRCH it returns `{attempted:true, delivered:false, method:"process-group", groupGone:true}`. Any other error is rethrown. Before this change a non-ESRCH error fell through to `kill(pid)`, which rethrew the same EPERM, so behaviour matches. The primitive no longer sends a positive-pid signal.
- `terminateRecordedProcess`: the ownership proof is now a `refusal()` closure (identity check, else win32 refusal, else the posix command-line match). It runs once before the terminator. When the outcome has `groupGone`, it runs again immediately before `killImpl(pid,"SIGTERM")`. On success the result is `{delivered:true, method:"process"}`. On a refusal the result is `{attempted:true, delivered:false, reason:"identity-mismatch"|"identity-unavailable"}`. ESRCH on the bare pid gives `delivered:false`.
- G2 (fresh-broker child handle): `killProcess(child.pid)` now returns `delivered:false` on groupGone, so its existing `child.kill` fallback runs. No code change there.
Tests (tests/process.test.mjs):
- The G1 unit tests are replaced by "terminateProcessTree never signals the bare pid after the group kill fails" (calls `[[-4242,"SIGTERM"]]`, groupGone).
- New tests: (a) "re-verifies the identity before signalling a pid that leads no group": calls `[[-42,"SIGTERM"],[42,"SIGTERM"]]`, 2 identity reads. (b) "refuses the bare pid when its identity changed after the group kill": only the group call, `identity-mismatch`. (c) "refuses the bare pid when its command line changed after the group kill": legacy ps path, refused.
RED: `ℹ pass 0 / ℹ fail 4`. GREEN: process.test.mjs `pass 16 fail 0`. broker-stale-pid + tracked-jobs: `pass 53 fail 0`.

## H2: truncated command lines
Change (`lib/process.mjs` `processCommandLine`):
- linux reads `/proc/<pid>/cmdline` through `options.readFileSyncImpl`, splits on NUL, drops empty parts and joins with spaces. Empty or unreadable gives null.
- Other posix platforms run `ps -ww -o command= -p <pid>` with `env {...process.env, COLUMNS:"10000", LC_ALL:"C"}` and `shell:false`. Empty or whitespace output gives null.
Consumers already treat null as unknown:
- The reaper G3 rule acts only on `typeof === "string" && commandLine && !includes("codex-companion.mjs")`.
- `ownsBrokerProcess` returns false on null, so the teardown refuses and nothing is signalled.
- `workerCommandLine` goes through `terminateRecordedProcess`, where `Boolean(commandLine)` is false and the kill is refused.
Tests (tests/process.test.mjs):
- "processCommandLine reads /proc/<pid>/cmdline on linux": path `/proc/42/cmdline`, a long path with the marker is kept, no NUL remains, empty and throwing reads give null, ps is never run.
- "processCommandLine asks ps for unlimited width off linux": `-ww` in args, `COLUMNS=10000`, `LC_ALL=C`, `shell:false`, blank output gives null.
- The reaper null case is covered by the existing tests/tracked-jobs.test.mjs "reapDeadJobs keeps a legacy running job whose command line cannot be read" (impl returns null, job stays running).
Fixture ripple: three legacy `terminateRecordedProcess` fixtures in tests/process.test.mjs faked `ps` via `runCommandImpl` with `platform:"linux"`. On linux the new code reads /proc, so they now say `platform:"darwin"`. No other test fakes a ps command line (`rg` for `command=` or `-o` in tests found none). The `processCommandLineImpl` fixtures in tracked-jobs are unaffected.
RED: `ℹ pass 16 / ℹ fail 2`. GREEN: `pass 18 fail 0`. broker-stale-pid + tracked-jobs: `pass 53 fail 0`.

## H3: SessionEnd dropped records it never stopped
Change (`session-lifecycle-hook.mjs` `cleanupSessionJobs`):
- For every running or queued foreground job of the ending session, the hook computes a keep reason. It is `budget-exhausted` when the probe budget is below MIN_STEP_MS. It is null when the outcome is `no-pid` or `attempted && delivered`. Otherwise it is `not-delivered` (attempted but not delivered), the refusal reason, or `kill-failed` (the call threw). A reason is cleared when `isPidAlive(pid) === false`.
- Kept jobs stay in `state.jobs` untouched, so `saveState` does not prune their request, pid or log files. Each one gets one stderr line: `[codex] SessionEnd left <id> running: <reason>`.
- `activeWorkspaceJobs` then sees kept jobs and the broker stays up.
- Background jobs, finished own jobs and other sessions' jobs behave as before.
Tests (tests/broker-stale-pid.test.mjs):
- (a) "session end keeps the record of a foreground worker it refused to signal". Two live stand-ins:
  - A legacy record whose pid runs `codex-companion.mjs task-worker --job-id task-someone-else`. After SessionEnd it is still present with status `running`, its `.request.json` and `.pid` files are intact, and stderr names it.
  - A record with `pidIdentity` that does not match the live pid. The record is kept and stderr names it. Both workers are still alive.
  - Deviation from the brief: for the identity-mismatch record the test does not assert `status running`. After cleanup, `activeWorkspaceJobs` runs `reapDeadJobs`, and its existing rule marks a mismatched identity as "pid reused" and fails the job. That is the reaper's verdict on a record whose worker is gone from that pid, and it removes the request payload. The record is never silently deleted. The "running + files intact" assertion is carried by the legacy job instead.
- (b) "session end keeps the records of foreground jobs its budget never reached": `CODEX_COMPANION_SESSION_END_BUDGET_MS=1`, with a stand-in whose command line would match if the job were reached. The record stays running, the request file is intact, stderr names it and the worker is alive.
- (c) delivered kill still removes the record: covered by the existing tests/runtime.test.mjs "session end fully cleans up jobs for the ending session" (passes in the gate).
RED: `ℹ pass 0 / ℹ fail 2` (stderr had no "left" line). GREEN: `pass 2 fail 0`. Whole broker-stale-pid file after the budget change: `pass 29 fail 0`.
CHANGELOG (both copies, identical 1.3.0 sections): one bullet under Fixed for H3. H1 and H2 need no bullet. The cancel bullet's "a pid that leads no process group is signalled directly" is still accurate, because that signal now follows a re-verification.

## Self-review
- No primitive signals a positive pid from a stored record without a fresh proof:
  - `terminateProcessTree` posix only signals `-pid`.
  - The win32 `killImpl(pid)` ENOENT fallback is reached from stored records only after an identity match, and win32 identity is always null, so those kills are refused.
  - `terminateRecordedProcess` re-proves ownership right before its bare-pid SIGTERM.
  - Remaining positive signals: the G2 `child.kill` on a live, unreaped handle (the allowed exception) and `app-server.mjs` win32 on a live `this.proc` handle.
- `/proc/<pid>/cmdline` and `ps -ww` both return null on empty or unreadable output (tested).
- SessionEnd removes a running foreground record only when the kill was delivered, the pid is provably dead, or there is no pid.
- The 12 s budget still holds. H1 can add a second probe per kill, so SessionEnd now gives each probe `min(2000, remaining/2)` in worker cleanup and `stepBudget(2000)/2` in broker teardown, and both probes fit inside the budget. Without this change a hung `ps` could run up to 2 s past the budget; the hooks.json timeout of 15 s would still have held. This change lives in the H3 commit, not H1, because it was found during self-review after H3 was committed. Interactive rebase is unavailable here, so it was amended into the last commit.
- Tests leave no processes behind: the stand-ins are SIGKILLed in `t.after`, and `pgrep -f codex-plugin-test-` gives 0.

## Gate (verbatim, final head 0b89636)
```
$ npm test > /tmp/npm-test-fix3.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-fix3.log; test "$st" -eq 0
ℹ tests 305
ℹ pass 305
ℹ fail 0
(exit 0)
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
$ npm run build
> @cbepx/codex-plugin-cc@1.3.0 prebuild
> mkdir -p plugins/codex/.generated/app-server-types && codex app-server generate-ts --out plugins/codex/.generated/app-server-types
> @cbepx/codex-plugin-cc@1.3.0 build
> tsc -p tsconfig.app-server.json
(exit 0)
$ npm run check-version
> node scripts/bump-version.mjs --check
All version metadata matches 1.3.0.
$ claude plugin validate . --strict
Validating marketplace manifest: /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.3.0/.claude-plugin/marketplace.json
✔ Validation passed
```
Working tree clean after the gate.
