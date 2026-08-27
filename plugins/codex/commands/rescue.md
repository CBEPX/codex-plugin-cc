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

2. Launch the job, then wait for it — two separate Bash calls, in ≤9-minute wait slices so the Bash tool's 10-minute cap never kills a long run. Bash calls share no variables — always set `JOB=<id>` literally at the top of every later call; never rely on a `$JOB` left over from a previous call.

2a. Launch (one Bash call):

```bash
ERR=$(mktemp)
JOB=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --json <flags> "<request text>" 2>"$ERR" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).jobId||"")}catch(e){}})')
[ -n "$JOB" ] || { cat "$ERR"; exit 1; }
echo "JOB=$JOB"
```
If this call exits non-zero, its output is the launch failure (Codex missing, unauthenticated, a bad flag, etc.) — show it to the user verbatim and stop; never report "no result". Otherwise its last line is `JOB=<id>`; read `<id>` from it.

2b. Wait and fetch the result (one Bash call, tool `timeout: 600000`). Set `JOB=<id>` literally as the first line, using the id you just read from 2a:

```bash
JOB=<id>
OUT=$(mktemp); ERR=$(mktemp)
while node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$JOB" --wait --timeout-ms 540000 --json >"$OUT" 2>"$ERR"; node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=(JSON.parse(d).job||{}).status;process.exit(s==="queued"||s==="running"?3:(s?0:2))}catch(e){process.exit(2)}})' < "$OUT"; rc=$?; [ "$rc" -eq 3 ]; do sleep 1; done
[ "$rc" -eq 0 ] || { cat "$OUT" "$ERR"; exit "$rc"; }
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$JOB"
```
The status check exits 3 while the job is still `queued`/`running` (loop — `sleep 1` keeps a fast exit-3 from spinning hot), 0 once the job reaches a terminal status, or 2 if the status output was empty or unparseable; either non-3 outcome ends the loop. If this Bash call is itself cut off by the tool's own timeout before the loop finishes, the job keeps running server-side — run 2b again with the same literal `JOB=<id>` line. If it exits non-zero, show its output verbatim and stop; never report "no result". Otherwise show the `result` output to the user verbatim, then add your own assessment.

3. Only when the request contains `--background`: invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`, prompt = the raw request minus `--background`) and tell the user the job id will arrive as a completion notification; they can also run `/codex:status` and `/codex:result <job-id>`.

Do not call `Skill(codex:rescue)` from here (it re-enters this command). If any Bash step exits non-zero, show its stderr to the user — never report "no result".
