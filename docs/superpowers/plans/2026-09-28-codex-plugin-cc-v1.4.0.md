# codex-plugin-cc v1.4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать Windows-джоб CI обязательным, дать репозиторию тулинг уровня cc-plugin-codex (lint/typecheck/coverage/mutation/dependabot/SECURITY/changelog-gate), закрыть мелкие Windows-баги без изменения kill-семантики и перенести отложенные minor из v1.3.0.

**Architecture:** Никаких новых runtime-зависимостей. Конфиги копируются из `/Users/g.mehrenin/project/personal/cc-plugin-codex` с заменой путей `hooks/**`,`scripts/**` → `plugins/codex/scripts/**`. Общее чтение stdin для хуков выносится в один модуль `plugins/codex/scripts/lib/hook-input.mjs`. На win32 spawn через `$SHELL` заменяется: `taskkill.exe`/`powershell.exe`/`where.exe` — `shell:false`; `codex`/`npm`/`node` — резолв через `where.exe`, `.cmd`/`.bat` → `cmd.exe /d /s /c`, `.exe` → напрямую. Process identity на Windows **не** трогается (v1.4.1).

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test`, eslint 10 flat config, tsc `checkJs`, c8, Stryker 9 (command runner), GitHub Actions.

**Spec:** `/Users/g.mehrenin/.claude/plans/glistening-chasing-backus.md`, раздел «v1.4.0 (пересмотр после v1.3.0)»; `docs/superpowers/triage/2026-09-27-ci-matrix-findings.md`; леджер `docs/superpowers/reports/v1.3.0/sdd-ledger.md` (строки `minor (deferred`/`parked`).

## Global Constraints

- Worktree `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.0`, ветка `release/v1.4.0` от `main` (f6f3db5). `main` = установленный `codex@cbepx` 1.3.0 — не трогать.
- Гейт на задачу: `npm test > /tmp/npm-test.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test.log; test "$st" -eq 0` → `fail 0` (314 на базе); `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0; `npm run build`. С Task 3 добавляются `npm run lint`, `npm run typecheck`, `npm run typecheck:tests`, и `npm run check` становится единым гейтом.
- Только `rg`, никаких `git add -A`, не пушить без команды. Трейлер `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; портированные upstream-PR — `Co-authored-by: <author> <login@users.noreply.github.com>`.
- Windows нельзя проверить локально: задачи 1–2 доказываются CI-матрицей (push ветки `release/v1.4.0` — с разрешения пользователя); реальные Windows-проверки Task 5 и Task 6 — тоже только CI.
- Kill-семантика (`terminateRecordedProcess`, `ownsBrokerProcess` на win32, отказы без identity) в этом релизе не меняется.

## Review Focus

1. Windows-путь в тексте задачи через `--args-stdin` (`C:\Users\x\proj`) доходит до Codex без потери `\` (Task 4).
2. `taskkill.exe` на Windows вызывается без `$SHELL`, поэтому `/PID` не превращается в путь (Task 5; проверяется unit-тестом на аргументы и CI).
3. Stop-hook с выключенным gate завершается за ≤2 s, даже если stdin никогда не закрывается (Task 6).
4. `npm test` на Windows под node 18 находит тесты (каталог вместо glob) (Task 1).
5. Один SHA гоняется одним прогоном матрицы, а не двумя (Task 2).

---

### Task 1: Windows-обвязка тестов (класс A) — тесты, а не продукт

**Files:**
- Create: `.gitattributes` (`* text=auto eol=lf`)
- Modify: `package.json` (`test`), `tests/test-env.mjs`, `tests/helpers.mjs`, `tests/runtime.test.mjs`, `tests/state.test.mjs`, `tests/broker-endpoint.test.mjs`, `tests/broker-idle-timeout.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/app-server.test.mjs`, `tests/commands.test.mjs`

**Interfaces:** новый helper в `tests/helpers.mjs`: `export const IS_WIN = process.platform === "win32";` и `export function homeEnv(home) { return { HOME: home, USERPROFILE: home }; }`. Тесты, зависящие от POSIX-семантики, получают `{ skip: IS_WIN }`.

- [ ] **Step 1**: `.gitattributes` с `* text=auto eol=lf`; `git add --renormalize .` не нужен (репо уже LF). Единого вызова `node --test` для Node 18/22/24 и Windows нет (проверено локально на Node 24: `node --test tests/` не принимает каталог — «tests» падает как один тест; Node 18 не раскрывает glob, cmd.exe тоже). Поэтому `scripts/run-tests.mjs` (≈10 строк): `readdirSync("tests")` → файлы `*.test.mjs` → `spawnSync(process.execPath, ["--import", "./tests/test-env.mjs", "--test", ...files, ...process.argv.slice(2)], { stdio: "inherit" })` → `process.exit(status ?? 1)`; `package.json`: `"test": "node scripts/run-tests.mjs"`. Все остальные скрипты (`test:coverage`, `test:mutation:*:unit`) используют тот же раннер или явные списки файлов; шаблон `tests/*.test.mjs` в них не оставлять.
- [ ] **Step 2**: `tests/test-env.mjs` — `import { fileURLToPath } from "node:url"; process.env.CODEX_COMPANION_MODEL_CATALOG = fileURLToPath(new URL("./fixtures/models-catalog.json", import.meta.url));`.
- [ ] **Step 3**: `tests/commands.test.mjs` — 5 regex с `\n` заменить на `\r?\n` (или нормализовать `read()` через `.replace(/\r\n/g, "\n")` — один хелпер, предпочтительно).
- [ ] **Step 4**: `tests/runtime.test.mjs`: transfer-тесты (~252, 297, 327, 353) → `...homeEnv(home)`; тест `setup is ready without npm…` (~85) → `PATH: [binDir, path.dirname(process.execPath)].join(path.delimiter)`; mode-assert'ы (~3314) и `tests/state.test.mjs` (~141, 696, 864) → внутрь `if (!IS_WIN)` или `{ skip: IS_WIN }` на тесте целиком, если mode — суть теста.
- [ ] **Step 5**: `tests/broker-endpoint.test.mjs:6` — тест уже передаёт `"darwin"` явно; падал из-за `path.join` на win32 → использовать `path.posix.join` в ожидании или `{ skip: IS_WIN }`. Сигнальные тесты (`app-server.test.mjs` close()×2, `broker-idle-timeout.test.mjs` ~365/386, `broker-stale-pid.test.mjs` ~443/~480): на win32 `signalCode` = `null`, `exitCode` = `1` после `taskkill`; обернуть ожидания `IS_WIN ? … : …` либо `{ skip: IS_WIN }` с комментарием, какой инвариант теряется. Тестовые `process.kill(pid)` на уже мёртвый pid — в `try/catch` (`ESRCH`).
- [ ] **Step 6**: `tests/state.test.mjs` «concurrent writers never leave a torn state.json» (~160–175): длинный `-e` скрипт → записать во временный файл (`makeTempDir()` + `fs.writeFileSync`) и `spawn(process.execPath, [file, …])` (node 24 на Windows: `spawn ENAMETOOLONG` роняет прогон).
- [ ] **Step 7**: гейт; commit `test: make the suite runnable on Windows (LF, directory discovery, env/mode/signal expectations)`.

---

### Task 2: CI hardening и обязательный Windows

**Files:** `.github/workflows/pull-request-ci.yml`, `.github/workflows/release-verify.yml`, `plugins/codex/scripts/session-lifecycle-hook.mjs` (`BROKER_BUSY_RETRY_MS`), `tests/broker-stale-pid.test.mjs`, `tests/commands.test.mjs`.

- [ ] **Step 1**: `pull-request-ci.yml`: `on.push.branches: [main, "release/**"]` (ветки `ci/**` убрать), `concurrency: { group: ci-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`; `continue-on-error` для Windows **остаётся** до зелёного прогона Task 1 на CI, затем снимается отдельным коммитом в этой же задаче.
- [ ] **Step 2**: `BROKER_BUSY_RETRY_MS` 1000 → 3000 (внутри 12 s: handshake ≤2 s + retry 3 s + teardown ≤2 s); `tests/commands.test.mjs` тест «SessionEnd hook timeout stays above the hook's own budget» — проверить, что арифметика в нём не захардкожена на 1 s. Тест «session end reaps a SIGKILLed background worker…» (`broker-stale-pid.test.mjs` ~443): перед вызовом хука дождаться, что broker больше не считает worker подключённым (`sendBrokerShutdown` не нужен — достаточно `waitFor(() => !isAlive(workerPid))` + короткий `setTimeout(200)`), чтобы тест проверял reaping, а не гонку закрытия сокета.
- [ ] **Step 3**: `release-verify.yml` — та же матрица `{ubuntu, macos, windows} × {18, 22, 24}` через `strategy.matrix`, шаги как в PR CI + `npm audit --omit=dev`, `npm pack --dry-run`.
- [ ] **Step 4**: после push (по команде пользователя) и зелёной матрицы: снять `continue-on-error`, оставить Windows required. Commit `ci: dedupe runs per SHA, widen broker busy-retry, make Windows required`.

---

### Task 3: Тулинг

**Files:** Create `eslint.config.mjs`, `tsconfig.json`, `tsconfig.tests.json`, `.githooks/pre-commit`, `scripts/setup-git-hooks.mjs`, `scripts/check-changelog.mjs`, `scripts/lib/changelog.mjs`, `.github/dependabot.yml`, `SECURITY.md`, `stryker.config.mjs`, `.github/workflows/mutation.yml`; Modify `package.json`, `.gitignore` (`reports/`, `.stryker-tmp/`), `tests/bump-version.test.mjs` (или новый `tests/changelog.test.mjs`).

**Interfaces:** скрипты `lint`, `typecheck`, `typecheck:tests`, `check:changelog`, `test:coverage`, `test:mutation:critical`, `test:mutation:critical:unit`, `setup:git-hooks`, `check` = `check-version && check:changelog && lint && typecheck && typecheck:tests && test`. `prepack`: `check-version && check:changelog`.

- [ ] **Step 1**: скопировать `eslint.config.mjs` из cc-plugin-codex (ignores + `plugins/codex/.generated/**`, `.worktrees/**`, `docs/**`); `tsconfig.json`: `include: ["plugins/codex/scripts/**/*.mjs"]`, `exclude: ["node_modules", "tests", ".worktrees"]`, остальное как в референсе; `tsconfig.tests.json` включает `tests/**/*.mjs`. Существующий `tsconfig.app-server.json` (`npm run build`) не трогать.
- [ ] **Step 2**: devDependencies: `eslint`, `@eslint/js`, `globals`, `c8`, `@stryker-mutator/core` — версии как в референсе (`^10.2.0`, `^10.0.1`, `^17.5.0`, `12.0.0`, `^9.6.1`); `npm install` → `package-lock.json`; `npm run lint` и `npm run typecheck` должны пройти — правки кода только там, где eslint/tsc реально ругаются (ожидаемо: JSDoc-типы в `codex.mjs`/`state.mjs` под `checkJs`; исправлять минимально, `// @ts-ignore` не использовать без комментария почему).
- [ ] **Step 3**: `scripts/check-changelog.mjs` + `scripts/lib/changelog.mjs` (копия референса; заголовок формата `## 1.3.0 — 2026-09-27`, поэтому regex: `^##\s+v?${version}(\s|$)`), плюс проверка `CHANGELOG.md` и `plugins/codex/CHANGELOG.md` побайтно равны — иначе `exit 1` с подсказкой `cp CHANGELOG.md plugins/codex/CHANGELOG.md`. Тест: временный репо с рассинхроном → падает; с секцией без bullet → падает.
- [ ] **Step 4**: c8: `"test:coverage": "c8 --all --include='plugins/codex/scripts/**/*.mjs' --exclude='plugins/codex/.generated/**' --reporter=text --reporter=json-summary --reporter=lcov --reports-dir=reports/coverage --check-coverage --lines=<факт-2> --statements=<факт-2> --branches=<факт-2> --functions=<факт-2> node --import ./tests/test-env.mjs --test tests/"` — пороги = измеренное значение минус 2 пункта, записать фактические числа в отчёт задачи; цель 85/75/90 — в README как ориентир, не в гейте.
- [ ] **Step 5**: Stryker только critical: `stryker.config.mjs` с `mutate: ["plugins/codex/scripts/lib/args.mjs", "plugins/codex/scripts/lib/model-catalog.mjs"]`, `commandRunner: npm run test:mutation:critical:unit` (= `node --import ./tests/test-env.mjs --test tests/args.test.mjs tests/model-catalog.test.mjs`), thresholds 80/55/55; `mutation.yml` — `workflow_dispatch` + `schedule` (воскресенье 03:00 UTC), без pull_request (не удлинять PR CI). Запустить локально один раз, записать score в отчёт.
- [ ] **Step 6**: `.githooks/pre-commit` (lint + typecheck), `scripts/setup-git-hooks.mjs`, `.github/dependabot.yml` (копии), `SECURITY.md` (Supported: latest release; Reporting: GitHub Security Advisories для `CBEPX/codex-plugin-cc`; без email). README: раздел «Development» с `npm run check`, `npm run setup:git-hooks`.
- [ ] **Step 7**: `pull-request-ci.yml`: шаги `npm run lint`, `typecheck`, `typecheck:tests`, `check:changelog` перед тестами; coverage-артефакт на ubuntu/node 22. Гейт; commit `chore: lint, typecheck, coverage, mutation (critical), dependabot, SECURITY.md, changelog gate`.

---

### Task 4: `--args-stdin` не съедает обратные слэши Windows-путей

**Files:** `plugins/codex/scripts/lib/args.mjs` (`splitRawArgumentString`), `tests/args.test.mjs`, README (раздел про `--args-stdin`).

- [ ] **Step 1: failing tests**
```js
test("splitRawArgumentString keeps Windows path backslashes that escape nothing", () => {
  assert.deepEqual(splitRawArgumentString("investigate C:\\Users\\me\\proj\\file.mjs"), ["investigate", "C:\\Users\\me\\proj\\file.mjs"]);
  assert.deepEqual(splitRawArgumentString('say \\"quoted\\" and a\\ b and back\\\\slash'), ["say", "\"quoted\"", "and", "a b", "and", "back\\slash"]);
  assert.deepEqual(splitRawArgumentString("'C:\\dir\\x' \"D:\\y\""), ["C:\\dir\\x", "D:\\y"]);
});
```
- [ ] **Step 2: implement** — `\` экранирует только следующий символ из набора `"`, `'`, `\`, пробел/таб (вне кавычек) и `"`/`\` внутри двойных кавычек; в остальных случаях `\` — литерал:
```js
    if (character === "\\") {
      const next = raw[index + 1];
      const escapable = quote === "'" ? false : quote === "\"" ? next === "\"" || next === "\\" : next === "\"" || next === "'" || next === "\\" || /\s/.test(next ?? "");
      if (escapable) { escaping = true; continue; }
      current += "\\";
      continue;
    }
```
(цикл переписать на `for (let index = 0; index < raw.length; index += 1)`; хвостовое `if (escaping) current += "\\"` остаётся). Существующие тесты `args.test.mjs` и runtime-тест «task --args-stdin keeps shell metacharacters…» должны пройти без изменений.
- [ ] **Step 3**: README — одно предложение: обратный слэш в тексте задачи сохраняется, если за ним не идёт кавычка, пробел или ещё один `\`. Гейт; commit `fix(args): keep Windows path backslashes in --args-stdin text`.

---

### Task 5: Windows spawn без `$SHELL`

**Files:** `plugins/codex/scripts/lib/process.mjs` (`runCommand`, `binaryAvailable`, `terminateProcessTree` win32), `plugins/codex/scripts/lib/app-server.mjs` (`spawn("codex", …)`), `plugins/codex/scripts/lib/broker-lifecycle.mjs` (`spawnBrokerProcess`: `windowsHide: true`), `tests/process.test.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`.

**Interfaces:**
- `resolveExecutable(command, { platform, env, runCommandImpl })` в `process.mjs`: posix → `command` как есть; win32 → `where.exe <command>` (`shell:false`, timeout 5 s), первая строка результата; `null` если не найдено.
- `spawnOptionsFor(resolvedPath, platform)` → `{ file, args, shell }`: `.cmd`/`.bat` → `{ file: "cmd.exe", argsPrefix: ["/d", "/s", "/c", resolvedPath], shell: false }` (аргументы передаются как есть; `cmd.exe /c` с явным путём не подвержен MSYS-мангline), иначе `{ file: resolvedPath, shell: false }`.
- `runCommand` по умолчанию `shell: false` на всех платформах; на win32 `command` без пути резолвится через `resolveExecutable` (кэш на процесс). Совместимость: если `where.exe` не нашёл — `ENOENT` как сегодня.

- [ ] **Step 1: unit tests** (инъекция `runCommandImpl`/`platform`): `terminateProcessTree(1234, {platform:"win32"})` вызывает `taskkill.exe` с `shell:false` (проверить переданные options через шпион-`runCommandImpl`); `resolveExecutable("codex", {platform:"win32", runCommandImpl: () => ({status:0, stdout:"C:\\npm\\codex.cmd\r\n"})})` → `.cmd` → `cmd.exe /d /s /c C:\npm\codex.cmd`; `.exe` → напрямую; ENOENT → `binaryAvailable` → `{available:false, detail:"not found"}`.
- [ ] **Step 2: implement** в `process.mjs`; `app-server.mjs:245`: `spawn(file, [...argsPrefix, "app-server"], { shell: false, windowsHide: true, … })` через `spawnOptionsFor(resolveExecutable("codex"))`; комментарий на строке ~283 про cmd.exe-дерево обновить (дерево теперь `cmd.exe → node`, `terminateProcessTree(this.proc.pid)` по-прежнему бьёт по дереву через `taskkill /T` на живом handle — допустимое исключение). `spawnBrokerProcess`: `windowsHide: true`.
- [ ] **Step 3: fixtures** — `tests/fake-codex-fixture.mjs` `installFakeCodex`: на win32 дополнительно писать `codex.cmd` (`@echo off\r\nnode "%~dp0codex.mjs" %*`) и класть JS в `codex.mjs`; на posix — как сейчас. `tests/helpers.mjs` `run()` — `shell` только для `.cmd` целей (или оставить как есть: тесты запускают `node`/`git` абсолютно/через PATH — проверить).
- [ ] **Step 4**: гейт локально (posix не меняется по поведению); Windows — CI. Commit `fix(windows): spawn without $SHELL — where.exe resolution, cmd.exe for .cmd shims, taskkill/powershell direct` с `Co-authored-by: mohammad-malik <mohammad-malik@users.noreply.github.com>` (#735) и `Co-authored-by: mittalpk <mittalpk@users.noreply.github.com>` (#669).

---

### Task 6: Чтение stdin в хуках — дедлайн, EAGAIN, лимит

**Files:** Create `plugins/codex/scripts/lib/hook-input.mjs`; Modify `plugins/codex/scripts/session-lifecycle-hook.mjs`, `plugins/codex/scripts/stop-review-gate-hook.mjs` (`main` → async), `plugins/codex/scripts/lib/fs.mjs` (`readStdinIfPiped` — EAGAIN retry), `tests/runtime.test.mjs`, новый `tests/hook-input.test.mjs`.

**Interfaces:** `export async function readHookInput({ timeoutMs = 2000, maxBytes = 1024 * 1024, stdin = process.stdin } = {})` → `{ input: object, truncated: boolean, timedOut: boolean }`; пустой stdin → `{}`; невалидный JSON → **throws** (stop-gate оставляет fail-closed на этом; session-hook ловит и идёт fail-open с stderr-строкой); `timedOut` → `{}` (Windows: stdin без EOF, #530). `readStdinIfPiped` (companion) — синхронный `readSync` в цикле с повтором на `EAGAIN` (до 50 × 20 ms), затем как сейчас.

- [ ] **Step 1: tests** — `hook-input.test.mjs`: (a) JSON приходит частями через `PassThrough` → собран; (b) stdin без `end` → через 200 ms `timedOut:true, input:{}`; (c) >maxBytes → `truncated:true` и throw на parse; (d) `{not-json` → throw. `runtime.test.mjs`: stop-hook с выключенным gate и `input` = открытый pipe без EOF (spawn с `stdio: ["pipe"]`, не закрывать stdin) завершается за <3 s с exit 0 и `CODEX_HOOK_STDIN_TIMEOUT_MS=200`.
- [ ] **Step 2: implement** — `hook-input.mjs` на событиях `data`/`end`/`error` с `setTimeout`; env `CODEX_HOOK_STDIN_TIMEOUT_MS` для тестов. Оба хука: `const { input } = await readHookInput()`; в stop-hook `main()` становится `async`, верхний `try/catch` — `await main()`. `fs.mjs`: EAGAIN-цикл.
- [ ] **Step 3**: гейт; commit `fix(hooks): bounded stdin read with EAGAIN retry and size cap` с `Co-authored-by: stantheman0128 <stantheman0128@users.noreply.github.com>` (#544), `Co-authored-by: tmchow <tmchow@users.noreply.github.com>` (#123).

---

### Task 7: Fallback state root на Windows → `%LOCALAPPDATA%`

**Files:** `plugins/codex/scripts/lib/state.mjs` (`resolveFallbackStateRoot`), `tests/state.test.mjs`, CHANGELOG.

- [ ] **Step 1: test** — `resolveFallbackStateRoot({ env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, platform: "win32", tmpdir: "C:\\Temp", pluginRoot })` → начинается с `C:\Users\me\AppData\Local\codex-companion\`; без `LOCALAPPDATA` → `tmpdir`. (Добавить параметр `platform` в опции; `mkdirSync` в тесте на posix создаст каталог — использовать `makeTempDir()` как `LOCALAPPDATA`.)
- [ ] **Step 2: implement** — `const base = platform === "win32" && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "codex-companion") : path.join(tmpdir, \`codex-companion-${uid ?? "user"}\`)`; остальное без изменений. Гейт; commit `fix(state): per-user fallback state root under %LOCALAPPDATA% on Windows`.

---

### Task 8: Перенос отложенных minor из леджера v1.3.0

**Files:** `tests/model-catalog.test.mjs` + `tests/fixtures/models-catalog.json`; `tests/state.test.mjs`; `tests/runtime.test.mjs`; `plugins/codex/scripts/codex-companion.mjs` (`handleSetup`, gate-флаги); `plugins/codex/scripts/stop-review-gate-hook.mjs` (`getMaxRounds`); `plugins/codex/scripts/lib/process.mjs` (`workerCommandLine`, ps-ветка); `plugins/codex/scripts/lib/broker-lifecycle.mjs` (enum причины); `tests/broker-stale-pid.test.mjs` (комментарии, `t.after`); README (transfer-предложение).

Один PR, пункты независимы:
- [ ] catalogue-only запись в fixture (`gpt-7-nova`, `priority: 0`) + tie по `priority` между двумя семействами → тест, что алиас `nova` резолвится **только** через каталог (в `FALLBACK_ALIASES` его нет), tie → новейшее семейство.
- [ ] refusal-тест: `fs.chmodSync(shared, 0o755)` явно; foreign-uid ветка: `uid: process.getuid() + 1` → refusal.
- [ ] `CODEX_REVIEW_GATE_MAX_ROUNDS=0` → без предела (4 блокировки подряд), `=5` → пятая блокирует, шестая allow; `Number.isInteger(parsed) && parsed >= 0`, иначе default 3 + stderr-предупреждение.
- [ ] `--review-gate-model ""`/`--review-gate-effort ""` → ошибка «use inherit to clear», ничего не пишется.
- [ ] `teardownBrokerSession` catch → `reason: "kill-failed"` заменить на `"identity-unavailable"`? Нет — оставить `kill-failed`, но добавить в документированный enum (`process.mjs` JSDoc + README-таблица причин).
- [ ] `workerCommandLine(jobId)` — `escapeRegExp(jobId)`; ps-ветка `processCommandLine` — `if (!(timeoutMs > 0)) return null` как в `getProcessIdentity`.
- [ ] `tests/runtime.test.mjs` G1-тест (SIGTERM-immune worker) — `t.after(() => { try { process.kill(-workerPid, "SIGKILL"); } catch {} })`; заголовки fresh-broker тестов — «killed as a process group».
- [ ] README transfer: одно предложение про `~/.claude/projects` / `$CLAUDE_CONFIG_DIR/projects`; комментарий в `codex.mjs` `registerThread` о single-tenant допущении broker.
- [ ] Гейт; commit `chore: fold in deferred v1.3.0 review minors`.

---

### Task 9: Документация

**Files:** `README.md`, `CHANGELOG.md` + `plugins/codex/CHANGELOG.md`.

- [ ] README: убрать `<video src="./docs/plugin-demo.webm">`; раздел «Windows»: что работает (команды, review, task, transfer), что ограничено до v1.4.1 (kill из сохранённых записей), требования (`where.exe`, `cmd.exe`, PowerShell 5.1 не нужен в v1.4.0), Git Bash больше не участвует в spawn; раздел «Development» (`npm run check`, `setup:git-hooks`, coverage/mutation). CHANGELOG `## 1.4.0 — <дата>`: Added/Changed/Fixed по задачам, с upstream-номерами (#525 #647 #656 #669 #708 #287 #409 #735; #440 #451; #530 #544; #120 #247 #123 #150 #165; #326).
- [ ] `tests/commands.test.mjs` README-assertions зелёные; гейт; commit `docs: Windows support notes, development section, 1.4.0 changelog`.

---

### Task 10: Release v1.4.0

- [ ] `node scripts/bump-version.mjs 1.4.0 && npm run check-version && npm run check:changelog`.
- [ ] Полный `npm run check` + leak-check + `claude plugin validate . --strict` + `npm audit --omit=dev` + `npm pack --dry-run`.
- [ ] Claude whole-branch review; `/codex:adversarial-review --base main --effort max` с фокусом на Task 5 (spawn) и Task 6 (stdin) — DO-NOT-SHIP блокирует.
- [ ] По команде пользователя: push, PR → зелёная матрица с обязательным Windows → `gh pr merge --merge` → tag → `npm pack` + sha256 → `gh release create` (`docs/RELEASING.md`) → `claude plugin update codex@cbepx`.
- [ ] Черновик `docs/superpowers/triage/upstream-comments-v1.4.0.md` → одобрение → `gh issue comment`; статусы в триаж-документе → `fixed-in v1.4.0`.

## Self-review

- Spec coverage: пункты 1–6 раздела v1.4.0 спека → Task 1–2 (п.1–2), Task 3 (п.3), Task 4–7 (п.4), Task 8 (п.5), Task 9–10 (п.6). v1.4.1 (identity) намеренно вне плана.
- Placeholder scan: пороги c8 «факт-2» и mutation score определяются измерением в Task 3 и записываются в отчёт — это не TBD, а правило.
- Type consistency: `readHookInput` → `{input, truncated, timedOut}` в обоих хуках; `resolveExecutable`/`spawnOptionsFor` используются и в `runCommand`, и в `app-server.mjs`.
- Review Focus 1–5 → Task 4, 5, 6, 1, 2 соответственно.
