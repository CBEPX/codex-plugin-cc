# codex-plugin-cc v1.4.1 — Windows process identity and the kill path

Date: 2026-09-28 (rev. 3 after Codex plan reviews `01a0e764-9bd4-7641-9202-037e6ee1d4ed` and `01a0e775-b096-7c30-8465-44c6e98fb7ea`). Roadmap: `~/.claude/plans/glistening-chasing-backus.md`, sections «v1.4.1» and «Дизайн: process identity». Base: `main` at 5662171 (v1.4.0).

## 1. Goal

On Windows the plugin refuses every kill that starts from a stored process record (`/codex:cancel`, `SessionEnd` cleanup of a still-running job, stale-broker replacement, broker teardown) with `identity-unavailable`, because `getProcessIdentity` returns `null` there. v1.4.1 gives Windows the posix guarantee: a recorded PID is signalled only once it is proven to still be the recorded process, and its tree goes with it. The fail-closed rule does not change: **an identity that cannot be read never authorises a destructive action, and an outcome that cannot be verified is never reported as delivered.**

Success:
- On windows-latest CI: `cancel` of a background job (turn interrupt ignored by the fake) kills the worker and the `cmd.exe → node → fake codex` tree under it while the shared broker another client uses stays up; `SessionEnd` tears down the session's broker from its record when the broker accepted `broker/shutdown` but did not exit; a record whose identity no longer matches the live pid is never signalled; a root killed by hand while its child lives makes `cancel` answer `cancellationPending` with the survivor listed, never `cancelled`; a planted `powershell.exe`/`powershell.cmd` in the workspace or a relative `PATH` entry is never executed.
- posix behaviour unchanged except §6.
- README «Still limited until v1.4.1» removed; CHANGELOG 1.4.1; upstream comments for #743 (win32), #423/#577, #336, #416, #487, #718 and the retest asks.

Out of scope: lock-ticket identity on win32 (PID-liveness stays), lease files for `status`, darwin birth-time identity, `review --background` detachment (#615, v1.5.0), Job Objects (descendants spawned after the kill snapshot are best-effort, §5), Constrained Language Mode support (CLM → refuse, §5).

## 2. Trust boundary and constraints

- **Windows directory.** `systemRoot(env)` takes `env.SystemRoot`/`env.SYSTEMROOT`, requires `^[A-Za-z]:\\[^\\/]+` and the existence of `<root>\System32\WindowsPowerShell\v1.0\powershell.exe`; otherwise the launcher is `unavailable` **and the breaker trips**. The plugin process's own environment is trusted (it was in v1.4.0 too; a project that can rewrite it via Claude Code settings is outside this model). The model covers repository *contents*: files, cwd, relative `PATH` entries, and everything a job's environment could inject into a child (`PSModulePath`, CLR profiler variables).
- **Clean child environment.** PowerShell gets exactly: `SystemRoot`, `windir` (= root), `TEMP`/`TMP` (from env if `path.win32.isAbsolute`, else `<root>\Temp`), `PATH=<root>\System32;<root>`, `PATHEXT=.EXE`, `PSModulePath=<root>\System32\WindowsPowerShell\v1.0\Modules`, `NoDefaultCurrentDirectoryInExePath=1`. Nothing else. cwd = `<root>\System32`.
- **Launch.** Only that absolute path; `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE>`; `shell:false`, `windowsHide`. Scripts use cmdlets and .NET only; **no external program is started by any script** (the `taskkill.exe` fallback of rev. 2 is gone: a kill that the pinned handle cannot deliver is `kill-failed`, not a second try by number).
- **Output protocol.** Each script prints only lines matching `^[A-Z]+( \d+)*$` (`OK`, `PHASE kill`, `SURVIVORS 1 2`); anything else on stdout invalidates the result (→ unknown/unavailable). Nothing localised is parsed.
- **Budgets.** Every probe/kill has a caller-supplied finite `timeoutMs ≥ 1`; otherwise «no probe» → `identity-unavailable`. The kill script receives an internal deadline (`timeoutMs − 500`) and never waits past it.
- **PID range.** Both scripts and their JS entry points accept only `1 ≤ pid ≤ 2147483647` (`Get-Process -Id` and `GetProcessById` take `Int32`); an out-of-range pid is `null`/`identity-unavailable` and never poisons a batch.

## 3. Design

### 3.1 Identity string

`win32:<FILETIME UTC>` = `Process.StartTime.ToFileTimeUtc()` read through a pinned process object (§3.4) — the kernel creation time (100 ns). Two reads of the same process agree; a process that inherited the PID never does. Legacy records (`pidIdentity: null`) keep refusing on win32.

### 3.2 Launcher

`runPowerShell(script, { timeoutMs, env, runCommandImpl, existsSyncImpl, now })` → `{ status, stdout, timedOut, unavailable }`. Breaker (`WINDOWS_IDENTITY_CIRCUIT_MS = 60 s`, monotonic `performance.now()`, injectable) trips on: invalid root, `ENOENT`, `ETIMEDOUT` (what `spawnSync` reports), exit 244. A success closes it. While open, callers get `unavailable` without spawning.

### 3.3 Probes

- `getProcessIdentities(pids, options)` → `Map<pid, string|null>`; **win32 only** batches: one PowerShell run over ≤ 256 deduplicated Int32 pids: for each `Get-Process -Id … -ErrorAction SilentlyContinue` object, `try { "$($p.Id) $($p.StartTime.ToFileTimeUtc())" } catch { }` — unreadable start time (access denied, exited) prints nothing → `null`. Extra pids beyond 256 stay `null`. posix: loops the unchanged per-pid probe.
- `getProcessIdentity(pid)` on win32 = batch of one; own-pid cache; default `timeoutMs` 10000.
- `reapDeadJobs` batches **on win32 only**, and only for records that passed the terminal-file and liveness checks; the posix branch and its per-pid budget recalculation are untouched. Empty Map = unknown → job left alone.

### 3.4 Kill: `terminateRecordedProcess` on win32

Inputs: `pid`, recorded `identity`, `excludePids` (the workspace's recorded broker pid, from `loadBrokerSession`, when the caller kills a worker), `timeoutMs`. One PowerShell run:

0. **Guards.** `$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'` → exit 244 (CLM cannot call `GetProcessById`/`Kill`; refusing beats a misleading 241). Deadline `= now + <timeoutMs − 500>`.
1. **Pin the root.** `$root = [System.Diagnostics.Process]::GetProcessById(pid)`; `[System.ArgumentException]` → 241 (the documented «not running» error); any other exception → 244. Then `$null = $root.Handle` — in .NET Framework this opens `PROCESS_ALL_ACCESS` and **caches the handle on the object** until `Dispose()`, so every later `StartTime`/`Kill()`/`WaitForExit()` on `$root` acts on that pinned process object, and a PID recycled after this point cannot be reached through it. `.Handle` failing (access denied) → 244.
2. **Verify.** `$root.StartTime.ToFileTimeUtc().ToString() -ne '<recorded>'` → 242.
3. **Tree.** `Get-CimInstance Win32_Process | Select ProcessId, ParentProcessId, CreationDate, CommandLine`. BFS from the root over `ParentProcessId` with a visited set. A child row is admitted only if all hold: (a) `GetProcessById` + `.Handle` succeed (pinned), (b) its pinned `StartTime.ToUniversalTime().Ticks / 10` (integer division: microsecond precision, CIM's own) equals the row's `CreationDate.ToUniversalTime().Ticks / 10` — exact at the snapshot's precision, no ±tolerance, UTC so DST cannot reorder, (c) that UTC value ≥ the parent's, (d) its pid is not in `excludePids` and its `CommandLine` does not contain `app-server-broker.mjs` (the shared broker a worker may have started lazily is its child by `ParentProcessId` but has its own lifecycle; its subtree is not descended into). Rejected nodes are never signalled. Errors in this phase → 244 (nothing was signalled). Prints `PHASE kill` once the tree is fixed.
4. **Kill.** Children first (reverse BFS), `.Kill()` on each pinned object; exceptions are recorded per node, not swallowed as success.
5. **Verify exit.** For each node, short `WaitForExit(250)` loops until the deadline; a node whose exit is confirmed is done; a node still alive, or one whose `WaitForExit`/`HasExited` threw, is a **survivor** (unknown ≠ exited). All confirmed → `OK` + exit 0. Otherwise `SURVIVORS <pids>` + exit 243. Errors in this phase → 243 with the whole tree listed as survivors.
6. `Dispose()` every pinned object in `finally`.

JS mapping: 0 → `{ attempted: true, delivered: true, method: "handle", reason: "identity-match" }`; 241 → `{ attempted: false, delivered: false, reason: "process-missing" }`; 242 → `identity-mismatch`; 243 → `{ attempted: true, delivered: false, reason: "kill-failed", survivors: number[] }` (survivors parsed only from a `SURVIVORS` line that matches the protocol; a malformed line → survivors unknown → `[]` with `unverified: true`); 244, breaker, invalid identity, out-of-range pid → `identity-unavailable`. **Timeout:** stdout is inspected — if `PHASE kill` was printed the kill phase had started → `{ attempted: true, delivered: false, reason: "kill-failed", unverified: true }`; otherwise `identity-unavailable`. Exit 245 no longer exists. posix branch and `terminateProcessTree` unchanged.

`delivered: true` means: the root and every admitted descendant were confirmed exited before the deadline. Descendants spawned after the snapshot are outside the guarantee (§5).

### 3.5 Capture at spawn

`spawnBrokerProcess` (`broker-lifecycle.mjs:282`), the background-worker spawn (`codex-companion.mjs:958`) and `runTrackedJob` (`tracked-jobs.mjs:183`) already call `getProcessIdentity`; once win32 returns a value they record it. Formats unchanged.

### 3.6 Sites, and the cancel contract

| Site | Today | v1.4.1 |
|---|---|---|
| `terminateRecordedProcess` win32 without identity | `identity-unavailable` | unchanged |
| `terminateRecordedProcess` win32 with identity | `identity-unavailable` | §3.4 |
| `getProcessIdentity` win32 | `null` | §3.3 |
| `ownsBrokerProcess` win32 | `true` (fallback only) | unchanged; teardown reaches the identity path |
| lock tickets | PID-liveness | unchanged |
| `cancel` win32 | `cancellationPending`, exit 1 | kills (§3.4 with `excludePids = [brokerPid]`) |

- **Mismatch.** `resolveCancelableJob` runs the reaper first (`job-control.mjs:297`); a proven mismatch becomes `failed («pid reused»)` before cancel touches the pid, so cancel answers that the job is no longer active (exit ≠ 0) and the stranger is never signalled. The Windows E2E tampers the identity the reaper actually reads (the indexed record via `upsertJob`, mirrored into the job file).
- **Survivors.** `cancel` with `kill-failed`/survivors keeps the job `running` with `cancellationPending: true, reason: "kill-failed"`, appends `orphanedPids: number[]` to the job record and the log; the root being dead does not make it `cancelled`. `SessionEnd` keeps such a job (existing `kept` path) and logs the survivors. A later `cancel` retries; when the root is gone the reaper fails the job and logs the recorded orphans.

### 3.7 Budgets and records (win32 only)

- SessionEnd: worker kills `min(WIN32_KILL_STEP_MS = 4000, remaining/2)`; broker teardown `min(4000, remaining)`; the kill script's internal deadline is `timeoutMs − 500`, so a run never exceeds its step. What does not fit → `budget-exhausted`, left to the next SessionEnd or the idle timeout. Posix keeps `IDENTITY_PROBE_MS = 2000` and its halving.
- **Records on unknown outcome (SessionEnd only, win32 only).** `teardownBrokerSession` returns `kept: true` when the outcome is `identity-unavailable`, timeout, or `kill-failed` while `isPidAlive(pid) !== false`; then pid/log/endpoint files and the broker record stay so a later SessionEnd or idle timeout can finish the job. `ensureBrokerSession`'s stale replacement is unchanged (it never blocks a user on a broken PowerShell): it replaces the record as today; the plan records this exception.
- Test knob `CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN=1`: the broker acknowledges `broker/shutdown` but does not exit, so the SessionEnd kill path is exercised end-to-end.

### 3.8 v1.4.0 tails (first PR)

- CI leak step on Windows: `$ErrorActionPreference='Stop'`, count excludes `$PID`, enumeration error → non-zero exit, bash checks the PowerShell exit status separately; enforcing on all OSes.
- `processCommandLine` ps branch: `timeoutMs` set and `≤ 0` → `null` without spawning (a fractional positive value is clamped by `runCommand` and probes).
- «session end reaps a SIGKILLed background worker» (ubuntu/node18 ×2): reproduce ×10 with the broker log tail; report; no poll-interval change in this release.
- Dependabot `qs` (dev-only): accept the automated PR.

## 4. Testing

- posix (injected impls): root validation + breaker on invalid root; clean env/cwd/argv; ENOENT/ETIMEDOUT/244 breaker with monotonic clock; batch parsing, cap 256, Int32 filter, junk stdout; script text assertions (LanguageMode guard, `.Handle` pinning before `StartTime`, `ArgumentException` → 241, µs UTC comparison, `excludePids`/`app-server-broker.mjs` exclusion, no external program, `PHASE kill` marker, `SURVIVORS` line); exit-code and stdout-protocol mapping incl. timeout-after-`PHASE kill`; reaper batching win32-only after cheap checks with a separate fixture for the empty-Map case; posix reaper per-pid budget unchanged; `killStepMs(platform)`; `teardownBrokerSession` `kept` (win32-only via injected platform) and existing posix `deepEqual` expectations updated to include `kept: false`; cancel survivors → `cancellationPending` + `orphanedPids` (injected `terminateImpl`).
- Windows only (`{ skip: !IS_WIN, timeout: 90_000 }`, required matrix): fresh-process identity (uncached, absolute file URLs for both `--import` and the module); `task --background` records `win32:`; cancel with `FAKE_CODEX_IGNORE_INTERRUPT=1` after the job has `threadId/turnId` — tree captured with names (`cmd.exe`, `node.exe`), cleanup registered right after pids are known, all gone after cancel, broker (used by a second client) still up; root killed by hand → `cancel` answers `cancellationPending` with `orphanedPids`; tampered indexed identity → reaper `failed (pid reused)`, stranger alive; SessionEnd with `CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN=1` tears the broker down by identity; planted PowerShell (renamed `cmd.exe` + `.cmd` shims, `PSModulePath` pointed at the repo) never runs; leak step 0.
- Timing rules from roadmap constraint 8 apply.

## 5. Rollout and risks

- CLM/AppLocker: scripts exit 244 at the guard → `identity-unavailable`, records kept at SessionEnd, behaviour otherwise equals v1.4.0; README says so. No CLM E2E (needs a lockdown policy the runner does not have); the guard is unit-tested by script text.
- PowerShell 5.1 missing or root invalid: breaker, v1.4.0 behaviour.
- No Job Object: descendants spawned after the snapshot survive; documented; the broker idle timeout and the reaper bound the leak.
- A process the plugin may not open (`.Handle` access denied) is `identity-unavailable`, never killed by number.
- Upstream comments only after the user approves; the «verify» bucket gets retest asks.

## 6. posix changes (the only ones)

1. `processCommandLine` ps branch refuses a budget `≤ 0` (was: spawned `ps` with a 1 ms clamp).
2. `teardownBrokerSession` gains a `kept` field in its result (always `false` on posix); existing tests that `deepEqual` the result are updated.
Everything else — reaper loop, hook budgets, broker teardown timing, poll intervals, stale replacement — is unchanged on posix; every new behaviour sits behind `platform === "win32"`.
