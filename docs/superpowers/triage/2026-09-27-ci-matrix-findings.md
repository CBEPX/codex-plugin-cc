# CI-матрица: результаты spike (2026-09-27)

Источник: PR #6 (`ci/matrix-spike`), run 36329030169, коммит 82cca83 (тесты v1.2.1 без изменений).
Артефакты: `test-log-<os>-node<ver>` (7 дней).

| OS | node 18 | node 22 | node 24 |
|---|---|---|---|
| ubuntu-latest | pass (239/239) | pass | pass |
| macos-latest | pass | pass | pass |
| windows-latest | **0 тестов**: `node --test tests/*.test.mjs` — glob не раскрывается (`Could not find 'D:\...\tests\*.test.mjs'`) | 213 pass / 20 fail / 6 skip | прервано `spawn ENAMETOOLONG` (uncaught в `state.test.mjs:171`), результаты неполные |

Локально macOS (worktree): 239/239, 0 утечек.

## Windows, node 22 — 20 падений по классам

### A. Тестовая обвязка (чинится в тестах/конфиге, продукт не виноват)

| Класс | Тесты | Причина | Фикс (v1.4.0) |
|---|---|---|---|
| CRLF checkout | `review command uses AskUserQuestion…`, `adversarial review command…`, `rescue and agent payload blocks…` | actions/checkout на Windows конвертирует `\n`→`\r\n`, regex в `tests/commands.test.mjs` ждут `\n` | `.gitattributes`: `* text=auto eol=lf` (и `git config core.autocrlf false` в CI) |
| `HOME` ≠ `USERPROFILE` | 4 transfer-теста | тесты подменяют `HOME`, а `os.homedir()` на Windows читает `USERPROFILE` | в тестах задавать оба; после Task 6 v1.3.0 (`CLAUDE_CONFIG_DIR`) тесты переводятся на него |
| POSIX mode 0600 | `job request payloads are written owner-only…`, `an active v1.1.1 record keeps its real --config…` | `fs.statSync().mode & 0o777` = 0o666 на NTFS | assert только на posix; README: на Windows приватность payload = ACL каталога `%TEMP%`/plugin data |
| Unix socket endpoint | `createBrokerEndpoint uses Unix sockets on non-Windows platforms` | тест без `platform` override на win32 | `{ skip: win32 }` или явный `platform: "linux"` |
| Сигналы | `close() bounds an app-server that ignores SIGTERM`, `close() stays bounded when it is called twice`, `broker exits on SIGTERM…`, `a second shutdown trigger…`, `session end reaps a SIGKILLed background worker…`, `session end recovers the lock a killed worker left behind` | на Windows `exitCode`/`signalCode` другие (`null`/`1` вместо `SIGKILL`/`0`), `process.kill(pid)` на уже мёртвый pid → `ESRCH` в самом тесте | win32-ветки ожиданий; `try/catch` вокруг тестового `kill` |
| `'node' is not recognized` | `setup is ready without npm when Codex is already installed…` | тест ставит `PATH=binDir` без каталога node | добавлять `path.dirname(process.execPath)` в PATH |
| `spawn ENAMETOOLONG` | `concurrent writers never leave a torn state.json for a reader` | длинный `-e` скрипт в argv (лимит ~32 KB); на node 24 — uncaught, роняет весь прогон | писать скрипт во временный файл |
| glob (node 18) | вся матрица node 18 | cmd.exe не раскрывает `tests/*.test.mjs`, Node 18 — тоже | `"test": "node --import ./tests/test-env.mjs --test tests/"` (каталог) или явный список |

### B. Реальные дефекты продукта на Windows (в план v1.4.0)

| Тест | Симптом | Дефект | Upstream |
|---|---|---|---|
| `cancelling an awaited job ends the await with exit 1…` | `taskkill /PID 3024 /T /F: exit=128: ERROR: The process with PID 8384 (child process of PID 756) could not be terminated. Reason: The operation attempted is not supported.` — `cancel` завершается с exit 1 | `terminateProcessTree` на win32: `taskkill /T` не может убить внуков; `runCommand` идёт через `shell: SHELL \|\| true` (`process.mjs:13`) | #525 #647 #656 #669 #708 #423 (PR #735, #577) |
| `task --args-stdin keeps shell metacharacters inside the prompt…` | prompt `investigate $(touch C:\Users\…\pwned)` приходит как `C:UsersRUNNER~1…` — обратные слэши съедены | `splitRawArgumentString` (`lib/args.mjs`) трактует `\` как escape; любой Windows-путь в тексте задачи через `--args-stdin` теряет разделители | (нет upstream-репорта; форк-специфичное, т.к. `--args-stdin` — фича форка) |

## Выводы для v1.4.0

1. Сначала класс A (один PR: `.gitattributes`, test-скрипт по каталогу, win32-ветки ожиданий, PATH/HOME в тестах, `-e` → файл) — после него Windows-джоб становится обязательным (`continue-on-error` снять).
2. Затем класс B как отдельные задачи с падающими тестами уже на реальном Windows-раннере.
3. Node 24 на всех ОС: зелёный на posix; на Windows — только после фикса `ENAMETOOLONG`.
