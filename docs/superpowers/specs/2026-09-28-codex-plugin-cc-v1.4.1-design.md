# codex-plugin-cc v1.4.1 — Windows process identity and the kill path

Date: 2026-09-28 (rev. 2 after the Codex plan review, session `01a0e764-9bd4-7641-9202-037e6ee1d4ed`). Roadmap: `~/.claude/plans/glistening-chasing-backus.md`, sections «v1.4.1» and «Дизайн: process identity». Base: `main` at 5662171 (v1.4.0).

## 1. Goal

On Windows the plugin currently refuses every kill that starts from a stored process record (`/codex:cancel`, `SessionEnd` cleanup of a still-running job, stale-broker replacement, broker teardown) with `identity-unavailable`, because `getProcessIdentity` returns `null` there. v1.4.1 gives Windows the same guarantee posix has had since v1.3.0: a recorded PID is signalled only once it is proven to still be the recorded process, and its tree goes with it. The four refusal sites become real kills; the fail-closed rule does not change: **an identity that cannot be read never authorises a destructive action.**

Success:
- On windows-latest CI: `cancel` of a background job kills the worker and the `cmd.exe → node → fake codex` tree under it; `SessionEnd` tears down the session's broker from its record; a job whose recorded identity no longer matches its pid is never signalled; a planted `powershell.exe`/`powershell.cmd` in the workspace or a relative `PATH` entry is never executed.
- posix behaviour unchanged except the two items listed in §6.
- README «Still limited until v1.4.1» removed; CHANGELOG 1.4.1; upstream comments for #743 (win32), #423/#577, #336, #416, #487, #718 and the retest asks.

Out of scope: lock-ticket identity on win32 (stays PID-liveness), lease files for `status`, darwin birth-time identity, `review --background` detachment (#615, v1.5.0), Job Objects (descendants spawned after the kill snapshot are best-effort, see §5).

## 2. Trust boundary and constraints

Roadmap constraint 9 (Windows spawn threat model) applies to PowerShell as it applied to `where.exe`/`cmd.exe`, plus what the plan review added:

- **Windows directory.** `systemRoot(env)` takes `env.SystemRoot`/`env.SYSTEMROOT`, requires `^[A-Za-z]:\\[^\\/]+` (an absolute drive path, not `.`, not UNC) and requires `<root>\System32\WindowsPowerShell\v1.0\powershell.exe` to exist; otherwise the launcher is `unavailable` (fail-closed). This is the same source `systemExe` used since v1.4.0. A project that can rewrite the plugin process's environment (Claude Code project settings can) is outside this threat model; the model covers repository *contents*: files, cwd, relative `PATH` entries.
- **Clean child environment.** PowerShell never inherits the job's environment. It gets exactly: `SystemRoot`, `windir` (= root), `TEMP`/`TMP` (from env, absolute-path-validated, else `<root>\Temp`), `PATH=<root>\System32;<root>`, `PATHEXT=.EXE`, `PSModulePath=<root>\System32\WindowsPowerShell\v1.0\Modules`, `NoDefaultCurrentDirectoryInExePath=1`. Nothing else — in particular no `COMPlus_*`/`CORECLR_*`/`DOTNET_*` (CLR profiler injection) and no inherited `PSModulePath`. cwd = `<root>\System32`, never the workspace.
- **Launch.** `powershell.exe` only by that absolute path; `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE>`; `shell:false`, `windowsHide`. Scripts use cmdlets and .NET only; the only external program a script may start is `"$env:SystemRoot\System32\taskkill.exe"` with the root we passed.
- **Output.** Machine-only: decimal integers separated by spaces/newlines; parsed with anchored regexes. Nothing localised is parsed.
- **Budgets.** Every probe/kill has a caller-supplied `timeoutMs`; below 1 ms (or unset budget spent) means «no probe» and `identity-unavailable`.

## 3. Design

### 3.1 Identity string

`win32:<FILETIME UTC>` where the number is `[System.Diagnostics.Process]::GetProcessById(pid).StartTime.ToFileTimeUtc()` — the kernel creation time from `GetProcessTimes` (100 ns units). Two reads of the same process agree; a process that inherited the PID never does. Prefix convention matches `linux:` / `darwin:`. Legacy records (`pidIdentity: null`) keep refusing on win32; no command-line probe is added. The identity is probed and verified through .NET process objects, not CIM `CreationDate`, so no DMTF-datetime precision loss enters the comparison.

### 3.2 Launcher

`runPowerShell(script, { timeoutMs, env, runCommandImpl, now })` in `lib/process.mjs`:
- validates `systemRoot(env)` and the launcher path (existence check injectable), builds the clean environment of §2, encodes the script;
- runs through `runCommand` (absolute path → direct spawn; `status: null` with `error.code === "ETIMEDOUT"` on timeout — that is what `spawnSync` reports);
- returns `{ status, stdout, timedOut, unavailable }`.
Circuit breaker: `ENOENT`, `ETIMEDOUT`, an invalid/missing root, or exit 244 opens it for 60 s of *monotonic* time (`performance.now()`, injectable); while open, every caller gets `unavailable` without spawning. A success closes it. Per process; a hook that opens it simply reports `identity-unavailable` for its remaining steps (§3.7).

### 3.3 Probes

- `getProcessIdentities(pids, options)` → `Map<pid, string|null>`. **win32 only** batches: one PowerShell run, `Get-Process -Id <a,b,…> -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }` inside try/catch (a process whose `StartTime` cannot be read — access denied, exited — prints nothing → `null`). At most 256 pids per call, deduplicated, `uint32`-range checked; more than that → the extra pids stay `null` (never the launcher marked unavailable). On posix the function loops `getProcessIdentity` with the caller's options — the posix probe itself does not change.
- `getProcessIdentity(pid)` on win32 = batch of one; own-pid cache as on posix. `timeoutMs` default 10000.
- `reapDeadJobs` uses the batch **on win32 only**, and only for the records that survive the existing terminal-file and liveness checks; the posix branch keeps its per-pid probe and per-pid budget recalculation exactly as today. An empty Map means «identity unknown» → the job is left alone, as today.

### 3.4 Kill: `terminateRecordedProcess` on win32

One PowerShell run, handle-based, in three phases with `$phase` tracked so failures map correctly:

1. **Preflight (no side effects).** `$root = GetProcessById(target)`; missing → 241. `$root.StartTime.ToFileTimeUtc()` ≠ recorded → 242. Take a CIM snapshot `Get-CimInstance Win32_Process | Select ProcessId, ParentProcessId, CreationDate`. Build the descendant set by BFS over `ParentProcessId` with a visited set, **admitting a node only if** (a) `GetProcessById` opens it, (b) its handle `StartTime` equals the snapshot `CreationDate` within 1 ms (the snapshot row really is that live process), and (c) its `StartTime` ≥ the parent's `StartTime` (a stale `ParentProcessId` pointing at a reused pid is rejected — Microsoft's own advice). Nodes failing any check are skipped and never signalled; the root's own handle is the one verified in step 1. Any error here → 244.
2. **Destructive.** Children first (reverse BFS order), `.Kill()` on the opened handle — the handle pins the process object, so a PID recycled between snapshot and kill cannot be hit. Each `Kill()` result is recorded; exceptions are caught per node (a node that already exited is not a failure).
3. **Verify.** `WaitForExit(2000)` on the root and each admitted descendant. All exited → 0. Root gone but some descendant still alive → 243 with the surviving pids on stdout (digits). Root alive after `.Kill()` → `taskkill.exe /PID <target> /F` via `"$env:SystemRoot\System32\taskkill.exe"`, then re-check: gone → 245, alive → 243. Errors in this phase → 243 (the destructive phase already ran).

Mapping to the existing result shape: 0 and 245 → `{ attempted: true, delivered: true, method: "handle", reason: "identity-match" }`; 241 → `reason: "process-missing"` with `attempted:false, delivered:false` (new vocabulary entry: proven gone, nothing to do — callers already treat `isPidAlive === false` as cleaned up); 242 → `identity-mismatch`; 243 → `attempted:true, delivered:false, reason:"kill-failed"` plus `survivors: number[]`; 244, timeout or breaker → `identity-unavailable` with `attempted:false`. A malformed recorded identity (`win32:` not followed by digits) never reaches PowerShell. Records without identity on win32 → `identity-unavailable` without spawning. The posix branch and `terminateProcessTree` (live child handle in the app-server client) do not change.

`delivered: true` therefore means: the root and every descendant that existed at the snapshot and was proven live are gone. Descendants spawned after the snapshot are outside the guarantee (no Job Object; §5).

### 3.5 Capture at spawn

`spawnBrokerProcess` (`broker-lifecycle.mjs:282`), the background-worker spawn (`codex-companion.mjs:958`) and `runTrackedJob` (`tracked-jobs.mjs:183`) already call `getProcessIdentity`; once the win32 branch returns a value they record it. Cost: one PowerShell per broker start and per `task --background` on Windows. Formats unchanged.

### 3.6 Sites that stop refusing, and the cancel contract

| Site | Today | v1.4.1 |
|---|---|---|
| `terminateRecordedProcess` win32 without identity | `identity-unavailable` | unchanged (legacy records) |
| `terminateRecordedProcess` win32 with identity | `identity-unavailable` | §3.4 |
| `getProcessIdentity` win32 (`process.mjs:217`) | `null` | §3.3 |
| `ownsBrokerProcess` win32 (`broker-lifecycle.mjs:324`) | `true` (fallback only) | unchanged; teardown reaches the identity path |
| lock tickets (`state.mjs:361/513`) | PID-liveness only | unchanged |
| `cancel` win32 | `cancellationPending`, exit 1 | kills; refusals keep the `left running: <reason>` path |

Cancel with a mismatched identity: `resolveCancelableJob` runs the reaper first (`job-control.mjs:297`), and the reaper turns a proven mismatch into `failed («pid reused»)` before cancel looks at the pid. That is the contract on every platform: a stranger holding the pid is never signalled, and the job is already terminal by the time cancel answers («job is not running»). The Windows E2E tampers the identity actually used (`pidIdentity` in the running job record, which `resolveJobPid` prefers) and asserts exactly that: cancel reports the job as failed with «pid reused», the stranger process stays alive.

### 3.7 Budgets and records

- SessionEnd (12 s after a 1 s read): worker kills use `min(WIN32_KILL_STEP_MS = 4000, remaining/2)` on win32 (`IDENTITY_PROBE_MS = 2000` stays for posix), broker teardown gets `min(4000, remaining)` on win32 (1000 stays on posix); what does not fit is reported `budget-exhausted` and left for the next SessionEnd or the broker idle timeout. A cold PowerShell on a degraded runner may spend the whole step; the breaker stops the hook from paying it twice.
- **Unknown outcome keeps the record.** Today `teardownBrokerSession` (`broker-lifecycle.mjs:361`) removes pid/log artifacts and the hook clears the broker record (`session-lifecycle-hook.mjs:319-320`) even after a refusal. v1.4.1: on `identity-unavailable`, timeout or `kill-failed` the broker record and the job record stay (the hook already keeps refused *jobs*); only `identity-match`+delivered, `process-missing`, or `isPidAlive === false` clear them. That is what lets a later SessionEnd or `cancel` retry.

### 3.8 v1.4.0 tails (first PR, before identity)

- CI leak step on Windows: `$ErrorActionPreference='Stop'`, the count excludes `$PID`, an enumeration error exits non-zero, bash checks PowerShell's exit status separately from the count; enforcing on all OSes.
- `processCommandLine` ps branch: `timeoutMs` set but `< 1` → `null` without spawning (fractional budgets are clamped to 1 ms by `runCommand`, so `0.3` still probes).
- «session end reaps a SIGKILLed background worker» (ubuntu/node18 ×2): reproduce ×10 with the broker log tail; fix the root cause if it reproduces, otherwise record.
- Dependabot `qs` (dev-only): accept the automated PR.

## 4. Testing

- posix (all matrix jobs, injected `runCommandImpl`/`existsSyncImpl`/`now`): launcher argv (absolute path from a validated root, flags, base64 round-trip), clean environment (no inherited keys, `PSModulePath` pinned, cwd = System32), root validation (`.`/relative/UNC/missing launcher → unavailable, no spawn), breaker on ENOENT/ETIMEDOUT/244 with monotonic clock and closing after 60 s, batch probe parsing (rows, missing pids, junk/localised output, cap 256), exit-code → result mapping for 0/241/242/243(+survivors)/244/245/timeout, malformed identity never spawns, reaper batching only on win32 with posix path untouched, hook budgets per platform, record retention on unknown outcomes.
- Windows only (`{ skip: !IS_WIN, timeout: 90_000 }`, required matrix): own identity read twice in a *fresh* process (no cache) agrees and differs from a long-lived child; `task --background` records `win32:`; `cancel` under `FAKE_CODEX_IGNORE_INTERRUPT=1` (so only the kill can end it) removes worker and every pid of the `cmd.exe → node → fake` tree captured before the kill; tampered `pidIdentity` → reaper marks «pid reused», cancel reports the job failed, the stranger stays alive; SessionEnd tears down a live broker from its record; planted `powershell.cmd` and a renamed copy of `cmd.exe` as `powershell.exe` in cwd and in a relative `PATH` entry, probed from a fresh process with that cwd/env → identity still `win32:` and no sentinel file written; leak step reports 0.
- Timing rules from roadmap constraint 8 apply.

## 5. Rollout and risks

- Constrained Language Mode / AppLocker: `Get-Process`/`Get-CimInstance` work, `.Kill()` and generic collections may be blocked → the script exits 244 in preflight → `identity-unavailable`, behaviour equals v1.4.0; README says so. Scripts avoid `New-Object` generics (plain arrays and hashtables) to stay CLM-friendly in the read-only phase.
- PowerShell 5.1 missing (`ENOENT`) or root invalid: breaker opens, behaviour equals v1.4.0.
- Antivirus makes the first start slow: budgets bound it; `status` never blocks longer than one probe.
- No Job Object: a descendant spawned after the snapshot survives a kill; documented; the broker idle timeout and the reaper still bound the leak.
- Upstream comments only after the user approves the drafts; the «verify» bucket (#113 #236 #285 #295 #310) gets a retest request.

## 6. posix changes (the only ones)

1. `processCommandLine` ps branch refuses a budget `< 1 ms` (was: spawned `ps` with a clamped 1 ms timeout).
2. `terminateRecordedProcess` gains the `process-missing` reason on win32 only; posix keeps `identity-mismatch` for a vanished pid (unchanged).
Everything else (reaper loop, hook budgets, broker teardown timing, poll intervals) is unchanged on posix; a Windows-only branch carries the new behaviour.
