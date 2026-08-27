---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--config key=value]... [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Delegate the request to Codex through the shared companion runtime. Default is synchronous: the user gets Codex's answer in this turn.

Raw slash-command arguments:
`$ARGUMENTS`

If the request contains `--background`, skip directly to step 3 — steps 1 and 2 are the default synchronous path and do not run for a `--background` request.

1. Strip `--wait` if present (it is the default). If the request contains `--resume`, use `task --resume-last`; if `--fresh`, use a fresh `task`; otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json` and follow its recommendation. Pass `--model`, `--effort` and every `--config key=value` through unchanged. Never add `--write` unless the user explicitly asked Codex to modify files.

2. Start the job and wait for it, in ≤9-minute slices so the Bash tool's 10-minute cap never kills a long run:

```bash
JOB=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --json <flags> "<request text>" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).jobId))')
until node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$JOB" --wait --timeout-ms 540000 --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d).job.status;process.exit(s==="queued"||s==="running"?1:0)})'; do :; done
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$JOB"
```
Run the `until` loop as one Bash call with `timeout: 600000`; if it returns because Bash timed out, run the same `until … done` line again — the job keeps running in the background. `status --wait --json` exits 0 regardless of whether the job finished or the wait itself timed out (see `handleStatus`/`waitForSingleJobSnapshot` in `codex-companion.mjs`), so the loop parses `job.status` from the JSON instead of the exit code — `"queued"`/`"running"` means keep looping, anything else is terminal. Show the `result` output to the user verbatim, then add your own assessment.

3. Only when the request contains `--background`: invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`, prompt = the raw request minus `--background`) and tell the user the job id will arrive as a completion notification; they can also run `/codex:status` and `/codex:result <job-id>`.

Do not call `Skill(codex:rescue)` from here (it re-enters this command). If any Bash step exits non-zero, show its stderr to the user — never report "no result".
