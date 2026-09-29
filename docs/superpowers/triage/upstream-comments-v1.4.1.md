# Upstream comment drafts — CBEPX fork v1.4.1

Posted 2026-09-29 after user approval (one comment per issue: #743 #423 #577 #336 #416 #487 #718; retest asks #70 #113 #236 #285 #295 #310).

Post each section's body with `gh issue comment <n> -R openai/codex-plugin-cc --body-file <file>`.

Sources: `### fixed-in v1.4.1` and `### verify` buckets of `docs/superpowers/triage/2026-09-27-upstream-triage.md`, CHANGELOG `## 1.4.1`, README «### Windows», spec §1. Release: https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1

Notes for the approver:
- The triage doc lists no issue about turns failing on U+2028/U+2029 line separators, so that transport fix is not mentioned in any comment.
- #743 (posix half), #487 (stale `broker.json` validation) and #416 (taskkill under Git Bash `SHELL`) were fixed in earlier fork releases; each draft says so.
- #416, #487, #718: v1.4.1 kills the verified tree from the stored record. It does not track a survivor that outlives its root (CHANGELOG Known limitations / README Limits); the drafts say "reported" rather than promise cleanup.
- #336 concerns Codex's own sandbox shell; the draft claims only what the plugin changed (no Store `pwsh` needed by the plugin).
- Only #423/#577 has an upstream PR to credit (#577 by @xoonjaeho); the triage doc names no reference PR for the other issues.
- #70 is still `verify` in the triage doc, so it is under retest asks.
- #219 (`verify`, taskkill under Git Bash on non-English Windows) was not in the requested list and has no draft.

## Fixed

### #743 — SessionEnd kills whatever pid `broker.json` names, without checking it is still a broker

Fixed on Windows in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1); the posix half was fixed in v1.3.0. `SessionEnd` and `/codex:cancel` now verify the recorded pid by its start time before killing, and a record without a captured identity refuses the kill (`identity-unavailable`) instead of signalling by pid. A verified tree is terminated through the in-box Windows PowerShell 5.1. If the kill cannot be verified, `SessionEnd` keeps the record (`kept=true`) and retries at the next `SessionEnd`.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

### #423 — `/codex:cancel` throws and leaves the job stuck as "running" when the pid is already dead on non-English Windows

Fixed in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1): `/codex:cancel` no longer parses `taskkill` output (locale-dependent) and no longer throws on a dead pid. A worker that is already gone is reported as `process-missing`. The job becomes `cancelled` only when no orphaned descendants are found and the worker had recorded a closed exit. Otherwise `cancel` answers `cancellationPending`, with the orphans as `survivors`. Upstream PR #577 used as reference, thanks @xoonjaeho. Limit planned for v1.4.2: a brokered cancel confirms the worker, not the turn.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

### #577 — fix: make cancel work under Git Bash on a non-English Windows (#423)

Same fix as #423, shipped in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1), used here as the reference; thanks @xoonjaeho. `/codex:cancel` on Windows now verifies the recorded process by start time and kills the verified tree through the in-box Windows PowerShell 5.1, with no `taskkill` and no `$SHELL` involved, so neither Git Bash argument mangling nor non-English console output matters. A worker that vanished first is `process-missing`; a partially surviving tree gives `cancellationPending` with `survivors`.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

### #336 — Codex sandbox shell commands fail with CreateProcessAsUserW 1312 on Windows — Store pwsh.exe cannot be spawned from Git Bash subprocess context

Fixed on the plugin side in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1): the plugin no longer needs the Store `pwsh.exe`. Its Windows process checks and kills run through the in-box Windows PowerShell 5.1, launched by absolute path (`System32\WindowsPowerShell\v1.0\powershell.exe`) with a clean environment. Shell commands that Codex's own sandbox runs are Codex's, not the plugin's, so I cannot say whether the 1312 error still appears there; a retest report would help.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

### #416 — Windows: zombie broker + codex app-server trees accumulate — broker/shutdown acks before unbounded cleanup, and taskkill tree-kill breaks under Git Bash SHELL

Fixed in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1); the `taskkill`-under-Git-Bash part was already fixed in v1.4.0 (no `$SHELL`). Now `SessionEnd` tears the broker down from its stored record when the broker accepted `broker/shutdown` but did not exit: the pid is verified by start time, then the verified tree is killed through in-box PowerShell 5.1. If part of the tree outlives the kill, it is reported as `survivors` and the record is kept (`kept=true`); a survivor is not tracked afterwards.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

### #487 — Windows: broker child processes leak and stale broker.json poisons setup tests on persistent machines

Fixed in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1); the stale `broker.json` validation was fixed in v1.3.0. The leaked children were left behind because Windows kills from a stored record were refused (`identity-unavailable`). Now a stale broker is replaced through a verified kill of its recorded process tree, and a failed broker start is killed the same way; its record is kept until the process has exited. Two racing broker starts no longer spawn two brokers. The CI leak check also runs on every OS.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

### #718 — Windows: every command leaks an orphaned broker, and a live app-server makes the workspace directory undeletable

Fixed in CBEPX/codex-plugin-cc v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1): the orphaned-broker cleanup that Windows refused (`identity-unavailable`) now works. `SessionEnd` and stale-broker replacement verify the recorded broker by start time and kill its verified tree, app-server child included, through in-box PowerShell 5.1. A broker whose kill cannot be verified keeps its record (`kept=true`) and is retried at the next `SessionEnd`. Descendants spawned after the kill snapshot are outside the guarantee and are reported as `survivors`, not killed.

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## Not closed — say why

None of #743, #423/#577, #336, #416, #487, #718 is marked "not closed" in the triage doc. The residual limits are stated inside the drafts above (#336 sandbox shell is Codex's own; #416/#487/#718 survivors are reported, not tracked).

## Retest asks

Template used for each paragraph below (the install lines are copied from README):

```
/plugin marketplace add CBEPX/codex-plugin-cc
/plugin install codex@cbepx
```

### #70 — spawnSync with shell:true fails on Windows network drives (UNC paths)

`shell:true` is gone since CBEPX/codex-plugin-cc v1.4.0, but `cmd.exe` (used for `.cmd` shims) still refuses a UNC working directory, so I cannot tell whether this is fixed. Could you retest on the fork v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1), on a checkout under a UNC path? Install: `/plugin marketplace add CBEPX/codex-plugin-cc`, then `/plugin install codex@cbepx`. Please report your OS, `codex --version`, and the output of `/codex:status --json`.

### #113 — Plugin install fails on Windows with corrupted error message

I could not reproduce this; it is an install-time error. Could you retry on the fork v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1) with `/plugin marketplace add CBEPX/codex-plugin-cc` and `/plugin install codex@cbepx`? If it still fails, please report the exact error text (screenshot or raw bytes if garbled), your OS and console code page, `codex --version`, and the `/codex:status --json` output if the plugin loads.

### #236 — Windows: codex-plugin-cc hangs at "Initializing…" when launching `codex app-server`

This is likely addressed by the spawn path since CBEPX/codex-plugin-cc v1.4.0 (no `$SHELL`, `codex.cmd` resolved from `PATH`), but I could not reproduce your setup. Could you retest on the fork v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1): `/plugin marketplace add CBEPX/codex-plugin-cc`, then `/plugin install codex@cbepx`? Please report your OS, `codex --version`, and the `/codex:status --json` output, and whether it still hangs.

### #285 — Stop/Session hooks fail on Windows when CWD is on a different drive than %USERPROFILE%

I could not reproduce this cross-drive case. Could you retest on the fork v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1) with a working directory on a different drive than `%USERPROFILE%`? Install: `/plugin marketplace add CBEPX/codex-plugin-cc`, then `/plugin install codex@cbepx`. Please report your OS, `codex --version`, the `/codex:status --json` output, and the hook error text if it still fails.

### #295 — Windows: shell tool-calls inside Codex turn fail with 'CreateProcessAsUserW failed: 1920'

By our reading, error 1920 comes from Codex's own tool sandbox rather than the plugin's process spawn, so the plugin may not be able to change it. I cannot reproduce it. Could you retest on the fork v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1): `/plugin marketplace add CBEPX/codex-plugin-cc`, then `/plugin install codex@cbepx`? Please report your OS, `codex --version`, the `/codex:status --json` output, and whether the same command fails when run directly with the `codex` CLI.

### #310 — Windows zh-TW: codex app-server JSONL parser crashes on Big5-encoded taskkill stdout leak

Since CBEPX/codex-plugin-cc v1.4.0, `taskkill` output is captured and no longer reaches the app-server stream, and v1.4.1 kills without `taskkill` at all, so this should not recur; I cannot test a zh-TW system. Could you retest on the fork v1.4.1 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.1): `/plugin marketplace add CBEPX/codex-plugin-cc`, then `/plugin install codex@cbepx`? Please report your OS and locale, `codex --version`, and the `/codex:status --json` output.
