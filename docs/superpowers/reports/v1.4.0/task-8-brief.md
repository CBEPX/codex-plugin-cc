### Task 8: Перенос отложенных minor из леджера v1.3.0

**Files:** `tests/model-catalog.test.mjs` + `tests/fixtures/models-catalog.json`; `tests/state.test.mjs`; `tests/runtime.test.mjs`; `plugins/codex/scripts/codex-companion.mjs` (`handleSetup`, gate-флаги); `plugins/codex/scripts/stop-review-gate-hook.mjs` (`getMaxRounds`); `plugins/codex/scripts/lib/process.mjs` (`workerCommandLine`, ps-ветка); `plugins/codex/scripts/lib/broker-lifecycle.mjs` (enum причины); `tests/broker-stale-pid.test.mjs` (комментарии, `t.after`); README (transfer-предложение).

Один PR, пункты независимы:
- [ ] catalogue-only запись в fixture (`gpt-7-nova`, `priority: 0`) + tie по `priority` между двумя семействами → тест, что алиас `nova` резолвится **только** через каталог (в `FALLBACK_ALIASES` его нет), tie → новейшее семейство.
- [ ] refusal-тест: `fs.chmodSync(shared, 0o755)` явно; foreign-uid ветка: `uid: process.getuid() + 1` → refusal.
- [ ] `CODEX_REVIEW_GATE_MAX_ROUNDS=0` → без предела (4 блокировки подряд), `=5` → пятая блокирует, шестая allow; `Number.isInteger(parsed) && parsed >= 0`, иначе default 3 + stderr-предупреждение.
- [ ] `--review-gate-model ""`/`--review-gate-effort ""` → ошибка «use inherit to clear», ничего не пишется.
- [ ] `kill-failed` добавить в документированный enum причин (`process.mjs` JSDoc + README-таблица).
- [ ] `workerCommandLine(jobId)` — `escapeRegExp(jobId)` (строго сужает matching; id генерируются). **Не в v1.4.0**: guard `timeoutMs > 0` в ps-ветке `processCommandLine` — меняет matching kill-путей (вызовы без timeout стали бы возвращать `null`) → v1.4.1.
- [ ] `tests/runtime.test.mjs` G1-тест (SIGTERM-immune worker) — `t.after(() => { try { process.kill(-workerPid, "SIGKILL"); } catch {} })`; заголовки fresh-broker тестов — «killed as a process group».
- [ ] README transfer: одно предложение про `~/.claude/projects` / `$CLAUDE_CONFIG_DIR/projects`; комментарий в `codex.mjs` `registerThread` о single-tenant допущении broker.
- [ ] Гейт; commit `chore: fold in deferred v1.3.0 review minors`.

---

