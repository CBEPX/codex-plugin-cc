---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--output <new-path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show the stored final output for a finished Codex job by running the Bash command below, then present the output as printed.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result --args-stdin <<'CODEX_ARGS'
$ARGUMENTS
CODEX_ARGS
```

Present the command output to the user as printed. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

When the output ends with a `Truncated:` block and a `Full output:` line, it is a preview (the command prints at most 8192 bytes). Present that preview and the `Full output:` line as printed. Do not re-run the command on your own. Only when the user asks for the full text, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <id> --wait` with the job id from that line, and present its output as printed.

If the arguments include `--output`, the command prints a JSON receipt (`outputFile`, `bytes`, `sha256`) instead of the report: show it as printed.
