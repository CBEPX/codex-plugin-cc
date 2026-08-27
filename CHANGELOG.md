# Changelog

## 1.1.1 — 2026-08-28

- Broker idle self-terminate (upstream #457): the shared Codex runtime exits after 30 minutes without a connected client (`CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` / `--idle-timeout`), so idle brokers and their app-server children no longer accumulate (#543).
- Broker lifecycle races found in #457: a broker that self-terminates on idle now drops its `broker.json` ownership record (a later `SessionEnd` could otherwise signal a recycled PID, and `status` could advertise a dead endpoint), teardown verifies the recorded PID really is this session's broker before signalling it, and the broker stops listening before it closes its app-server child so a client connecting mid-shutdown is refused instead of being served and then failing its first RPC.
- Test suite no longer leaks fake `codex app-server`/broker processes (5 s idle timeout in the test environment; CI fails if any `codex-plugin-test-*` process survives).
- Rescue shell blocks use `command rm -f --` in their cleanup trap (no noise from `rm` aliases such as `trash`).

## 1.1.0 — 2026-08-27

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 1.0.6 (`db52e28`). Marketplace `cbepx`, plugin name unchanged (`codex`).

### Merged from upstream pull requests
- #616 accept `max` and `ultra` reasoning efforts
- #688 resolve model aliases on `review` / `adversarial-review`
- #426 `on-request` approval policy for `--write` task runs
- #501 answer MCP elicitation requests instead of rejecting them
- #608 rescue agent awaits the delegated result instead of returning a placeholder
- #690 explicit Bash blocks in `status`/`result`/`cancel`/`transfer` commands (pass permission classifiers)
- #547 unknown flags are CLI errors, never part of the prompt; `--help` prints usage and exits 0
- #645 / #644 job records store resolved model/effort/sandbox; reasoning start is logged
- #672 SessionStart hook timeout raised; #668 idempotent `CLAUDE_ENV_FILE` exports; #682 stop gate fails closed on malformed input; #396 `CODEX_REVIEW_GATE_MAX_ROUNDS`

### Fork changes
- Slash-command arguments reach the companion through a quoted heredoc on stdin (`--args-stdin`) instead of a shell string: Claude Code substitutes `$ARGUMENTS` before bash runs, so `$(...)`/backticks in a prompt used to execute on the host shell, outside Codex's sandbox. Rescue job ids are validated before use. `/codex:rescue` keeps the two channels separate — the request prose goes to `--prompt-file` through its own quoted heredoc so quotes, backslashes and newlines survive byte-exact, while `--args-stdin` carries only runtime flags — and randomizes both heredoc delimiters per call; the other seven command bodies keep the fixed `CODEX_ARGS` delimiter because their payload is only flags and job ids.
- Approval requests (`execCommandApproval`, `applyPatchApproval`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`) are answered with each type's refusal variant instead of a `-32601` protocol error that made `--write` turns fail or hang.
- Background task records are written before the worker is spawned (a fast worker used to find no record and exit while the launch reported `queued`), and the worker reads the full request — including `--config` values — from a private one-shot `jobs/<id>.request.json` (mode 0600); the job record `status`/`result` echo keeps secret-looking config values redacted.
- Model and reasoning effort are sent per thread via `thread/start.config` (`model`, `review_model` for native review, `model_reasoning_effort`); generic `--config` pairs are applied first, dedicated flags override them; `--effort` now works on `review` and `adversarial-review`.
- Repeatable `--config key=value` on `task`, `review`, `adversarial-review` forwards any `config.toml` override to the thread (values are JSON-parsed; quote a literal string as `'"true"'`). Prompt-taking commands stop option parsing at the first positional, so prompt text like `ls -R` is never mis-parsed.
- `--resume-last` opens a fresh app-server session (cold resume) so `--config`, sandbox and approval policy take effect, and never sends `model` on `thread/resume` (it would drop the persisted model); the resumed turn's model/effort ride on `turn/start`.
- All MCP elicitations are declined (no operator is present); URL/form flows must be completed in an interactive Codex session.
- `/codex:rescue` is synchronous by default without the `Agent` tool: `task --background` → `status --wait` in ≤9-minute slices (job id carried literally between Bash calls) → `result`; launch failures stop immediately with visible stderr; `Agent` only for `--background`; `--write` is never added unless the user explicitly asked Codex to modify files.
- `/codex:rescue` asks before continuing an existing Codex thread (`Continue current Codex thread` / `Start a new Codex thread`) instead of resuming silently; its `allowed-tools` is now `Bash, AskUserQuestion, Agent` because the body is multi-command shell.
- A resume refuses to start a second turn on a thread that a queued or running job is still using, including a job from another Claude session.
- Model aliases: `sol`, `luna`, `terra`, `mini` (plus `spark`); rescue agent has no pinned `model:`; runtime skill mentions `$agent-compat:skill-router` for uncommon domains.
- Stop-gate script timeout (13 min) is below the hook timeout (15 min); `spawnSync` uses `SIGKILL` and a 16 MiB buffer.
- Hermetic test environment (`tests/test-env.mjs`); CI on push; `npm run build` type-checks the JSDoc.

## 1.0.6 and earlier
See upstream releases: https://github.com/openai/codex-plugin-cc/releases
