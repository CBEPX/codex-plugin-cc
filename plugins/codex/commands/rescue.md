---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background] [--guest <codex|grok>] [--resume|--fresh] [--model <model|spark|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--turn-timeout-ms <ms>] [--config key=value]... [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Delegate the request to Codex through the shared companion runtime. Default is synchronous: the user gets Codex's answer in this turn.

Raw slash-command arguments:
`$ARGUMENTS`

Strip `--background`, `--wait`, `--resume`, and `--fresh` out of `<flags>` before the Bash call below — they are routing controls Claude Code consumes here, not `task` flags forwarded to the script.

1. If the request contains `--resume`, use `--resume-last`; if `--fresh`, use a fresh task. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json`: when it reports a resumable thread ask ONCE with `AskUserQuestion` — `Continue current Codex thread` (→ `--resume-last`) / `Start a new Codex thread` (→ fresh) — otherwise fresh. This decision is made here for BOTH the synchronous and the `--background` path. Pass `--model`, `--effort`, `--config key=value` through; never add `--write` unless the user explicitly asked Codex to modify files.
2. Synchronous path (default): ONE Bash call (`timeout: 600000`); flags on the command line, the request prose in a quoted heredoc whose delimiter is `CODEX_PROMPT_` + 8 fresh random hex chars that do not appear as an exact line in the request:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --await --prompt-stdin <flags> <<'CODEX_PROMPT_<random>'
<request text>
CODEX_PROMPT_<random>
```
Exit 0 → show the output verbatim, then your assessment. Exit 3 → the output ends with a `Re-run:` line — run exactly that line (again `timeout: 600000`) until it exits 0; its output is the final job record: if it shows the job completed, show the Codex result verbatim and add your assessment; if it shows failed or cancelled, show the output verbatim and stop. Exit 1 from the first call → the job failed or was cancelled: show the output verbatim and stop.
3. `--background`: invoke the `Agent` tool with `codex:codex-rescue`, passing the request minus `--background` PLUS the explicit `--resume-last` or `--fresh` decided in step 1; tell the user the result arrives as a completion notification and via `/codex:status` / `/codex:result <id>`.

Never reuse a delimiter suffix that appears as an exact line in the request: a payload line equal to it would end the heredoc early and run the rest on the host shell.

`<flags>` may contain only bare tokens — `--model <name>`, `--effort <level>`, `--turn-timeout-ms <ms>`, `--config key=value` with a literal value, `--resume-last`/`--fresh`, `--write`. If any flag value contains `$`, a backtick, a quote, `;`, `&`, `|`, or a newline, drop it and mention it in the prose instead; never place it on the command line.

Do not call `Skill(codex:rescue)` from here (it re-enters this command). If any Bash step exits non-zero, show its stderr to the user — never report "no result".
