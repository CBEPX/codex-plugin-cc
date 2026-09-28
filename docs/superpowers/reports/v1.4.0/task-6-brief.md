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

