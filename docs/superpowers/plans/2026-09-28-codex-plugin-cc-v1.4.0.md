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
- Kill-семантика (`terminateRecordedProcess`, `ownsBrokerProcess` на win32, отказы без identity, `cancellationPending` при живом непроверяемом worker) в этом релизе не меняется; тесты на Windows принимают текущие отказы, а не ослабляют их.
- Tooling (eslint 10, Stryker 9, c8 12) требует Node ≥20 → lint/typecheck/coverage/mutation гоняются только на Node 24; runtime-тесты — на 18/22/24. `engines.node >=18.18.0` не меняется.
- Codex-ревью плана (thread `01a0e4e4-9afc-7f30-8355-af30403a3cc4`, 2026-09-28) учтено во всех задачах ниже; при исполнении Task 5 и Task 6 обязательный второй проход `/codex:rescue --effort xhigh` (read-only) по диффу до Claude-ревью.

## Review Focus

1. Windows-путь в тексте задачи через `--args-stdin` (`C:\Users\x\proj`) доходит до Codex без потери `\` (Task 4).
2. `taskkill.exe` на Windows вызывается без `$SHELL`, поэтому `/PID` не превращается в путь (Task 5; проверяется unit-тестом на аргументы и CI).
3. Stop-hook с выключенным gate завершается за ≤2 s, даже если stdin никогда не закрывается (Task 6).
4. `npm test` на Windows под node 18 находит тесты (каталог вместо glob) (Task 1).
5. Один SHA гоняется одним прогоном матрицы, а не двумя (Task 2).

---

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

### Task 2: CI hardening; Windows обязательный — в конце релиза

**Files:** `.github/workflows/pull-request-ci.yml`, `.github/workflows/release-verify.yml`, `plugins/codex/scripts/session-lifecycle-hook.mjs` (`BROKER_BUSY_RETRY_MS`), `plugins/codex/scripts/app-server-broker.mjs` (одна строка лога при закрытии клиентского сокета, если её нет), `tests/broker-stale-pid.test.mjs`, `tests/commands.test.mjs`.

- [ ] **Step 1**: `pull-request-ci.yml`: `on: { pull_request, push: { branches: [main] }, workflow_dispatch }` — release-ветки до PR проверяются через `workflow_dispatch`, так один SHA гоняется одним событием; `concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`. Матрица runtime-тестов `{ubuntu, macos, windows} × {18, 22, 24}`; отдельный job `quality` на ubuntu/node 24 (lint, build/typecheck, typecheck:tests, check:changelog, coverage-артефакт — наполняется в Task 3). `continue-on-error` для Windows **остаётся** до Task 9.
- [ ] **Step 2**: `BROKER_BUSY_RETRY_MS` 1000 → 3000 — увеличение окна ожидания ответа `busy:false`; инвариант «teardown только после подтверждённого idle» не меняется; бюджет: handshake bound 5 s (`session-lifecycle-hook.mjs:40`, зажат `stepBudget`) + retry 3 s + teardown ≤2 s ≤ 12 s. Тест «session end reaps a SIGKILLed background worker…» (~443): к существующему `waitFor(!isAlive)` добавить `waitFor(() => brokerLog.includes("client disconnected"))` по `broker.log` (если broker такой строки не пишет — добавить одну в `app-server-broker.mjs` на `close` сокета). Никаких фиксированных `sleep`.
- [ ] **Step 3**: `release-verify.yml` — та же матрица + quality job + `npm audit --omit=dev`, `npm pack --dry-run`.
- [ ] **Step 4**: commit `ci: one run per SHA, quality job on node 24, wider broker busy-retry`. Снятие `continue-on-error` — Task 9, после полного зелёного прогона с Task 4–6.

---

### Task 3: Тулинг (только Node 24)

**Files:** Create `eslint.config.mjs`, `tsconfig.tests.json`, `.githooks/pre-commit`, `scripts/setup-git-hooks.mjs`, `scripts/check-changelog.mjs`, `scripts/lib/changelog.mjs`, `.c8rc.json`, `.github/dependabot.yml`, `SECURITY.md`, `stryker.config.mjs`, `.github/workflows/mutation.yml`; Modify `package.json`, `.gitignore` (`reports/`, `.stryker-tmp/`), новый `tests/changelog.test.mjs`.

**Interfaces:** `lint`; `typecheck` = существующий `npm run build` (`tsconfig.app-server.json` уже `checkJs` против generated types — **не** переводить на NodeNext: extensionless JSDoc-импорты в `app-server.mjs:3–8`, `codex.mjs:2–9`); `typecheck:tests` (новый `tsconfig.tests.json`, `extends` app-server config, `include: ["tests/**/*.mjs", "scripts/**/*.mjs"]`); `check:changelog`; `test:coverage`; `test:mutation:critical`(+`:unit`); `setup:git-hooks`; `check` = `check-version && check:changelog && lint && build && typecheck:tests && test`. `prebuild` (генерация protocol types) остаётся и всегда предшествует typecheck.

- [ ] **Step 1**: `eslint.config.mjs` из референса + ignores `plugins/codex/.generated/**`, `.worktrees/**`, `docs/**`, `reports/**`; `tsconfig.tests.json`. devDependencies: `eslint ^10.2.0`, `@eslint/js ^10.0.1`, `globals ^17.5.0`, `c8 12.0.0`, `@stryker-mutator/core ^9.6.1`; `npm install`; lint/typecheck:tests зелёные с минимальными правками (только реальные находки; `// @ts-expect-error` с причиной, не `@ts-ignore`).
- [ ] **Step 2**: `scripts/check-changelog.mjs` + `scripts/lib/changelog.mjs` (регекс `^##\s+v?<version>(\s|$)` под формат `## 1.3.0 — 2026-09-27`) + побайтное равенство `CHANGELOG.md` и `plugins/codex/CHANGELOG.md`; `tests/changelog.test.mjs`: нет секции → fail; секция без bullet → fail; копии расходятся → fail с подсказкой `cp`.
- [ ] **Step 3**: coverage: globs в `.c8rc.json` (`include: ["plugins/codex/scripts/**/*.mjs", "scripts/**/*.mjs"]`, `exclude: ["plugins/codex/.generated/**"]`, `all: true`, reporters text/json-summary/lcov, `reports-dir: reports/coverage`), `"test:coverage": "c8 --check-coverage node scripts/run-tests.mjs"`. c8 передаёт `NODE_V8_COVERAGE` дочерним процессам, поэтому companion-подпроцессы покрытие дают; ограничения (в README/отчёт): SIGKILL/`taskkill /F` не оставляют dump, detached broker/worker может завершиться после отчёта, Windows-ветки на ubuntu не измеряются. Сначала подтвердить ненулевое покрытие `codex-companion.mjs` в отчёте, затем пороги = факт − 2 п.п. в `.c8rc.json`; ориентир 85/75/90 — в README.
- [ ] **Step 4**: Stryker critical: `mutate: ["plugins/codex/scripts/lib/args.mjs", "plugins/codex/scripts/lib/model-catalog.mjs"]`, `commandRunner: node --import ./tests/test-env.mjs --test tests/args.test.mjs tests/model-catalog.test.mjs`, thresholds 80/55/55; `mutation.yml` — `workflow_dispatch` + `schedule` (вс 03:00 UTC), node 24, без pull_request. Один локальный прогон → score в отчёт.
- [ ] **Step 5**: `.githooks/pre-commit`, `scripts/setup-git-hooks.mjs`, `.github/dependabot.yml`, `SECURITY.md` (Supported: latest release; Reporting: GitHub Security Advisories `CBEPX/codex-plugin-cc`, без email). README «Development».
- [ ] **Step 6**: наполнить quality job из Task 2. Гейт `npm run check`; commit `chore: lint, typecheck for tests, coverage, mutation (critical), dependabot, SECURITY.md, changelog gate`.

---

### Task 4: `--args-stdin` не съедает обратные слэши Windows-путей

**Files:** `plugins/codex/scripts/lib/args.mjs` (`splitRawArgumentString`), `tests/args.test.mjs`, README.

**Контракт (минимальное изменение старой модели):** модель кавычек не меняется (`\` обрабатывается до проверки кавычек, `\'` внутри `'…'` по-прежнему даёт `'`); меняется одно: `\` экранирует **только** следующий символ из whitelist `"`, `'`, `\`, whitespace (`/\s/`, включая перевод строки — как сегодня); перед любым другим символом `\` — литерал. Документируемые ограничения: `\\server\share` → `\server\share`; `C:\dir\` перед закрывающей `"` экранирует кавычку. Для byte-exact текста есть `--prompt-stdin` (rescue уже его использует); `normalizeArgv` (`codex-companion.mjs:191–224`) получает то же поведение намеренно.

- [ ] **Step 1: failing tests** (`tests/args.test.mjs`):
```js
test("splitRawArgumentString keeps a backslash that escapes nothing (Windows paths)", () => {
  assert.deepEqual(splitRawArgumentString("investigate C:\\Users\\me\\proj\\file.mjs"), ["investigate", "C:\\Users\\me\\proj\\file.mjs"]);
  assert.deepEqual(splitRawArgumentString("'C:\\dir\\x' \"D:\\y\""), ["C:\\dir\\x", "D:\\y"]);
});
test("splitRawArgumentString keeps the old escape semantics for quotes, backslash and whitespace", () => {
  assert.deepEqual(splitRawArgumentString("say \\\"q\\\" a\\ b back\\\\slash it\\'s"), ["say", "\"q\"", "a b", "back\\slash", "it's"]);
  assert.deepEqual(splitRawArgumentString("'it\\'s'"), ["it's"]);                 // old behaviour, kept
  assert.deepEqual(splitRawArgumentString("\\\\server\\share"), ["\\server\\share"]); // documented limitation
});
```
- [ ] **Step 2: implement** — в ветке `character === "\\"`: `const next = raw[index + 1]; if (next === "\"" || next === "'" || next === "\\" || /\s/.test(next ?? "")) { escaping = true; continue; } current += "\\"; continue;` (цикл по индексу). Больше ничего.
- [ ] **Step 3**: README: правило в одном предложении + `--prompt-stdin` для точного текста. Гейт; commit `fix(args): keep backslashes that escape nothing in --args-stdin text`.

---

### Task 5: Windows spawn без `$SHELL`

**Files:** `plugins/codex/scripts/lib/process.mjs`, `plugins/codex/scripts/lib/app-server.mjs` (spawn `codex`), `plugins/codex/scripts/lib/broker-lifecycle.mjs` (`windowsHide: true` в `spawnBrokerProcess`), `tests/process.test.mjs`, `tests/fake-codex-fixture.mjs`, `tests/helpers.mjs`, README (совместимость).

**Дизайн (с учётом ревью Codex):**
- `resolveExecutable(command, { env, cwd })` — только win32; **сырой** `spawnSync("where.exe", [command], { shell: false, timeout: 5000, env, cwd })` (не через `runCommand` — иначе рекурсия); из строк результата берётся первая с расширением из `PATHEXT` (`.exe`, `.cmd`, `.bat`, `.com`); extensionless shim (bash-скрипт) пропускается; не найдено → `null` → `ENOENT`, как сегодня. Без кэша.
- `buildLaunch(resolvedPath, args)`: `.exe`/`.com` → `{ file: resolvedPath, args, windowsVerbatimArguments: false }`; `.cmd`/`.bat` → `{ file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", '"' + [resolvedPath, ...args].map(quoteForCmd).join(" ") + '"'], windowsVerbatimArguments: true }`; `quoteForCmd` — правила Node `child_process` для `shell:true` (обернуть в `"` при пробелах/кавычках/пустой строке, `"` → `\"`, завершающие `\` удваивать перед закрывающей `"`; `& | < > ^ %` внутри кавычек не трогать — `/s` снимает внешнюю пару). ≈15 строк, таблица случаев в тесте.
- `runCommand`: на win32 `shell:false` всегда; `command` без пути → `resolveExecutable` → `buildLaunch`. `taskkill.exe`/`powershell.exe`/`where.exe` — прямые `.exe`. Критерии `terminateProcessTree` (`/T /F`, `looksLikeMissingProcessMessage`, ENOENT-fallback) не меняются.
- `app-server.mjs:245`: `spawn(launch.file, launch.args, { shell: false, windowsVerbatimArguments: launch.windowsVerbatimArguments, windowsHide: true, … })` для `resolveExecutable("codex")` + `["app-server"]`; комментарий ~283 обновить (`terminateProcessTree(this.proc.pid)` на живом handle остаётся допустимым исключением).
- **Совместимость (README + CHANGELOG «Changed»)**: codex/npm, доступные только внутри Git Bash (alias, функция, bash-only PATH), перестают находиться — нужен `codex.cmd`/`codex.exe` в Windows PATH.

- [ ] **Step 1: unit tests** (`tests/process.test.mjs`, инъекция `spawnSyncImpl`): `resolveExecutable` выбирает `codex.cmd` из вывода `codex\r\ncodex.cmd\r\n`; таблица `buildLaunch`/`quoteForCmd`: путь с пробелом, аргумент с `"`, пустой аргумент, `%PATH%`, `a&b`, завершающий `\`; `terminateProcessTree(win32)` вызывает `taskkill.exe` c `shell:false` (шпион на options).
- [ ] **Step 2: implement**; `spawnBrokerProcess`: `windowsHide: true`.
- [ ] **Step 3: fixtures** — `installFakeCodex` на win32 пишет `codex.cjs` (тело фикстуры использует `require`) + `codex.cmd` = `@echo off\r\nnode "%~dp0codex.cjs" %*`; на posix как сейчас. `tests/helpers.mjs` `run()`: `shell:false` для `process.execPath`/`git`.
- [ ] **Step 4: Windows round-trip test** (`{ skip: !IS_WIN }`, выполняется только на CI): `.cmd`-шим, печатающий `JSON.stringify(process.argv.slice(2))`, в каталоге **с пробелом**; `runCommand` с `["plain", "with space", "q\"uote", "", "%PATH%", "a&b", "trail\\"]` → argv совпадает.
- [ ] **Step 5**: второй проход `/codex:rescue --effort xhigh` по диффу (read-only) до Claude-ревью. Гейт локально (posix без изменения поведения); Windows — CI. Commit `fix(windows): spawn without $SHELL — where.exe resolution, quoted cmd.exe launch for .cmd shims, direct taskkill/powershell` с `Co-authored-by: mohammad-malik <mohammad-malik@users.noreply.github.com>` (#735), `Co-authored-by: mittalpk <mittalpk@users.noreply.github.com>` (#669).

---

### Task 6: Чтение stdin в хуках — дедлайн, EAGAIN, лимит (без потери payload)

**Files:** Create `plugins/codex/scripts/lib/hook-input.mjs`; Modify `plugins/codex/scripts/session-lifecycle-hook.mjs`, `plugins/codex/scripts/stop-review-gate-hook.mjs` (`main` → async; prompt в companion через `--prompt-stdin`, не argv), `plugins/codex/scripts/lib/fs.mjs` (`readStdinIfPiped`), `tests/hook-input.test.mjs`, `tests/runtime.test.mjs`, `tests/commands.test.mjs`.

**Interfaces:** `export async function readHookInput({ timeoutMs = 2000, maxBytes = 1024 * 1024, stdin = process.stdin } = {})` → `{ input: object|null, error: null | { code: "timeout"|"overflow"|"invalid-json", message } }`. EOF → parse полного ввода; дедлайн → если накопленный буфер **уже** валидный JSON — принять (EOF задержался), иначе `error.code = "timeout"`; байты > `maxBytes` → прекратить чтение, `"overflow"`, усечённый буфер не парсится; невалидный JSON → `"invalid-json"`. `StringDecoder("utf8")` на границах chunk'ов, лимит в байтах; по завершении `clearTimeout`, снять listeners, `stdin.pause()`/`destroy()`. Env `CODEX_HOOK_STDIN_TIMEOUT_MS` — для тестов.
- Stop-hook: вызов внутри существующего fail-closed блока: любой `error` → `{"decision":"block"}` (как сегодня для malformed), **кроме** `timeout` с пустым буфером при `stopReviewGate === false` в workspace по `CLAUDE_PROJECT_DIR`/`process.cwd()` → allow (это #530); при включённом gate timeout → block с причиной «hook input did not arrive». Prompt в companion — через `--prompt-stdin` (снимает лимит argv на Windows).
- SessionEnd-hook: `error` → stderr-строка и `return` без cleanup (не подставлять `{}`); бюджет 12 s стартует после чтения, поэтому `timeoutMs` = 1000; тест «SessionEnd hook timeout stays above…» дополнить `15 > 12 + 1`.
- `readStdinIfPiped` (companion): `readSync` в цикле, накопленные байты сохраняются между повторами `EAGAIN` (до 50 × 20 ms); исчерпание → throw, не частичный prompt.

- [ ] **Step 1: tests** — `tests/hook-input.test.mjs` через `PassThrough`: (a) JSON частями + EOF; (b) полный JSON без EOF → принят на дедлайне; (c) частичный на дедлайне → `timeout`; (d) UTF-8 символ через границу chunk'ов; (e) > `maxBytes` → `overflow` без parse; (f) `{not-json` → `invalid-json`. `runtime.test.mjs`: stop-hook с выключенным gate и открытым stdin без EOF → exit 0 за <3 s (`CODEX_HOOK_STDIN_TIMEOUT_MS=200`); с включённым gate → `block` с причиной про input; `last_assistant_message` 300 KB → prompt доходит до fake codex целиком.
- [ ] **Step 2: implement**; оба хука; `fs.mjs`.
- [ ] **Step 3**: второй проход `/codex:rescue --effort xhigh` (read-only). Гейт; commit `fix(hooks): bounded stdin read that never drops a complete payload; review prompt via stdin` с `Co-authored-by: stantheman0128 <stantheman0128@users.noreply.github.com>` (#544), `Co-authored-by: tmchow <tmchow@users.noreply.github.com>` (#123).

---

### Task 7: Fallback state root на Windows → `%LOCALAPPDATA%`

**Files:** `plugins/codex/scripts/lib/state.mjs` (`resolveFallbackStateRoot`), `tests/state.test.mjs`, CHANGELOG.

- [ ] **Step 1: test** — `resolveFallbackStateRoot({ env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, platform: "win32", tmpdir: "C:\\Temp", pluginRoot })` → начинается с `C:\Users\me\AppData\Local\codex-companion\`; без `LOCALAPPDATA` → `tmpdir`. (Добавить параметр `platform` в опции; `mkdirSync` в тесте на posix создаст каталог — использовать `makeTempDir()` как `LOCALAPPDATA`.)
- [ ] **Step 2: implement** — `const base = platform === "win32" && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "codex-companion") : path.join(tmpdir, \`codex-companion-${uid ?? "user"}\`)`; **переходная политика**: если новый корень ещё не существует, а старый `<tmpdir>/codex-companion-user/<hash>` существует — использовать старый (без миграции файлов) и написать одну stderr-строку; тест на оба случая; CHANGELOG «Changed». Гейт; commit `fix(state): per-user fallback state root under %LOCALAPPDATA% on Windows`.

---

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
