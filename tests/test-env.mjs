// Hermetic test environment: strip host-session variables that Claude Code /
// the plugin's own SessionStart hook export, so tests see a clean machine.
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_PLUGIN_CC_ARGS"
]) {
  delete process.env[name];
}
