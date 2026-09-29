# Task 2 Report: PowerShell-запускатель: валидированный root, чистое окружение, breaker, протокол вывода

## What was implemented

### Commit 1 — `feat(process): in-box PowerShell launcher with a validated root, clean environment, output protocol and breaker` (`0dbc498`)

Added to `plugins/codex/scripts/lib/process.mjs`, immediately after `systemExe` (verbatim from the brief):

- `WINDOWS_PROCESS_MISSING_EXIT = 241`, `WINDOWS_IDENTITY_MISMATCH_EXIT = 242`, `WINDOWS_TERMINATION_FAILED_EXIT = 243`, `WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244`
- `WIN32_MAX_PID = 2147483647`, `isWin32Pid(pid)`
- `resetWindowsIdentityCircuit()` — clears the module-level breaker timestamp (test-only reset hook)
- `systemRoot(env, { existsSyncImpl })` — accepts only an absolute drive path (`^[A-Za-z]:\\[^\\/]+`) that also holds `<root>\System32\WindowsPowerShell\v1.0\powershell.exe`
- `systemPowerShell(root)` — builds that absolute path
- `powerShellEnvironment(root, env)` — minimal clean environment (`SystemRoot`, `windir`, `TEMP`/`TMP` inherited only if absolute else `<root>\Temp`, `PATH` limited to System32+root, `PATHEXT=.EXE`, `PSModulePath` pinned to the in-box module path, `NoDefaultCurrentDirectoryInExePath=1`) — never inherits the caller's `PSModulePath`/`PATH`/CLR hooks
- `encodePowerShell(script)` — UTF-16LE base64 for `-EncodedCommand`
- `parseProtocolLines(stdout)` — splits on `\r?\n`, drops only a single trailing empty line, validates every remaining line against `^[A-Z]+( \d+)*$` with no `trim()` (so space/TAB/NBSP/blank lines invalidate the whole answer); returns `null` on any violation
- `runPowerShell(script, { timeoutMs, env, runCommandImpl, existsSyncImpl, now })` — launches via the validated absolute path, `shell: false`, cwd `<root>\System32`, the clean environment, `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <encoded>`; fails closed (`unavailable: true`) when the breaker is open, `timeoutMs` is not finite/`≥1`, or the root is invalid; trips the breaker (`WINDOWS_IDENTITY_CIRCUIT_MS = 60000` on an injectable monotonic `now`) on `ENOENT`, `ETIMEDOUT`, or exit `244`; preserves `stdout` on a timeout for phase discrimination

### Commit 2 — `ci(test): enforce the leak step on every OS through the PowerShell launcher` (`3043ede`)

- Created `scripts/check-leaks.mjs` verbatim from the brief: exports `leakCount(lines)` (validates `LEAK <pid> <ppid>`* then exactly one matching `COUNT <n>`, else `null`); on posix runs `pgrep -af codex-plugin-test-`; on win32 enumerates via `runPowerShell`/`Get-CimInstance Win32_Process` and parses the reply only through `parseProtocolLines` + `leakCount`; a guarded `main()` runs only when invoked directly (`import.meta.url === pathToFileURL(process.argv[1]).href`), so the module import used by the test is side-effect free.
- Added the `leakCount` test to `tests/commands.test.mjs` verbatim from the brief.
- Replaced the v1.4.0 "reported, not enforced" Windows branch in both `.github/workflows/pull-request-ci.yml` and `.github/workflows/release-verify.yml` with the brief's step: `sleep 10 && node scripts/check-leaks.mjs | tee -a "$GITHUB_STEP_SUMMARY"`, enforced on every OS.

## Files changed

- `plugins/codex/scripts/lib/process.mjs` (+102 lines, commit `0dbc498`)
- `tests/process.test.mjs` (+90 lines: imports + 6 new tests, commit `0dbc498`)
- `scripts/check-leaks.mjs` (new, 74 lines, commit `3043ede`)
- `tests/commands.test.mjs` (+10 lines: import + `leakCount` test, commit `3043ede`)
- `.github/workflows/pull-request-ci.yml` (leak step replaced, commit `3043ede`)
- `.github/workflows/release-verify.yml` (leak step replaced, commit `3043ede`)

## TDD evidence

### Commit 1 (`process.mjs` / `tests/process.test.mjs`)

**RED** — `node --import ./tests/test-env.mjs --test --test-name-pattern="systemRoot|powerShellEnvironment|parseProtocolLines|runPowerShell" tests/process.test.mjs`, run before any implementation code was added:

```
file:///…/tests/process.test.mjs:12
  parseProtocolLines,
  ^^^^^^^^^^^^^^^^^^
SyntaxError: The requested module '../plugins/codex/scripts/lib/process.mjs' does not provide an export named 'parseProtocolLines'
…
✖ tests/process.test.mjs (28.186875ms)
ℹ tests 1
ℹ fail 1
```

Expected: the module doesn't export any of the new symbols yet — a static ESM import error rather than a runtime assertion failure, which is the expected shape of RED for a brand-new export set.

**GREEN** — same command, after implementing the block in `process.mjs`:

```
✔ systemRoot accepts only an absolute drive path that holds the in-box PowerShell (0.62325ms)
✔ powerShellEnvironment is minimal and never inherits the job's variables (0.340541ms)
✔ parseProtocolLines accepts only upper-case words followed by integers (0.139334ms)
✔ runPowerShell launches the in-box powershell.exe by absolute path, clean env, System32 cwd and an encoded script (0.207042ms)
✔ runPowerShell is unavailable without a valid root or a finite budget and never spawns then (0.41175ms)
✔ runPowerShell opens the circuit on ENOENT, ETIMEDOUT or exit 244 and closes it after a minute (0.228958ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

Full `tests/process.test.mjs` file also run standalone: 33 tests, 32 pass, 1 skip (the Windows-only `.cmd` round-trip test, `{ skip: !IS_WIN }`), 0 fail.

### Commit 2 (`scripts/check-leaks.mjs` / `tests/commands.test.mjs`)

`check-leaks.mjs` and its `leakCount` test were written together (per the brief's verbatim blocks), so RED evidence was produced retroactively by temporarily removing the implementation file and re-running the focused test:

**RED** — `mv scripts/check-leaks.mjs <scratch>/check-leaks.mjs.bak && node --import ./tests/test-env.mjs --test --test-name-pattern="leakCount" tests/commands.test.mjs`:

```
…
url: 'file:///…/scripts/check-leaks.mjs'
code: 'ERR_MODULE_NOT_FOUND'
…
✖ tests/commands.test.mjs (27.699708ms)
ℹ tests 1
ℹ fail 1
```

Expected: the test imports `{ leakCount }` from `../scripts/check-leaks.mjs`, which does not exist once moved away.

**GREEN** — restore file (`mv <scratch>/check-leaks.mjs.bak scripts/check-leaks.mjs`), same command:

```
✔ leakCount accepts only LEAK* COUNT with a matching count (0.582542ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

## Gate command and exit code per commit

Both gates were run as the exact chain the brief mandates (`npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit -m …`), executed via a script file rather than inline, because inlining the chain through this harness's `/bin/zsh -c "… eval '<command>' …"` wrapper puts the literal string `codex-plugin-test-` into the wrapper's own argv, which the mandated `pgrep -f codex-plugin-test-` inside the chain would then match against itself — a false positive that has nothing to do with the code under test. Running `bash <scratch>/gateN.sh` avoids that: the wrapper's argv is just `bash <path>`, with no marker substring, so `pgrep -f` only ever sees real fixture processes.

An earlier attempt to gate-check with `npm run check 2>&1 | tail -100` reported "exit code 0" in the background-task notification, but that is `tail`'s exit code, not `npm run check`'s (confirmed empirically: `false | tail -5; echo $?` prints `0` in this zsh/bash environment, no `pipefail`). That run was **not** treated as gate evidence; `npm run check` was re-run redirected to a log file with its exit code captured explicitly (`… > log 2>&1; echo "GATE1_EXIT:$?" >> log`) before doing anything else, and again as part of each commit's mandated `&&`-chain.

- **Gate 1 (`npm run check`, standalone verification before touching the tree further):** real exit `0`. 369 tests, 368 pass, 0 fail, 1 skip, duration ≈ 239 s.
- **Commit 1 gate** (`bash <scratch>/gate5.sh` — full mandated chain, `npm run check && sleep 10 && [pgrep check] && git add plugins/codex/scripts/lib/process.mjs tests/process.test.mjs && git commit …`): real exit `0` (captured via `echo "GATE5_EXIT:$?"` appended to the log, *after* the whole `&&` chain — a nonzero chain exit would have produced `GATE5_EXIT:<nonzero>` and no commit). Log shows `369 tests / 368 pass / 0 fail / 1 skip`, `[release/v1.4.1 0dbc498] feat(process): …`, `GATE5_EXIT:0`.
- **Commit 2 gate** (`bash <scratch>/gate7.sh` — same chain over `scripts/check-leaks.mjs tests/commands.test.mjs .github/workflows/pull-request-ci.yml .github/workflows/release-verify.yml`): first attempt failed at **parse time**, before `npm run check` ran, with a bash 3.2 (macOS's `/bin/bash`) parser bug — a `<<'EOF'` heredoc containing an apostrophe (`"the plugin's own validated launcher"`) nested inside `git commit -m "$(cat <<'EOF' … EOF)"` breaks bash 3.2's parser (`unexpected EOF while looking for matching ''`), reproduced in isolation and confirmed nothing was committed (`git log` unchanged, working tree still had the 4 files as untracked/modified). Fixed by rewording the commit body to avoid the apostrophe and re-running: real exit `0`. Log shows `369 tests / 368 pass / 0 fail / 1 skip`, `[release/v1.4.1 3043ede] ci(test): …`, `GATE7_EXIT:0`.

Both pushes succeeded: `a7711eb..0dbc498` and `0dbc498..3043ede` on `release/v1.4.1`.

## check-leaks.mjs smoke output

A first smoke run (`node scripts/check-leaks.mjs`) was executed while `npm run check`'s `npm test` step was still running in the background and returned exit 1 with two PIDs. Investigated with `ps -p <pid> -o pid,ppid,etime,command`: both PIDs (and later, seven more caught the same way) were live children of that in-flight test run (an `app-server-broker.mjs`/`codex app-server` pair under a `codex-plugin-test-*` temp dir, `ELAPSED 00:00`–`00:04`) — i.e., processes mid-test, not leaks. This is expected: the check is only meaningful once the suite has actually finished (the `sleep 10` grace period in CI exists for exactly this reason).

After confirming `pgrep -f codex-plugin-test- | wc -l` was `0` (suite finished, nothing outstanding), the smoke check was re-run cleanly:

```
$ node scripts/check-leaks.mjs; echo "exit:$?"
Leaked test processes after 10 s: 0
exit:0
```

Both workflow YAML files were also validated as syntactically well-formed (`python3 -c "import yaml; yaml.safe_load(open(f))"` for both files → `OK`).

## Self-review findings

- **Completeness:** every export the brief's Interfaces section lists is present with the exact name/signature/return shape given (`WIN32_MAX_PID`, `isWin32Pid`, `systemRoot`, `systemPowerShell`, `powerShellEnvironment`, `encodePowerShell`, `parseProtocolLines`, `runPowerShell`, the four `WINDOWS_*_EXIT` constants, `resetWindowsIdentityCircuit`). All 6 Step 1 tests and the `leakCount` test are present verbatim. Both workflow files' leak steps were replaced verbatim with the brief's YAML. `scripts/check-leaks.mjs` matches the brief byte-for-byte (spot-checked via `git show` diff against the brief's block).
- **Quality:** no renames, no restructuring beyond "after `systemExe`" as instructed; comments retained as written in the brief (they carry real rationale — breaker semantics, protocol strictness, PowerShell 5.1-only intent).
- **Discipline (YAGNI):** did not add tests for `isWin32Pid`/`WIN32_MAX_PID` beyond what the brief specifies — they're trivial one-liners consumed by later tasks, consistent with the "trivial one-liners need no test" guidance; did not touch anything outside the two files named in Step 1/3 and the four named in Step 6.
- **Testing:** focused pattern runs and full-file runs both pass; TDD evidence captured for both commits (retroactively for commit 2, documented above with the reasoning). `eslint`/`typecheck:tests`/`build` all pass as part of `npm run check` (both gate runs, real exit 0, not inferred from log text).
- **posix behavior:** the new code is reachable only through the new exports; nothing existing (`systemExe`, `resolveExecutable`, `runCommand`, etc.) was modified, so posix behavior is unchanged by construction.

## Concerns

1. **Commit trailer email mismatch.** The task brief (and the SDD-controller instructions relayed to me) explicitly specify the commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, which is what both commits use. A separate system-level attribution reminder in this session specifies `Claude Sonnet 5 <noreply@anthropic.com>` instead. I followed the task-specific brief since it names this exact trailer for this exact task in two places, but flagging the discrepancy for the controller to confirm/reconcile before merge, in case the two instructions are meant to be reconciled differently.
2. **Windows path is unverified in this session.** Per the task framing, everything Windows-specific here is proven only through injected `runCommandImpl`/`existsSyncImpl` fakes (macOS host); the real `powershell.exe`/CIM enumeration path, and the real Windows leg of `scripts/check-leaks.mjs`, will only be exercised once CI runs on `windows-latest` after this push.
3. **Gate-script apostrophe bug (environmental, not code).** Documented above for the record: macOS's `/bin/bash` (3.2.57) mis-parses a quoted heredoc containing an apostrophe when nested inside `$(...)`. This bit the *gate-running scaffolding* (a scratch shell script used to execute the mandated `&&`-chain), not any committed file. No corrective action needed beyond what was already done (reworded, re-verified with `bash -n`, re-ran); noting it in case it recurs for a future task's gate script on this same runner.

## Fix round 1 — Windows leak enumeration timeout raised to 3 minutes

**Finding (Important, from CI on `3043ede`):** on the three hosted Windows jobs the leak step's `Get-CimInstance Win32_Process` enumeration took 30–53 s (step wall time including `sleep 10`: 40 s / 59 s / 63 s), while `scripts/check-leaks.mjs` set `ENUMERATE_MS = 60000`. A run a few seconds slower than the fastest observed trips the launcher's own timeout, and the step fails closed (CI red) even with zero real leaks.

**Controller ruling:** raise `ENUMERATE_MS` to `180000` (3× margin over the measured 30–53 s) with a one-line comment explaining why; nothing else in the file changes.

**What changed:** `scripts/check-leaks.mjs`, lines 14-16:

```diff
 const MARKER = "codex-plugin-test-";
-const ENUMERATE_MS = 60000;
+// Measured 30-53 s on hosted Windows runners; 3 min gives that a 3x margin.
+const ENUMERATE_MS = 180000;
```

No other lines touched.

**Covering tests / smoke check:**

`node --import ./tests/test-env.mjs --test --test-name-pattern="leakCount" tests/commands.test.mjs`:

```
✔ leakCount accepts only LEAK* COUNT with a matching count (0.485334ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

(Unaffected by the constant change, as expected — `leakCount` only parses already-received protocol lines; the fix is about how long `runPowerShell` is allowed to wait for them.)

`node scripts/check-leaks.mjs; echo exit:$?`:

- First attempt returned `leaked test processes: 545` / `exit:1`. Investigated: the offending PID (545, gone moments later per `ps -p 545`) was **not** a real leak — my own Bash command line for that attempt itself contained the literal substring `codex-plugin-test-` (a `pgrep -f codex-plugin-test- | wc -l` sanity check chained in the same command), and this harness wraps every Bash call in `/bin/zsh -c "… eval '<command>' …"`, so that literal string sat in the wrapper `zsh` process's own argv for the duration of the call. `check-leaks.mjs`'s internal `pgrep -af codex-plugin-test-` matched that wrapper process, not a fixture leak — the same self-matching trap noted in the original report's gate-command discipline, this time tripped by an ad hoc diagnostic command rather than the gate script itself.
- Re-run with a command that does not itself contain the marker string:

```
$ node scripts/check-leaks.mjs; echo "exit:$?"
Leaked test processes after 10 s: 0
exit:0
```

**Gate command and exit code:** `bash <scratch>/gate-fix1.sh` running the mandated chain `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add scripts/check-leaks.mjs && git commit -m …` (run via a script file, not inlined, for the same self-matching reason). Real exit captured via `echo "GATE_FIX1_EXIT:$?"` appended to the log after the whole `&&` chain (not the backgrounding wrapper's own exit, which is unconditionally 0). Log tail:

```
ℹ tests 369
ℹ pass 368
ℹ fail 0
ℹ skipped 1
duration_ms 212764.474542
[release/v1.4.1 1fa1c2c] ci(test): give the Windows leak enumeration a 3 min budget (measured 30–53 s on hosted runners)
 1 file changed, 2 insertions(+), 1 deletion(-)
GATE_FIX1_EXIT:0
```

**Commit / push:** `1fa1c2c ci(test): give the Windows leak enumeration a 3 min budget (measured 30–53 s on hosted runners)` — single file changed (`scripts/check-leaks.mjs`, +2/-1), working tree clean after the commit (`git status --short` empty). Pushed: `3043ede..1fa1c2c release/v1.4.1 -> release/v1.4.1`.

**Concern for this round:** mid-fix, the Bash tool briefly returned "server-side auto mode classifier gave no verdict" for a few consecutive attempts (a transient harness issue, unrelated to this change); waited it out with read-only work (re-reading the edited file, drafting the gate script and this report section) and it cleared on retry. No impact on the final result.
