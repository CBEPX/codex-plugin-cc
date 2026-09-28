# Триаж upstream issues/PR openai/codex-plugin-cc для форка CBEPX

- Дата триажа: 2026-09-27
- Источники: `2026-09-27-upstream-issues.tsv` (269 открытых issues), `2026-09-27-upstream-prs.tsv` (239 открытых PR) — итого 508 записей
- Upstream заморожен на v1.0.6 (`db52e28`), форк CBEPX — на v1.2.1
- Примечание: `#128` упомянут в согласованной дорожной карте (кластер `models & effort`, v1.3.0), но отсутствует среди 508 открытых записей обоих TSV на дату среза — вероятно уже закрыт/влит апстримом; отдельной строки в таблицах ниже для него нет.

## Легенда статусов

- `fixed-in <ver>` — эквивалент уже смержен в форк CBEPX (см. `CHANGELOG.md` и комментарии в `plugins/codex/scripts`).
- `planned <ver>` — запланировано на указанный будущий релиз форка.
- `verify` — требует проверки/классификации, отдельного решения ещё нет.
- `reference-only` — крупный PR, полезен как референс идей, но не для прямого мержа как есть.
- `wontfix` — вне паритета с форком (например, интеграции с другими хостами/моделями), сознательно не переносится.
- `noise` — спам/нерелевантный тикет без содержательного отчёта.
- `n-a` — не применимо к форку (специфика Codex-host/окружения, которую форк не воспроизводит).

## Сводная таблица кластеров

| Кластер | issues | PR | целевой релиз |
|---|---|---|---|
| broker lifecycle | 33 | 32 | v1.3.0/v1.4.0/v1.5.0 (часть уже исправлена: 1.1.1) |
| CLAUDE_ENV_FILE | 4 | 6 | исправлено: 1.1.0 |
| Windows process/taskkill | 31 | 11 | v1.4.0/v1.5.0 (часть уже исправлена: 1.1.0) |
| job state & wedged running | 55 | 33 | v1.3.0/v1.5.0/v1.6.0 (часть уже исправлена: 1.1.0/1.2.0) |
| turn capture & terminal errors | 4 | 10 | v1.3.0 |
| stop-review gate | 16 | 14 | v1.3.0/v1.5.0 (часть уже исправлена: 1.1.0) |
| argv/prompt parsing | 5 | 6 | v1.5.0 (часть уже исправлена: 1.1.0) |
| models & effort | 22 | 17 | v1.3.0/v1.5.0 (часть уже исправлена: 1.1.0) |
| review scope/flags/output | 26 | 27 | v1.5.0/v1.6.0 |
| transfer | 5 | 4 | v1.3.0/v1.5.0 |
| sandbox/config | 13 | 9 | v1.5.0 (часть уже исправлена: 1.1.0) |
| MCP | 5 | 3 | v1.5.0 (часть уже исправлена: 1.1.0) |
| state dir & security | 4 | 4 | v1.3.0 |
| hooks stdin/EAGAIN & misc hooks | 11 | 19 | v1.3.0/v1.4.0/v1.5.0 (часть уже исправлена: 1.1.0) |
| feature requests | 22 | 31 | v1.5.0/v1.6.0 |
| docs/meta | 6 | 11 | verify |
| noise | 7 | 2 | n/a (шум) |
| **Итого** | **269** | **239** | |

## 1. broker lifecycle

Жизненный цикл брокера (app-server-broker): порождение, простой, teardown, гонки владения.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #108 | issue | — | Broker process not cleaned up on session exit — no idle timeout | fixed-in 1.1.1 | — |
| #163 | issue | — | Test suite leaks broker processes — 158 orphans found | verify | — |
| #184 | pr | +551/-9 | fix(runtime): prevent tracked jobs hanging forever on broker disconnect | verify | — |
| #236 | issue | — | Windows: codex-plugin-cc hangs at “Initializing…” when launching `codex app-server`; likely broker/spawn/   stdio issue | verify | see #484; likely addressed by the v1.4.0 spawn path (no $SHELL, resolved codex.cmd); needs a reporter retest |
| #293 | pr | +382/-14 | [Night Shift] Add sendBrokerShutdown timeout and --context flag | verify | — |
| #300 | pr | +60/-7 | Fix broker shutdown hang on unresponsive socket | verify | cherry-pick candidate |
| #303 | pr | +205/-12 | [codex] Fix stale shared broker auth after account switch | verify | — |
| #342 | issue | — | [BUG] /codex:setup reports loggedIn:false when shared broker is busy; getCodexAuthStatus missing direct-fallback | verify | — |
| #343 | pr | +549/-9 | fix(runtime): clean up stale brokers and lock state updates | verify | — |
| #361 | pr | +409/-14 | Harden the Codex turn lifecycle: bound stalls, stop abandoned upstream work, idle broker shutdown | verify | — |
| #369 | pr | +479/-11 | fix: per-workspace broker ignores CODEX_HOME — make it account-aware so multi-account fallback works | verify | — |
| #380 | issue | — | SessionEnd cleanup fails when review cwd ≠ session cwd — broker.json looked up by cwd-hash, leaving orphan brokers even on graceful /quit | planned v1.5.0 | see #381 |
| #402 | issue | — | Sequential task calls fail ~50% with "codex app-server connection closed" — broker reused after single-turn exit, shouldRetryDirect misses clean close | verify | — |
| #404 | pr | +156/-4 | fix: stop broker readiness race and reap prior-session orphans | verify | — |
| #416 | issue | — | Windows: zombie broker + codex app-server trees accumulate — broker/shutdown acks before unbounded cleanup, and taskkill tree-kill breaks under Git Bash SHELL | planned v1.4.1 | taskkill-under-Git-Bash part fixed-in v1.4.0 (no $SHELL); tree kill from stored records needs process identity (v1.4.1) |
| #432 | issue | — | Rescue runs launched via the harness's background Bash die silently when the shell tree is reaped — job wedges at "running" with companion, broker, and app-server all killed mid-turn | verify | — |
| #439 | pr | +573/-23 | fix: multi-session broker and state lifecycle bugs | verify | — |
| #450 | issue | — | Shared/co-owned broker orphaned when an owning session exits without SessionEnd | fixed-in 1.1.1 | see #457 |
| #451 | pr | +130/-11 | fix: hide detached broker window on Windows | fixed-in v1.4.0 | cherry-pick candidate |
| #453 | pr | +19/-0 | Terminate broker when its app-server child exits (fixes wedged/zombie broker hangs) | verify | cherry-pick candidate |
| #457 | pr | +202/-3 | fix(broker): self-terminate on idle to reap orphaned shared brokers (#450) | fixed-in 1.1.1 | fixes #450 |
| #484 | pr | +28/-3 | fix: use a deterministic Windows shell for broker spawns (#236) | verify | fixes #236 |
| #487 | issue | — | Windows: broker child processes leak and stale broker.json poisons setup tests on persistent machines | planned v1.4.1 | stale broker.json validation fixed-in v1.3.0; leaked children need the v1.4.1 kill path |
| #490 | pr | +199/-3 | Stop orphaned Codex companion brokers | verify | — |
| #509 | issue | — | Rescue tasks intermittently hang forever: stale shared broker reused without a health check; headless app-server inherits desktop MCP servers | verify | — |
| #518 | pr | +1320/-175 | fix: close detached broker and worker lifecycles | verify | — |
| #521 | issue | — | Predictable os.tmpdir() fallback state dir (0755) + unvalidated broker.json lets a co-located user MITM the Codex IPC and force arbitrary process-kill / file-delete | fixed-in v1.3.0 | — |
| #526 | issue | — | Prevent clients racing with idle-timeout broker shutdown | verify | — |
| #540 | issue | — | Ending any Claude session kills the shared broker mid-turn: concurrent sessions' tasks die silently (exit 0) and stay "running" forever | verify | — |
| #541 | pr | +2948/-204 | Fix test broker leaks, state races, and signal-masked command failures | verify | — |
| #543 | issue | — | app-server brokers never self-terminate → orphaned process/RAM leak (34 chains, 272 procs, ~2.2GB) | fixed-in 1.1.1 | — |
| #566 | pr | +119/-3 | fix(broker): terminate the broker on teardown instead of only unlinking its pid file | verify | cherry-pick candidate |
| #579 | pr | +32/-1 | test: reap the brokers and temp dirs a suite run leaves behind | verify | cherry-pick candidate |
| #580 | pr | +840/-29 | fix: give the app-server broker an idle timeout, and kill the one it replaces | verify | — |
| #602 | issue | — | feat: expose `disableBroker` through an env var — there is no supported way to opt out of the shared app-server broker | planned v1.5.0 | — |
| #605 | issue | — | app-server brokers leak permanently when SessionEnd doesn't fire | verify | — |
| #612 | issue | — | Session end//clear tears down workspace-shared broker, silently losing other sessions' running jobs | verify | — |
| #623 | pr | +4105/-94 | bug fix: stop session end from tearing down the shared broker under other sessions' jobs | reference-only | see #628 |
| #628 | issue | — | Terminal-status repair: residual multi-fault interleavings, turn-identity race window, and broker readiness-probe kills (follow-up to #623) | verify | see #623 |
| #629 | issue | — | Test suite leaks ~50 app-server-broker processes per full run | verify | — |
| #631 | issue | — | Companion writes all job state (broker.json, state.json, jobs/) into another plugin's data directory | fixed-in v1.3.0 | — |
| #632 | issue | — | test: broker-spawn integration tests flake under host load — widen/tune the waitFor budget and reap leaked processes | verify | — |
| #636 | issue | — | SessionEnd cannot find the broker when CLAUDE_PLUGIN_DATA differs between spawn and teardown — same cwd, same hash, different state root | planned v1.5.0 | — |
| #642 | pr | +109/-3 | Stop brokers started by the test suite | verify | cherry-pick candidate |
| #650 | pr | +267/-3 | fix: tolerate EPERM when unlinking broker teardown files | fixed-in v1.3.0 | — |
| #652 | pr | +844/-33 | fix: bound the lifetime of detached brokers and task workers | verify | — |
| #660 | pr | +646/-85 | Reap leaked broker sessions across working directories | verify | — |
| #665 | issue | — | app-server client never marks itself unusable after child exit — two unbounded hangs in the broker dispatch path (1.0.4) | verify | — |
| #666 | pr | +52/-2 | fix(broker): ignore pid/log unlink failures during teardown | fixed-in v1.3.0 | cherry-pick candidate |
| #671 | issue | — | Shared per-workspace broker is torn down by any session's SessionEnd, killing other sessions' in-flight jobs | verify | — |
| #680 | pr | +393/-4 | fix(broker): shut down the app-server broker after an idle timeout | verify | — |
| #694 | pr | +42/-2 | test: clean up shared brokers and temp directories | verify | cherry-pick candidate |
| #697 | issue | — | app-server-broker silently disables all git hooks when started in a git worktree | verify | — |
| #706 | issue | — | App-server broker retains thread subscriptions after task clients disconnect | verify | — |
| #715 | pr | +289/-23 | fix(setup): fall back when broker auth is busy | verify | — |
| #718 | issue | — | Windows: every command leaks an orphaned broker, and a live app-server makes the workspace directory undeletable | planned v1.4.1 | orphaned broker cleanup from stored records needs process identity (v1.4.1) |
| #741 | issue | — | `npm test` leaves a detached broker and a fake app-server behind for every test workspace | verify | — |
| #743 | issue | — | SessionEnd kills whatever pid `broker.json` names, without checking it is still a broker (pid reuse → SIGTERM to an unrelated process group) | fixed-in v1.3.0 | posix-only; Windows kill-from-record refusal now targeted v1.4.1, not v1.4.0 |
| #749 | pr | +72/-7 | fix(broker): do not signal stale persisted pids | fixed-in v1.3.0 | cherry-pick candidate |
| #753 | issue | — | ensureBrokerSession() deletes a live broker's state without killing it — the only production caller passes no killProcess | fixed-in v1.3.0 | see #762 |
| #762 | pr | +5/-3 | fix: terminate broker process when ensureBrokerSession tears down (fixes #753) | fixed-in v1.3.0 | fixes #753 |
| #767 | issue | — | SessionEnd never reclaims the app-server broker when the Claude session cwd is not a git repository | planned v1.5.0 | — |
| #768 | pr | +169/-1 | fix(broker): stop tearing down a live broker that misses the readiness probe | fixed-in v1.3.0 | — |
| #773 | pr | +83/-8 | fix: bound hung broker connects instead of waiting forever | fixed-in v1.3.0 | cherry-pick candidate |
| #782 | issue | — | Broker processes leak on Windows: ensureBrokerSession tears down stale broker without killing it | fixed-in v1.3.0 | — |

## 2. CLAUDE_ENV_FILE

Дублирующиеся/растущие экспорты SessionStart в CLAUDE_ENV_FILE.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #339 | pr | +391/-19 | [Night Shift] Fix session env leak #338 | verify | — |
| #386 | pr | +22/-1 | fix(session-lifecycle): make appendEnvVar idempotent (#322) | verify | cherry-pick candidate |
| #558 | pr | +742/-379 | fix: deduplicate session environment exports | verify | — |
| #657 | pr | +168/-6 | fix: rewrite session env exports instead of appending them | verify | — |
| #661 | issue | — | SessionStart hook appends duplicate exports to CLAUDE_ENV_FILE until every Bash call fails | fixed-in 1.1.0 | — |
| #664 | issue | — | SessionStart hook appends to $CLAUDE_ENV_FILE unconditionally — breaks the Bash tool on Windows after ~28 session starts | fixed-in 1.1.0 | — |
| #668 | pr | +22/-1 | Fix duplicate SessionStart exports in CLAUDE_ENV_FILE | fixed-in 1.1.0 | — |
| #748 | pr | +22/-6 | fix: keep only the latest value per key in CLAUDE_ENV_FILE (SessionStart) | verify | cherry-pick candidate |
| #778 | issue | — | session-lifecycle-hook appends CLAUDE_ENV_FILE exports on every SessionStart (incl. compaction) -> Bash tool silently truncated on Windows | fixed-in 1.1.0 | — |
| #783 | issue | — | SessionStart hook appends duplicate exports to CLAUDE_ENV_FILE on every start, resume and compaction, so every Bash call fails with E2BIG in long sessions | fixed-in 1.1.0 | — |

## 3. Windows process/taskkill

Windows-специфика: taskkill, spawn/PATHEXT, PowerShell, EPERM/ENOENT на Windows.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #57 | issue | — | Review mode blocks all commands on Windows: sandbox policy rejects PowerShell | planned v1.5.0 | sandbox/profile surface (--sandbox/--profile sugar) |
| #70 | issue | — | spawnSync with shell:true fails on Windows network drives (UNC paths) | planned v1.4.1 | shell:true is gone in v1.4.0, but cmd.exe (used for .cmd shims) still refuses a UNC cwd; verify on a UNC checkout |
| #113 | issue | — | Plugin install fails on Windows with corrupted error message | verify | install-time error text; not reproduced |
| #219 | issue | — | Fix taskkill cancellation on Windows Git Bash (MSYS path mangling +   non-English locale) | verify | — |
| #250 | issue | — | /codex:review hangs indefinitely on xcode/XcodeListWindows MCP call | verify | — |
| #277 | issue | — | Plugin v1.0.4 codex-companion review --background hangs 2-30min into review (CLI 0.125, Windows) | verify | — |
| #280 | issue | — | Windows: review --cwd <worktree> wastes ~15 sandbox-declined commands hunting for the right directory | verify | — |
| #285 | issue | — | Stop/Session hooks fail on Windows when CWD is on a different drive than %USERPROFILE% | verify | cross-drive cwd for hooks; not reproduced |
| #287 | issue | — | Windows: spawn("codex") in app-server.mjs throws ENOENT (Node does not try PATHEXT for .cmd shims) | fixed-in v1.4.0 | — |
| #294 | pr | +41/-2 | Fix Windows + Git Bash compatibility, auth-retry hang, base ref validation | verify | cherry-pick candidate |
| #295 | issue | — | Windows: shell tool-calls inside Codex turn fail with 'CreateProcessAsUserW failed: 1920' on plugin v1.0.4 | verify | CreateProcessAsUserW 1920 comes from Codex's own tool sandbox, not the plugin spawn |
| #310 | issue | — | Windows zh-TW: codex app-server JSONL parser crashes on Big5-encoded taskkill stdout leak | verify | taskkill stdout is captured by spawnSync in v1.4.0 and never reaches the app-server stream; needs a zh-TW retest |
| #330 | issue | — | codex-companion IPC pipe deadlocks mid-review when codex spawns stdout-heavy PowerShell commands on Windows | verify | — |
| #336 | issue | — | Codex sandbox shell commands fail with CreateProcessAsUserW 1312 on Windows — Store pwsh.exe cannot be spawned from Git Bash subprocess context | planned v1.4.1 | — |
| #349 | issue | — | Windows: /codex:review and /codex:rescue silently return empty results because plugin forces broken sandbox modes | planned v1.5.0 | sandbox/profile surface (--sandbox/--profile sugar) |
| #360 | pr | +423/-25 | [Night Shift] Fix Windows sandbox and rescue error output | verify | — |
| #403 | issue | — | SessionEnd hook can hit 5s timeout on Windows due to shelling out to git | verify | — |
| #409 | issue | — | [Windows] POSIX path conversion mangles slash-prefixed CLI args under Git Bash | fixed-in v1.4.0 | — |
| #423 | issue | — | `/codex:cancel` throws and leaves the job stuck as "running" when the pid is already dead on non-English Windows | planned v1.4.1 | see #577 |
| #438 | pr | +16/-4 | fix(windows): resolve cross-platform test compatibility and path separation issues | verify | cherry-pick candidate |
| #440 | issue | — | spawnBrokerProcess() missing windowsHide: true — leftover spawn site from #67 | fixed-in v1.4.0 | — |
| #441 | issue | — | Stop hook flashes a visible console window on Windows at every turn end — consider not registering it while stopReviewGate is disabled | verify | — |
| #478 | issue | — | codex-companion background jobs: no turn timeout, no PID-liveness reaping, shell-mangled taskkill (Windows) — jobs stick as 'running' forever | verify | — |
| #510 | issue | — | Windows: sandbox helper fails ("setup refresh had errors"), cancel command mangles /PID flag, and stale jobs never marked as failed | verify | — |
| #514 | issue | — | `/codex:transfer` is broken on Windows: false "did not record an imported thread" error, and no-arg auto-detection always fails | planned v1.5.0 | — |
| #525 | issue | — | Windows: taskkill /PID is mangled by MSYS path conversion when SHELL is set (Git Bash under Claude Code) — cancel and SessionEnd cleanup never kill the process tree | fixed-in v1.4.0 | — |
| #528 | issue | — | session-lifecycle-hook: SessionStart appends env exports without dedup - env file grows unboundedly on resume/compact, breaking Bash on Windows (8191-char limit) | fixed-in 1.1.0 | — |
| #530 | issue | — | Stop hook hangs until 900s timeout on Windows even when review gate is disabled (stdin EOF never arrives) | fixed-in v1.4.0 | see #544 |
| #544 | pr | +149/-19 | fix: bound Stop hook stdin read so disabled gate cannot hang on Windows (#530) | fixed-in v1.4.0 | fixes #530 |
| #577 | pr | +215/-15 | fix: make cancel work under Git Bash on a non-English Windows (#423) | planned v1.4.1 | fixes #423 |
| #618 | issue | — | /codex:transfer always fails on Windows: ledger lookup can never match (verbatim \?\ paths + hash of a live transcript) | planned v1.5.0 | — |
| #626 | issue | — | teardownBrokerSession: unguarded pid/log unlinkSync throws EPERM on Windows and fails the whole job - the other four cleanup steps in the same function are already guarded | fixed-in v1.3.0 | guarded pid/log unlink landed in v1.3.0 (best-effort teardown); not announced upstream yet |
| #633 | issue | — | teardownBrokerSession: unguarded pid/log unlinkSync throws EPERM on Windows and fails the whole job - the other four cleanup steps in the same function are already guarded | fixed-in v1.3.0 | duplicate of #626; duplicate of #626; same v1.3.0 fix |
| #643 | issue | — | Review jobs on Windows leave junk files in the reviewed repo (pwsh treats ">" in quoted code as a redirect) | verify | — |
| #647 | issue | — | Windows: SHELL env var (Git Bash) breaks taskkill; handleCancel swallows terminateProcessTree exceptions, leaving jobs stuck in running/finalizing | fixed-in v1.4.0 | — |
| #656 | pr | +112/-4 | fix: Windows SHELL env var breaks taskkill; handleCancel aborts before updating job state on a partial kill failure | fixed-in v1.4.0 | cherry-pick candidate |
| #669 | pr | +604/-10 | fix: resolve executables instead of shell-wrapping SHELL on Windows spawns | fixed-in v1.4.0 | — |
| #701 | pr | +218/-18 | fix(transfer): resolve imported thread id on Windows and surface import failures | planned v1.5.0 | — |
| #708 | issue | — | Windows: `cancel` silently fails — Git Bash mangles `taskkill /PID /T /F` flags, leaving jobs stuck as `running` | fixed-in v1.4.0 | — |
| #735 | pr | +13/-4 | Do not run taskkill through a shell on Windows | fixed-in v1.4.0 | cherry-pick candidate |
| #770 | pr | +1/-1 | Make the prebuild step work on Windows | verify | cherry-pick candidate |
| #776 | pr | +298/-19 | Fix Windows SessionEnd hang and taskkill false failures | verify | — |

## 4. job state & wedged running

Состояние job'ов (state.json, ticket lock), зависшие/`running forever` задачи, cancel/resume, /codex:rescue как механика фоновых задач.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #101 | issue | — | feat: promote codex-rescue to ~/.claude/agents/ at setup time to support permissionMode | verify | — |
| #115 | issue | — | Codex rescue task gets stuck in infinite tool-call loop during code review | verify | — |
| #122 | issue | — | codex:codex-rescue agent times out before Codex task completes on large diffs | verify | — |
| #158 | issue | — | `codex:rescue` can claim a background Codex run started, then fall back to non-Codex analysis when `Bash` is denied | verify | — |
| #183 | issue | — | runTrackedJob / captureTurn can hang in phase: finalizing indefinitely (no timeout) | verify | — |
| #193 | issue | — | Orphaned `codex` process at 100% CPU after Claude Code session ended (PPID=1, main thread spinning in `read()`) | verify | — |
| #198 | issue | — | [BUG] codex:codex-rescue hangs in worktrees when run_in_background is used | verify | — |
| #203 | issue | — | codex:rescue skill init consumes ~20% of session usage budget before actual work | verify | — |
| #214 | pr | +12/-4 | fix: keep rescue task calls in foreground | verify | cherry-pick candidate |
| #222 | issue | — | No OS-level process liveness check — stale 'running' state after worker death (root cause for #164, #202) | verify | — |
| #228 | issue | — | companion jobs stuck as status:running when foreground task receives SIGTERM (no signal handler) | verify | — |
| #232 | issue | — | Regression of #42: /codex:rescue still cannot prompt via AskUserQuestion in 1.0.3 | verify | — |
| #237 | issue | — | codex:review stuck consistently | verify | — |
| #249 | pr | +3/-5 | fix: stop codex-rescue agent from swallowing task_ids | verify | cherry-pick candidate |
| #264 | issue | — | codex-companion: per-job state JSON stuck at status=running after task_complete; streaming .output drain disconnects mid-turn | verify | — |
| #266 | issue | — | macOS: /codex:rescue intermittently hangs, then fails with Unknown skill even though codex-companion works directly` | verify | — |
| #268 | issue | — | codex-rescue hangs sporadically | verify | — |
| #288 | issue | — | `sendBrokerShutdown` has no timeout — SessionEnd hook can hang indefinitely | verify | — |
| #304 | issue | — | codex-companion.mjs hardcodes workspace-write sandbox for write tasks — git push fails with DNS error, work stuck in local worktree | verify | — |
| #319 | pr | +3/-1 | fix(codex-rescue): require Bash call unconditionally to stop fabricated forwarder output | verify | cherry-pick candidate |
| #321 | issue | — | Delegated sessions show unresolved placeholder in Codex Desktop | verify | — |
| #324 | issue | — | codex:codex-rescue subagent returns stub instead of actual task output | verify | — |
| #325 | pr | +4/-0 | fix(rescue): pass timeout: 600000 on the inner task Bash call | verify | cherry-pick candidate |
| #346 | pr | +5594/-281 | Companion reliability overhaul: deterministic completion, cancellation-safe background jobs (task + review), and explicit thread resume | reference-only | reference, huge PR |
| #350 | issue | — | codex-rescue subagent returns empty output on any companion error — "return nothing" instruction + stderr-only error path | verify | — |
| #354 | issue | — | feature request: codex:reviewer subagent (review-mode counterpart to codex-rescue) | planned v1.6.0 | see #462 |
| #355 | pr | +168/-5 | fix: keep background jobs alive across SessionEnd | fixed-in 1.2.0 | — |
| #356 | issue | — | task/rescue hangs at "starting" for image-generation prompts | verify | — |
| #367 | issue | — | Background task hangs forever in "queued" when --cwd is a git worktree (detached worker dies silently; no timeout) | verify | — |
| #370 | issue | — | Proposal: detach long-running codex-rescue dispatches via external bg-tmux helper (Bash tool 10-min ceiling workaround) | verify | see #372 |
| #372 | pr | +315/-21 | fix(#370): run foreground codex task in the detached worker so long turns survive the 10-minute Bash ceiling | verify | fixes #370 |
| #376 | pr | +100/-3 | Bound the Codex turn await: fix unbounded hang on stalled/dead app-server + make turn budget configurable | fixed-in 1.2.0 | — |
| #377 | issue | — | Robustness: detached-worker spawn error handling, dead-worker reconciliation, atomic + serialized state writes | verify | — |
| #390 | pr | +584/-11 | fix: salvage a stalled Codex turn instead of hanging forever | verify | — |
| #391 | issue | — | Delegated tasks / reviews can wedge in "running" forever when Codex drops terminal turn events | verify | — |
| #405 | issue | — | adversarial-review builds an unbounded prompt — large working trees fail with "Input exceeds the maximum length of 1048576 characters" | planned v1.5.0 | see #461 |
| #410 | issue | — | Background job state machine retains zombie entries; `--fresh` does not clear them | verify | — |
| #412 | issue | — | /codex:rescue fails to write files — always returns a read-only sandbox error | verify | — |
| #415 | pr | +4/-6 | fix: defer getWorkingTreeState call and clean up process exit handling | verify | cherry-pick candidate |
| #425 | pr | +294/-9 | fix: reap ghost jobs whose worker died without recording a result | fixed-in 1.2.0 | — |
| #435 | pr | +150/-3 | Fix background job zombie entries and enhance --fresh clearing | verify | — |
| #458 | issue | — | state.json job index: unguarded read-modify-write race loses concurrent jobs and deletes their artifacts | fixed-in 1.2.0 | — |
| #460 | pr | +350/-9 | fix(state): serialize concurrent updateState/saveState with file lock and atomic write | fixed-in 1.2.0 | — |
| #475 | pr | +70/-11 | Add task --resume-thread <id> for explicit thread resume | planned v1.5.0 | cherry-pick candidate |
| #486 | issue | — | codex-rescue agent's contradictory background contract runs the companion in foreground — job orphaned at subagent turn end, permanently stuck at 'running' | verify | — |
| #492 | pr | +65/-17 | fix: share Codex task state across worktrees | verify | cherry-pick candidate |
| #493 | issue | — | codex-rescue: forward intended worktree cwd to detached task | verify | — |
| #495 | issue | — | `/codex:status` renders literal `<br>` in Actions column instead of a line break | planned v1.5.0 | — |
| #497 | pr | +731/-57 | Fix task runner liveness, workspace, and cancellation reliability | verify | — |
| #498 | issue | — | `result <id>` on a queued/running job reports "No job found" — the still-running message is unreachable when a reference is given | fixed-in 1.2.0 | — |
| #504 | pr | +46/-4 | fix: report active jobs from explicit result lookups | verify | cherry-pick candidate |
| #515 | issue | — | Background-job reliability/UX: broken cancel, stale-job accumulation, individual-job wedge, no blocking await | verify | — |
| #520 | issue | — | task --background: detached worker has no timeout or stall watchdog | verify | — |
| #524 | issue | — | codex-companion: workspace-keyed job registry returns 'No job found' for completed jobs when cwd drifts into a git repo | fixed-in 1.2.0 | — |
| #531 | issue | — | Write-mode task jobs report status "completed" even when zero workspace writes landed | verify | — |
| #532 | pr | +209/-8 | fix: fail loud when a write task lands zero workspace writes | verify | — |
| #542 | issue | — | Foreground task dispatch dies unrecoverably at Claude Code's 10-min Bash cap — SIGTERM kills the codex chain and no session id is ever surfaced for resume | verify | — |
| #550 | pr | +76/-2 | fix: preserve long foreground task recovery | verify | cherry-pick candidate |
| #556 | pr | +280/-19 | fix: resolve jobs across workspace registries | verify | — |
| #567 | pr | +102/-17 | Fix rescue thread persistence across Claude session resume | verify | cherry-pick candidate |
| #569 | pr | +21/-7 | feat: show persistent delegated tasks in Codex Desktop | verify | cherry-pick candidate |
| #590 | pr | +174/-22 | fix: run foreground tasks detached-worker-first so a timed-out wait hands back a resolvable task id | verify | — |
| #598 | issue | — | Turn capture can hang forever when the app-server connection drops mid-turn | verify | — |
| #599 | pr | +2/-2 | fix: render status actions without raw HTML in the table cell | planned v1.5.0 | cherry-pick candidate |
| #601 | issue | — | codex-rescue subagent cannot retrieve its own background task result, and status/result are user-invocation-only | verify | — |
| #608 | pr | +8/-4 | fix(rescue): await the delegated Codex result instead of returning a placeholder | fixed-in 1.1.0 | — |
| #615 | issue | — | codex-companion: review jobs ignore --background, dead children never reaped, no wall-clock ceiling — jobs stuck 'running' forever | verify | — |
| #617 | pr | +177/-20 | fix: fail loud when a delegated Codex task run performs no work | verify | — |
| #620 | issue | — | task --background: detached worker is spawned before its job file is written, and a fast-failing worker leaves a permanently queued job that was reported as started | verify | — |
| #634 | issue | — | Harness auto-backgrounds foreground companion at Bash 120s timeout → reaped mid-turn, job wedged at 'running' (Linux repro; prompt-level fix insufficient — needs signal-flush, exitPromise race, PID liveness) | verify | — |
| #639 | issue | — | result/cancel report "No job found" for jobs that exist; killed workers stay `running` forever | verify | — |
| #667 | pr | +357/-28 | Recover Codex jobs across workspace scopes | verify | — |
| #673 | issue | — | docs(codex-rescue): document the sandbox writable-root constraint (writes outside the repo are silently read as delegation failure) | verify | — |
| #686 | issue | — | `codex-rescue` can generate duplicate `pgrep -f "codex-companion.mjs"` wait loops that keep each other alive on macOS (stuck background tasks) | verify | — |
| #689 | pr | +1142/-274 | Fix job records lost on concurrent background task launches | reference-only | reference, huge PR |
| #696 | pr | +88/-1 | Keep the inferred-completion timer referenced | verify | cherry-pick candidate |
| #698 | issue | — | `captureTurn` treats the `error` notification as non-terminal, so a Codex-side failure hangs the turn forever and wedges the job at `status: running` | fixed-in v1.3.0 | — |
| #700 | issue | — | task: add `--resume-thread <id>` — jobs killed by a usage limit cannot be resumed from the plugin | planned v1.5.0 | — |
| #704 | issue | — | status reports a background job as running forever when its worker dies before writing a terminal status | verify | — |
| #740 | issue | — | `thread/resume` sandbox is ignored while the thread is still live in the shared app-server, so `task --resume-last --write` cannot write after a read-only run | verify | — |
| #742 | pr | +506/-14 | feat: add `--sandbox <mode>` to `task` and `/codex:rescue` | planned v1.5.0 | — |
| #754 | issue | — | codex-rescue reports completion without checking git state — reproducible false positives | verify | — |
| #765 | issue | — | codex-rescue with --cwd <git worktree>: git write ops fail because the linked worktree's gitdir (hub .git/worktrees/<name>) is outside the sandbox writable roots | verify | — |
| #774 | pr | +75/-3 | fix: surface status --wait timeouts instead of looking successful | fixed-in v1.3.0 | cherry-pick candidate |
| #775 | pr | +30/-1 | fix: do not crash when a fileChange start event omits changes | fixed-in v1.3.0 | cherry-pick candidate |
| #781 | issue | — | captureTurn drops every notification (including turn/completed) when the start response has no turn.id, hanging the job forever | fixed-in v1.3.0 | — |
| #786 | issue | — | cancel never signals a foreground companion on Linux/macOS: process-group kill fails with ESRCH and there is no fallback to the pid | verify | — |
| #787 | pr | +42/-12 | fix: signal the pid when the process-group kill fails with ESRCH | verify | cherry-pick candidate |

## 5. turn capture & terminal errors

Захват turn (captureTurn, turn/completed), терминальные ошибки app-server, runCommand/stderr робастность.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #31 | issue | — | Buffered thread/started notifications can drop subagent names and log raw thread IDs | verify | — |
| #107 | issue | — | Enhancement: support turn/start sandboxPolicy for task-like commands in externally sandboxed environments | verify | — |
| #243 | pr | +254/-2 | fix: resolve captureTurn when app-server disconnects mid-turn | verify | — |
| #302 | pr | +153/-1 | fix(runtime): add wall-clock timeouts to JSON-RPC request and captureTurn | verify | — |
| #429 | pr | +46/-2 | fix: treat signal-terminated subprocesses as failures in runCommand | verify | cherry-pick candidate |
| #581 | pr | +3/-1 | fix: replay buffered thread lifecycle events before turn filtering | verify | cherry-pick candidate |
| #625 | pr | +49/-5 | Suppress dynamic tool progress in stderr | verify | cherry-pick candidate |
| #685 | pr | +786/-102 | fix: make app-server connection loss terminal | verify | — |
| #707 | pr | +1364/-89 | fix(app-server): unsubscribe task threads after client disconnect | reference-only | reference, huge PR |
| #710 | pr | +261/-7 | fix(runtime): terminate turns on terminal errors | fixed-in v1.3.0 | — |
| #744 | issue | — | `runCommand` sets `maxBuffer: options.maxBuffer` — the ENOBUFS fix from #179 works only because a spread `undefined` deletes Node's default | verify | — |
| #747 | pr | +27/-2 | fix: make runCommand maxBuffer explicit | verify | cherry-pick candidate |
| #757 | issue | — | A server-side turn failure that terminates stores no `errorMessage`, so `status` reports the reason as `Summary: {` | fixed-in v1.3.0 | see #763 |
| #763 | pr | +105/-4 | fix: persist errorMessage on non-throwing turn failure and shorten summary (fixes #757) | fixed-in v1.3.0 | fixes #757 |

## 6. stop-review gate

Stop-хук ревью-гейта: fail-open/fail-closed, таймауты, monorepo-режим, отчёт об ошибках.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #59 | issue | — | Review gate setup writes to temp dir, but Stop hook reads from persistent dir | verify | — |
| #213 | issue | — | feat: support user-level defaults for companion config (e.g. stopReviewGate) | verify | — |
| #248 | issue | — | Stop review gate blocks Claude on infrastructure errors, causing rewake loops | verify | — |
| #297 | pr | +32/-2 | fix(stop-review-gate): treat job as inactive when its pid is dead | verify | cherry-pick candidate |
| #352 | pr | +6/-3 | fix(stop-review-gate-hook): always emit valid JSON on stdout | verify | cherry-pick candidate |
| #353 | pr | +166/-11 | feat(stop-review-gate): add monorepo mode for sibling git repos | verify | — |
| #385 | pr | +57/-5 | fix: run the stop-gate review as an ephemeral, untracked, read-only one-shot | verify | cherry-pick candidate |
| #396 | pr | +64/-1 | Add optional CODEX_REVIEW_GATE_MAX_ROUNDS cap to the stop review gate | fixed-in 1.1.0 | — |
| #422 | pr | +134/-19 | fix(stop-review-gate): fail open on infra errors instead of blocking | verify | — |
| #442 | pr | +24/-2 | fix: surface the real task error in the stop-review gate instead of stderr noise | verify | cherry-pick candidate |
| #452 | issue | — | Stop-review-gate hook masks the real failure: Node 24 DEP0190 warning displaces the actual error in stderr-first reporting | n-a | DEP0190 Node warning, posix quirk — n/a |
| #483 | issue | — | stop-review-gate-hook.mjs: fail-closed reason strings do not mention the /codex:setup --disable-review-gate escape valve | fixed-in v1.3.0 | — |
| #517 | issue | — | Jobs killed by host timeouts stay "running" forever (no pid liveness check); concurrent state writers can wipe all job state and silently disable stopReviewGate | verify | — |
| #548 | issue | — | Stop-review gate hook loops until CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (missing `stop_hook_active` guard) | fixed-in v1.3.0 | — |
| #565 | pr | +67/-0 | fix: honor stop_hook_active in the stop-review-gate hook | fixed-in v1.3.0 | cherry-pick candidate |
| #568 | pr | +337/-15 | Archive completed stop-gate review threads | verify | — |
| #573 | pr | +128/-17 | fix(review-gate): name disable command in stop-hook infra failure messages | fixed-in v1.3.0 | cherry-pick candidate |
| #589 | issue | — | stop-review-gate: signal-terminated review loses signal metadata in the fail-closed reason | fixed-in v1.3.0 | — |
| #611 | issue | — | Stop-review gate: hung jobs pile up into livelock; review --wait can exit 0 without a verdict | verify | — |
| #662 | pr | +2972/-194 | Harden Codex stop gate supervision | reference-only | reference, huge PR |
| #676 | issue | — | Stop review gate fails open when hook stdin is malformed JSON | fixed-in 1.1.0 | — |
| #682 | pr | +23/-1 | fix: fail closed on malformed stop hook input | fixed-in 1.1.0 | — |
| #684 | issue | — | `/codex:setup --enable-review-gate` reports success but writes the flag to a state root the Stop hook never reads — the gate silently fails open | verify | — |
| #695 | issue | — | Stop-review gate discards the failure reason on four paths; every failure surfaces as a DEP0190 warning | verify | — |
| #709 | pr | +225/-43 | fix(stop-gate): preserve review failure details | verify | — |
| #764 | issue | — | Stop-review gate is lost in every new git worktree (state keyed by rev-parse --show-toplevel) | planned v1.5.0 | — |
| #766 | issue | — | Stop-review gate: review timeout equals the hook's own 900s timeout, so a slow review ends the turn with no message | verify | — |
| #769 | issue | — | Stop review gate has no way to pin the model or reasoning effort it reviews with | fixed-in v1.3.0 | — |
| #772 | pr | +23/-2 | fix: leave Stop-hook headroom so a timed-out review gate can report | verify | cherry-pick candidate |
| #777 | issue | — | Positional CLI argv >~1KB gets node child SIGKILLed on macOS+EDR — breaks stop-review-gate and codex-rescue forwarding | verify | — |

## 7. argv/prompt parsing

Разбор argv/промптов: `$ARGUMENTS`, `--prompt-file`, позиционные аргументы, инъекции через shell.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #23 | issue | — | Review fails with JSONL parse error: bracketed paste mode escape sequence in output ([?2004h) | verify | — |
| #523 | pr | +21/-16 | fix(review): accept positional focus text for parity with adversarial-review | planned v1.5.0 | cherry-pick candidate |
| #535 | pr | +67/-0 | Add argument parser unit coverage | verify | cherry-pick candidate |
| #539 | issue | — | task --help (and any unknown --flag) is swallowed into the prompt and dispatches a real thread, hijacking --resume-last | fixed-in 1.1.0 | see #547 |
| #547 | pr | +130/-0 | fix: treat task --help and unknown flags as CLI errors (#539) | fixed-in 1.1.0 | fixes #539 |
| #555 | pr | +68/-9 | fix: preserve task prompts as free text | verify | cherry-pick candidate |
| #570 | issue | — | task command misparses prompt words like "--resume" as CLI flags when forwarded as a single argument | planned v1.5.0 | — |
| #574 | pr | +262/-8 | fix(companion): harden task path parsing and availability probes | verify | — |
| #621 | issue | — | task --prompt-file: the file is re-read by the launcher, so a caller cannot prove which bytes were dispatched | verify | — |
| #622 | issue | — | task --prompt-file: the prompt path is discarded after reading, so no plugin cleanup can ever remove the caller's file | verify | — |
| #690 | pr | +20/-4 | fix(commands): replace inline !` command syntax with explicit Bash blocks | fixed-in 1.1.0 | — |

## 8. models & effort

Модели, алиасы моделей и reasoning effort (`--effort`, max/ultra, gpt-5.x).

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #44 | issue | — | Feature: support default model and effort settings in /codex:setup | verify | — |
| #156 | pr | +0/-1 | fix: allow model invocation for adversarial-review command | verify | see #157 |
| #157 | pr | +2/-3 | feat: allow model invocation for adversarial-review command (#156) | verify | fixes #156 |
| #211 | issue | — | disable-model-invocation hides commands from skill list, blocking user-initiated invocation | planned v1.5.0 | — |
| #227 | pr | +24/-6 | fix: allow model invocation for codex commands except review | planned v1.5.0 | cherry-pick candidate |
| #257 | issue | — | `task`/`review` short alias `-m` consumes prompt tokens as `--model`, producing silent OpenAI 400 errors | planned v1.5.0 | — |
| #307 | pr | +21/-21 | refactor: rename gpt-5-4-prompting skill to codex-prompting | verify | cherry-pick candidate |
| #309 | issue | — | [BUG] adversarial-review / review fail with HTTP 400 ('gpt-5.5 requires newer Codex') on CLI 0.130.0 | verify | — |
| #366 | pr | +259/-171 | feat: update prompting skill to GPT-5.5 (gpt-5-5-prompting) | verify | — |
| #393 | issue | — | codex-companion task path: missing-cwd misread as 'not installed', prompt fragments parsed as --model (400 as result), dropped turn errors | verify | — |
| #408 | pr | +20/-11 | fix(app-server): pass `-c model="..."` to `codex app-server` so options.model takes effect | fixed-in 1.1.0 | — |
| #463 | issue | — | Make gpt-5-4-prompting skill model-neutral and multi-agent aware | planned v1.3.0 | — |
| #468 | issue | — | Current Plugin does not support gpt-5.6 model family | fixed-in v1.3.0 | — |
| #471 | pr | +1302/-161 | Support GPT-5.6 models and refresh stale brokers | verify | — |
| #476 | issue | — | review / adversarial-review silently ignore reasoning effort — --effort unparsed, and turn/start effort omitted on the adversarial path | fixed-in 1.1.0 | — |
| #481 | issue | — | Job records never capture the resolved model/effort/sandbox a job ran with | planned v1.5.0 | — |
| #485 | issue | — | codex-rescue agent references stale gpt-5-4-prompting skill; effort hint omits max/ultra (default model is now gpt-5.6-sol) | fixed-in v1.3.0 | — |
| #496 | issue | — | adversarial-review / review can complete the turn without a schema-conforming final message on multi-tool-call reviews at high reasoning effort | verify | — |
| #512 | issue | — | `task` prompts passed as a single argument are re-tokenized: quotes/backslashes stripped, prose `--model`/`--write` hijacked as real options | planned v1.5.0 | — |
| #522 | issue | — | /codex:review rejects focus text — breaks interface parity with /codex:adversarial-review and blocks non-English model/effort entry | planned v1.5.0 | — |
| #559 | issue | — | Feature: bounded same-thread auto-retry (or resumable hint) on "Selected model is at capacity" turn deaths | verify | — |
| #616 | pr | +57/-7 | feat: accept max and ultra reasoning efforts | fixed-in 1.1.0 | — |
| #637 | pr | +35/-7 | Accept the max and ultra reasoning tiers | fixed-in 1.1.0 | — |
| #638 | pr | +11063/-716 | Align the Claude Code plugin with GPT-5.6 runtime and prompting | reference-only | reference, huge PR |
| #644 | pr | +2/-0 | Log the start of model reasoning in background job logs | fixed-in 1.1.0 | — |
| #645 | pr | +117/-13 | Capture resolved model/effort/sandbox in job records | fixed-in 1.1.0 | — |
| #651 | issue | — | Add --effort to review/adversarial-review subcommands (parity with task) | fixed-in 1.1.0 | — |
| #654 | issue | — | Document `--model` on `review` and `adversarial-review` | planned v1.5.0 | — |
| #655 | issue | — | Companion runs record neither the resolved model nor which `codex` binary served them | planned v1.5.0 | — |
| #677 | pr | +100/-6 | Support --effort on adversarial-review | verify | cherry-pick candidate |
| #687 | issue | — | review / adversarial-review forward --model unnormalized, so the documented `spark` alias fails as "not supported when using Codex with a ChatGPT account" | fixed-in 1.1.0 | — |
| #688 | pr | +48/-1 | fix: resolve model aliases on review and adversarial-review | fixed-in 1.1.0 | — |
| #699 | issue | — | Background jobs: prompt text swallowed as options (-m pytest -> model 404); dead workers never finalized; cancel hangs; stderr discarded | planned v1.5.0 | see #702 |
| #702 | pr | +104/-36 | fix(task): stop free-form prompt text from hijacking --model (defect 1 of #699) | planned v1.5.0 | fixes #699 |
| #703 | issue | — | Skill `gpt-5-4-prompting` still targets GPT-5.4, retired from the rate card on 2026-08-31 | fixed-in v1.3.0 | — |
| #705 | issue | — | adversarial-review threads are always ephemeral — no way to verify which model actually ran a review | planned v1.5.0 | — |
| #746 | pr | +86/-4 | Support --effort on adversarial-review, and surface unrecognised options | verify | cherry-pick candidate |
| #751 | issue | — | `VALID_REASONING_EFFORTS` rejects `max` and `ultra` locally, so the flagship model's top two reasoning tiers are unreachable from the plugin | verify | see #761 |
| #761 | pr | +49/-7 | fix: allow max and ultra reasoning efforts (fixes #751) | fixed-in 1.1.0 | fixes #751 |

## 9. review scope/flags/output

Флаги, scope и вывод `/codex:review` и `/codex:adversarial-review`.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #4 | issue | — | Review Plan | verify | — |
| #6 | issue | — | Feature: infra-aware adversarial review prompts + auto-scaling by diff size | verify | — |
| #20 | pr | +350/-6 | feat: add throttle controls for review gate | verify | — |
| #65 | issue | — | Review context collection crashes on broken untracked symlinks | verify | — |
| #68 | issue | — | why i can't ask Claude to launch 4 codex:review commands in parallel ?! | verify | — |
| #69 | issue | — | adversarial-review: EISDIR crash when untracked directories exist + input size overflow | verify | — |
| #104 | issue | — | /add feature to do full code review based on folder, not on latest git commit | verify | — |
| #114 | issue | — | feat: review remote branches/PRs without local checkout | verify | — |
| #129 | pr | +20/-9 | fix: pass review findings to rescue automatically | planned v1.6.0 | cherry-pick candidate |
| #136 | pr | +317/-0 | Add /codex:plan-review command | planned v1.6.0 | — |
| #146 | pr | +984/-5 | feat: add /codex:diff-review, /codex:watch, /codex:config and codex:optimize | verify | — |
| #207 | issue | — | the codex tool seems not writing review output reliably | verify | — |
| #221 | issue | — | feat: /codex:review should not ask by default — auto-decide wait vs background | planned v1.5.0 | — |
| #223 | issue | — | Support codex:review in non-interactive mode (claude --print) | planned v1.5.0 | — |
| #226 | pr | +48/-8 | feat #167: add --sandbox flag and CODEX_SANDBOX env var for review and task commands | verify | cherry-pick candidate |
| #273 | issue | — | Codex returns 'verdict: blocked' on completed work — three distinct causes mask successful task output | verify | — |
| #279 | issue | — | codex-companion.mjs: three reliability bugs in background review handling | verify | — |
| #282 | issue | — | Companion/review jobs should not share the user's main Codex Desktop history feed by default | verify | — |
| #292 | pr | +1028/-15 | Add Jujutsu repository support for /codex:review - fixes #215 | wontfix | fixes #215 |
| #298 | issue | — | /codex:review caps findings at ~3 — add configurable max or return all material findings | verify | — |
| #299 | pr | +1590/-6 | [codex] Add rescue from review result | planned v1.6.0 | — |
| #306 | issue | — | Reaching codex rate limit causes an infinite review cycle that consumes claude code tokens for no reason | verify | — |
| #311 | pr | +179/-4 | fix: drop non-JSONL garbage on codex app-server stdout | verify | — |
| #313 | pr | +231/-11 | fix: cap adversarial review prompt size to stay under Codex API 1MB input limit | planned v1.5.0 | — |
| #314 | pr | +239/-8 | fix: cap adversarial-review prompt at 800KB with UTF-8-safe fallback chain | planned v1.5.0 | — |
| #315 | pr | +1/-1 | fix: widen /codex:review wait threshold to ~5 files / 200 lines | verify | cherry-pick candidate |
| #327 | pr | +137/-10 | fix: raise adversarial review inline diff limits and expose overrides | planned v1.5.0 | cherry-pick candidate |
| #328 | pr | +5463/-90 | feat(adversarial-review): make self-collect path multi-turn so it can actually work | reference-only | reference, huge PR |
| #329 | issue | — | Codex review no response all the time in claude code VS Code plugin | verify | — |
| #333 | issue | — | Focus text in adversarial-review is re-tokenized; --FLAG VALUE substrings leak into CLI args | planned v1.5.0 | — |
| #407 | pr | +160/-13 | fix: recover structured output for /codex:adversarial-review when the turn uses tools | verify | — |
| #436 | pr | +3/-1 | docs: fix review gate README anchor | verify | cherry-pick candidate |
| #445 | issue | — | Use Codex auto-review for rescue task escalations | planned v1.6.0 | — |
| #461 | pr | +71/-3 | fix: cap aggregate untracked content in review context (#405) | planned v1.5.0 | fixes #405 |
| #465 | pr | +88/-4 | Fix false approvals when adversarial review turns fail | verify | cherry-pick candidate |
| #494 | pr | +84/-2 | fix: auto-review write-capable task escalations | planned v1.6.0 | cherry-pick candidate |
| #529 | issue | — | Review commands should persist their Codex threads (write rollouts) like task runs do | planned v1.5.0 | — |
| #533 | pr | +7/-1 | Document review scope selection | verify | cherry-pick candidate |
| #557 | pr | +7/-2 | fix: persist Codex review threads | planned v1.5.0 | cherry-pick candidate |
| #583 | pr | +78/-1 | fix: parse structured output wrapped in a markdown code fence | planned v1.5.0 | cherry-pick candidate |
| #584 | pr | +59/-5 | fix: name the schema's required keys in the adversarial review prompt | verify | cherry-pick candidate |
| #585 | issue | — | Proposal: sharded map-reduce review for large diffs — k concurrent background tasks + a cross-shard integration pass (working prototype, ~4.3× measured) | planned v1.6.0 | — |
| #586 | pr | +2357/-33 | feat: add parallel-review subcommand (sharded map-reduce review) | planned v1.6.0 | — |
| #593 | pr | +338/-87 | feat: --json structured output for task and review | planned v1.5.0 | — |
| #603 | issue | — | adversarial-review (and presumably other companion commands) fail with EPERM creating job-state dir under ~/.claude/plugins/data/codex-openai-codex/state/... inside a Claude Code session | verify | — |
| #606 | pr | +2186/-118 | Add independently verified Codex reviews | reference-only | reference, huge PR |
| #610 | issue | — | Stop-time review gate ALLOW results are silent/invisible in Claude Desktop's Code tab | verify | — |
| #653 | issue | — | `review --base <nonexistent-sha>` exits 0 and reviews a far wider diff | planned v1.5.0 | — |
| #658 | pr | +231/-19 | Reject missing review base refs | planned v1.5.0 | — |
| #675 | issue | — | Review commands start ephemeral threads, so Codex usage from them is unattributable | planned v1.5.0 | — |
| #679 | issue | — | review --json emits no `result` (and no `parseError`): the built-in reviewer path never produces schema-shaped output, unlike adversarial-review | planned v1.5.0 | — |
| #714 | pr | +121/-16 | fix(review): preserve adversarial focus text | planned v1.5.0 | cherry-pick candidate |
| #760 | issue | — | Consider whether the "adversarial review" framing can be softened | verify | — |

## 10. transfer

`/codex:transfer` — импорт/связывание тредов между Claude- и Codex-сессиями.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #296 | pr | +158/-14 | Harden rescue task handoff failures | verify | — |
| #417 | issue | — | ` /codex:transfer` fails with "did not record an imported thread" for both auto-detected and explicit --source | planned v1.5.0 | see #469 |
| #469 | pr | +94/-8 | fix: resolve imported transfer threads when the ledger record diverges (#417) | planned v1.5.0 | fixes #417 |
| #502 | issue | — | transfer: stale Claude transcript path after session enters a worktree | planned v1.5.0 | — |
| #576 | pr | +632/-35 | feat: add automatic user-approved expert handoff | verify | — |
| #600 | issue | — | /codex:status, /codex:transfer, /codex:cancel, /codex:result fail the Bash permission check — inline `!`…`` body is unmatchable | verify | — |
| #624 | pr | +157/-6 | Fix transfer resolution after Claude session forks | planned v1.5.0 | — |
| #721 | issue | — | /codex:transfer is broken when CLAUDE_CONFIG_DIR is set — Claude transcript root hardcoded to ~/.claude/projects | fixed-in v1.3.0 | — |
| #750 | issue | — | `/codex:transfer` is one-shot per session: a second run silently imports nothing, and is indistinguishable from failure | planned v1.5.0 | — |

## 11. sandbox/config

Sandbox-политики, `config.toml`, approval-режимы, auth/OAuth.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #41 | issue | — | /codex:setup returns 401 "OAuth token has expired" despite fresh ChatGPT login | verify | — |
| #105 | issue | — | Codex plugin commands fail with command not found: node on Mac App | verify | — |
| #141 | issue | — | [Bug] codex app-server crashes on macOS inside Claude Code sandbox (SCDynamicStore NULL         panic) | verify | — |
| #145 | issue | — | Add --full-access flag to companion task for unsandboxed execution | planned v1.5.0 | see #147 |
| #147 | pr | +2/-2 | feat: add --full-access flag for sandboxed execution (#145) | planned v1.5.0 | fixes #145 |
| #233 | issue | — | The codex companion cannot bypass the auth guard when the user uses custom base url that does not need any auth | verify | — |
| #240 | issue | — | Plugin overrides Codex sandbox config and can trigger bwrap failures | verify | — |
| #281 | issue | — | app-server fails with "access token could not be refreshed" after logout/login while `codex exec` works | verify | — |
| #308 | issue | — | Large prompt to codex:codex-rescue is silently rejected as 'user denied' with no user prompt; Claude Code cannot recover | verify | — |
| #318 | pr | +62/-0 | docs: troubleshooting section for bwrap sandbox failures on restricted hosts | verify | cherry-pick candidate |
| #320 | issue | — | Not working with chatGPT subscriptions | verify | — |
| #426 | pr | +74/-2 | fix: pass on-request approval policy for write-capable task runs | fixed-in 1.1.0 | — |
| #482 | issue | — | Hardcoded sandbox values always override config.toml sandbox_mode | verify | — |
| #505 | issue | — | Plugin runtime ignores sandbox_mode from config.toml; unusable on kernels with apparmor_restrict_unprivileged_userns=1 (bwrap loopback failure) while direct codex exec works | verify | — |
| #534 | pr | +25/-2 | Report missing Claude projects directory | verify | cherry-pick candidate |
| #575 | pr | +86/-13 | Support external sandbox policy for task turns | verify | cherry-pick candidate |
| #613 | pr | +125/-5 | fix: honor sandbox_workspace_write.network_access from user config | verify | cherry-pick candidate |
| #635 | issue | — | codex exec fails at startup with "failed to initialize in-process app-server client: Operation not permitted (os error 1)" in non-interactive/CI-like environments | verify | — |
| #646 | pr | +176/-22 | Resolve the task sandbox from config.toml and add task --read-only | verify | — |
| #716 | pr | +412/-3 | fix(session): resolve workspaces without git | verify | — |
| #722 | pr | +3/-0 | docs(rescue): document writable sandbox scope | verify | cherry-pick candidate |
| #785 | issue | — | Browser use from /codex:rescue is denied with no Chrome approval path | verify | — |

## 12. MCP

MCP elicitation/approval и clientInfo-обвязка app-server.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #199 | issue | — | clientInfo.name should use codex-namespaced identifier instead of host application name | verify | — |
| #255 | pr | +19/-2 | fix: namespace app-server client info | verify | cherry-pick candidate |
| #258 | issue | — | Claude Code review hangs on MCP tool call when an MCP server triggers elicitation | verify | — |
| #276 | issue | — | app-server clientInfo.name "Claude Code" causes 400 invalid_request_error for gpt-5.5 | verify | — |
| #499 | issue | — | Connector (codex_apps) MCP tool calls are auto-rejected: app-server client stubs all server→client requests with -32601 | planned v1.5.0 | see #501 |
| #501 | pr | +51/-1 | fix(app-server): accept MCP elicitation requests instead of rejecting them (#499) | fixed-in 1.1.0 | fixes #499 |
| #640 | issue | — | Plugin never answers MCP tool-call approval requests, so every MCP call in a `task` run is denied | planned v1.5.0 | — |
| #641 | pr | +165/-4 | Accept MCP elicitation requests so headless MCP tool calls work | fixed-in 1.1.0 | — |

## 13. state dir & security

Каталог состояния плагина, изоляция от соседних плагинов, security-харденинг путей.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #75 | issue | — | Codex plugin bypasses project-level Claude Code permission settings (deny rules in .claude/settings.json) | verify | — |
| #124 | issue | — | feat: support `--dangerously-skip-permissions` (aka yolo) mode for the app server | verify | — |
| #289 | pr | +114/-8 | Harden `--prompt-file` against paths outside the working directory | verify | cherry-pick candidate |
| #290 | pr | +99/-11 | Use `--end-of-options` before user-controlled refs in git invocations | verify | cherry-pick candidate |
| #326 | pr | +21/-0 | Create SECURITY.md for security policy | fixed-in v1.4.0 | cherry-pick candidate |
| #382 | issue | — | Concurrent Claude Code sessions race on shared ~/.codex — app-server spawned without an isolated CODEX_HOME | verify | — |
| #609 | issue | — | Plugin state dir has no plugin-identity segment: sibling plugins share one jobs array, and pruneJobs deletes the other plugin's records | fixed-in v1.3.0 | — |
| #683 | pr | +132/-13 | fix: isolate companion state from sibling plugins | fixed-in v1.3.0 | cherry-pick candidate |

## 14. hooks stdin/EAGAIN & misc hooks

EAGAIN/stdin в хуках, CLAUDE_PLUGIN_ROOT/DATA, прочие SessionStart/SessionEnd хуки.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #120 | issue | — | EAGAIN crash in hook scripts: readFileSync(0) fails when stdin is non-blocking | fixed-in v1.4.0 | see #150 |
| #123 | pr | +118/-2 | fix: handle EAGAIN in hook readFileSync(0) for non-blocking stdin | fixed-in v1.4.0 | cherry-pick candidate |
| #125 | pr | +90/-6 | fix: fall back to tmpdir state when CLAUDE_PLUGIN_DATA state is empty | verify | cherry-pick candidate |
| #132 | pr | +18/-2 | fix: handle EAGAIN when reading hook stdin in non-blocking mode | fixed-in v1.4.0 | cherry-pick candidate |
| #139 | pr | +30/-0 | feat: block direct codex CLI calls via PreToolUse hook | verify | cherry-pick candidate |
| #150 | pr | +20/-10 | fix: handle EAGAIN in hook scripts readHookInput (#120) | fixed-in v1.4.0 | fixes #120 |
| #165 | pr | +68/-8 | fix: handle EAGAIN in hook scripts when stdin is non-blocking | fixed-in v1.4.0 | cherry-pick candidate |
| #189 | pr | +18/-2 | fix: handle EAGAIN error when reading stdin in hook scripts | fixed-in v1.4.0 | cherry-pick candidate |
| #190 | pr | +241/-10 | [codex] sanitize codex child process env | verify | — |
| #247 | issue | — | codex-companion crashes with EAGAIN on concurrent sessions (readStdinIfPiped sync read) | fixed-in v1.4.0 | — |
| #274 | pr | +5/-2 | fix(codex-rescue): append </dev/null to codex-companion task invocation | verify | cherry-pick candidate |
| #345 | issue | — | Codex --background killed by SessionEnd hook when wrapped in Claude Code Agent subagent | verify | — |
| #381 | pr | +3661/-159 | fix: tear down brokers by sessionId on SessionEnd to avoid orphaned worktree brokers (#380) | reference-only | fixes #380 |
| #397 | issue | — | /codex:rescue subagent silently fails to delegate — ${CLAUDE_PLUGIN_ROOT} is empty in subagent Bash | verify | — |
| #448 | issue | — | Plugin hooks fail when CLAUDE_PLUGIN_ROOT is missing on macOS | verify | — |
| #449 | pr | +143/-3 | fix: tolerate missing CLAUDE_PLUGIN_ROOT in hooks | verify | cherry-pick candidate |
| #459 | issue | — | Remove unsupported top-level description from hooks.json | fixed-in v1.3.0 | — |
| #474 | issue | — | Increase `SessionEnd` hook timeout to prevent premature cancellation | verify | — |
| #491 | pr | +755/-66 | Prevent SessionEnd from killing shared Codex tasks | verify | — |
| #562 | issue | — | SessionStart hook leaks per-plugin CLAUDE_PLUGIN_DATA into the shared session env file | fixed-in 1.1.0 | — |
| #582 | issue | — | Codex clamps official plugin SessionEnd timeout from 5s to 3s | n-a | Codex-host SessionEnd clamp — n/a to fork |
| #619 | pr | +3/-1 | fix: lower the SessionEnd hook timeout to Codex CLI's 3s cap | n-a | Codex-host SessionEnd clamp — n/a to fork |
| #659 | pr | +586/-44 | fix: SessionEnd/status lookups miss state written under a different CLAUDE_PLUGIN_DATA root, orphaning brokers | planned v1.5.0 | — |
| #670 | issue | — | SessionStart hook is killed by its own 5s timeout, silently dropping CODEX_COMPANION_SESSION_ID | verify | — |
| #672 | pr | +8/-1 | fix: allow SessionStart hook more time to restore state | fixed-in 1.1.0 | — |
| #674 | pr | +167/-6 | fix: resolve rescue plugin root without environment | verify | — |
| #713 | pr | +142/-3 | fix(stdin): retry transient nonblocking reads | verify | cherry-pick candidate |
| #717 | issue | — | DEP0190 on Node 24: every companion command warns on stderr before its JSON | n-a | DEP0190 Node warning, posix quirk — n/a |
| #755 | pr | +55/-2 | fix(hooks): align SessionEnd timeout with Codex runtime cap | n-a | Codex-host SessionEnd clamp — n/a to fork |
| #780 | pr | +3/-1 | Clamp SessionEnd hook timeout to Codex limit | n-a | Codex-host SessionEnd clamp — n/a to fork |

## 15. feature requests

Запросы новых команд/флагов и интеграций (включая внеприоритетные: Gemini/Antigravity, imagegen, tmux, jj, computer-use).

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #1 | pr | +1633/-14 | Add Gemini CLI extension commands | wontfix | out of parity |
| #7 | issue | — | Feature: consult command for persistent multi-turn Q&A sessions | planned v1.6.0 | — |
| #8 | issue | — | Feature: auto-detect command based on workspace state | verify | — |
| #72 | pr | +966/-0 | feat: let Claude Code agents use OpenAI models | wontfix | out of parity |
| #91 | issue | — | add gemini cli extension command | wontfix | out of parity |
| #102 | issue | — | Add `/codex:usage` command to show rate limits and usage | verify | — |
| #103 | pr | +172/-3 | feature: add `/codex:usage` command to show rate limits and account plan | verify | — |
| #135 | issue | — | feat: git worktree isolation for write-capable rescue tasks | verify | see #137 |
| #137 | pr | +496/-10 | feat: add --worktree flag for isolated write-capable rescue tasks | verify | fixes #135 |
| #149 | pr | +725/-1 | Add /codex:agent-team for tmux split-pane multi-agent spawning | wontfix | out of parity |
| #152 | pr | +344/-4 | Add /codex:usage command to show rate limits and usage | verify | duplicate of #103 |
| #205 | issue | — | Feature request: support a /codex:test command | verify | — |
| #206 | pr | +1707/-25 | feat: add strict /codex:test workflow | verify | — |
| #208 | issue | — | Bug: /plugin install does not add plugin to enabledPlugins, causing 'Unknown skill' on all commands | verify | — |
| #209 | pr | +22/-7 | feat: add --fast flag to task command for service_tier support | verify | fixes #210 |
| #210 | issue | — | Feature request: --fast flag for task command (service_tier=fast support) | verify | see #209 |
| #215 | issue | — | feat: support jujutsu (jj) workspaces | wontfix | see #292 |
| #229 | issue | — | can codex plugin capture context like codex desktop mac app? | verify | — |
| #230 | issue | — | feat: add --resume-id <threadId> option to task command | planned v1.5.0 | — |
| #242 | issue | — | Can we possibly improve the performance of the plugin given that CC has reduced TTL of prompt cache drastically? | verify | — |
| #246 | pr | +57/-5 | feat: add --auto-poll default for task command | verify | cherry-pick candidate |
| #251 | issue | — | feat: allow selecting a Codex profile for companion-launched jobs | planned v1.5.0 | — |
| #256 | pr | +236/-30 | Add profile selection to Codex companion runs | planned v1.5.0 | — |
| #263 | issue | — | [feat] need /codex: implement/excute | verify | — |
| #271 | pr | +390/-1 | Add /codex:image for native image generation through Codex | wontfix | out of parity |
| #275 | issue | — | It seems impossible to send new messages to Claude Code to guide it through a task or add requirements without interrupting the current process.I'm using the self-hosted version. | verify | — |
| #283 | issue | — | Delegated sessions are not renamed with a representative identifier in Codex | verify | — |
| #284 | issue | — | Add --context flag to /codex command | verify | — |
| #291 | pr | +73/-0 | feat: add /codex:attach command for live log streaming | verify | cherry-pick candidate |
| #317 | pr | +635/-19 | Add direct Codex CLI and goal commands | verify | — |
| #332 | pr | +520/-89 | feat(state): add --state-dir flag + CODEX_COMPANION_STATE_DIR env var | verify | — |
| #340 | pr | +3706/-30 | feat: add Antigravity CLI and Gemini environment support | wontfix | out of parity |
| #347 | pr | +326/-19 | feat(task): add --background --await + await subcommand for completion-bound process | verify | — |
| #351 | pr | +1106/-4 | Add new two commands monitor & shift | verify | — |
| #357 | pr | +883/-9 | Add managed image generation (/codex:imagegen) | wontfix | out of parity |
| #359 | pr | +6088/-127 | Add observer and worktree features with multi-root support | reference-only | reference, huge PR |
| #418 | issue | — | Feature: forward extra args (custom model_provider / profile) to every codex launch | planned v1.5.0 | — |
| #419 | pr | +369/-19 | feat: forward CODEX_PLUGIN_CC_ARGS to codex launches | planned v1.5.0 | — |
| #446 | issue | — | feature request: /codex:computer-use to delegate runtime/UI verification (app launch, screenshots, simulators) | wontfix | out of parity |
| #462 | pr | +89/-1 | feat: add codex-reviewer subagent for programmatic reviews (#354) | planned v1.6.0 | fixes #354 |
| #488 | pr | +2944/-8 | feat: rig edition — tier routing, typed envelopes, quota failover, fanout/council/cloud verbs | wontfix | out of parity |
| #519 | issue | — | feat: support a plugin-only Codex configuration layer | verify | — |
| #560 | pr | +810/-9 | feat(rescue): carry the Claude session into a Codex rescue with --session-context | verify | — |
| #578 | pr | +447/-9 | feat: recover a lost result from the Codex rollout transcript | verify | — |
| #587 | issue | — | Resident roles: charters installed as standing goals make unassigned threads self-run turns (codex >=0.146); please make goal installation opt-in + add thread/goal/clear | verify | — |
| #678 | pr | +71/-1 | feat: recognize OrcaRouter as a first-class provider | verify | cherry-pick candidate |
| #681 | pr | +420/-35 | feat(companion): handle --help per subcommand so it cannot start a run | verify | — |
| #691 | pr | +119/-2 | feat(app-server): expose CODEX_COMPANION_APP_SERVER_DISABLE_BROKER env var | planned v1.5.0 | cherry-pick candidate |
| #712 | pr | +312/-15 | feat(task): verify prompt file digests | verify | — |
| #719 | pr | +2622/-151 | feat: add `task --thread <id>` to resume a specific Codex thread | reference-only | reference, huge PR |
| #724 | pr | +295/-32 | feat: enforce scoped Codex task reads | verify | — |
| #745 | issue | — | Alternative: claude-codex-bridge — full async Codex agents with live progress & steering | verify | — |
| #779 | pr | +151/-10 | feat: add --ephemeral flag to `task` to avoid polluting Codex Recent | planned v1.5.0 | — |

## 16. docs/meta

Документация, тесты-инфраструктура, мета-вопросы о проекте.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #26 | issue | — | Consider listing in awesome-codex-plugins | verify | — |
| #79 | issue | — | README: Purpose / Benefits of this plugin? | verify | — |
| #93 | pr | +1254/-2 | test: add comprehensive coverage for args, fs, prompts, render, state… | verify | — |
| #204 | pr | +346/-0 | [Night Shift] Add rescue edge case tests and audit README | verify | — |
| #368 | issue | — | Is there an active fork of this plugin? | verify | — |
| #388 | issue | — | codex-cli-runtime skill should instruct agents to use --prompt-file for shell-safe prompt passing | verify | — |
| #399 | pr | +11/-2 | [Night Shift] Document --prompt-file for shell-safe prompt passing | verify | cherry-pick candidate |
| #401 | pr | +43/-3 | [Night Shift] Fix subagent env var resolution and add background task docs | verify | cherry-pick candidate |
| #455 | issue | — | Test suite is not hermetic inside a live Claude Code session: 4 failures at HEAD + fixture state leaks into the user's real plugin data dir | verify | — |
| #456 | pr | +27/-4 | fix(tests): keep the suite hermetic inside a live Claude Code session | verify | cherry-pick candidate |
| #473 | pr | +104/-0 | docs: add contributor guide | verify | cherry-pick candidate |
| #479 | pr | +5/-5 | Minor updates to Codex Rescue agent and skill text for better Sonnet subagent adherence | verify | cherry-pick candidate |
| #537 | pr | +20/-0 | Document workaround for hidden explicit commands | verify | cherry-pick candidate |
| #553 | issue | — | codex-rescue: node-based file writes for prompt assembly trip the auto-mode bypass classifier | verify | — |
| #591 | pr | +8/-3 | docs: --cwd routing flag, deterministic --wait/--background stripping, non-interactive resume guard | verify | cherry-pick candidate |
| #692 | pr | +35/-1 | fix(rescue): forbid node-based prompt writes and pgrep wait loops | verify | cherry-pick candidate |
| #720 | pr | +0/-6 | docs: drop the /reload-plugins step from install | verify | cherry-pick candidate |

## 17. noise

Спам/нерелевантные тикеты без содержательного отчёта.

| # | type | size | title | status | note |
|---|---|---|---|---|---|
| #80 | issue | — | Questions Regarding Understanding and Usage | noise | noise |
| #98 | issue | — | Call Codex and a custom skill | noise | noise |
| #117 | issue | — | code breaks due to exception ,. | noise | noise |
| #134 | issue | — | New feature requirements | noise | noise |
| #140 | pr | +1/-1 | Update README.md | noise | noise |
| #192 | pr | +1/-0 | CC | noise | noise |
| #431 | issue | — | Yeshit | noise | noise |
| #434 | issue | — | ثت | noise | noise |
| #437 | issue | — | Is there anyone experienced who could try running this operating-system-like project? I can provide the .md file, but I’m not getting it to work properly on my end. | noise | noise |

## Authors to credit

PR со статусом `planned <ver>` либо с пометкой `cherry-pick candidate` — для последующих `Co-authored-by` при переносе:

- #123 — @tmchow
- #125 — @tmchow
- #129 — @Co-Messi
- #132 — @JiayuuWang
- #136 — @erickreutz
- #139 — @peterdrier
- #147 — @D2758695161
- #150 — @D2758695161
- #165 — @ikbear
- #189 — @chelseachen007
- #214 — @lttlin
- #226 — @BryanBorck
- #227 — @BastianZim
- #246 — @oitray
- #249 — @Shui-Zhou
- #255 — @d3v07
- #256 — @dhruvac29
- #274 — @hobaratio
- #289 — @lohengrin332
- #290 — @lohengrin332
- #291 — @rezzminator
- #294 — @Joepaken
- #297 — @yoshitarof
- #299 — @RiverAi7z
- #300 — @dhruvac29
- #307 — @tonyyunyang
- #313 — @cardene777
- #314 — @cardene777
- #315 — @robertbpugh
- #318 — @AZERIA-IT
- #319 — @mrlitong
- #325 — @ultsaza
- #326 — @tanakauo
- #327 — @kingdoooo
- #352 — @AliceLJY
- #385 — @joelmdev
- #386 — @NYCU-Chung
- #399 — @Pgarciapg
- #401 — @Pgarciapg
- #415 — @fix2015
- #419 — @klmklmnb
- #429 — @SEPURI-SAI-KRISHNA
- #436 — @CooperSheroy
- #438 — @mayankpandey0
- #442 — @fabiogioachin
- #449 — @leejhy
- #451 — @e345ee
- #453 — @lselva123
- #456 — @Caleb0796
- #461 — @ayobamiseun
- #462 — @ayobamiseun
- #465 — @CapCap
- #469 — @ayobamiseun
- #473 — @ayobamiseun
- #475 — @Guardiannw
- #479 — @studioetc
- #492 — @xzjncu
- #494 — @Yogitmeister
- #504 — @NgoQuocViet2001
- #523 — @axisrow
- #533 — @Kevinjohn
- #534 — @Kevinjohn
- #535 — @Kevinjohn
- #537 — @Kevinjohn
- #544 — @stantheman0128
- #550 — @hogeheer499-commits
- #555 — @Epochex
- #557 — @dinhnguyenminhhoang
- #565 — @mittalpk
- #566 — @srdrkr
- #567 — @Asher123452
- #569 — @SanAntonio021
- #573 — @SomSamantray
- #575 — @fenril058
- #577 — @xoonjaeho
- #579 — @xoonjaeho
- #581 — @axisrow
- #583 — @andyli953
- #584 — @andyli953
- #586 — @QuocHuannn
- #591 — @scompel
- #593 — @scompel
- #599 — @Wintersta7e
- #613 — @joscarras
- #624 — @sensei-woo
- #625 — @LZong-tw
- #642 — @principalwater
- #650 — @SomSamantray
- #656 — @mittalpk
- #658 — @jacobbabula
- #659 — @mittalpk
- #666 — @Hughhhhcoder
- #669 — @mittalpk
- #677 — @cjsteigerwald
- #678 — @kuswardhanietidims-svg
- #683 — @weivwang
- #691 — @tyoon10
- #692 — @tyoon10
- #694 — @SSMinnowJohnson
- #696 — @stevebooks
- #701 — @JMak-Security
- #702 — @JMak-Security
- #710 — @ALV0612
- #713 — @ALV0612
- #714 — @ALV0612
- #720 — @yigitkonur
- #722 — @rksharma-owg
- #735 — @mohammad-malik
- #742 — @alirezarzg
- #746 — @taur-us
- #747 — @sylvesterkaczmarek
- #748 — @MeGaNeKoS
- #749 — @sylvesterkaczmarek
- #762 — @Soumya95
- #763 — @Soumya95
- #768 — @mzl9039
- #770 — @aramfachan
- #772 — @kevin9327
- #773 — @kevin9327
- #774 — @kevin9327
- #775 — @kevin9327
- #779 — @0dimen
- #787 — @SammyTourani

## Upstream comment queue

Issue (не PR) со статусом `fixed-in`/`planned`, сгруппированные по релизу, на который будет отправлен комментарий "fixed in vX" апстриму. Issues со статусом `noise`/`wontfix`/`verify`/`reference-only`/`n-a` исключены (для них релиз ещё не определён либо не применим).

### fixed-in 1.1.0

#476, #528, #539, #562, #651, #661, #664, #676, #687, #778, #783

### fixed-in 1.1.1

#108, #450, #543

### fixed-in 1.2.0

#458, #498, #524

### fixed-in 1.3.0

#459, #468, #483, #485, #521, #548, #589, #609, #631, #698, #703, #721, #743, #753, #757, #769, #781, #782

### fixed-in 1.4.0

#120, #247, #287, #409, #440, #525, #530, #647, #708

### planned v1.3.0

#463

### fixed-in v1.3.0, not announced upstream yet

#626, #633 (guarded pid/log unlink in broker teardown)

### planned v1.4.1

#70, #336, #416, #423, #487, #718

### verify (Windows, needs a reporter retest after v1.4.0)

#113, #236, #285, #295, #310

### planned v1.5.0

#57, #145, #211, #221, #223, #230, #251, #257, #333, #349, #380, #405, #417, #418, #481, #495, #499, #502, #512, #514, #522, #529, #570, #602, #618, #636, #640, #653, #654, #655, #675, #679, #699, #700, #705, #750, #764, #767

### planned v1.6.0

#7, #354, #445, #585

