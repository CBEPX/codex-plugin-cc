---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all] [--output <new-path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the Codex status command with the Bash tool (the `allowed-tools` frontmatter above permits it), then format the output as described below:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status --args-stdin <<'CODEX_ARGS'
$ARGUMENTS
CODEX_ARGS
```

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

If the output ends with a `Truncated:` line, keep that line and the next-step line after it as printed, below the table or the output. Do not re-run the command on your own.

If the arguments include `--output`, the command prints a JSON receipt (`outputFile`, `bytes`, `sha256`) instead of the report: show it as printed.
