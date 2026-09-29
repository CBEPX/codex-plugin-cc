### Task 6: Документация

**Files:**
- Modify: `README.md` («### Windows», ~385–395: удалить «Still limited until v1.4.1 …»; исправить два утверждения про `where.exe` (строки 389 и 393 — с v1.4.0 `codex`/`npm`/`git` ищутся файловым `resolveExecutable` по абсолютным записям `PATH` × `PATHEXT`, относительные записи `PATH` и cwd пропускаются, `where.exe` не вызывается; требования: только `cmd.exe` для `.cmd`-шимов и, с v1.4.1, Windows PowerShell 5.1 in-box); добавить потолки из `process.mjs:57–64`: аргумент с CR/LF отвергается ошибкой, `%VAR:a=b%` внутри аргумента `.cmd`-шима остаётся документированным ограничением; требования: Windows PowerShell 5.1 in-box; Constrained Language Mode/AppLocker → kill из записи отказывает (`identity-unavailable`), записи брокера сохраняются до следующей попытки; потомки, появившиеся после снимка, вне гарантии; **survivor kill'а, переживший смерть root, — известная утечка без верхней границы и без повторной попытки: pid и identity в ответе/логе — диагностика для оператора**; общий брокер никогда не убивается вместе с worker'ом), таблица причин (`process-missing`, `kill-failed` с survivors, метод `handle`).
- Modify: `CHANGELOG.md` + `plugins/codex/CHANGELOG.md` (`## 1.4.1 — <день релизного коммита>`: Fixed — kill из записей на Windows через закреплённые handle'ы (#743 win32, #423/#577, #336, #416, #487, #718), leak-шаг обязателен; Changed — `status` на Windows делает одну пробу на все живые job'ы; survivors kill'а сообщаются с identity (`cancellationPending` + `survivors`), job не считается cancelled при живом root; сопровождение survivors записями — вне v1.4.1; записи брокера сохраняются при неизвестном исходе SessionEnd (Windows); ps-guard `≤ 0`; `teardownBrokerSession` результат содержит `kept`).
- Modify: `docs/superpowers/triage/2026-09-27-upstream-triage.md` — статусы `fixed-in v1.4.1`.
- Test: `tests/commands.test.mjs` README-assertions.

- [ ] **Step 1**: правки; `cp CHANGELOG.md plugins/codex/CHANGELOG.md`; `node scripts/check-changelog.mjs`.
- [ ] **Step 2: gate + commit** `docs: Windows kill path, 1.4.1 changelog, triage statuses`.

---

