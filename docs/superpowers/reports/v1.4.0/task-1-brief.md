### Task 1: Windows-обвязка тестов (класс A) — тесты, а не продукт

**Files:**
- Create: `.gitattributes` (`* text=auto eol=lf`), `scripts/run-tests.mjs`
- Modify: `package.json` (`test`, `prebuild`), `tests/test-env.mjs`, `tests/helpers.mjs`, `tests/runtime.test.mjs`, `tests/state.test.mjs`, `tests/broker-endpoint.test.mjs`, `tests/broker-idle-timeout.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/app-server.test.mjs`, `tests/commands.test.mjs`

**Interfaces:** `tests/helpers.mjs`: `export const IS_WIN = process.platform === "win32";`, `export function homeEnv(home) { return { HOME: home, USERPROFILE: home }; }`; `run()` — `shell:false` для `node`/`git` (в тестах `run("node", …)` → `run(process.execPath, …)`), `shell` только там, где цель — `.cmd`. Тесты POSIX-семантики (mode-биты, unix socket, отрицательные pid, `pgrep`, graceful-signal сценарии, «неубиваемый ребёнок» в `app-server.test.mjs:145–154`) получают `{ skip: IS_WIN }` с комментарием, какой инвариант на Windows не моделируется; **замена ожиданий на другие exit-коды запрещена**.

- [ ] **Step 0 (инвентарь)**: spike-список относится к v1.2.1; после Task 2 (по команде пользователя — push ветки, `workflow_dispatch`) снять актуальный список падений Windows на текущем SHA и записать в отчёт задачи; класс A ниже — ожидаемое, не исчерпывающее.
- [ ] **Step 1**: `.gitattributes`; единого вызова `node --test` для Node 18/22/24 и Windows нет (проверено локально на Node 24: `node --test tests/` → `ERR_UNSUPPORTED_DIR_IMPORT`; на Node 18 каталог сработал бы, но подхватил бы и `tests/test-env.mjs` по шаблону `test-*`; cmd.exe не раскрывает glob). Поэтому `scripts/run-tests.mjs` (≈10 строк): `readdirSync("tests")` → `*.test.mjs` → `spawnSync(process.execPath, ["--import", "./tests/test-env.mjs", "--test", ...files, ...process.argv.slice(2)], { stdio: "inherit" })` → `process.exit(status ?? 1)`; `package.json`: `"test": "node scripts/run-tests.mjs"`; остальные test-скрипты — явные списки файлов. `prebuild`: `mkdir -p` → `node -e "require('fs').mkdirSync('plugins/codex/.generated/app-server-types',{recursive:true})"`.
- [ ] **Step 2**: `tests/test-env.mjs` — `fileURLToPath(new URL("./fixtures/models-catalog.json", import.meta.url))`.
- [ ] **Step 3**: `tests/commands.test.mjs` — один хелпер `read()` нормализует `\r\n` → `\n`.
- [ ] **Step 4**: `tests/runtime.test.mjs`: transfer-тесты (~252, 297, 327, 353) → `...homeEnv(home)`; тест «setup is ready without npm…» (~76–94) — на win32 `{ skip: IS_WIN }` (изолировать `node.exe` без `npm` переносимо нельзя; добавление каталога Node в PATH вернуло бы npm и обессмыслило тест); mode-assert'ы (~3314) и `tests/state.test.mjs` (~141, 696, 864) под `if (!IS_WIN)`.
- [ ] **Step 5**: `tests/broker-endpoint.test.mjs:6` — ожидание строить через `path.join` хоста (`"unix:" + path.join(dir, "broker.sock")`), не `path.posix`; сигнальные тесты: `app-server.test.mjs` close()×2 — `{ skip: IS_WIN }` (сценарий «SIGTERM-immune child» на Windows не моделируется), `broker-idle-timeout.test.mjs` (~365/386, ~395–446: `pgrep`, graceful SIGTERM) и `broker-stale-pid.test.mjs` (~443/~483: отрицательные pid) — классифицировать каждый: posix-only → skip; платформенно-нейтральный → оставить. Тестовые `process.kill` на мёртвый pid — `try/catch`.
- [ ] **Step 6**: `tests/state.test.mjs` «concurrent writers…» (~160–184, >100 KiB JSON в `-e`) → временный `.mjs` файл + проверка `spawn` error и exit status writer'а.
- [ ] **Step 7**: Windows-ожидания для `cancel`: тест «cancelling an awaited job…» (~3668) на win32 принимает `cancellationPending` + exit 1 (документированный отказ v1.3.0), код не ослабляется.
- [ ] **Step 8**: гейт; commit `test: make the suite runnable on Windows (LF, explicit runner, env/mode/signal expectations)`.

---

