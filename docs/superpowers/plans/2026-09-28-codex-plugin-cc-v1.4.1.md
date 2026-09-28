# codex-plugin-cc v1.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать Windows ту же гарантию kill-пути, что posix имеет с v1.3.0: записанный PID сигналится только после доказательства через закреплённый process handle, дерево завершается теми же handle'ами, исход без подтверждения никогда не считается доставленным; четыре win32-отказа становятся реальными kill'ами; плюс хвосты v1.4.0.

**Architecture:** Один запускатель `runPowerShell` (валидированный `SystemRoot`, абсолютный путь `System32\WindowsPowerShell\v1.0\powershell.exe`, чистое минимальное окружение, cwd = System32, `-EncodedCommand`, протокол вывода `^[A-Z]+( \d+)*$`, breaker по монотонным часам). Identity = `win32:<FILETIME>` из `.NET Process.StartTime`, читаемого через объект с закреплённым `.Handle`. Проба — batch `Get-Process -Id …` (только win32, Int32). Kill — один скрипт: guard CLM → pin root (`GetProcessById` + `.Handle`) → сверка `StartTime` → CIM-снимок дерева с допуском узла только при совпадении UTC-микросекунд его закреплённого `StartTime` со снимком и ≥ родителя, без поддерева брокера, ошибка pin потомка (кроме «его уже нет») → 244 → `KILL` → `.Kill()` по закреплённым объектам, дети → родитель → `WaitForExit` до абсолютного дедлайна, неподтверждённый узел = survivor → `OK` или строки `SURVIVOR <pid> <filetime>` (identity из ещё закреплённого объекта); успех только при полной последовательности `KILL`,`OK`. Survivors **сообщаются и логируются, но не сопровождаются записями** (решение по объёму: spec §1/§5). Никаких внешних программ, никакого `taskkill`. Survivors и `kept` доходят до всех callers на win32. posix — только два изменения из spec §6.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test` (`scripts/run-tests.mjs`), fake Codex fixture, Windows PowerShell 5.1 (in-box), .NET `System.Diagnostics.Process`, CIM `Win32_Process` (снимок дерева), GitHub Actions с обязательным Windows.

**Spec:** `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` (rev. 10; план rev. 11); roadmap `/Users/g.mehrenin/.claude/plans/glistening-chasing-backus.md`, разделы «v1.4.1» и «Дизайн: process identity».

## Global Constraints

- Worktree `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.1`, ветка `release/v1.4.1` от `main` (5662171 = v1.4.0). `main` = установленный `codex@cbepx` 1.4.0 — не трогать.
- Гейт на задачу: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit …` (roadmap п. 7: только `&&`, только exit-коды).
- Только `rg`, никаких `git add -A`. Трейлер `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push ветки разрешён; PR/merge/tag — отдельный вопрос в Task 7.
- Threat-model (spec §2): PowerShell только по валидированному абсолютному пути; чистое окружение; cwd = System32; никаких голых имён; **скрипты не запускают ни одной внешней программы**; вывод по протоколу `^[A-Z]+( \d+)*$` (`ID …`, `KILL`, `OK`, `SURVIVOR <pid> <filetime>`); `-EncodedCommand`; PID ∈ [1, 2147483647]; kill требует `timeoutMs ≥ 750`.
- Fail-closed: `null`/ошибка/таймаут/breaker/CLM никогда не разрешает kill; неподтверждённый exit = survivor, никогда `delivered:true`; записи без identity на win32 остаются `identity-unavailable`; lock-тикеты на win32 — PID-liveness; `terminateProcessTree` (живой handle app-server) — как в v1.4.0.
- posix меняется ровно в трёх местах (spec §6): ps-guard `≤ 0`, поле `kept: false` в результате `teardownBrokerSession`, и ничего в cancel (pending-reason/JSON на posix байт-в-байт как v1.4.0). Всё новое — за `platform === "win32"`.
- Тайминги (roadmap п. 8): Windows-only E2E — `{ skip: !IS_WIN, timeout: 90_000 }`, ожидания через `waitFor` (30 s), `t.after` регистрируется сразу после получения pid.
- Windows локально нет: Task 2–5 доказываются inject-тестами на posix + Windows-матрицей после push; при исполнении Task 4 обязателен второй проход `/codex:rescue --effort xhigh` (read-only) с брифом по spec §2 и «PID reuse между снимком и Kill», «CLM», «поддерево брокера», «survivors».

## Review Focus

1. Подложенный `powershell.exe` (копия `cmd.exe`) / `powershell.cmd` в cwd или относительном `PATH`, `PSModulePath`/`COMPlus_*` из окружения job'а никогда не влияют на запуск (Task 2 argv/env-тесты; Task 5 sentinel из свежего процесса с абсолютными file URL).
2. Не-ASCII путь и не-английская локаль (#310): протокол вывода `^[A-Z]+( \d+)*$`, любая другая строка → неизвестный исход (Task 3/4 тесты с мусорным stdout).
3. Рецикл PID и устаревший `ParentProcessId`: root и каждый узел закреплены `.Handle` до чтения `StartTime`, узлы сверяются по UTC-микросекундам без допуска (Task 4 тест на текст скрипта + маппинг 242).
4. CLM/медленный раннер: guard `LanguageMode` в обоих скриптах → 244 → breaker → `identity-unavailable`, запись сохраняется на SessionEnd (Task 3/4/5); таймаут после `KILL` → `kill-failed` + `unverified`, exit 0 с мусором → не delivered (Task 4).
5. Survivors / общий брокер как ребёнок worker'а: `SURVIVOR`-строки → `cancellationPending` + `survivors` (pid+identity) в ответе и логе, никогда `cancelled` при живом root; брокер исключён по pid и по `app-server-broker.mjs` (Task 4 скрипт, Task 5 cancel + E2E «тот же app-server обслуживает следующий job»).

---

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

### Task 2: PowerShell-запускатель: валидированный root, чистое окружение, breaker, протокол вывода

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (после `systemExe`)
- Create: `scripts/check-leaks.mjs` (Step 6)
- Modify: `.github/workflows/pull-request-ci.yml` (~62–73), `.github/workflows/release-verify.yml` (~75–82) (Step 6)
- Test: `tests/process.test.mjs`; `tests/commands.test.mjs` (`leakCount`)

**Interfaces (Produces):**
- `export const WIN32_MAX_PID = 2147483647; export const isWin32Pid = (pid) => Number.isInteger(pid) && pid >= 1 && pid <= WIN32_MAX_PID;`
- `export function systemRoot(env, { existsSyncImpl } = {})` → `string|null` (`^[A-Za-z]:\\[^\\/]+` + существует `<root>\System32\WindowsPowerShell\v1.0\powershell.exe`).
- `export function systemPowerShell(root)`, `export function powerShellEnvironment(root, env)`, `export function encodePowerShell(script)` — как в spec §2.
- `export function parseProtocolLines(stdout)` → `string[] | null`: строки по `\r?\n` **без `trim()`** (только один завершающий перевод строки отбрасывается), каждая `^[A-Z]+( \d+)*$`, иначе `null` — пробел, TAB, NBSP или пустая строка внутри делают ответ невалидным.
- `export function runPowerShell(script, { timeoutMs, env, runCommandImpl, existsSyncImpl, now })` → `{ status: number|null, stdout: string, timedOut: boolean, unavailable: boolean }`; breaker трипается на invalid root, `ENOENT`, `ETIMEDOUT`, exit 244; `timeoutMs` должен быть конечным и `≥ 1`.
- Константы: `WINDOWS_PROCESS_MISSING_EXIT = 241`, `WINDOWS_IDENTITY_MISMATCH_EXIT = 242`, `WINDOWS_TERMINATION_FAILED_EXIT = 243`, `WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244`; `export function resetWindowsIdentityCircuit()`.

- [ ] **Step 1: failing tests** (helpers `PS_UNDER`/`existsPs` определить один раз в начале файла тестов):

```js
const PS_UNDER = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const existsPs = (p) => p === PS_UNDER;
const psBase = { env: { SystemRoot: "D:\\Win" }, timeoutMs: 1000, existsSyncImpl: existsPs };

test("systemRoot accepts only an absolute drive path that holds the in-box PowerShell", () => {
  assert.equal(systemRoot({ SystemRoot: "D:\\Win" }, { existsSyncImpl: existsPs }), "D:\\Win");
  assert.equal(systemRoot({ SYSTEMROOT: "D:\\Win" }, { existsSyncImpl: existsPs }), "D:\\Win");
  for (const bad of [".", "relative\\dir", "\\\\server\\share", "D:\\", "", undefined]) {
    assert.equal(systemRoot({ SystemRoot: bad }, { existsSyncImpl: existsPs }), null, JSON.stringify(bad));
  }
  assert.equal(systemRoot({ SystemRoot: "D:\\Win" }, { existsSyncImpl: () => false }), null, "launcher must exist");
});

test("powerShellEnvironment is minimal and never inherits the job's variables", () => {
  const env = powerShellEnvironment("D:\\Win", { PATH: "C:\\repo\\tools", PSModulePath: "C:\\repo\\mods", COMPlus_EnableDiagnostics: "1", TEMP: "C:\\T", TMP: "relative" });
  assert.deepEqual(env, {
    SystemRoot: "D:\\Win", windir: "D:\\Win", TEMP: "C:\\T", TMP: "D:\\Win\\Temp",
    PATH: "D:\\Win\\System32;D:\\Win", PATHEXT: ".EXE",
    PSModulePath: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules", NoDefaultCurrentDirectoryInExePath: "1"
  });
});

test("parseProtocolLines accepts only upper-case words followed by integers", () => {
  assert.deepEqual(parseProtocolLines("KILL\r\nSURVIVOR 4300 1337\r\nSURVIVOR 4301 1338\r\n"), ["KILL", "SURVIVOR 4300 1337", "SURVIVOR 4301 1338"]);
  assert.deepEqual(parseProtocolLines(""), []);
  for (const junk of ["failure 5\r\n", "OK\r\nZugriff verweigert\r\n", "4242 1337\r\nINFO: x\r\n", "KILL\nOK\t\n", "KILL\nOK\u00a0\n", "KILL\n\nOK\n", " OK\n", "OK\n\n"]) {
    assert.equal(parseProtocolLines(junk), null, JSON.stringify(junk));
  }
  assert.deepEqual(parseProtocolLines("OK"), ["OK"], "a final newline is optional, nothing else is");
});

test("runPowerShell launches the in-box powershell.exe by absolute path, clean env, System32 cwd and an encoded script", () => {
  resetWindowsIdentityCircuit();
  let seen = null;
  const result = runPowerShell("Write-Output OK", {
    ...psBase, env: { SystemRoot: "D:\\Win", PSModulePath: "C:\\repo" }, timeoutMs: 1234,
    runCommandImpl: (file, args, options) => { seen = { file, args, options }; return { status: 0, stdout: "OK\r\n", stderr: "", error: null }; }
  });
  assert.equal(seen.file, PS_UNDER);
  assert.deepEqual(seen.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.equal(Buffer.from(seen.args[6], "base64").toString("utf16le"), "Write-Output OK");
  assert.equal(seen.options.timeoutMs, 1234);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.cwd, "D:\\Win\\System32");
  assert.equal(seen.options.env.PSModulePath, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.equal("COMPlus_EnableDiagnostics" in seen.options.env, false);
  assert.deepEqual(result, { status: 0, stdout: "OK\r\n", timedOut: false, unavailable: false });
});

test("runPowerShell is unavailable without a valid root or a finite budget and never spawns then", () => {
  resetWindowsIdentityCircuit();
  const never = () => assert.fail("must not spawn");
  assert.equal(runPowerShell("x", { ...psBase, env: { SystemRoot: "." }, runCommandImpl: never }).unavailable, true);
  // An invalid root trips the breaker too: a valid root right after is not spawned either.
  assert.equal(runPowerShell("x", { ...psBase, runCommandImpl: never }).unavailable, true);
  resetWindowsIdentityCircuit();
  for (const timeoutMs of [0, -1, Infinity, NaN, undefined]) {
    assert.equal(runPowerShell("x", { ...psBase, timeoutMs, runCommandImpl: never }).unavailable, true, String(timeoutMs));
  }
});

test("runPowerShell opens the circuit on ENOENT, ETIMEDOUT or exit 244 and closes it after a minute", () => {
  resetWindowsIdentityCircuit();
  let clock = 1_000_000;
  const now = () => clock;
  let calls = 0;
  const enoent = () => { calls += 1; return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }; };
  assert.equal(runPowerShell("x", { ...psBase, runCommandImpl: enoent, now }).unavailable, true);
  assert.equal(runPowerShell("x", { ...psBase, runCommandImpl: enoent, now }).unavailable, true);
  assert.equal(calls, 1, "the open circuit must not spawn again");
  clock += 60_001;
  assert.equal(runPowerShell("x", { ...psBase, runCommandImpl: () => { calls += 1; return { status: 0, stdout: "OK", stderr: "", error: null }; }, now }).unavailable, false);
  assert.equal(calls, 2);
  for (const result of [
    { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM" },
    { status: 244, stdout: "", stderr: "", error: null }
  ]) {
    resetWindowsIdentityCircuit();
    const first = runPowerShell("x", { ...psBase, runCommandImpl: () => result, now });
    assert.equal(first.unavailable, true);
    assert.equal(first.timedOut, result.error?.code === "ETIMEDOUT");
    assert.equal(runPowerShell("x", { ...psBase, runCommandImpl: () => assert.fail("circuit must be open"), now }).unavailable, true);
  }
});
```

- [ ] **Step 2: run** → FAIL (`systemRoot is not exported`).
- [ ] **Step 3: implement** после `systemExe`:

```js
export const WINDOWS_PROCESS_MISSING_EXIT = 241;
export const WINDOWS_IDENTITY_MISMATCH_EXIT = 242;
export const WINDOWS_TERMINATION_FAILED_EXIT = 243;
export const WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244;
export const WIN32_MAX_PID = 2147483647;
export const isWin32Pid = (pid) => Number.isInteger(pid) && pid >= 1 && pid <= WIN32_MAX_PID;
const WINDOWS_IDENTITY_CIRCUIT_MS = 60000;
const WINDOWS_ROOT = /^[A-Za-z]:\\[^\\/]+/;
const PROTOCOL_LINE = /^[A-Z]+( \d+)*$/;
let windowsIdentityUnavailableAt = null;

export function resetWindowsIdentityCircuit() {
  windowsIdentityUnavailableAt = null;
}

// The Windows directory, taken from the environment like every other System32
// path since v1.4.0, but only when it is an absolute drive path that really
// holds the in-box PowerShell 5.1 (never `pwsh`, #336; never `.`, never UNC).
export function systemRoot(env, options = {}) {
  const root = env?.SystemRoot ?? env?.SYSTEMROOT;
  if (typeof root !== "string" || !WINDOWS_ROOT.test(root)) {
    return null;
  }
  return (options.existsSyncImpl ?? fs.existsSync)(systemPowerShell(root)) ? root : null;
}

export function systemPowerShell(root) {
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// PowerShell never inherits the job's environment: no PSModulePath pointing at
// a repository, no CLR profiler hooks, no PATH. Exactly what it needs to start.
export function powerShellEnvironment(root, env = process.env) {
  const temp = (name) => (typeof env?.[name] === "string" && path.win32.isAbsolute(env[name]) ? env[name] : path.win32.join(root, "Temp"));
  return {
    SystemRoot: root,
    windir: root,
    TEMP: temp("TEMP"),
    TMP: temp("TMP"),
    PATH: `${path.win32.join(root, "System32")};${root}`,
    PATHEXT: ".EXE",
    PSModulePath: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    NoDefaultCurrentDirectoryInExePath: "1"
  };
}

export function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

// Scripts speak a machine-only protocol: upper-case words and integers. One
// foreign line (a localised error, a stray prompt) voids the whole answer.
export function parseProtocolLines(stdout) {
  // No trimming: a line is the exact text between line breaks. Only the single
  // newline that terminates the last line is optional.
  const lines = String(stdout ?? "").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.every((line) => PROTOCOL_LINE.test(line)) ? lines : null;
}

// One way to run PowerShell: validated absolute path, clean environment,
// System32 as cwd, script as -EncodedCommand. A launcher that is missing,
// invalid, hangs or reports 244 trips a per-process breaker: for a minute
// every caller gets `unavailable` at once instead of each waiting out its own
// timeout.
export function runPowerShell(script, options = {}) {
  const now = options.now ?? (() => performance.now());
  const unavailable = { status: null, stdout: "", timedOut: false, unavailable: true };
  const trip = () => {
    windowsIdentityUnavailableAt = now();
    return unavailable;
  };
  if (windowsIdentityUnavailableAt !== null && now() - windowsIdentityUnavailableAt < WINDOWS_IDENTITY_CIRCUIT_MS) {
    return unavailable;
  }
  if (!(Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1)) {
    return unavailable;
  }
  const env = options.env ?? process.env;
  const root = systemRoot(env, options);
  if (!root) {
    return trip();
  }
  const result = (options.runCommandImpl ?? runCommand)(
    systemPowerShell(root),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    { cwd: path.win32.join(root, "System32"), env: powerShellEnvironment(root, env), timeoutMs: options.timeoutMs, shell: false }
  );
  const timedOut = result.error?.code === "ETIMEDOUT" || (!result.error && result.status === null);
  if (result.error?.code === "ENOENT" || timedOut || result.status === WINDOWS_IDENTITY_UNAVAILABLE_EXIT) {
    windowsIdentityUnavailableAt = now();
    return { ...unavailable, stdout: String(result.stdout ?? ""), timedOut };
  }
  if (!result.error) {
    windowsIdentityUnavailableAt = null;
  }
  return { status: result.status ?? null, stdout: String(result.stdout ?? ""), timedOut: false, unavailable: false };
}
```

  (`performance` — глобал Node ≥16. На таймауте `stdout` сохраняется: Task 4 по нему различает фазы.)
- [ ] **Step 4: run** → PASS; eslint.
- [ ] **Step 5: gate + commit** `feat(process): in-box PowerShell launcher with a validated root, clean environment, output protocol and breaker`.
- [ ] **Step 6: обязательный leak-шаг CI через запускатель** — создать `scripts/check-leaks.mjs` (полностью):

```js
#!/usr/bin/env node
// CI leak check: no process from a test fixture directory (codex-plugin-test-*)
// may outlive the suite. Windows enumerates through the plugin's own PowerShell
// launcher (validated root, clean environment, System32 cwd, -EncodedCommand)
// and reads nothing but its protocol: one `LEAK <pid> <ppid>` per process, then
// exactly one `COUNT <n>` that must equal the number of LEAK lines. Anything
// else — a stray line, a second COUNT, a count that disagrees — fails the step
// instead of passing as "no leaks".
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseProtocolLines, runPowerShell } from "../plugins/codex/scripts/lib/process.mjs";

const MARKER = "codex-plugin-test-";
const ENUMERATE_MS = 60000;

// Protocol lines → number of leaked processes, or null when the answer is not
// exactly LEAK* COUNT with a matching count.
export function leakCount(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }
  const count = /^COUNT (\d+)$/.exec(lines[lines.length - 1]);
  const leaks = lines.slice(0, -1);
  if (!count || !leaks.every((line) => /^LEAK \d+ \d+$/.test(line)) || Number(count[1]) !== leaks.length) {
    return null;
  }
  return leaks.length;
}

function fail(message, detail = "") {
  process.stderr.write(`${message}\n${detail}${detail && !detail.endsWith("\n") ? "\n" : ""}`);
  process.exit(1);
}

function main() {
  if (process.platform !== "win32") {
    const pgrep = spawnSync("pgrep", ["-af", MARKER], { encoding: "utf8" });
    if (pgrep.error) {
      fail(`pgrep failed: ${pgrep.error.message}`);
    }
    if (pgrep.status === 0) {
      fail("leaked test processes:", pgrep.stdout);
    }
    if (pgrep.status !== 1) {
      fail(`pgrep exited ${pgrep.status}`, pgrep.stderr);
    }
    process.stdout.write("Leaked test processes after 10 s: 0\n");
    return;
  }
  const filter = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${MARKER}' -and $_.ProcessId -ne $PID }`;
  const run = runPowerShell(
    `$ErrorActionPreference = 'Stop'; $p = @(${filter}); foreach ($x in $p) { [Console]::Out.WriteLine('LEAK ' + [int]$x.ProcessId + ' ' + [int]$x.ParentProcessId) }; [Console]::Out.WriteLine('COUNT ' + $p.Count)`,
    { timeoutMs: ENUMERATE_MS }
  );
  const lines = run.unavailable || run.status !== 0 ? null : parseProtocolLines(run.stdout);
  const leaked = leakCount(lines);
  if (leaked === null) {
    fail(`leak check could not enumerate processes (status ${run.status}, unavailable ${run.unavailable}, timedOut ${run.timedOut})`, run.stdout);
  }
  process.stdout.write(`Leaked test processes after 10 s: ${leaked}\n`);
  if (leaked > 0) {
    // Diagnostic for the operator, never parsed: the same launcher, a table.
    const table = runPowerShell(
      `$ErrorActionPreference = 'Stop'; ${filter} | Select-Object ProcessId,ParentProcessId,Name,@{n='Cmd';e={$_.CommandLine.Substring(0,[Math]::Min(160,$_.CommandLine.Length))}} | Format-Table -AutoSize | Out-String -Width 220`,
      { timeoutMs: ENUMERATE_MS }
    );
    fail(lines.join("\n"), table.stdout);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

  Тест (`tests/commands.test.mjs`, импорт `{ leakCount }` из `../scripts/check-leaks.mjs` — импорт безопасен благодаря guard'у):

```js
test("leakCount accepts only LEAK* COUNT with a matching count", () => {
  assert.equal(leakCount(["COUNT 0"]), 0);
  assert.equal(leakCount(["LEAK 4242 7", "LEAK 4243 7", "COUNT 2"]), 2);
  for (const junk of [[], ["LEAK garbage\tjunk", "COUNT 0"], ["COUNT 3", "COUNT 0"], ["COUNT 0", "JUNK"], ["LEAK 4242 7", "COUNT 0"], ["LEAK 4242 7"], ["COUNT 1"]]) {
    assert.equal(leakCount(junk), null, JSON.stringify(junk));
  }
});
```

  Оба workflow — шаг целиком (замена v1.4.0-шага; `bash` на GitHub = `-eo pipefail`, поэтому exit-код `node` проходит через `tee`):

```yaml
      # Same check as the local gate on every OS, enforced everywhere. Windows
      # enumerates through the plugin's own PowerShell launcher and reads only
      # its protocol (scripts/check-leaks.mjs); it runs even after a red suite so
      # the leak list is always available.
      - name: No leaked test processes
        if: always()
        shell: bash
        run: |
          sleep 10
          node scripts/check-leaks.mjs | tee -a "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 7: gate + commit** `ci(test): enforce the leak step on every OS through the PowerShell launcher`. Push; контроллер диспатчит CI: все джобы зелёные со строкой `Leaked test processes after 10 s: 0`.

---

### Task 3: Identity на win32 — batch-проба `getProcessIdentities`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`getProcessIdentity` win32-ветка ~217–223; новая `getProcessIdentities`)
- Test: `tests/process.test.mjs` (заменить `assert.equal(getProcessIdentity(42, { platform: "win32" }), null)` на inject-тест)

**Interfaces (Produces):**
- `export function getProcessIdentities(pids, options)` → `Map<number, string|null>`; win32: один `runPowerShell` на ≤ 256 pid (дедуп, `isWin32Pid`); posix: цикл `getProcessIdentity(pid, options)`.
- `getProcessIdentity(pid, options)` на win32 → `win32:<FILETIME>` или `null`; `timeoutMs` по умолчанию 10000; own-pid кэш.
- Скрипт (`identityProbeScript(pids)`) — строки протокола `ID <pid> <filetime>`:

```powershell
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 244 }
foreach ($p in @(Get-Process -Id <a,b,...> -ErrorAction SilentlyContinue)) {
  try { $null = $p.Handle; Write-Output ('ID {0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }
}
```

  (CLM → 244 → breaker, как и у kill-скрипта; `.Handle` закрепляет объект до чтения `StartTime`.)

- [ ] **Step 1: failing tests**

```js
test("getProcessIdentities on win32 probes every pid in one PowerShell run and parses only protocol rows", () => {
  resetWindowsIdentityCircuit();
  let script = null;
  const runCommandImpl = (file, args) => {
    script = Buffer.from(args[6], "base64").toString("utf16le");
    return { status: 0, stdout: "ID 4242 133700000000000000\r\nID 7 133700000000000001\r\n", stderr: "", error: null };
  };
  const options = { platform: "win32", runCommandImpl, ...psBase };
  const map = getProcessIdentities([4242, 7, 99, 7], options);
  assert.match(script, /LanguageMode -ne 'FullLanguage'\) \{ exit 244 \}/);
  assert.match(script, /Get-Process -Id 4242,7,99 /);
  assert.match(script, /\$null = \$p\.Handle/);
  assert.equal(map.get(4242), "win32:133700000000000000");
  assert.equal(map.get(7), "win32:133700000000000001");
  assert.equal(map.get(99), null, "a pid the probe did not print is null");
  assert.equal(map.size, 3);
  // A single probe asks for one pid and gets one row back.
  resetWindowsIdentityCircuit();
  assert.equal(getProcessIdentity(4242, { ...options, runCommandImpl: () => ({ status: 0, stdout: "ID 4242 133700000000000000\r\n", stderr: "", error: null }) }), "win32:133700000000000000");
});

test("getProcessIdentities rejects the whole answer on a foreign line, a duplicate pid or an unrequested pid", () => {
  for (const stdout of ["ID 4242 7\r\nOK\r\n", "ID 4242 7\r\nID 4242 8\r\n", "ID 4242 7\r\nID 5 9\r\n"]) {
    resetWindowsIdentityCircuit();
    const partial = getProcessIdentities([4242, 7], { platform: "win32", ...psBase, runCommandImpl: () => ({ status: 0, stdout, stderr: "", error: null }) });
    assert.deepEqual([...partial.values()], [null, null], JSON.stringify(stdout));
  }
  // Only the pids actually sent to PowerShell (the first 256) may be answered.
  resetWindowsIdentityCircuit();
  const overflow = getProcessIdentities(Array.from({ length: 300 }, (_, i) => 1000 + i), { platform: "win32", ...psBase, runCommandImpl: () => ({ status: 0, stdout: "ID 1299 42\r\n", stderr: "", error: null }) });
  assert.equal(overflow.get(1299), null, "a pid beyond the batch was never asked about");
  assert.ok([...overflow.values()].every((value) => value === null));
});

test("getProcessIdentities caps a batch at 256 Int32 pids and never marks the launcher unavailable for size", () => {
  resetWindowsIdentityCircuit();
  const pids = Array.from({ length: 300 }, (_, i) => 1000 + i).concat([0, -1, 2 ** 31, 2.5]);
  let asked = null;
  const map = getProcessIdentities(pids, { platform: "win32", ...psBase, runCommandImpl: (file, args) => { const script = Buffer.from(args[6], "base64").toString("utf16le"); asked = /-Id ([\d,]+) /.exec(script)[1].split(",").length; return { status: 0, stdout: "", stderr: "", error: null }; } });
  assert.equal(asked, 256);
  assert.equal(map.size, 300, "out-of-range pids are dropped, extra ones stay null");
  assert.equal(runPowerShell("x", { ...psBase, runCommandImpl: () => ({ status: 0, stdout: "", stderr: "", error: null }) }).unavailable, false);
});

test("getProcessIdentity on win32 is null on junk output, timeout, exit 244, a spent budget or an invalid pid", () => {
  const base = { platform: "win32", ...psBase };
  for (const result of [
    { status: 0, stdout: "not a number\r\n", stderr: "", error: null },
    { status: 0, stdout: "ID 4242 1\r\nZugriff verweigert\r\n", stderr: "", error: null },
    { status: 0, stdout: "", stderr: "", error: null },
    { status: null, stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) },
    { status: 244, stdout: "", stderr: "", error: null }
  ]) {
    resetWindowsIdentityCircuit();
    assert.equal(getProcessIdentity(4242, { ...base, runCommandImpl: () => result }), null);
  }
  resetWindowsIdentityCircuit();
  const never = () => assert.fail("must not probe");
  assert.equal(getProcessIdentity(4242, { ...base, timeoutMs: 0, runCommandImpl: never }), null);
  assert.equal(getProcessIdentity(-1, { ...base, runCommandImpl: never }), null);
  assert.equal(getProcessIdentity(2 ** 31, { ...base, runCommandImpl: never }), null);
});

test("getProcessIdentities on posix equals the per-pid probe", () => {
  const readFileSyncImpl = (p) => `${p.split("/")[2]} (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 ${p.includes("/41/") ? 111 : 222} 0 0 0`;
  const map = getProcessIdentities([41, 42], { platform: "linux", readFileSyncImpl });
  assert.deepEqual([...map.entries()], [[41, "linux:111"], [42, "linux:222"]]);
});
```

- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement**

```js
const WIN32_PROBE_BATCH = 256;
const WIN32_IDENTITY_ROW = /^ID (\d+) (\d+)$/;

function identityProbeScript(pids) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit ${WINDOWS_IDENTITY_UNAVAILABLE_EXIT} }`,
    `foreach ($p in @(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue)) {`,
    "  try { $null = $p.Handle; Write-Output ('ID {0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }",
    "}"
  ].join("\n");
}

// Several pids, one probe. On win32 that is one PowerShell run for the whole
// list (a cold start costs 0.5-3 s; per pid it would multiply); elsewhere the
// per-pid probe is already cheap and is called unchanged. Unknown, missing or
// unparseable → null; too many pids → the extra ones stay null.
export function getProcessIdentities(pids, options = {}) {
  const platform = options.platform ?? process.platform;
  const wanted = [...new Set(pids.filter(isWin32Pid))];
  const map = new Map(wanted.map((pid) => [pid, null]));
  if (wanted.length === 0) {
    return map;
  }
  if (platform !== "win32") {
    for (const pid of wanted) {
      map.set(pid, getProcessIdentity(pid, options));
    }
    return map;
  }
  const sent = new Set(wanted.slice(0, WIN32_PROBE_BATCH));
  const probe = runPowerShell(identityProbeScript([...sent]), { ...options, timeoutMs: options.timeoutMs ?? 10000 });
  const lines = probe.unavailable || probe.status !== 0 ? null : parseProtocolLines(probe.stdout);
  // The whole answer must be ID rows, each for a pid this run actually sent,
  // each pid at most once. A stray OK, a duplicate or a pid outside the batch
  // voids the answer as a whole: partial trust in a script's output is how a
  // wrong identity gets in.
  const rows = [];
  const seen = new Set();
  for (const line of lines ?? []) {
    const row = WIN32_IDENTITY_ROW.exec(line);
    const pid = row ? Number(row[1]) : null;
    if (!row || !sent.has(pid) || seen.has(pid)) {
      return map;
    }
    seen.add(pid);
    rows.push([pid, `win32:${row[2]}`]);
  }
  for (const [pid, identity] of rows) {
    map.set(pid, identity);
  }
  return map;
}
```

  В `getProcessIdentity` заменить win32-ветку:

```js
  if (platform === "win32") {
    if (!isWin32Pid(pid)) {
      return null;
    }
    if (pid === process.pid && ownIdentityCache.has(platform)) {
      return ownIdentityCache.get(platform);
    }
    const identity = getProcessIdentities([pid], options).get(pid) ?? null;
    if (pid === process.pid && identity) {
      ownIdentityCache.set(platform, identity);
    }
    return identity;
  }
```

  Удалить `// ponytail: CIM (CreationDate) identity lands in v1.4.0`. Windows-only тест (`{ skip: !IS_WIN, timeout: 60_000 }`; в `tests/process.test.mjs` добавить `import { fileURLToPath, pathToFileURL } from "node:url"`, `import { spawn } from "node:child_process"` (если ещё нет), `run` из `./helpers.mjs` и `const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")` — `helpers.mjs` не экспортирует `ROOT`): свежие процессы через `run(process.execPath, ["--import", TEST_ENV_URL, "-e", \`import(${JSON.stringify(PROCESS_MJS_URL)}).then(m => console.log(JSON.stringify([m.getProcessIdentities([process.pid]).get(process.pid), m.getProcessIdentity(process.pid)])))\`])`, где `TEST_ENV_URL`/`PROCESS_MJS_URL` — `pathToFileURL(path.join(ROOT, …)).href` (оба абсолютные и **сериализованы в строку скрипта**, как в sentinel-тесте Task 5); проверить: оба значения равны, `^win32:\d+$`; долгоживущий ребёнок `spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"])` с `t.after(kill)` — его identity из двух свежих процессов совпадает и отличается от их собственных.
- [ ] **Step 4: run** → PASS; eslint.
- [ ] **Step 5: gate + commit** `feat(process): Windows process identity from the process start time, batched per probe`.

---

### Task 4: Verify-and-kill на win32 в `terminateRecordedProcess`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`terminateRecordedProcess` ~274–326; новые `terminateWindowsRecordedProcess`, `terminateScript`, `fileTimeAt`)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:318-341` (комментарии; enum причин + `process-missing`)
- Modify: `README.md` таблица причин teardown (`process-missing`, `kill-failed` c survivors, метод `handle`)
- Test: `tests/process.test.mjs`

**Interfaces (Consumes):** Task 2. **Produces:** `terminateRecordedProcess(pid, { identity, platform: "win32", timeoutMs, excludePids = [], env, runCommandImpl, existsSyncImpl, now, clock })` → `{ attempted, delivered, method?: "handle", reason, survivors?: [{ pid: number, identity: string|null }], unverified?: true }`; `reason` ∈ прежний словарь + `process-missing`. `clock` (по умолчанию `Date.now`) — только для теста абсолютного дедлайна.

Скрипт `terminateScript(pid, fileTime, excludePids, deadlineFileTime)` — все подстановки только цифры; `deadlineFileTime` = FILETIME UTC момента `clock() + timeoutMs − 500` (JS: `(BigInt(ms) * 10000n + 116444736000000000n).toString()`), так что время запуска PowerShell входит в бюджет:

```powershell
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 244 }
$target = <pid>
$expected = '<fileTime>'
$exclude = @(<excludePids or nothing>)
$deadline = [DateTime]::FromFileTimeUtc(<deadlineFileTime>)
$pinned = @()
function Pin([int]$id) {
  $h = [System.Diagnostics.Process]::GetProcessById($id)
  $null = $h.Handle
  $script:pinned += $h
  return $h
}
function Micro($dt) { $t = [long]$dt.ToUniversalTime().Ticks; return $t - ($t % 10) }
function Remaining() { return [int][Math]::Floor([Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)) }
$tree = @()
$code = 244
try {
  try {
    try { $root = Pin $target } catch [System.ArgumentException] { $code = 241; throw } 
    if ($root.StartTime.ToFileTimeUtc().ToString() -ne $expected) { $code = 242; throw 'mismatch' }
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine)
    $tree = @($root)
    $starts = @{ $target = (Micro $root.StartTime) }
    $seen = @{ $target = $true }
    $queue = @($target)
    while ($queue.Count -gt 0) {
      $pp = $queue[0]
      $queue = @($queue | Select-Object -Skip 1)
      foreach ($r in $rows) {
        $cid = [int]$r.ProcessId
        if ([int]$r.ParentProcessId -ne $pp -or $seen.ContainsKey($cid)) { continue }
        $seen[$cid] = $true
        if ($exclude -contains $cid) { continue }
        if ($r.CommandLine -and $r.CommandLine.Contains('app-server-broker.mjs')) { continue }
        try { $h = Pin $cid } catch [System.ArgumentException] { continue }   # already gone: proven
        $live = Micro $h.StartTime
        if ($live -ne (Micro $r.CreationDate)) { continue }                  # a stranger holding a reused pid
        if ($live -lt $starts[$pp]) { continue }                             # stale ParentProcessId
        $starts[$cid] = $live
        $tree += $h
        $queue += $cid
      }
    }
    if ((Remaining) -lt 250) { $code = 244; throw 'budget' }
  } catch { exit $code }
  Write-Output 'KILL'
  $survivors = @()
  try {
    [array]::Reverse($tree)
    foreach ($h in $tree) { try { $h.Kill() } catch { } }
    foreach ($h in $tree) {
      $confirmed = $false
      while (-not $confirmed) {
        $left = Remaining
        if ($left -le 0) { break }
        try { if ($h.WaitForExit([Math]::Min(250, $left))) { $confirmed = $true } } catch { break }
      }
      if (-not $confirmed) { $survivors += $h }
    }
  } catch {
    $survivors = @($tree)
  }
  if ($survivors.Count -eq 0) { Write-Output 'OK'; exit 0 }
  # Identity from the still-pinned object: a later report can never be confused with a reused pid.
  foreach ($h in $survivors) { $ft = '0'; try { $ft = $h.StartTime.ToFileTimeUtc().ToString() } catch { }; Write-Output ('SURVIVOR {0} {1}' -f $h.Id, $ft) }
  exit 243
} finally {
  foreach ($h in $pinned) { try { $h.Dispose() } catch { } }
}
```

  Для исполнителя: `.Handle` в .NET Framework открывает `PROCESS_ALL_ACCESS` и кэширует handle до `Dispose()` — `StartTime`/`Kill()`/`WaitForExit()` этого объекта идут по нему; `GetProcessById` бросает `ArgumentException` только для «процесс не запущен»; любая другая ошибка pin (access denied, CLM) у **потомка** не проглатывается — она выходит из внутреннего `try` и даёт 244 (ничего не сигналилось); `Micro` — целочисленная арифметика `Int64` без деления; `[array]::Reverse($tree)` даёт порядок дети → root; исключение `WaitForExit` = survivor. Внешний `try/finally` покрывает обе фазы; строки `SURVIVOR` печатаются до `finally` (объекты ещё закреплены), `0` вместо filetime означает «identity не прочитана». Выход `exit N` внутри `try` срабатывает после `finally`.

- [ ] **Step 1: failing tests**

```js
test("terminateRecordedProcess on win32 runs the pinned verify-and-kill script and maps its protocol", () => {
  const clock = () => 1_700_000_000_000; // ms; deadline = clock + 3000 - 500
  const expectedDeadline = (BigInt(1_700_000_000_000 + 2500) * 10000n + 116444736000000000n).toString();
  const base = { identity: "win32:133700000000000000", platform: "win32", ...psBase, timeoutMs: 3000, excludePids: [555], clock };
  const cases = [
    [0, "KILL\r\nOK\r\n", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }],
    [0, "failure 5\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [0, "KILL\r\nZugriff verweigert\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [241, "", { attempted: false, delivered: false, method: "handle", reason: "process-missing" }],
    [241, "KILL\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [242, "", { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }],
    [242, "KILL\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "KILL\r\nSURVIVOR 4300 1337\r\nSURVIVOR 4301 0\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 4300, identity: "win32:1337" }, { pid: 4301, identity: null }] }],
    [243, "KILL\r\nfailure 5\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "junk\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "KILL\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "KILL\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "KILL\r\nOK\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [244, "", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [244, "KILL\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [1, "", { attempted: false, delivered: false, reason: "identity-unavailable" }]
  ];
  for (const [status, stdout, expected] of cases) {
    resetWindowsIdentityCircuit();
    let script = null;
    const result = terminateRecordedProcess(4242, { ...base, runCommandImpl: (file, args) => { script = Buffer.from(args[6], "base64").toString("utf16le"); return { status, stdout, stderr: "", error: null }; } });
    assert.deepEqual(result, expected, `exit ${status} / ${JSON.stringify(stdout)}`);
    assert.match(script, /LanguageMode -ne 'FullLanguage'\) \{ exit 244 \}/);
    assert.match(script, /\$target = 4242\n/);
    assert.match(script, /\$expected = '133700000000000000'/);
    assert.match(script, /\$exclude = @\(555\)/);
    assert.match(script, new RegExp(`FromFileTimeUtc\\(${expectedDeadline}\\)`), "absolute deadline counts the PowerShell start-up");
    assert.match(script, /\$null = \$h\.Handle/, "the handle is pinned before StartTime is read");
    assert.match(script, /catch \[System\.ArgumentException\] \{ \$code = 241; throw \}/);
    assert.match(script, /catch \[System\.ArgumentException\] \{ continue \}/, "a child that is already gone is skipped, any other pin error aborts with 244");
    assert.match(script, /\$t - \(\$t % 10\)/, "exact Int64 microsecond truncation");
    assert.match(script, /app-server-broker\.mjs/);
    assert.match(script, /\.Kill\(\)/);
    assert.doesNotMatch(script, /taskkill|& "|Start-Process/, "no external program is ever started");
    assert.match(script, /finally \{\n  foreach \(\$h in \$pinned\)/);
    const survivorAt = script.indexOf("'SURVIVOR {0} {1}'");
    const finallyAt = script.indexOf("} finally {");
    assert.ok(survivorAt > 0 && finallyAt > 0 && survivorAt < finallyAt, "SURVIVOR lines are printed while the objects are still pinned");
  }
  // A timeout after KILL is an unverified attempt (KILL anywhere in the output counts); before it, no evidence at all.
  const timedOut = (stdout) => ({ status: null, stdout, stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) });
  for (const out of ["KILL\r\n", "warning\r\nKILL\r\n"]) {
    resetWindowsIdentityCircuit();
    assert.deepEqual(terminateRecordedProcess(4242, { ...base, runCommandImpl: () => timedOut(out) }), { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true });
  }
  resetWindowsIdentityCircuit();
  assert.deepEqual(terminateRecordedProcess(4242, { ...base, runCommandImpl: () => timedOut("") }), { attempted: false, delivered: false, reason: "identity-unavailable" });
  // Malformed identity, out-of-range pid, a legacy record or a budget under 750 ms never reach PowerShell.
  for (const override of [{ identity: "win32:abc" }, { identity: "linux:5" }, { identity: null }, { pid: 2 ** 31 }, { timeoutMs: 700 }]) {
    resetWindowsIdentityCircuit();
    const { pid = 4242, ...rest } = override;
    assert.equal(terminateRecordedProcess(pid, { ...base, ...rest, runCommandImpl: () => assert.fail("must not run") }).reason, "identity-unavailable");
  }
});
```

  Существующий тест «terminateRecordedProcess refuses on identity mismatch and without identity on win32» остаётся.
- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement** — в `terminateRecordedProcess` перед `const refusal = …`:

```js
  if (platform === "win32") {
    return terminateWindowsRecordedProcess(pid, identity, options);
  }
```

  и:

```js
const KILL_DEADLINE_MARGIN_MS = 500;
const KILL_MIN_BUDGET_MS = 750;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;

export function fileTimeAt(ms) {
  return (BigInt(Math.floor(ms)) * 10000n + FILETIME_EPOCH_OFFSET).toString();
}

// One PowerShell run pins the recorded process (GetProcessById + .Handle), proves
// its start time, builds the tree from a CIM snapshot admitting only children
// whose pinned start time equals the snapshot's at microsecond precision and
// follows their parent's, skips the shared broker, kills children-first through
// the pinned objects and waits for each until an absolute deadline. Every answer
// is an exit code plus protocol lines; an exit that could not be confirmed is a
// survivor, and a corrupted answer after KILL is an unverified attempt.
function terminateWindowsRecordedProcess(pid, identity, options) {
  const refused = (reason) => ({ attempted: false, delivered: false, reason });
  const fileTime = typeof identity === "string" ? /^win32:(\d+)$/.exec(identity)?.[1] : null;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!fileTime || !isWin32Pid(pid) || !(Number.isFinite(timeoutMs) && timeoutMs >= KILL_MIN_BUDGET_MS)) {
    return refused("identity-unavailable");
  }
  const excludePids = (options.excludePids ?? []).filter(isWin32Pid);
  const deadline = fileTimeAt((options.clock ?? Date.now)() + timeoutMs - KILL_DEADLINE_MARGIN_MS);
  const run = runPowerShell(terminateScript(pid, fileTime, excludePids, deadline), { ...options, timeoutMs });
  // An exact KILL line anywhere proves the destructive phase began; a clean
  // sequence is required for anything stronger than "attempted".
  // `rawLines` are exact lines (no trim): "KILL" must be the whole line.
  const rawLines = String(run.stdout ?? "").split(/\r?\n/);
  const protocol = parseProtocolLines(run.stdout);
  const clean = protocol !== null;
  const killStarted = rawLines.includes("KILL");
  const survivorRows = (protocol ?? []).slice(1).map((line) => /^SURVIVOR (\d+) (\d+)$/.exec(line));
  const failed = (extra) => ({ attempted: true, delivered: false, method: "handle", reason: "kill-failed", ...extra });
  const unverified = () => failed({ survivors: [], unverified: true });
  // The exit code classifies, the protocol refines, a contradiction is unknown:
  // a KILL line next to a pre-kill exit code cannot come from our script.
  if (killStarted && run.status !== 0 && run.status !== WINDOWS_TERMINATION_FAILED_EXIT) {
    return unverified();
  }
  if (run.unavailable) {
    return refused("identity-unavailable");
  }
  switch (run.status) {
    case 0:
      if (clean && protocol.length === 2 && protocol[0] === "KILL" && protocol[1] === "OK") {
        return { attempted: true, delivered: true, method: "handle", reason: "identity-match" };
      }
      return killStarted ? unverified() : refused("identity-unavailable");
    case WINDOWS_PROCESS_MISSING_EXIT:
      return { attempted: false, delivered: false, method: "handle", reason: "process-missing" };
    case WINDOWS_IDENTITY_MISMATCH_EXIT:
      return { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" };
    case WINDOWS_TERMINATION_FAILED_EXIT:
      // A 243 without at least one SURVIVOR row is not the script's answer.
      return clean && protocol.length >= 2 && protocol[0] === "KILL" && survivorRows.every(Boolean)
        ? failed({ survivors: survivorRows.map((row) => ({ pid: Number(row[1]), identity: row[2] === "0" ? null : `win32:${row[2]}` })) })
        : unverified();
    default:
      return refused("identity-unavailable");
  }
}
```

  `terminateScript(pid, fileTime, excludePids, deadlineFileTime)` — массив строк скрипта выше `.join("\n")` с подстановками (`$exclude = @(${excludePids.join(",")})`; пустой список → `@()`).
- [ ] **Step 4:** обновить комментарии/enum в `broker-lifecycle.mjs:318-341` (добавить `process-missing`, убрать «CIM identity is v1.4.0») и README-таблицу причин (`process-missing` — «the pid was provably gone before anything was signalled; the record is cleaned up»; `kill-failed` может нести `survivors`). `tests/commands.test.mjs` README-assertions — проверить.
- [ ] **Step 5: run** → PASS; eslint.
- [ ] **Step 6: второй проход Codex** (контроллер): `/codex:rescue --effort xhigh`, read-only; бриф = spec §2 + §3.4. Замечания → fix-раунд до Task 5.
- [ ] **Step 7: gate + commit** `feat(process): Windows kill from a stored record pins the process, verifies its start time and terminates the verified tree`.

---

### Task 5: Callers на win32 — reaper batch, cancel survivors, бюджеты, сохранение записей, runtime-ожидания, Windows E2E

**Files:**
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs:380-440` (`reapDeadJobs`: win32 batch)
- Modify: `plugins/codex/scripts/lib/job-control.mjs` (новая `cancelDecision`; `readStoredJob` там уже объявлена — не импортировать её из `state.mjs`)
- Modify: `plugins/codex/scripts/codex-companion.mjs:1340-1365` (cancel: `excludePids`, survivors в ответе/логе на win32)
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs` (константы ~22–45; `cleanupSessionJobs` ~98–166 → `export`; teardown ~298–322; существующий `main().catch((error) => { process.stderr.write(…); process.exit(1); })` (~347–350) целиком, без изменений, оборачивается в `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { … }` с `import { pathToFileURL } from "node:url"` — иначе `import` модуля из теста читал бы hook stdin; `.catch` остаётся, чтобы ошибка записи state по-прежнему печаталась одной строкой с exit 1, а не unhandled rejection; `hooks.json` вызывает файл напрямую, поведение хука при прямом запуске не меняется)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:342-380` (`teardownBrokerSession`: опции `platform`, `keepOnUnknown`, `terminateRecordedProcessImpl`; поле `kept`)
- Modify: `plugins/codex/scripts/app-server-broker.mjs` (~294–315, `broker/shutdown`: тестовый knob `CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN=1`)
- Modify: `tests/tracked-jobs.test.mjs:408,417,424` (явный `platform: "linux"`) и `:490` («runTrackedJob records the worker identity…»: на win32 ожидать `^win32:\d+$`, равный `getProcessIdentity(process.pid)` того же процесса, вместо `null`), `tests/broker-stale-pid.test.mjs:1365,1381` (`deepEqual` + `kept: false`)
- Modify: `tests/runtime.test.mjs` (Step 8); `tests/helpers.mjs` (`cimTree`)
- Test: новые тесты в `tests/tracked-jobs.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/runtime.test.mjs`, `tests/job-control.test.mjs` (`cancelDecision`, `renderCancelPending`, `emitCancelPending`), новый `tests/session-lifecycle-hook.test.mjs`; `tests/runtime.test.mjs:1922` (legacy win32 `deepEqual` без `survivors`: поле добавляется в JSON только когда список непуст, поэтому ожидание остаётся верным)

**Interfaces (Consumes):** `getProcessIdentities`, `terminateRecordedProcess` win32 (`process-missing`, `survivors: [{pid, identity}]`, `unverified`, `excludePids`). **Produces:**
- `reapDeadJobs(…, { getProcessIdentitiesImpl })` (только win32-ветка).
- `export function cancelDecision({ pid, kill, alive, platform })` → `{ pending: boolean, reason: string|null, survivors: [{pid, identity}] }` (`lib/job-control.mjs`); на posix `survivors` всегда `[]`, причины как в v1.4.0.
- `teardownBrokerSession(…, { platform, keepOnUnknown, terminateRecordedProcessImpl })` → `{ signalled, reason, kept }`; `export function killStepMs(platform)` в хуке.
- Никаких новых полей в записях job'ов: survivors живут только в ответе `cancel` (win32, когда непусто), в логе job'а и в stderr SessionEnd (spec §3.6).

- [ ] **Step 1: failing tests** (reaper; в файле, где уже тестируется `reapDeadJobs`, тем же способом подготовки записей):

```js
test("reapDeadJobs on win32 probes the live identities in one batch after the cheap checks and fails only the reused pid", () => {
  const workspace = makeTempDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore" });
  try {
    const jobs = [
      { id: "job-a", status: "running", pid: process.pid, pidIdentity: "win32:1" },
      { id: "job-b", status: "running", pid: child.pid, pidIdentity: "win32:2" },
      { id: "job-c", status: "completed", pid: 1, pidIdentity: "win32:9" }
    ];
    for (const job of jobs) writeJobFile(workspace, job.id, job);
    const probes = [];
    const reaped = reapDeadJobs(workspace, jobs, {
      platform: "win32",
      getProcessIdentitiesImpl: (pids) => { probes.push([...pids].sort((a, b) => a - b)); return new Map(pids.map((pid) => [pid, pid === process.pid ? "win32:1" : "win32:other"])); }
    });
    assert.deepEqual(probes, [[process.pid, child.pid].sort((a, b) => a - b)], "one probe, only for records that passed the terminal/liveness checks");
    assert.equal(reaped.find((j) => j.id === "job-a").status, "running");
    assert.equal(reaped.find((j) => j.id === "job-b").status, "failed");
    assert.match(reaped.find((j) => j.id === "job-b").errorMessage, /pid reused/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("reapDeadJobs on win32 leaves every job alone when the batch answers nothing", () => {
  const workspace = makeTempDir();
  const jobs = [{ id: "job-x", status: "running", pid: process.pid, pidIdentity: "win32:1" }];
  writeJobFile(workspace, "job-x", jobs[0]);
  const reaped = reapDeadJobs(workspace, jobs, { platform: "win32", getProcessIdentitiesImpl: () => new Map() });
  assert.equal(reaped[0].status, "running");
});

test("reapDeadJobs on posix keeps its per-pid probe and per-pid budget", () => {
  const seen = [];
  let clock = 0;
  reapDeadJobs(makeTempDir(), [{ id: "j", status: "running", pid: process.pid, pidIdentity: "x:1" }], {
    platform: "linux",
    remainingMs: () => 1500 - clock,
    getProcessIdentityImpl: (pid, opts) => { seen.push(opts.timeoutMs); clock += 700; return "x:1"; },
    getProcessIdentitiesImpl: () => assert.fail("posix must not batch")
  });
  assert.deepEqual(seen, [1500]);
});
```

- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement reaper** — `tracked-jobs.mjs`: импорт `getProcessIdentities` из `./process.mjs` рядом с `getProcessIdentity`; в JSDoc над функцией (`tracked-jobs.mjs:374`) в тип `options` добавить `getProcessIdentitiesImpl?: typeof getProcessIdentities` (иначе `npm run typecheck` даёт TS2339); `reapDeadJobs` целиком (изменения: опция `getProcessIdentitiesImpl`, `probeMs`, `liveIdentityCandidate`, `batch`, ветка `actual`):

```js
export function reapDeadJobs(workspaceRoot, jobs, options = {}) {
  const {
    lockWaitMs,
    remainingMs,
    getProcessIdentityImpl = getProcessIdentity,
    getProcessIdentitiesImpl = getProcessIdentities,
    processCommandLineImpl = processCommandLine,
    platform = process.platform
  } = options;
  const waitFor = () => {
    if (!remainingMs) {
      return lockWaitMs;
    }
    const left = Math.max(0, remainingMs());
    return lockWaitMs === undefined ? left : Math.min(lockWaitMs, left);
  };
  const probeMs = () => (remainingMs ? Math.min(IDENTITY_PROBE_MS, remainingMs()) : IDENTITY_PROBE_MS);
  // The jobs the identity probe can judge: still running by the index and on
  // disk, with a live pid that carries an identity — the same tests the loop
  // below applies, so the batch never probes a pid the loop would not.
  const liveIdentityCandidate = (job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return null;
    }
    const stored = readStoredJobOrNull(workspaceRoot, job.id);
    if (stored && stored.status !== "running" && stored.status !== "queued") {
      return null;
    }
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (!pid || !identity || isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return null;
    }
    return { pid, identity };
  };
  // win32: one PowerShell for every candidate instead of one per job — a cold
  // start costs up to 3 s against a 12 s SessionEnd. posix probes stay per job
  // (a /proc read or one ps). A batch that fails judges nothing.
  // ponytail: each win32 candidate's job file is read twice (here and in the loop).
  let batch = new Map();
  if (platform === "win32") {
    const candidatePids = [...new Set(jobs.map(liveIdentityCandidate).filter(Boolean).map((candidate) => candidate.pid))];
    if (candidatePids.length > 0 && !(remainingMs && remainingMs() < REAP_MIN_STEP_MS)) {
      try {
        batch = getProcessIdentitiesImpl(candidatePids, { platform, timeoutMs: probeMs() });
      } catch {
        batch = new Map();
      }
    }
  }
  const deferred = [];
  const reaped = jobs.map((job) => {
    if (remainingMs && remainingMs() < REAP_MIN_STEP_MS) {
      // Left as-is for the next run — say so, or a job that is dead but still
      // listed as running looks like a live one to whoever reads the decision.
      deferred.push(job.id);
      return job;
    }
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }
    const stored = readStoredJobOrNull(workspaceRoot, job.id);
    if (stored && stored.status !== "running" && stored.status !== "queued") {
      // Terminal on disk: markJobDead keeps the real result and reconciles it
      // into the index rather than failing the job.
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    // The queued record carries no pid of its own — the parent records it in an
    // atomic sidecar instead of rewriting the worker's job file.
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    // Alive is not enough: the pid may now belong to another process (#743).
    // A probe that fails or times out proves nothing, so the job is left alone.
    if (pid && identity) {
      let actual = null;
      if (platform === "win32") {
        actual = batch.get(pid) ?? null;
      } else {
        try {
          actual = getProcessIdentityImpl(pid, { timeoutMs: probeMs() });
        } catch {
          actual = null;
        }
      }
      if (actual && actual !== identity) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (pid reused: ${pid} now belongs to another process)`, waitFor());
      }
    } else if (pid && platform !== "win32") {
      // A legacy record has no identity; a readable command line that is plainly
      // not a companion is proof enough to stop waiting on it. Nothing is signalled.
      let commandLine = null;
      try {
        commandLine = processCommandLineImpl(pid, { timeoutMs: probeMs() });
      } catch {
        commandLine = null;
      }
      if (typeof commandLine === "string" && commandLine && !commandLine.includes("codex-companion.mjs")) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (worker pid ${pid} now belongs to an unrelated process)`, waitFor());
      }
    }
    return job;
  });
  if (deferred.length > 0) {
    process.stderr.write(`[codex] Reaper ran out of budget; not judged this run: ${deferred.join(", ")}.\n`);
  }
  return reaped;
}
```

  Старые inject-тесты (`tests/tracked-jobs.test.mjs:408,417,424`) получают явный `platform: "linux"`; тест `:490` на win32 ожидает `^win32:\d+$` (см. Files).

- [ ] **Step 4: `cancelDecision` + cancel** (`lib/job-control.mjs`):

```js
// What cancel does with a kill outcome. posix keeps its v1.4.0 answer; win32
// treats survivors and an unverified attempt as "not cancelled": the job stays
// running and the survivors are reported, never followed by a record (spec §1).
export function cancelDecision({ pid, kill, alive, platform = process.platform }) {
  if (!pid) {
    return { pending: false, reason: null, survivors: [] };
  }
  const win32Unknown = platform === "win32" && kill.attempted && (kill.survivors?.length > 0 || kill.unverified === true);
  const stillHere = (!kill.attempted || !kill.delivered) && alive === true;
  if (!stillHere && !win32Unknown) {
    return { pending: false, reason: null, survivors: [] };
  }
  const reason = kill.attempted ? (platform === "win32" ? "kill-failed" : "not-delivered") : kill.reason;
  return { pending: true, reason, survivors: platform === "win32" ? (kill.survivors ?? []) : [] };
}
```

  Тест-таблица (`tests/process.test.mjs` или `tests/job-control.test.mjs`): `[{attempted:true,delivered:true}, alive:false] → not pending`; `[{attempted:true,delivered:false,survivors:[{pid:4301,identity:"win32:7"}]}, alive:false, win32] → pending "kill-failed" survivors [{4301,…}]`; то же на `linux` → not pending (posix как v1.4.0); `[{attempted:false,reason:"identity-unavailable"}, alive:true] → pending "identity-unavailable"`; `[{attempted:true,delivered:false,unverified:true}, alive:false, win32] → pending`; `[{attempted:false,reason:"process-missing"}, alive:false] → not pending`; `[{attempted:true,delivered:false}, alive:true, linux] → pending "not-delivered"`.
  В `lib/job-control.mjs` рядом с `cancelDecision` (строки ниже — полностью, без сокращений; текст pending и строка лога скопированы из `codex-companion.mjs:1348–1353` v1.4.0 байт-в-байт):

```js
// Pending cancel, rendered once for the three sinks. On posix `survivors` is
// always [] and `reason` is v1.4.0's, so json/text/logLine are byte-identical
// to v1.4.0 there; only win32 adds a survivors suffix and a stderr diagnostic.
export function renderCancelPending(decision, pid, jobId) {
  const survivors = decision.survivors ?? [];
  const pending = `cancellation not confirmed: worker pid ${pid} left running (${decision.reason})`;
  const survivorText = survivors.map((s) => `${s.pid}:${s.identity ?? "unknown"}`).join(" ");
  const suffix = survivors.length > 0
    ? ` worker tree survivors: ${survivorText}`
    : decision.reason === "kill-failed" ? " (unverified)" : "";
  return {
    json: { jobId, status: "running", cancellationPending: true, reason: decision.reason, ...(survivors.length > 0 ? { survivors } : {}) },
    text: `${pending}\nThe turn interrupt was sent; the job stays running until the worker exits. Re-run cancel or wait for result.\n`,
    logLine: `${pending}${suffix}`,
    diagnostic: survivors.length > 0 ? `[codex] worker tree survivors: ${survivorText}\n` : null,
  };
}

// The caller's side of a pending cancel: one JSON document or the text on
// stdout, the diagnostic (if any) on stderr, one line in the job log.
export function emitCancelPending(decision, pid, jobId, { json, appendLog, stdout = process.stdout, stderr = process.stderr }) {
  const rendered = renderCancelPending(decision, pid, jobId);
  appendLog(rendered.logLine);
  if (rendered.diagnostic) {
    stderr.write(rendered.diagnostic);
  }
  stdout.write(json ? `${JSON.stringify(rendered.json, null, 2)}\n` : rendered.text);
  return rendered;
}
```

  В `codex-companion.mjs` (~1340): импортировать `loadBrokerSession` (`./lib/broker-lifecycle.mjs`), `cancelDecision` и `emitCancelPending` (`./lib/job-control.mjs`); заменить существующую строку `const kill = terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id) });` (1342) и блок `if (pid && (!kill.attempted || !kill.delivered) && isPidAlive(pid) === true) { … }` (1346–1356) — вместе, чтобы `kill` объявлялся один раз — на:

```js
  const brokerPid = process.platform === "win32" ? loadBrokerSession(workspaceRoot)?.pid : null;
  const kill = terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id), excludePids: Number.isInteger(brokerPid) ? [brokerPid] : [] });
  // A worker we may not signal, or whose signal reached nothing, but that is
  // still alive is not cancelled: the job stays running, and the sidecar stays
  // so a later cancel or the reaper can still find it.
  const decision = cancelDecision({ pid, kill, alive: isPidAlive(pid) });
  if (decision.pending) {
    emitCancelPending(decision, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
    process.exitCode = 1;
    return;
  }
```

  (`JSON.stringify(rendered.json, null, 2)` + `\n` = то, что `outputResult` печатал через `console.log`, поэтому posix-вывод `cancel --json` не меняется; существующие posix-тесты cancel и legacy win32-тест `runtime.test.mjs:1922` проходят без правок.)

  Тесты (`tests/job-control.test.mjs`, рядом с таблицей `cancelDecision`):
  - `renderCancelPending({ pending: true, reason: "kill-failed", survivors: [{ pid: 4301, identity: "win32:7" }] }, 4300, "job-1")` → `json.survivors` deepEqual списку, `logLine` заканчивается на ` worker tree survivors: 4301:win32:7`, `diagnostic === "[codex] worker tree survivors: 4301:win32:7\n"`;
  - `renderCancelPending({ pending: true, reason: "kill-failed", survivors: [] }, 4300, "job-1")` → нет поля `survivors`, `logLine` заканчивается на ` (unverified)`, `diagnostic === null`;
  - `renderCancelPending({ pending: true, reason: "not-delivered", survivors: [] }, 4300, "job-1")` → `json` deepEqual `{ jobId: "job-1", status: "running", cancellationPending: true, reason: "not-delivered" }`, `logLine === "cancellation not confirmed: worker pid 4300 left running (not-delivered)"`, `diagnostic === null` (posix v1.4.0);
  - `emitCancelPending` с survivors и `json: true` и подменёнными writer'ами (`{ write: (chunk) => out.push(chunk) }` для stdout/stderr, `appendLog: (l) => log.push(l)`): `out` — ровно один chunk, `JSON.parse(out[0])` возвращает объект с `survivors`; `err` — ровно один chunk `[codex] worker tree survivors: 4301:win32:7\n`; `log` — одна строка с суффиксом survivors; тот же вызов с `json: false` → `out[0]` равен `rendered.text`, stderr тот же. Это и есть доказательство, что диагностика никогда не попадает в stdout; существующий `runtime.test.mjs:1954` (identity-mismatch без survivors) остаётся как posix-регрессия.

- [ ] **Step 5: хук** — `session-lifecycle-hook.mjs`: импорт `pathToFileURL` из `node:url`; после константы `IDENTITY_PROBE_MS` (~45):

```js
// Kill budget per job: a Windows kill is one PowerShell run (pin, verify, kill
// the tree, wait) and needs more than a posix signal plus probe.
export function killStepMs(platform = process.platform) {
  return platform === "win32" ? 4000 : IDENTITY_PROBE_MS;
}
```

  `cleanupSessionJobs` целиком (изменения: `export`, `deps`, `killStepMs(platform)`, `outcome` до `try`, `excludePids`, `unresolved`):

```js
export function cleanupSessionJobs(cwd, sessionId, lockWaitMs, remainingMs, deps = {}) {
  const { platform = process.platform, terminateRecordedProcessImpl = terminateRecordedProcess, brokerPid = null } = deps;
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // One locked read-modify-write: the jobs this decides to stop and the list it
  // writes back have to come from the same snapshot, or another session's job —
  // created between the read and the write — is dropped from the index and its
  // files are pruned with it.
  withStateLock(workspaceRoot, () => {
    const state = loadState(workspaceRoot);
    const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    if (sessionJobs.length === 0) {
      return;
    }

    // A record is only dropped once its worker is stopped or provably gone; one
    // this hook refused to signal, failed to signal or never reached stays, so
    // the worker is not orphaned and `activeWorkspaceJobs` still sees it.
    const kept = new Set();
    for (const job of sessionJobs) {
      // Background jobs are explicitly dispatched to outlive the session that
      // started them. Leave them running and leave their state entry intact so
      // any session in the workspace can still poll for status/results.
      if (job.background) {
        continue;
      }
      const stillRunning = job.status === "queued" || job.status === "running";
      if (!stillRunning) {
        continue;
      }
      // Only a pid still provably this job's process is signalled (#743). posix
      // proves it with up to two probes; win32 pins, verifies and kills the tree
      // in one PowerShell run, so its step is longer (killStepMs).
      const probeMs = Math.floor(Math.min(killStepMs(platform), remainingMs() / 2));
      let reason = "budget-exhausted";
      let outcome = null;
      if (probeMs >= MIN_STEP_MS) {
        let pid;
        try {
          const recorded = resolveJobPid(workspaceRoot, job);
          pid = recorded.pid;
          outcome = terminateRecordedProcessImpl(pid, {
            identity: recorded.identity,
            commandLineMatch: workerCommandLine(job.id),
            timeoutMs: probeMs,
            // The shared broker can be this worker's child on Windows: never in its tree.
            excludePids: Number.isInteger(brokerPid) ? [brokerPid] : []
          });
          reason =
            outcome.reason === "no-pid" || (outcome.attempted && outcome.delivered)
              ? null
              : outcome.attempted
                ? platform === "win32"
                  ? outcome.reason
                  : "not-delivered"
                : outcome.reason;
        } catch {
          reason = "kill-failed";
        }
        // A dead root settles it on posix. On win32 a tree with survivors, or a
        // kill whose outcome is unknown, keeps the record whatever the root did:
        // the next SessionEnd judges it again (no survivor records — spec §1).
        const unresolved = platform === "win32" && ((outcome?.survivors?.length ?? 0) > 0 || outcome?.unverified === true);
        if (reason && isPidAlive(pid) === false && !unresolved) {
          reason = null;
        }
        if (unresolved) {
          reason = reason ?? "kill-failed";
          process.stderr.write(
            `[codex] SessionEnd left ${job.id} tree survivors: ${(outcome.survivors ?? []).map((s) => `${s.pid}:${s.identity ?? "unknown"}`).join(" ") || "unverified"}\n`
          );
        }
      }
      if (reason) {
        kept.add(job.id);
        process.stderr.write(`[codex] SessionEnd left ${job.id} running: ${reason}\n`);
      }
    }

    saveState(workspaceRoot, {
      ...state,
      jobs: state.jobs.filter((job) => job.sessionId !== sessionId || job.background || kept.has(job.id))
    });
  }, { waitMs: lockWaitMs });
}
```

  В `handleSessionEnd` (~218) вызов становится `cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV], stepBudget(STATE_LOCK_STEP_MS), remainingMs, { brokerPid: process.platform === "win32" ? pid : null });` (`pid` — pid брокера из `brokerSession`, объявлен выше). Teardown (~298–322):

```js
  const teardown = teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    pidIdentity,
    killProcess: terminateProcessTree,
    // posix halved: a broker gone from its group is re-proved with a second
    // probe. win32: one PowerShell run does verify and kill, hence the kill step.
    timeoutMs: process.platform === "win32" ? stepBudget(killStepMs()) : Math.floor(stepBudget(IDENTITY_PROBE_MS) / 2),
    // An unknown outcome keeps the broker's records for the next SessionEnd.
    keepOnUnknown: true
  });
  // Every branch of this hook says what it decided: when a broker outlives a
  // SessionEnd the only question worth asking is which of these paths ran.
  process.stderr.write(
    `[codex] Broker teardown: endpoint=${brokerEndpoint ?? "none"} pid=${pid ?? "none"} signalled=${teardown.signalled} reason=${teardown.reason} kept=${teardown.kept} busyRetries=${busyRetries} budgetExhausted=false\n`
  );

  // A replacement broker can have started — and recorded itself — while this one
  // was shutting down. Clearing unconditionally would delete the live broker's
  // ownership record, which is exactly what the broker's own endpoint-guarded
  // `clearOwnSessionRecord` avoids on its side. A kept record is kept here too.
  if (!teardown.kept && loadBrokerSession(cwd)?.endpoint === brokerEndpoint) {
    clearBrokerSession(cwd);
  }
```

  Конец файла (~347–350): существующий `main().catch(...)` без изменений внутри `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { … }`.

  Бюджет: на win32 kill каждого job'а ≤ `min(4000, remaining/2)` — с 12 s хватает на два job'а и teardown; остальное — `budget-exhausted` как сегодня.

  Тесты (`tests/session-lifecycle-hook.test.mjs`, новый; импорт `{ cleanupSessionJobs, killStepMs }` из `../plugins/codex/scripts/session-lifecycle-hook.mjs`, `{ loadState, upsertJob }` из `../plugins/codex/scripts/lib/state.mjs`, `makeTempDir` из `./helpers.mjs`; записи сажаются как в `tests/tracked-jobs.test.mjs` — `upsertJob(repo, { id, status: "running", sessionId, background: false, pid: 4300, pidIdentity: "win32:1", … })` с теми же обязательными полями, что там):

```js
test("killStepMs gives a Windows kill one PowerShell run's worth of budget", () => {
  assert.equal(killStepMs("win32"), 4000);
  assert.equal(killStepMs("linux"), 2000);
});

test("SessionEnd keeps a job whose tree left survivors and drops one whose kill settled", () => {
  const cases = [
    ["win32", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 4301, identity: "win32:7" }] }, true, /tree survivors: 4301:win32:7/],
    ["win32", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }, true, /tree survivors: unverified/],
    ["linux", { attempted: true, delivered: false, reason: "not-delivered" }, false, null],
    ["win32", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }, false, null],
    ["win32", { attempted: false, delivered: false, reason: "no-pid" }, false, null]
  ];
  // A pid that is provably dead: a child that has already exited (reaped by
  // spawnSync), so no table row depends on which pids the host happens to use.
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
  for (const [platform, outcome, keptExpected, stderrPattern] of cases) {
    const repo = makeTempDir();
    const sessionId = "session-1";
    upsertJob(repo, { id: "job-1", status: "running", sessionId, background: false, pid: deadPid, pidIdentity: platform === "win32" ? "win32:1" : "linux:1" });
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      cleanupSessionJobs(repo, sessionId, 1000, () => 8000, { platform, terminateRecordedProcessImpl: () => outcome, brokerPid: 555 });
    } finally {
      process.stderr.write = original;
    }
    const remaining = loadState(repo).jobs.map((job) => job.id);
    assert.deepEqual(remaining, keptExpected ? ["job-1"] : [], `${platform} ${JSON.stringify(outcome)}`);
    if (stderrPattern) {
      assert.match(written.join(""), stderrPattern);
    }
  }
});

test("SessionEnd passes the broker pid as the excluded subtree", () => {
  const repo = makeTempDir();
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  let seen = null;
  cleanupSessionJobs(repo, "s", 1000, () => 8000, { platform: "win32", brokerPid: 555, terminateRecordedProcessImpl: (pid, options) => { seen = options; return { attempted: true, delivered: true, method: "handle", reason: "identity-match" }; } });
  assert.deepEqual(seen.excludePids, [555]);
  assert.ok(seen.timeoutMs <= 4000 && seen.timeoutMs >= 100);
});
```

  (Импорт `spawnSync` из `node:child_process`. Если `upsertJob` требует полей, которых нет в примере, — взять минимальный набор из существующего теста `tests/tracked-jobs.test.mjs`, где записи сажаются для `reapDeadJobs`. Третий тест использует тот же `deadPid` вместо `4300`.)

- [ ] **Step 6: `teardownBrokerSession` kept** — `broker-lifecycle.mjs` (`process` уже импортирован; `terminateRecordedProcess` тоже), функция целиком:

```js
export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  pidIdentity = null,
  killProcess = null,
  timeoutMs = undefined,
  ownsProcess = ownsBrokerProcess,
  platform = process.platform,
  keepOnUnknown = false,
  terminateRecordedProcessImpl = terminateRecordedProcess
}) {
  let signalled = false;
  let reason = "no-pid";
  let outcome = null;
  if (Number.isFinite(pid) && killProcess) {
    try {
      outcome = terminateRecordedProcessImpl(pid, {
        identity: pidIdentity,
        commandLineMatch: (commandLine) => ownsProcess(pid, endpoint, timeoutMs, commandLine),
        timeoutMs,
        terminateImpl: (target) => killProcess(target)
      });
      signalled = outcome.attempted && outcome.delivered;
      reason = outcome.reason;
    } catch {
      // Ignore missing or already-exited broker processes.
      reason = "kill-failed";
    }
  }

  // win32 only: an outcome that proves nothing about the broker — no probe, a
  // kill that did not verify, survivors — keeps every record when the caller
  // asks (SessionEnd), so the next SessionEnd can try again. A missing or
  // foreign process is a settled answer and is cleaned up as before; a dead
  // root does not settle an unknown outcome.
  const unknown =
    platform === "win32" &&
    (["identity-unavailable", "kill-failed"].includes(reason) || outcome?.unverified === true || (outcome?.survivors?.length ?? 0) > 0);
  const kept = keepOnUnknown && !signalled && unknown;
  if (kept) {
    return { signalled, reason, kept };
  }

  // Best-effort: a self-cleaning broker or a locked file must not fail the hook.
  if (pidFile) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
      // upstream #633/#626 report EPERM here on Windows).
    }
  }

  if (logFile) {
    try {
      fs.unlinkSync(logFile);
    } catch {
      // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
      // upstream #633/#626 report EPERM here on Windows).
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown
      // (this already swallowed ENOENT, and every other error, before this fix).
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }

  return { signalled, reason, kept: false };
}
```

  `ensureBrokerSession` вызывает teardown **без** `keepOnUnknown` (stale replacement не меняется). Обновить `deepEqual` в `tests/broker-stale-pid.test.mjs:1365,1381` (`kept: false`). Тесты (`tests/broker-stale-pid.test.mjs`, рядом с существующими teardown-тестами; `sessionDir` через `makeTempDir()`, `pidFile`/`logFile` — файлы в нём, `killProcess: () => {}`):

```js
test("teardownBrokerSession keeps the records on Windows when the outcome is unknown and asked to", () => {
  const cases = [
    ["win32", true, { attempted: false, delivered: false, reason: "identity-unavailable" }, true],
    ["win32", true, { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 7, identity: "win32:9" }] }, true],
    ["win32", true, { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }, true],
    ["win32", true, { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, false],
    ["win32", true, { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }, false],
    ["win32", false, { attempted: false, delivered: false, reason: "identity-unavailable" }, false],
    ["linux", true, { attempted: false, delivered: false, reason: "identity-unavailable" }, false]
  ];
  for (const [platform, keepOnUnknown, outcome, keptExpected] of cases) {
    const sessionDir = makeTempDir();
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    fs.writeFileSync(pidFile, "999999");
    fs.writeFileSync(logFile, "");
    const result = teardownBrokerSession({ pidFile, logFile, sessionDir, pid: 999999, pidIdentity: "win32:1", killProcess: () => {}, timeoutMs: 1000, platform, keepOnUnknown, terminateRecordedProcessImpl: () => outcome });
    assert.equal(result.kept, keptExpected, `${platform} keepOnUnknown=${keepOnUnknown} ${JSON.stringify(outcome)}`);
    assert.equal(result.reason, outcome.reason);
    assert.equal(fs.existsSync(pidFile), keptExpected, "records survive exactly when kept");
    assert.equal(fs.existsSync(logFile), keptExpected);
  }
  // No pid at all is settled: nothing to keep.
  const sessionDir = makeTempDir();
  assert.deepEqual(teardownBrokerSession({ pidFile: null, logFile: null, sessionDir, pid: null, killProcess: () => {}, platform: "win32", keepOnUnknown: true }), { signalled: false, reason: "no-pid", kept: false });
});
```

- [ ] **Step 7: broker knob** — в обработчике `broker/shutdown` (`app-server-broker.mjs` ~306–314) сразу **после** блока `if (busy) { … continue; }` и **перед** существующей строкой `send(socket, { id: message.id, result: {} });` (ответ отправляется один раз — либо knob'ом, либо существующей строкой):

```js
          // Test knob (Windows E2E only): acknowledge the shutdown and stay up,
          // so SessionEnd has to go through the recorded-pid kill path.
          if (process.platform === "win32" && process.env.CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN === "1") {
            send(socket, { id: message.id, result: {} });
            process.stderr.write("[broker] test knob: acknowledged shutdown, staying up\n");
            continue;
          }
```

  Только для тестов; README не упоминать.
- [ ] **Step 8: runtime win32-ожидания** — `tests/runtime.test.mjs`: ~1914–1920 оставить (legacy без identity); ~2167 `cancel sends turn interrupt`: убрать `IS_WIN && status === 1`; ~2436–2476 «session end preserves background jobs»: убрать win32-ветку; ~3885–3895 turn-timeout/cancel: убрать `if (IS_WIN)`, общий путь `status 0`, `/cancelled/i`, `assert.equal(await exited, 1)`; «session end fully cleans up jobs»: без win32-ветки; снять skip с 2004 (regex → `/^(linux|darwin|win32):/`) и 4115; оставить skip на 1954 и 3906. На уровне модуля: `import { isPidAlive } from "../plugins/codex/scripts/lib/process.mjs"; const isAlive = (pid) => isPidAlive(pid) === true;` (локальный одноимённый helper — переименовать).
- [ ] **Step 9: helper `cimTree`** (`tests/helpers.mjs`, только для Windows-тестов; бросает при ошибке, а не возвращает `[]`):

```js
// Every pid under `rootPid` by ParentProcessId (BFS), with a coarse executable
// class — for Windows-only tests that assert a whole tree died or survived.
// Runs through the plugin's own launcher (validated root, clean env, System32
// cwd, -EncodedCommand) and speaks its protocol: `NODE <pid>`, `CMD <pid>` or
// `OTHER <pid>` per node, nothing else. Throws when the enumeration fails or the
// output is not clean: a silent [] would make "everything is gone" vacuously true.
export function cimTree(rootPid, env = process.env) {
  const script = `$ErrorActionPreference = 'Stop'; $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name); $q = @(${rootPid}); $seen = @{}; while ($q.Count -gt 0) { $p = $q[0]; $q = @($q | Select-Object -Skip 1); if ($seen.ContainsKey($p)) { continue }; $seen[$p] = $true; $row = $all | Where-Object { $_.ProcessId -eq $p } | Select-Object -First 1; if ($row) { $w = if ($row.Name -match '^(?i)node\\.exe$') { 'NODE' } elseif ($row.Name -match '^(?i)cmd\\.exe$') { 'CMD' } else { 'OTHER' }; [Console]::Out.WriteLine($w + ' ' + [int]$row.ProcessId) }; foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) { $q += [int]$c.ProcessId } }`;
  resetWindowsIdentityCircuit();
  const run = runPowerShell(script, { env, timeoutMs: 20000 });
  const lines = run.unavailable || run.status !== 0 ? null : parseProtocolLines(run.stdout);
  if (lines === null) {
    throw new Error(`cimTree failed: status ${run.status} unavailable ${run.unavailable} timedOut ${run.timedOut}\n${run.stdout}`);
  }
  return lines.map((line) => {
    const row = /^(NODE|CMD|OTHER) (\d+)$/.exec(line);
    if (!row) {
      throw new Error(`cimTree: unexpected line ${JSON.stringify(line)}`);
    }
    return { pid: Number(row[2]), name: row[1] === "NODE" ? "node.exe" : row[1] === "CMD" ? "cmd.exe" : "other" };
  });
}
```

  (`tests/helpers.mjs` импортирует `runPowerShell`, `parseProtocolLines`, `resetWindowsIdentityCircuit` из `../plugins/codex/scripts/lib/process.mjs`; `resetWindowsIdentityCircuit` перед вызовом — чтобы breaker, сработавший в предыдущем тесте, не превратил enumeration в ложный throw. Имена `node.exe`/`cmd.exe` сохранены ради существующих `/^cmd\.exe$/i` в Step 10.)

- [ ] **Step 10: Windows-only E2E** (`{ skip: !IS_WIN, timeout: 90_000 }`, `tests/runtime.test.mjs`; `ROOT` — уже объявленный локально в `tests/runtime.test.mjs:25` (helpers его не экспортирует); импорты `cimTree`, `upsertJob`, `loadBrokerSession`, `resolveStateDir`, `pathToFileURL`; `SESSION_HOOK` уже есть; во всех тестах `t.after` для root регистрируется **сразу после получения pid**, для дерева — сразу после `cimTree`):

```js
test("cancel on Windows kills a direct worker and the codex.cmd tree under it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // A cold resume owns its own app-server, so the tree hangs under the worker, not the broker.
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pidIdentity && j.threadId && j.turnId ? j : null; });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  const tree = cimTree(running.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(tree.some((n) => /^cmd\.exe$/i.test(n.name)) && tree.filter((n) => /^node\.exe$/i.test(n.name)).length >= 2, `expected worker → cmd.exe → node.exe, got ${JSON.stringify(tree)}`);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => (tree.every((n) => !isAlive(n.pid)) ? "gone" : null));
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled");
});

test("cancel on Windows leaves the shared broker and its subtree alive, and the same app-server serves the next job", { skip: !IS_WIN, timeout: 120_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold A"], { cwd: repo, env });
  const jobA = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.status === "running" && j.turnId ? j : null; });
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, "worker A started the shared broker");
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  const brokerTree = cimTree(broker.pid);
  t.after(() => { for (const { pid } of brokerTree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(brokerTree.some((n) => /^cmd\.exe$/i.test(n.name)), `expected the app-server tree under the broker, got ${JSON.stringify(brokerTree)}`);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  // The broker is A's child by ParentProcessId on Windows; the kill must skip its whole subtree.
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => (!isAlive(withPid.pid) ? "gone" : null));
  assert.equal(isAlive(broker.pid), true, "the shared broker survives a worker kill");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "the broker's subtree survives");
  // The same app-server still serves: the fake holds every turn 60 s, so bound the next job by the turn timeout
  // and prove it went through the existing app-server (no second start) rather than a direct fallback.
  const next = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "3000", "--json", "quick C"], { cwd: repo, env, timeout: 60000 });
  assert.equal(next.error, undefined);
  assert.equal(next.status, 1, next.stderr);
  // The foreground JSON carries only the payload; the stored job carries the outcome.
  const jobC = readPersistedJob(repo);
  assert.notEqual(jobC.id, jobA);
  assert.match(jobC.errorMessage ?? "", /turn timed out after 3000 ms/, "the next job really ran a turn (and hit its budget)");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1, "no second app-server was started for the next job");
  assert.equal(fakeState.lastTurnStart?.prompt, "quick C", "the turn went through the existing app-server");
  assert.equal(loadBrokerSession(repo)?.pid, broker.pid, "no replacement broker was started");
});

test("a root that died before cancel is failed by the reaper on Windows; nothing is signalled by number", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.turnId ? j : null; });
  const tree = cimTree(withPid.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  process.kill(withPid.pid, "SIGKILL");
  await waitFor(() => (!isAlive(withPid.pid) ? "dead" : null));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0, "the reaper already failed the job; cancel has nothing active to signal");
  assert.equal(readPersistedJob(repo, jobId).status, "failed");
  // The orphaned children are the documented limitation here: nothing is touched by number.
  assert.ok(tree.filter((n) => n.pid !== withPid.pid).some((n) => isAlive(n.pid)));
});

test("a reused-looking identity is never signalled on Windows: the reaper fails the job and cancel reports it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pidIdentity ? j : null; });
  upsertJob(repo, { id: jobId, pidIdentity: "win32:1" });
  const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0);
  assert.equal(isAlive(withPid.pid), true, "the process holding the pid is a stranger to this record and must stay");
  const stored = readPersistedJob(repo, jobId);
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage ?? "", /pid reused/);
});

test("SessionEnd tears down a broker that acknowledged shutdown but stayed up, by its recorded identity", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { CODEX_COMPANION_SESSION_ID: "sess-win", CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const broker = await waitFor(() => loadBrokerSession(repo));
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  assert.match(broker.pidIdentity ?? "", /^win32:\d+$/);
  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "sess-win" }) });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stderr, /Broker teardown: .*signalled=true reason=identity-match/);
  await waitFor(() => (!isAlive(broker.pid) ? "gone" : null));
  assert.equal(loadBrokerSession(repo), null);
});

test("a planted PowerShell in the workspace or a relative PATH entry is never what the identity probe runs", { skip: !IS_WIN, timeout: 90_000 }, () => {
  const repo = makeTempDir(); fs.mkdirSync(path.join(repo, "tools"));
  const marker = path.join(repo, "HIJACKED");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(repo, "powershell.exe"));
  for (const planted of ["powershell.cmd", path.join("tools", "powershell.cmd"), path.join("tools", "powershell.exe.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), `@echo off\r\necho x> "${marker}"\r\n`);
  }
  const testEnvUrl = pathToFileURL(path.join(ROOT, "tests", "test-env.mjs")).href;
  const processUrl = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "process.mjs")).href;
  const probe = run(process.execPath, ["--import", testEnvUrl, "-e", `import(${JSON.stringify(processUrl)}).then(m => console.log(m.getProcessIdentity(process.pid) ?? 'null'))`], {
    cwd: repo, env: { ...process.env, PATH: `.;tools;${process.env.PATH}`, PSModulePath: path.join(repo, "tools") }
  });
  assert.match(probe.stdout.trim(), /^win32:\d+$/, probe.stderr);
  assert.equal(fs.existsSync(marker), false);
});
```

- [ ] **Step 11: gate + commit** `feat(runtime): Windows workers and brokers are killed from their records; survivors are reported, unknown outcomes are kept`. Push; контроллер диспатчит CI — Windows-джобы зелёные с leak-шагом 0 = доказательство Task 3–5.

---

### Task 6: Документация

**Files:**
- Modify: `README.md` («### Windows», ~385–395: удалить «Still limited until v1.4.1 …»; исправить два утверждения про `where.exe` (строки 389 и 393 — с v1.4.0 `codex`/`npm`/`git` ищутся файловым `resolveExecutable` по абсолютным записям `PATH` × `PATHEXT`, относительные записи `PATH` и cwd пропускаются, `where.exe` не вызывается; требования: только `cmd.exe` для `.cmd`-шимов и, с v1.4.1, Windows PowerShell 5.1 in-box); добавить потолки из `process.mjs:57–64`: аргумент с CR/LF отвергается ошибкой, `%VAR:a=b%` внутри аргумента `.cmd`-шима остаётся документированным ограничением; требования: Windows PowerShell 5.1 in-box; Constrained Language Mode/AppLocker → kill из записи отказывает (`identity-unavailable`), записи брокера сохраняются до следующей попытки; потомки, появившиеся после снимка, вне гарантии; **survivor kill'а, переживший смерть root, — известная утечка без верхней границы и без повторной попытки: pid и identity в ответе/логе — диагностика для оператора**; общий брокер никогда не убивается вместе с worker'ом), таблица причин (`process-missing`, `kill-failed` с survivors, метод `handle`).
- Modify: `CHANGELOG.md` + `plugins/codex/CHANGELOG.md` (`## 1.4.1 — <день релизного коммита>`: Fixed — kill из записей на Windows через закреплённые handle'ы (#743 win32, #423/#577, #336, #416, #487, #718), leak-шаг обязателен; Changed — `status` на Windows делает одну пробу на все живые job'ы; survivors kill'а сообщаются с identity (`cancellationPending` + `survivors`), job не считается cancelled при живом root; сопровождение survivors записями — вне v1.4.1; записи брокера сохраняются при неизвестном исходе SessionEnd (Windows); ps-guard `≤ 0`; `teardownBrokerSession` результат содержит `kept`).
- Modify: `docs/superpowers/triage/2026-09-27-upstream-triage.md` — статусы `fixed-in v1.4.1`.
- Test: `tests/commands.test.mjs` README-assertions.

- [ ] **Step 1**: правки; `cp CHANGELOG.md plugins/codex/CHANGELOG.md`; `node scripts/check-changelog.mjs`.
- [ ] **Step 2: gate + commit** `docs: Windows kill path, 1.4.1 changelog, triage statuses`.

---

### Task 7: Release v1.4.1

- [ ] `node scripts/bump-version.mjs 1.4.1 && npm run check-version && npm run check:changelog` (дата в заголовке = день релиза).
- [ ] `npm run check` + leak-check + `claude plugin validate . --strict` + `npm audit --omit=dev` + `npm pack --dry-run`; принять Dependabot-PR по `qs`, если открыт (после merge — `git pull` в worktree и повторный гейт).
- [ ] Whole-branch Claude review (Opus), затем `/codex:adversarial-review --base main --effort max` с брифом по spec §2/§3.4 и «PID reuse», «CLM», «поддерево брокера», «survivors»; DO-NOT-SHIP блокирует; закладывать 3–5 проходов.
- [ ] Финальный CI на релизном SHA: 9 джобов + quality, Windows leak-шаг 0.
- [ ] По команде пользователя: PR → merge → tag → `npm pack` + sha256 → `gh release create` → `claude plugin update codex@cbepx`; smoke в свежей сессии.
- [ ] Черновик `docs/superpowers/triage/upstream-comments-v1.4.1.md` (#743 win32, #423/#577, #336, #416, #487, #718; #70 только если UNC подтверждён; retest-просьбы #113 #236 #285 #295 #310) → одобрение → `gh issue comment`; статусы; архив SDD в `docs/superpowers/reports/v1.4.1/`; удалить worktree/ветку.

## Self-review

- Spec coverage: §2 → Task 2 (root/env/cwd/launch/protocol/breaker/PID-range); §3.1 → Task 3/4 (`.Handle` + `StartTime`); §3.2 → Task 2; §3.3 → Task 3 + Task 5 reaper (win32-only, отдельная fixture для пустой Map); §3.4 → Task 4 (guard CLM, pin, 241/242/243/244, exact Int64 µs UTC, child pin error → 244, `excludePids`/`app-server-broker.mjs`, `KILL`/`OK`/`SURVIVOR pid filetime`, absolute deadline, без внешних программ); §3.5 → без кода (E2E проверяет `win32:` в записях); §3.6 → Task 5 Step 4 (`cancelDecision` win32-only, `excludePids`, survivors в ответе/логе, без записей) + E2E (direct tree kill, broker survives + same app-server serves next job via `appServerStarts`, root-dead → reaper contract); §3.7 → Task 5 Steps 5–7 (whole-tree `kept` по текущему исходу, `keepOnUnknown` только из хука); §3.8 → Task 1; §4 → тесты Task 1–5 (B8-исправления: счёт pid по аргументу `-Id`, отдельная fixture, сериализованные абсолютные file URL, `isAlive` через `isPidAlive`, явный `platform` в трёх старых inject-тестах и win32-ожидание в тесте `runTrackedJob records the worker identity`, `kept: false` в `deepEqual`, `cimTree` реализован в helpers с таймаутом и ошибкой вместо `[]`, `let outcome` вне `try` в хуке и teardown); §5 → Task 6 + breaker; §6 → Task 1, Task 5 Step 4 (posix cancel без изменений) и Step 6.
- Placeholder scan: все шаги с кодом/командами; условных E2E больше нет (`--background --resume-last` поддерживается: cold resume даёт прямой транспорт).
- Type consistency: `runPowerShell` → `{ status, stdout, timedOut, unavailable }` (Task 2/3/4); `parseProtocolLines` → `string[]|null` (Task 2/3/4); `getProcessIdentities` → `Map<number,string|null>` (Task 3/5); `terminateRecordedProcess` win32 → `{ attempted, delivered, method?, reason, survivors?, unverified? }` (Task 4/5); `fileTimeAt(ms)` (Task 4); `cancelDecision` → `{ pending, reason, survivors: [{pid, identity}] }` (Task 5); `survivors` из Task 4 — `[{pid, identity|null}]`; `teardownBrokerSession(…, { platform, keepOnUnknown, terminateRecordedProcessImpl })` → `{ signalled, reason, kept }` (Task 5); `killStepMs(platform)` (Task 5); `cimTree(pid)` → `[{pid,name}]` (Task 5); `isWin32Pid`/`WIN32_MAX_PID` (Task 2/3/4); тестовые helpers `PS_UNDER`/`existsPs`/`psBase` определены один раз в `tests/process.test.mjs`.
- Review Focus 1–5 → Task 2 env/argv + Task 5 sentinel; Task 2 protocol + Task 3/4 junk stdout (exit 0 + junk ≠ delivered); Task 4 скрипт (pin, exact µs UTC) + тест 242; Task 3/4 guard + timeout-after-KILL + Task 5 whole-tree `kept`; Task 4 `SURVIVOR`-строки до `Dispose` + Task 5 `cancelDecision`/`renderCancelPending` + E2E брокер (тот же app-server, `lastTurnStart.prompt`).
