### Task 1: Хвосты v1.4.0 — ps-guard, разбор флейка

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs:196-207` (`processCommandLine`, ps-ветка)
- Test: `tests/process.test.mjs`
- Investigate: `tests/broker-stale-pid.test.mjs` («session end reaps a SIGKILLed background worker …», ~448–520)
- Done before Task 1 (commit «fix(app-server): read JSONL frames on newline only»): `node:readline` резал JSONL app-server на U+2028/U+2029, любой turn с таким символом в команде/выводе падал как «connection closed before the turn completed» (оба транспорта); `SpawnedCodexAppServerClient` читает через `handleChunk`, тест «a notification containing U+2028/U+2029 is one frame» в `tests/app-server.test.mjs`, knob `FAKE_CODEX_ANSWER_TEXT`. В Task 6 CHANGELOG: Fixed — эта строка.

**Interfaces:** `processCommandLine(pid, { timeoutMs })` — сигнатура прежняя; `timeoutMs` задан и `≤ 0` → `null` без спавна.

- [ ] **Step 1: failing test** (`tests/process.test.mjs`):

```js
test("processCommandLine treats a spent budget as no probe on the ps branch", () => {
  for (const timeoutMs of [0, -1]) {
    assert.equal(processCommandLine(42, { platform: "darwin", timeoutMs, runCommandImpl: () => assert.fail("must not spawn ps") }), null);
  }
  // A fractional positive budget is clamped by runCommand and still probes; an unset one probes too.
  for (const options of [{ timeoutMs: 0.3 }, {}]) {
    assert.equal(processCommandLine(42, { platform: "darwin", ...options, runCommandImpl: () => ({ status: 0, stdout: "node x\n", stderr: "", error: null }) }), "node x");
  }
});
```

- [ ] **Step 2: run** `node --import ./tests/test-env.mjs --test --test-name-pattern="spent budget as no probe" tests/process.test.mjs` → FAIL.
- [ ] **Step 3: implement** перед `runCommandImpl("ps", …)`:

```js
  // A spent budget is no probe (spawnSync would read 0 as "no timeout").
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
    return null;
  }
```

- [ ] **Step 4: run** → PASS; весь `tests/process.test.mjs` → pass.
- [ ] **Step 5: leak-шаг CI** — в этой задаче **не трогать**: обязательный Windows-leak-шаг требует запускателя PowerShell из Task 2 и делается там (Task 2 Step 6, `scripts/check-leaks.mjs`); v1.4.0-шаг «reported, not enforced» остаётся до него.
- [ ] **Step 6: флейк reaper-теста** — `for i in $(seq 10); do node --import ./tests/test-env.mjs --test --test-name-pattern="session end reaps a SIGKILLed background worker" tests/broker-stale-pid.test.mjs > /tmp/reap-$i.log 2>&1 || echo "FAIL $i"; done`. Любой FAIL → «hook said» и «broker log tail» из лога в отчёт задачи и в леджер; **код не менять** (решение о причине — контроллер, вне scope этого релиза). Без FAIL — «10/10 green locally».
- [ ] **Step 7: gate + commit** `fix(process): ps probe honours a spent budget`. Push.

---

