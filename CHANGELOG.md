# Changelog

## 1.1.0 — 2026-08-27

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 1.0.6 (`db52e28`). Marketplace `cbepx`, plugin name unchanged (`codex`).

### Merged from upstream pull requests
- #616 accept `max` and `ultra` reasoning efforts
- #688 resolve model aliases on `review` / `adversarial-review`
- #426 `on-request` approval policy for `--write` task runs
- #501 answer MCP elicitation requests instead of rejecting them
- #608 rescue agent awaits the delegated result instead of returning a placeholder
- #690 explicit Bash blocks in `status`/`result`/`cancel`/`transfer` commands (pass permission classifiers)
- #547 `task --help` and unknown flags are CLI errors, never a prompt
- #645 / #644 job records store resolved model/effort/sandbox; reasoning start is logged
- #672 SessionStart hook timeout raised; #668 idempotent `CLAUDE_ENV_FILE` exports; #682 stop gate fails closed on malformed input; #396 `CODEX_REVIEW_GATE_MAX_ROUNDS`

### Fork changes
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
