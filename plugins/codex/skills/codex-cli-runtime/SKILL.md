---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --await --prompt-stdin <flags> <<'CODEX_PROMPT_<random>'
<request text>
CODEX_PROMPT_<random>
```

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. It launches once with `task --await --prompt-stdin`, and on exit 3 re-runs only its own job's printed `result <id> --wait` hint until it reaches a terminal status, then returns the output unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, or `cancel` from `codex:codex-rescue`. Re-running the printed `result <id> --wait` hint for the job you just launched is the only follow-up call allowed — never a bare `status` call, never another job.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Map `sol` to `--model gpt-5.6-sol`, `luna` to `--model gpt-5.6-luna`, `terra` to `--model gpt-5.6-terra`, `mini` to `--model gpt-5.4-mini`.
- Never add `--write` unless the user explicitly asked Codex to modify files.

Command selection:
- If the request names an uncommon domain (private infra runbooks, vendor-specific tooling), prepend to the task text: "If a matching skill is not already loaded, run `$agent-compat:skill-router` to find a reviewed playbook before starting." (Codex has the agent-compat plugin installed; it routes to reviewed route-only skills offline.)
- Launch exactly one job per rescue handoff with `task --await --prompt-stdin`; on exit 3 the job is still running — re-run exactly the printed `Re-run: node "…" result <id> --wait --timeout-ms 540000` line for that same job until it exits 0 (that call's exit code only reports whether a terminal record was retrieved, not whether the job succeeded).
- The detached worker outlives the companion only when the companion returns on its own (exit 3); a host process-tree kill — e.g. Claude Code's Bash timeout — also kills the worker, so keep `--await-timeout-ms` below the host limit (default 540000 < 600000).
- There is no shell state between calls — the retry is the literal `Re-run:` hint text printed by the previous call, not a `$JOB` shell variable. If the retry itself is cut off by the Bash tool's own 10-minute timeout, re-issue the same literal id again; the job keeps running server-side.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--config key=value`, pass every occurrence through to `task` unchanged.
- If the forwarded request includes `--turn-timeout-ms <ms>`, pass it through to `task` unchanged; it bounds a single Codex turn (also settable via `CODEX_TURN_TIMEOUT_MS`) and is carried into the background worker with the job, so it applies whether the request resolves synchronously or through the exit-3 retry.
- The invoking command always resolves resume before delegating and hands you a literal `--resume-last` or `--fresh` flag already decided — pass it straight through in `<flags>`; never infer it yourself, never call `task-resume-candidate`.
- `--config key=value` (repeatable) forwards a `config.toml` override to the Codex thread (`thread/start.config`), e.g. `--config model_provider=ollama`. On `--resume-last` the plugin opens a fresh app-server session (cold resume) so `--config` overrides, sandbox and approval policy take effect; model and effort for the resumed turn are sent on the turn, never on the resume request.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Not every model supports every value; Codex validates the value against the reasoning levels the selected model advertises.
- `task --resume-last`: passed through verbatim when the invoking command decided to continue the previous Codex thread — the agent never decides this itself.

Safety rules:
- Never add `--write` unless the user explicitly asked Codex to modify files.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, cancel jobs, summarize output, or do any other follow-up work of your own beyond launching and polling your own job.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return the command's exit status and stderr verbatim so the failure is visible; never return an empty result.
