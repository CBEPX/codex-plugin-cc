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

