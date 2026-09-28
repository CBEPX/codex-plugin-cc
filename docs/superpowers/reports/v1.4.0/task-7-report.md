# Task 7 — отчёт

Commit: `35f6bed` на `release/v1.4.0` (base dfd941d). Не запушено.

## Изменения по файлам

- `plugins/codex/scripts/lib/state.mjs`
  - `resolveFallbackStateRoot`: новый параметр `platform` (по умолчанию `process.platform`). Он же теперь управляет POSIX-проверкой owner/mode (проверка не изменилась). На win32 с `LOCALAPPDATA` корень — `%LOCALAPPDATA%\codex-companion\<hash>`. Там есть комментарий: ACL per-user профиля заменяет POSIX-проверку. Переходная политика: если нового `<LOCALAPPDATA>\codex-companion\<hash>` нет, а старый `<tmpdir>\codex-companion-user\<hash>` есть, используется старый. Файлы не мигрируются, ничего не создаётся. Проверка выполняется до `mkdirSync`. Одна строка в stderr на процесс для каждого legacy-корня (module-level `Set`, потому что `resolveStateDir` вызывается многократно).
  - Новый экспорт `retryOnWindows(op, codes, { platform })`: работает только на win32 и только для перечисленных кодов; 20 попыток с паузой 15 ms через существующий `sleepSync`; затем бросается последняя ошибка без изменений. Худший случай — около 300 ms на вызов. Нижняя часть диапазона 10–50 ms выбрана потому, что `readLockEntryOwner` работает внутри дедлайна `waitForTurn`.
  - `writeFileAtomic`: `renameSync` в retry при `EPERM`/`EBUSY`/`EACCES`, с маркером `// ponytail:`.
  - `readLockEntryOwner`: `readFileSync` в retry при `EPERM`/`EBUSY`. `ENOENT` по-прежнему означает `present:false`. EACCES/EIO/EISDIR бросаются сразу, комментарий дополнен одной фразой про win32.
  - `loadState`: `readFileSync` в retry при `EBUSY`.
- `tests/state.test.mjs`: снят `{ skip: IS_WIN }` с теста torn-state. Читатель в тесте читает как `loadState` (retry на EBUSY). Добавлены 4 теста: helper (19 бросков → успех, 20 → проброшена именно 20-я ошибка, posix и ENOENT → без повторов), корень с/без `LOCALAPPDATA`, переходный случай (legacy + одна строка, повтор без строки, после появления нового корня — новый).
- `README.md`: абзац в `### Windows` про `%LOCALAPPDATA%\codex-companion` и переходную политику. Отдельного предложения про fallback-корень раньше не было, поэтому добавлено новое.

## Что подтвердит только Windows CI

- Тест torn-state проходит на windows/node 18 и 24: rename в писателе больше не падает с EPERM. Если читатель в тесте получит EPERM (а не EBUSY), то `loadState` тоже нужен EPERM, и это будет реальная находка.
- Тест «two processes acquiring concurrently never overlap» больше не ловит EPERM в `readLockEntryOwner`. Если EPERM придёт из `statLockEntry` (`statSync`), нужен тот же helper; сейчас доказательств этому нет, поэтому не сделано.
- Реальный путь `%LOCALAPPDATA%` на Windows (на macOS проверяется только через `platform: "win32"` и temp-каталог как `LOCALAPPDATA`).

## Гейт (Node 24, macOS)

`npm run check` → exit 0:
```
ℹ tests 350
ℹ suites 0
ℹ pass 349
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 172454.536834
```
`sleep 10; pgrep -f codex-plugin-test- | wc -l` → `0`.

Примечание: в окружении harness выставлен `CLAUDE_PLUGIN_DATA`. Поэтому прямой `node --test tests/state.test.mjs` роняет существующий тест «temp-backed per-workspace directory». Через `env -u CLAUDE_PLUGIN_DATA` проходят все 36 тестов; `npm run check` зелёный. К изменению это не относится.

## Отклонения

- CHANGELOG не тронут, хотя brief требует «Changed»: по указанию контроллера его пишет Task 9.
- Subject коммита и trailer взяты у контроллера, а не из brief.
- Retry `readLockEntryOwner` проверяется через экспортированный helper с фейковой операцией, а не через инъекцию `readFileSyncImpl` (контроллер разрешил любой вариант).
- В `writeFileAtomic` нет `unlinkSync`-fallback, о котором говорилось в контексте: его не существует, и выдумывать его я не стал.
