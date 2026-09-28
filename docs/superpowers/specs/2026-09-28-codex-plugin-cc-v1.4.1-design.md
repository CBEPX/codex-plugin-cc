# codex-plugin-cc v1.4.1 — Windows process identity (CIM) and the kill path

Date: 2026-09-28. Roadmap: `~/.claude/plans/glistening-chasing-backus.md`, sections «v1.4.1» and «Дизайн: process identity». Base: `main` at 5662171 (v1.4.0).

## 1. Goal

On Windows the plugin currently refuses every kill that starts from a stored process record (`/codex:cancel`, `SessionEnd` cleanup of a still-running job, stale-broker replacement, broker teardown) with `identity-unavailable`, because `getProcessIdentity` returns `null` there. v1.4.1 gives Windows the same guarantee posix has had since v1.3.0: a recorded PID is signalled only once it is proven to still be the recorded process, and the whole tree goes with it. The four refusal sites become real kills; nothing about the fail-closed rule changes: **an identity that cannot be read never authorises a destructive action.**

Success:
- On windows-latest CI: `cancel` of a background job kills the worker (its pid disappears); `SessionEnd` tears down the session's broker from its record; a job whose sidecar identity was tampered with is left alone with `identity-mismatch`; a live app-server tree spawned through `codex.cmd` is fully gone after the kill.
- posix behaviour byte-identical to v1.4.0 (inject-tested).
- README «Still limited until v1.4.1» removed; CHANGELOG 1.4.1; upstream comments for #743 (win32), #423/#577, #336, #416, #487, #718 and the retest asks.

Out of scope: lock-ticket identity on win32 (stays PID-liveness), lease files for `status`, darwin birth-time identity, `review --background` detachment (#615, v1.5.0).

## 2. Constraints inherited from v1.4.0

Roadmap constraint 9 (Windows spawn threat model) applies to PowerShell exactly as it applied to `where.exe`/`cmd.exe`:
- `powershell.exe` is launched only by absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (a `systemPowerShell(env)` next to `systemExe`); never `pwsh`, never a bare name (#336: Store pwsh is not in-box).
- The script travels as `-EncodedCommand <base64 UTF-16LE>` with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`, so no cmd/PowerShell quoting layer sees our text and no `$PROFILE` runs.
- Scripts call cmdlets and .NET only (`Get-CimInstance`, `Invoke-CimMethod`); the one external tool, `taskkill.exe`, is referenced by its `System32` absolute path as a fallback. Nothing is resolved through `PATH` or the cwd.
- Output is machine-only: decimal integers separated by spaces and newlines. Nothing localised is ever parsed (taskkill messages, `CreationDate` as text). Code page cannot corrupt digits.
- Every probe or kill has a timeout supplied by the caller (`timeoutMs`), `spawnSync` style; a spent budget means «no probe» (`identity-unavailable`), never a longer wait.

## 3. Design

### 3.1 Identity string

`win32:<CreationDate as FILETIME UTC>` — the `[DateTime]$p.CreationDate).ToFileTimeUtc()` value, an integer with 100 ns resolution. Two reads of the same process agree; a process that inherited the PID never does. Prefix convention matches `linux:` / `darwin:`. Legacy records (`pidIdentity: null`) keep refusing on win32: there is no command-line probe there and none is added.

### 3.2 One PowerShell launcher

`runPowerShell(script, { timeoutMs, env, runCommandImpl })` in `lib/process.mjs`:
- builds the argv above from `systemPowerShell(env)` and `Buffer.from(script, "utf16le").toString("base64")`;
- goes through `runCommand` (absolute path → launched directly, `shell:false`, `windowsHide`) so the existing timeout/status semantics apply (`status: null` on timeout);
- returns `{ status, stdout, timedOut }`.
Circuit breaker: an `ENOENT`, a timeout, or exit code 244 (see 3.4) marks the launcher unavailable for `WINDOWS_IDENTITY_CIRCUIT_MS` (60 s, per process); while open, probes answer `null` immediately and kills answer `identity-unavailable`. Tests inject `runCommandImpl` and `now`.

### 3.3 Probes: `getProcessIdentity` and `getProcessIdentities`

- `getProcessIdentities(pids, options)` → `Map<pid, identity|null>`. On win32 it is one PowerShell run for all pids: `Get-CimInstance Win32_Process -Filter "ProcessId = a OR ProcessId = b …"` printing one `pid filetime` line per hit; missing pids map to `null`. On posix it loops the existing per-pid probe (no behaviour change).
- `getProcessIdentity(pid)` on win32 = `getProcessIdentities([pid]).get(pid)`; own-pid cache (`ownIdentityCache`) applies as on posix.
- `reapDeadJobs` (`tracked-jobs.mjs:380`, today one probe per live job) switches to the batch, so `status` on Windows costs one PowerShell (≈0.5–3 s cold), not one per job. `cleanupSessionJobs` does not probe separately: the kill script in 3.4 verifies the identity itself, so SessionEnd pays one PowerShell per recorded pid and nothing when there is none.

### 3.4 Kill: `terminateRecordedProcess` on win32

For a record with an identity, one PowerShell script does verify-and-kill atomically enough for our purpose:
1. `Get-CimInstance Win32_Process -Filter "ProcessId = <pid>"`; missing → exit 241; CIM error → exit 244.
2. `ToFileTimeUtc()` ≠ recorded → exit 242 (identity-mismatch).
3. Snapshot `Get-CimInstance Win32_Process | Select ProcessId, ParentProcessId`, collect descendants of `<pid>` transitively, order children-first, `Invoke-CimMethod -MethodName Terminate` on each, then on `<pid>` — this replaces `taskkill /T`, which failed for grandchildren on CI («The operation attempted is not supported»).
4. Re-read `<pid>`: gone → exit 0; still present → try `System32\taskkill.exe /PID <pid> /F`; still present → exit 243 (termination-failed); gone during the attempt → exit 245 (treated as delivered).
Mapping to the existing result shape: `{ attempted, delivered, method: "cim", reason }` with the reason vocabulary unchanged (`identity-match`, `identity-mismatch`, `identity-unavailable`, `kill-failed`); 245 ⇒ `identity-match`/delivered. The posix branch and `terminateProcessTree` (used on a live child handle by the app-server client) do not change.

### 3.5 Capture at spawn (no code change expected)

`spawnBrokerProcess` (`broker-lifecycle.mjs:282`), the background-worker spawn (`codex-companion.mjs:958`) and `runTrackedJob` (`tracked-jobs.mjs:183`) already call `getProcessIdentity`; once the win32 branch returns a value they record it. Cost: one PowerShell per broker start and per `task --background` on Windows (0.5–3 s). Sidecar and record formats are unchanged (`pidIdentity` string).

### 3.6 Sites that stop refusing

| Site | Today | v1.4.1 |
|---|---|---|
| `terminateRecordedProcess` win32 without identity | `identity-unavailable` | unchanged (legacy records) |
| `terminateRecordedProcess` win32 with identity | `identity-unavailable` | 3.4 |
| `ownsBrokerProcess` win32 (`broker-lifecycle.mjs:324`) | `true` (fallback only) | unchanged; teardown now reaches the identity path |
| `getProcessIdentity` win32 (`process.mjs:217`) | `null` | 3.3 |
| lock tickets (`state.mjs:361/513`) | PID-liveness only | unchanged (`// ponytail`) |
| `cancel` win32 | `cancellationPending`, exit 1 | kills; the existing `left running: <reason>` path stays for refusals |

### 3.7 Budgets

SessionEnd (12 s after a 1 s read): per-pid verify-and-kill runs each ≤ `min(5000, remaining/2)` (the existing `probeMs` arithmetic in `cleanupSessionJobs`), broker teardown last; anything that does not fit is reported as today (`budget-exhausted`) and left to the next SessionEnd or the broker idle timeout. On a runner that is 2–3× slower the first cold PowerShell may take the whole probe budget; the breaker prevents repeated waits inside one hook.

### 3.8 v1.4.0 tails (first PR, before identity)

- CI leak step: exclude the counting `powershell.exe` itself (`$_.ProcessId -ne $PID`) and make Windows enforcing (`exit 1` on a non-zero count) in both workflows.
- `processCommandLine` ps branch: `timeoutMs > 0` guard (deferred from v1.4.0 Task 8).
- «session end reaps a SIGKILLed background worker» flaked twice on ubuntu/node18 with «still serving another session»: the test now prints the broker log tail; investigate with it, fix or re-classify.
- Dependabot `qs` (dev-only): accept the automated PR.

## 4. Testing

- posix (all matrix jobs, injected `runCommandImpl`): the encoded script argv (absolute path, flags, base64 round-trips to the script), batch probe parsing (multiple lines, missing pids, junk output → `null`), exit-code → reason mapping for 0/241/242/243/244/245 and timeout, breaker opens on ENOENT/timeout/244 and closes after 60 s, `getProcessIdentities` on posix equals per-pid results, `reapDeadJobs`/`cleanupSessionJobs` use one probe per call.
- Windows only (`{ skip: !IS_WIN }`, required matrix): own identity stable and ≠ a `node -e` child; `task --background` → sidecar carries `win32:` identity; `cancel` kills the worker (pid gone within 10 s); tampered sidecar identity → worker left alive, `identity-mismatch`; SessionEnd tears down the broker from its record; a `codex.cmd` tree (cmd.exe → node → fake) is fully gone after the kill; a planted `powershell.cmd`/`powershell.exe` in cwd and in a relative PATH entry is never executed (sentinel file); leak step reports 0.
- Timing rules from roadmap constraint 8 apply (relative margins, `waitFor` 30 s).

## 5. Rollout and risks

- Constrained Language Mode or AppLocker may block `.NET` calls or CIM: the script exits 244 → `identity-unavailable` → refuse, same as today; documented in README.
- PowerShell 5.1 is in-box on every supported Windows; if absent (`ENOENT`) the breaker opens and behaviour equals v1.4.0.
- Antivirus can make the first PowerShell start slow; budgets bound it, and `status` never blocks longer than one probe.
- Upstream: comments only after the user approves the drafts; the «verify» bucket (#113 #236 #285 #295 #310) gets a retest request, not a fix claim.
