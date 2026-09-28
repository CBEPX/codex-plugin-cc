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

