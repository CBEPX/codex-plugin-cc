### Task 9: Документация

**Files:** `README.md`, `CHANGELOG.md` + `plugins/codex/CHANGELOG.md`.

- [ ] README: убрать `<video src="./docs/plugin-demo.webm">`; раздел «Windows»: что работает (команды, review, task, transfer), что ограничено до v1.4.1 (kill из сохранённых записей), требования (`where.exe`, `cmd.exe`, PowerShell 5.1 не нужен в v1.4.0), Git Bash больше не участвует в spawn; раздел «Development» (`npm run check`, `setup:git-hooks`, coverage/mutation). CHANGELOG `## 1.4.0 — <дата>`: Added/Changed/Fixed по задачам, с upstream-номерами (#525 #647 #656 #669 #708 #287 #409 #735; #440 #451; #530 #544; #120 #247 #123 #150 #165; #326).
- [ ] `tests/commands.test.mjs` README-assertions зелёные; гейт; commit `docs: Windows support notes, development section, 1.4.0 changelog`.

---


- Task 7 follow-up for CHANGELOG: the %LOCALAPPDATA% transitional notice only applies to unversioned/dev installs (state-root hash derives from CLAUDE_PLUGIN_ROOT, which includes the plugin version in the marketplace cache).
