### Task 2: CI hardening; Windows обязательный — в конце релиза

**Files:** `.github/workflows/pull-request-ci.yml`, `.github/workflows/release-verify.yml`, `plugins/codex/scripts/session-lifecycle-hook.mjs` (`BROKER_BUSY_RETRY_MS`), `plugins/codex/scripts/app-server-broker.mjs` (одна строка лога при закрытии клиентского сокета, если её нет), `tests/broker-stale-pid.test.mjs`, `tests/commands.test.mjs`.

- [ ] **Step 1**: `pull-request-ci.yml`: `on: { pull_request, push: { branches: [main] }, workflow_dispatch }` — release-ветки до PR проверяются через `workflow_dispatch`, так один SHA гоняется одним событием; `concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`. Матрица runtime-тестов `{ubuntu, macos, windows} × {18, 22, 24}`; отдельный job `quality` на ubuntu/node 24 (lint, build/typecheck, typecheck:tests, check:changelog, coverage-артефакт — наполняется в Task 3). `continue-on-error` для Windows **остаётся** до Task 9.
- [ ] **Step 2**: `BROKER_BUSY_RETRY_MS` 1000 → 3000 — увеличение окна ожидания ответа `busy:false`; инвариант «teardown только после подтверждённого idle» не меняется; бюджет: handshake bound 5 s (`session-lifecycle-hook.mjs:40`, зажат `stepBudget`) + retry 3 s + teardown ≤2 s ≤ 12 s. Тест «session end reaps a SIGKILLed background worker…» (~443): к существующему `waitFor(!isAlive)` добавить `waitFor(() => brokerLog.includes("client disconnected"))` по `broker.log` (если broker такой строки не пишет — добавить одну в `app-server-broker.mjs` на `close` сокета). Никаких фиксированных `sleep`.
- [ ] **Step 3**: `release-verify.yml` — та же матрица + quality job + `npm audit --omit=dev`, `npm pack --dry-run`.
- [ ] **Step 4**: commit `ci: one run per SHA, quality job on node 24, wider broker busy-retry`. Снятие `continue-on-error` — Task 9, после полного зелёного прогона с Task 4–6.

---

