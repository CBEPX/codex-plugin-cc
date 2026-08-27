---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. It launches once with `task --background --json`, polls only that job's own `status`, then returns the `result` stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, or `cancel` from `codex:codex-rescue`. `status` and `result` are allowed, but only for the job you just launched — never another job.
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
- Launch exactly one job per rescue handoff with `task --background --json`, then poll only that job with `status <id> --wait --timeout-ms 540000 --json` until it reaches a terminal status, then fetch it with `result <id>`.
- The detached worker outlives the companion only when the companion returns on its own (exit 3); a host process-tree kill — e.g. Claude Code's Bash timeout — also kills the worker, so keep `--await-timeout-ms` below the host limit (default 540000 < 600000).
- Bash calls share no shell state — carry the job id as literal text between calls, never as a leftover `$JOB` shell variable. If a wait call is cut off by the Bash tool's own 10-minute timeout, re-issue it with the same literal id; the job keeps running server-side.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--config key=value`, pass every occurrence through to `task` unchanged.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--config key=value` (repeatable) forwards a `config.toml` override to the Codex thread (`thread/start.config`), e.g. `--config model_provider=ollama`. On `--resume-last` the plugin opens a fresh app-server session (cold resume) so `--config` overrides, sandbox and approval policy take effect; model and effort for the resumed turn are sent on the turn, never on the resume request.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Not every model supports every value; Codex validates the value against the reasoning levels the selected model advertises.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Never add `--write` unless the user explicitly asked Codex to modify files.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, cancel jobs, summarize output, or do any other follow-up work of your own beyond launching and polling your own job.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return the command's exit status and stderr verbatim so the failure is visible; never return an empty result.
