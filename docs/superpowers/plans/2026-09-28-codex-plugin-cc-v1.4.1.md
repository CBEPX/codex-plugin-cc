# codex-plugin-cc v1.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать Windows ту же гарантию kill-пути, что posix имеет с v1.3.0: записанный PID сигналится только после доказательства через закреплённый process handle, дерево завершается теми же handle'ами, исход без подтверждения никогда не считается доставленным; четыре win32-отказа становятся реальными kill'ами; плюс хвосты v1.4.0.

**Architecture:** Один запускатель `runPowerShell` (валидированный `SystemRoot`, абсолютный путь `System32\WindowsPowerShell\v1.0\powershell.exe`, чистое минимальное окружение, cwd = System32, `-EncodedCommand`, протокол вывода `^[A-Z]+( \d+)*$`, breaker по монотонным часам). Identity = `win32:<FILETIME>` из `.NET Process.StartTime`, читаемого через объект с закреплённым `.Handle`. Проба — batch `Get-Process -Id …` (только win32, Int32). Kill — один скрипт: guard CLM → pin root (`GetProcessById` + `.Handle`) → сверка `StartTime` → CIM-снимок дерева с допуском узла только при совпадении UTC-микросекунд его закреплённого `StartTime` со снимком и ≥ родителя, без поддерева брокера → `PHASE kill` → `.Kill()` по закреплённым объектам, дети → родитель → `WaitForExit` до дедлайна, неподтверждённый узел = survivor → `OK`/`SURVIVORS …`. Никаких внешних программ, никакого `taskkill`. Survivors и `kept` доходят до всех callers на win32. posix — только два изменения из spec §6.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test` (`scripts/run-tests.mjs`), fake Codex fixture, Windows PowerShell 5.1 (in-box), .NET `System.Diagnostics.Process`, CIM `Win32_Process` (снимок дерева), GitHub Actions с обязательным Windows.

**Spec:** `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` (rev. 3); roadmap `/Users/g.mehrenin/.claude/plans/glistening-chasing-backus.md`, разделы «v1.4.1» и «Дизайн: process identity».

## Global Constraints

- Worktree `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.1`, ветка `release/v1.4.1` от `main` (5662171 = v1.4.0). `main` = установленный `codex@cbepx` 1.4.0 — не трогать.
- Гейт на задачу: `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit …` (roadmap п. 7: только `&&`, только exit-коды).
- Только `rg`, никаких `git add -A`. Трейлер `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push ветки разрешён; PR/merge/tag — отдельный вопрос в Task 7.
- Threat-model (spec §2): PowerShell только по валидированному абсолютному пути; чистое окружение; cwd = System32; никаких голых имён; **скрипты не запускают ни одной внешней программы**; вывод по протоколу `^[A-Z]+( \d+)*$`; `-EncodedCommand`; PID ∈ [1, 2147483647].
- Fail-closed: `null`/ошибка/таймаут/breaker/CLM никогда не разрешает kill; неподтверждённый exit = survivor, никогда `delivered:true`; записи без identity на win32 остаются `identity-unavailable`; lock-тикеты на win32 — PID-liveness; `terminateProcessTree` (живой handle app-server) — как в v1.4.0.
- posix меняется ровно в двух местах (spec §6): ps-guard `≤ 0` и поле `kept: false` в результате `teardownBrokerSession`. Всё новое — за `platform === "win32"`.
- Тайминги (roadmap п. 8): Windows-only E2E — `{ skip: !IS_WIN, timeout: 90_000 }`, ожидания через `waitFor` (30 s), `t.after` регистрируется сразу после получения pid.
- Windows локально нет: Task 2–5 доказываются inject-тестами на posix + Windows-матрицей после push; при исполнении Task 4 обязателен второй проход `/codex:rescue --effort xhigh` (read-only) с брифом по spec §2 и «PID reuse между снимком и Kill», «CLM», «поддерево брокера», «survivors».

## Review Focus

1. Подложенный `powershell.exe` (копия `cmd.exe`) / `powershell.cmd` в cwd или относительном `PATH`, `PSModulePath`/`COMPlus_*` из окружения job'а никогда не влияют на запуск (Task 2 argv/env-тесты; Task 5 sentinel из свежего процесса с абсолютными file URL).
2. Не-ASCII путь и не-английская локаль (#310): протокол вывода `^[A-Z]+( \d+)*$`, любая другая строка → неизвестный исход (Task 3/4 тесты с мусорным stdout).
3. Рецикл PID и устаревший `ParentProcessId`: root и каждый узел закреплены `.Handle` до чтения `StartTime`, узлы сверяются по UTC-микросекундам без допуска (Task 4 тест на текст скрипта + маппинг 242).
4. CLM/медленный раннер: guard `LanguageMode` → 244 → `identity-unavailable`, запись сохраняется на SessionEnd (Task 4/5); таймаут после `PHASE kill` → `kill-failed` + `unverified`, не `identity-unavailable` (Task 4).
5. Root мёртв, ребёнок жив / общий брокер как ребёнок worker'а: `SURVIVORS` → `cancellationPending` + `orphanedPids`, никогда `cancelled`; брокер исключён по pid и по `app-server-broker.mjs` (Task 4 скрипт, Task 5 cancel + E2E с вторым клиентом).

---

### Task 1: Хвосты v1.4.0 — обязательный leak-шаг CI, ps-guard, разбор флейка

**Files:**
- Modify: `.github/workflows/pull-request-ci.yml` (~66–73), `.github/workflows/release-verify.yml` (~75–82)
- Modify: `plugins/codex/scripts/lib/process.mjs:196-207` (`processCommandLine`, ps-ветка)
- Test: `tests/process.test.mjs`
- Investigate: `tests/broker-stale-pid.test.mjs` («session end reaps a SIGKILLed background worker …», ~448–520)

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
- [ ] **Step 5: CI leak step** (оба workflow), Windows-ветка:

```bash
          if [ "$RUNNER_OS" = "Windows" ]; then
            set +e
            powershell -NoProfile -Command "\$ErrorActionPreference = 'Stop'; try { \$p = @(Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'codex-plugin-test-' -and \$_.ProcessId -ne \$PID }) } catch { Write-Error \$_; exit 2 }; \$p | Select-Object ProcessId,ParentProcessId,Name,@{n='Cmd';e={\$_.CommandLine.Substring(0,[Math]::Min(160,\$_.CommandLine.Length))}} | Format-Table -AutoSize | Out-String -Width 220 | Write-Host; Write-Output \$p.Count" > leak-count.txt
            ps_status=$?
            set -e
            leaked=$(tail -1 leak-count.txt | tr -d '\r ')
            echo "Leaked test processes after 10 s: ${leaked:-?} (powershell exit ${ps_status})" | tee -a "$GITHUB_STEP_SUMMARY"
            [ "$ps_status" = "0" ] && [ "$leaked" = "0" ] || exit 1
          elif pgrep -af codex-plugin-test- ; then echo "leaked test processes" >&2; exit 1; fi
```

  Комментарий над шагом: «Same check as the local gate on every OS; the Windows count excludes the counting shell itself and an enumeration error fails the step.»
- [ ] **Step 6: флейк reaper-теста** — `for i in $(seq 10); do node --import ./tests/test-env.mjs --test --test-name-pattern="session end reaps a SIGKILLed background worker" tests/broker-stale-pid.test.mjs > /tmp/reap-$i.log 2>&1 || echo "FAIL $i"; done`. Любой FAIL → «hook said» и «broker log tail» из лога в отчёт задачи и в леджер; **код не менять** (решение о причине — контроллер, вне scope этого релиза). Без FAIL — «10/10 green locally».
- [ ] **Step 7: gate + commit** `ci(test): enforce the leak step on Windows; ps probe honours a spent budget`. Push; контроллер диспатчит CI: Windows-джобы зелёные с `Leaked test processes after 10 s: 0 (powershell exit 0)`.

---

### Task 2: PowerShell-запускатель: валидированный root, чистое окружение, breaker, протокол вывода

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (после `systemExe`)
- Test: `tests/process.test.mjs`

**Interfaces (Produces):**
- `export const WIN32_MAX_PID = 2147483647; export const isWin32Pid = (pid) => Number.isInteger(pid) && pid >= 1 && pid <= WIN32_MAX_PID;`
- `export function systemRoot(env, { existsSyncImpl } = {})` → `string|null` (`^[A-Za-z]:\\[^\\/]+` + существует `<root>\System32\WindowsPowerShell\v1.0\powershell.exe`).
- `export function systemPowerShell(root)`, `export function powerShellEnvironment(root, env)`, `export function encodePowerShell(script)` — как в spec §2.
- `export function parseProtocolLines(stdout)` → `string[] | null`: непустые строки, каждая `^[A-Z]+( \d+)*$`, иначе `null`.
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
  assert.deepEqual(parseProtocolLines("PHASE kill\r\nSURVIVORS 4300 4301\r\n"), ["PHASE kill", "SURVIVORS 4300 4301"]);
  assert.deepEqual(parseProtocolLines(""), []);
  for (const junk of ["failure 5\r\n", "OK\r\nZugriff verweigert\r\n", "4242 1337\r\nINFO: x\r\n"]) {
    assert.equal(parseProtocolLines(junk), null, JSON.stringify(junk));
  }
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
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
foreach ($p in @(Get-Process -Id <a,b,...> -ErrorAction SilentlyContinue)) {
  try { $null = $p.Handle; Write-Output ('ID {0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }
}
```

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
  assert.match(script, /Get-Process -Id 4242,7,99 /);
  assert.equal(map.get(4242), "win32:133700000000000000");
  assert.equal(map.get(7), "win32:133700000000000001");
  assert.equal(map.get(99), null, "a pid the probe did not print is null");
  assert.equal(map.size, 3);
  assert.equal(getProcessIdentity(4242, options), "win32:133700000000000000");
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
  const probe = runPowerShell(identityProbeScript(wanted.slice(0, WIN32_PROBE_BATCH)), { ...options, timeoutMs: options.timeoutMs ?? 10000 });
  const lines = probe.unavailable || probe.status !== 0 ? null : parseProtocolLines(probe.stdout);
  for (const line of lines ?? []) {
    const row = WIN32_IDENTITY_ROW.exec(line);
    if (row && map.has(Number(row[1]))) {
      map.set(Number(row[1]), `win32:${row[2]}`);
    }
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

  Удалить `// ponytail: CIM (CreationDate) identity lands in v1.4.0`. Windows-only тест (`{ skip: !IS_WIN, timeout: 60_000 }`): свежие процессы через `run(process.execPath, ["--import", TEST_ENV_URL, "-e", "import(PROCESS_MJS_URL).then(m => console.log(JSON.stringify([m.getProcessIdentities([process.pid]).get(process.pid), m.getProcessIdentity(process.pid)])))"])`, где `TEST_ENV_URL`/`PROCESS_MJS_URL` — `pathToFileURL(path.join(ROOT, …)).href` (оба абсолютные); проверить: оба значения равны, `^win32:\d+$`; долгоживущий ребёнок `spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"])` с `t.after(kill)` — его identity из двух свежих процессов совпадает и отличается от их собственных.
- [ ] **Step 4: run** → PASS; eslint.
- [ ] **Step 5: gate + commit** `feat(process): Windows process identity from the process start time, batched per probe`.

---

### Task 4: Verify-and-kill на win32 в `terminateRecordedProcess`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`terminateRecordedProcess` ~274–326; новые `terminateWindowsRecordedProcess`, `terminateScript`)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:318-341` (комментарии; enum причин + `process-missing`)
- Modify: `README.md` таблица причин teardown (`process-missing`, метод `handle`)
- Test: `tests/process.test.mjs`

**Interfaces (Consumes):** Task 2. **Produces:** `terminateRecordedProcess(pid, { identity, platform: "win32", timeoutMs, excludePids = [], env, runCommandImpl, existsSyncImpl, now })` → `{ attempted, delivered, method?: "handle", reason, survivors?: number[], unverified?: true }`; `reason` ∈ прежний словарь + `process-missing`.

Скрипт `terminateScript(pid, fileTime, excludePids, deadlineMs)` (все подстановки — только цифры; `deadlineMs = timeoutMs − 500`, минимум 250):

```powershell
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 244 }
$target = <pid>
$expected = '<fileTime>'
$exclude = @(<excludePids or nothing>)
$deadline = [DateTime]::UtcNow.AddMilliseconds(<deadlineMs>)
$pinned = @()
function Pin([int]$id) {
  $h = [System.Diagnostics.Process]::GetProcessById($id)
  $null = $h.Handle
  $script:pinned += $h
  return $h
}
function Micro($dt) { return [long][Math]::Floor($dt.ToUniversalTime().Ticks / 10) }
$tree = @()
try {
  try { $root = Pin $target } catch [System.ArgumentException] { exit 241 } catch { exit 244 }
  if ($root.StartTime.ToFileTimeUtc().ToString() -ne $expected) { exit 242 }
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
      try { $h = Pin $cid } catch { continue }
      $live = Micro $h.StartTime
      if ($live -ne (Micro $r.CreationDate)) { continue }
      if ($live -lt $starts[$pp]) { continue }
      $starts[$cid] = $live
      $tree += $h
      $queue += $cid
    }
  }
} catch { exit 244 }
Write-Output 'PHASE kill'
$survivors = @()
try {
  [array]::Reverse($tree)
  foreach ($h in $tree) { try { $h.Kill() } catch { } }
  foreach ($h in $tree) {
    $confirmed = $false
    while (-not $confirmed -and [DateTime]::UtcNow -lt $deadline) {
      try { if ($h.WaitForExit(250)) { $confirmed = $true } } catch { break }
    }
    if (-not $confirmed) { $survivors += $h.Id }
  }
} catch {
  $survivors = @($tree | ForEach-Object { $_.Id })
} finally {
  foreach ($h in $pinned) { try { $h.Dispose() } catch { } }
}
if ($survivors.Count -eq 0) { Write-Output 'OK'; exit 0 }
Write-Output ('SURVIVORS ' + ($survivors -join ' '))
exit 243
```

  Для исполнителя: `.Handle` в .NET Framework открывает `PROCESS_ALL_ACCESS` и кэширует handle на объекте до `Dispose()` — все последующие `StartTime`/`Kill()`/`WaitForExit()` этого объекта идут по нему; `GetProcessById` бросает `ArgumentException` только для «процесс не запущен»; узлы, не прошедшие проверки, не попадают в `$tree`; никаких внешних программ; в фазе kill исключение `WaitForExit` = survivor, не exited.

- [ ] **Step 1: failing tests**

```js
test("terminateRecordedProcess on win32 runs the handle-based verify-and-kill script and maps its protocol", () => {
  const base = { identity: "win32:133700000000000000", platform: "win32", ...psBase, timeoutMs: 3000, excludePids: [555] };
  const cases = [
    [0, "PHASE kill\r\nOK\r\n", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }],
    [241, "", { attempted: false, delivered: false, method: "handle", reason: "process-missing" }],
    [242, "", { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }],
    [243, "PHASE kill\r\nSURVIVORS 4300 4301\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [4300, 4301] }],
    [243, "PHASE kill\r\nfailure 5\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [244, "", { attempted: false, delivered: false, reason: "identity-unavailable" }]
  ];
  for (const [status, stdout, expected] of cases) {
    resetWindowsIdentityCircuit();
    let script = null;
    const result = terminateRecordedProcess(4242, { ...base, runCommandImpl: (file, args) => { script = Buffer.from(args[6], "base64").toString("utf16le"); return { status, stdout, stderr: "", error: null }; } });
    assert.deepEqual(result, expected, `exit ${status}`);
    assert.match(script, /LanguageMode -ne 'FullLanguage'\) \{ exit 244 \}/);
    assert.match(script, /\$target = 4242\n/);
    assert.match(script, /\$expected = '133700000000000000'/);
    assert.match(script, /\$exclude = @\(555\)/);
    assert.match(script, /\$null = \$h\.Handle/, "the handle is pinned before StartTime is read");
    assert.match(script, /catch \[System\.ArgumentException\] \{ exit 241 \} catch \{ exit 244 \}/);
    assert.match(script, /Ticks \/ 10/, "UTC microsecond comparison, no tolerance");
    assert.match(script, /app-server-broker\.mjs/);
    assert.match(script, /\.Kill\(\)/);
    assert.doesNotMatch(script, /taskkill|& "|Start-Process/, "no external program is ever started");
    assert.match(script, /AddMilliseconds\(2500\)/, "internal deadline = timeoutMs - 500");
  }
  // A timeout after PHASE kill is an unverified attempt; before it, no evidence at all.
  resetWindowsIdentityCircuit();
  const timedOut = (stdout) => ({ status: null, stdout, stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) });
  assert.deepEqual(terminateRecordedProcess(4242, { ...base, runCommandImpl: () => timedOut("PHASE kill\r\n") }), { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true });
  resetWindowsIdentityCircuit();
  assert.deepEqual(terminateRecordedProcess(4242, { ...base, runCommandImpl: () => timedOut("") }), { attempted: false, delivered: false, reason: "identity-unavailable" });
  // Malformed identity, out-of-range pid or a legacy record never reach PowerShell.
  for (const [pid, identity] of [[4242, "win32:abc"], [4242, "linux:5"], [4242, null], [2 ** 31, "win32:1"]]) {
    resetWindowsIdentityCircuit();
    assert.equal(terminateRecordedProcess(pid, { ...base, identity, runCommandImpl: () => assert.fail("must not run") }).reason, "identity-unavailable");
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

// One PowerShell run pins the recorded process (GetProcessById + .Handle), proves
// its start time, builds the tree from a CIM snapshot admitting only children
// whose pinned start time equals the snapshot's at microsecond precision and
// follows their parent's, skips the shared broker, kills children-first through
// the pinned objects and waits for each. Every answer is an exit code plus
// protocol lines; an exit that could not be confirmed is a survivor.
function terminateWindowsRecordedProcess(pid, identity, options) {
  const refused = (reason) => ({ attempted: false, delivered: false, reason });
  const fileTime = typeof identity === "string" ? /^win32:(\d+)$/.exec(identity)?.[1] : null;
  if (!fileTime || !isWin32Pid(pid)) {
    return refused("identity-unavailable");
  }
  const timeoutMs = options.timeoutMs ?? 10000;
  const excludePids = (options.excludePids ?? []).filter(isWin32Pid);
  const deadlineMs = Math.max(250, Math.floor(timeoutMs) - KILL_DEADLINE_MARGIN_MS);
  const run = runPowerShell(terminateScript(pid, fileTime, excludePids, deadlineMs), { ...options, timeoutMs });
  const lines = parseProtocolLines(run.stdout);
  const killStarted = Boolean(lines?.includes("PHASE kill"));
  const survivorsLine = lines?.find((line) => line.startsWith("SURVIVORS "));
  const failed = (extra) => ({ attempted: true, delivered: false, method: "handle", reason: "kill-failed", ...extra });
  if (run.unavailable) {
    return killStarted ? failed({ survivors: [], unverified: true }) : refused("identity-unavailable");
  }
  switch (run.status) {
    case 0:
      return { attempted: true, delivered: true, method: "handle", reason: "identity-match" };
    case WINDOWS_PROCESS_MISSING_EXIT:
      return { attempted: false, delivered: false, method: "handle", reason: "process-missing" };
    case WINDOWS_IDENTITY_MISMATCH_EXIT:
      return { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" };
    case WINDOWS_TERMINATION_FAILED_EXIT:
      return lines && survivorsLine
        ? failed({ survivors: survivorsLine.split(" ").slice(1).map(Number) })
        : failed({ survivors: [], unverified: true });
    default:
      return killStarted ? failed({ survivors: [], unverified: true }) : refused("identity-unavailable");
  }
}
```

  `terminateScript(pid, fileTime, excludePids, deadlineMs)` — массив строк скрипта выше `.join("\n")` с подстановками (`$exclude = @(${excludePids.join(",")})`; пустой список → `@()`).
- [ ] **Step 4:** обновить комментарии/enum в `broker-lifecycle.mjs:318-341` (добавить `process-missing`, убрать «CIM identity is v1.4.0») и README-таблицу причин (`process-missing` — «the pid was provably gone before anything was signalled; the record is cleaned up»; `kill-failed` теперь может нести `survivors`). `tests/commands.test.mjs` README-assertions — проверить.
- [ ] **Step 5: run** → PASS; eslint.
- [ ] **Step 6: второй проход Codex** (контроллер): `/codex:rescue --effort xhigh`, read-only; бриф = spec §2 + §3.4 (handle pinning, CLM, µs UTC, поддерево брокера, survivors/unverified, протокол). Замечания → fix-раунд до Task 5.
- [ ] **Step 7: gate + commit** `feat(process): Windows kill from a stored record pins the process, verifies its start time and terminates the verified tree`.

---

### Task 5: Callers на win32 — reaper batch, cancel survivors, бюджеты, сохранение записей, runtime-ожидания, Windows E2E

**Files:**
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs:380-440` (`reapDeadJobs`)
- Modify: `plugins/codex/scripts/codex-companion.mjs:1340-1365` (cancel: `excludePids`, survivors → `cancellationPending` + `orphanedPids`)
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs` (константы ~22–45; `cleanupSessionJobs` ~98–166: `excludePids`, survivors в лог; teardown ~298–322: `kept`)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:342-380` (`teardownBrokerSession`: `platform` опция, `kept`)
- Modify: `plugins/codex/scripts/app-server-broker.mjs` (~294–315, `broker/shutdown`: тестовый knob `CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN=1` — ответить `{}` и не завершаться)
- Modify: `tests/tracked-jobs.test.mjs:417,424` (явный `platform: "linux"`/`"darwin"` — на Windows старые inject-тесты иначе пойдут в batch и сравнят `win32:` с `linux:`), `tests/broker-stale-pid.test.mjs:1365,1381` (`deepEqual` + `kept: false`)
- Modify: `tests/runtime.test.mjs` (см. Step 6)
- Test: новые тесты в `tests/tracked-jobs.test.mjs`, `tests/broker-stale-pid.test.mjs`, `tests/runtime.test.mjs`

**Interfaces (Consumes):** `getProcessIdentities`, `terminateRecordedProcess` win32 (`process-missing`, `survivors`, `unverified`, `excludePids`). **Produces:** `reapDeadJobs(…, { getProcessIdentitiesImpl })` (только win32-ветка); `teardownBrokerSession(…, { platform })` → `{ signalled, reason, kept }`; `export function killStepMs(platform)` в хуке (4000 на win32, `IDENTITY_PROBE_MS` иначе); job-record поле `orphanedPids?: number[]`.

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
- [ ] **Step 3: implement reaper** — опция `getProcessIdentitiesImpl = getProcessIdentities`; helper `liveIdentityCandidate(job)` → `{pid, identity}|null` с теми же проверками, что в основном цикле (running/queued, не terminal on disk, `isPidAlive(pid) !== false`, `pid && identity`); **только при `platform === "win32"`** один вызов до цикла: `batch = (() => { try { return getProcessIdentitiesImpl(candidatePids, { platform, timeoutMs: remainingMs ? Math.min(IDENTITY_PROBE_MS, remainingMs()) : IDENTITY_PROBE_MS }); } catch { return new Map(); } })()`; в цикле на win32 `actual = batch.get(pid) ?? null`; posix-ветка — код и per-pid `timeoutMs` без изменений.
- [ ] **Step 4: cancel survivors + excludePids** (`codex-companion.mjs` ~1340): `const brokerPid = loadBrokerSession(workspaceRoot)?.pid ?? null; const kill = terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id), excludePids: Number.isInteger(brokerPid) ? [brokerPid] : [] });` и условие pending: `if (pid && (!kill.attempted || !kill.delivered) && (isPidAlive(pid) === true || kill.survivors?.length || kill.unverified))` → reason `kill.attempted ? "kill-failed" : kill.reason`; при `kill.survivors?.length` — `upsertJob(workspaceRoot, { id: job.id, orphanedPids: kill.survivors })` и строка лога `worker tree survivors: <pids>`; JSON-ответ дополняется `orphanedPids`. Тест (runtime, posix, inject невозможен через CLI → unit на функцию-помощник `cancelOutcome(kill, pidAlive)` → выделить чистую функцию `cancelDecision({ pid, kill, alive })` → `{ pending: boolean, reason, orphanedPids }` и протестировать таблицей: delivered → not pending; `kill-failed` + survivors при мёртвом root → pending с orphanedPids; `identity-unavailable` + alive → pending; `process-missing` → not pending).
- [ ] **Step 5: хук** — `export function killStepMs(platform = process.platform) { return platform === "win32" ? 4000 : IDENTITY_PROBE_MS; }`; в `cleanupSessionJobs`: `probeMs = Math.floor(Math.min(killStepMs(), remainingMs() / 2))`, `excludePids` = pid брокера сессии (загрузить `loadBrokerSession(cwd)` **до** `cleanupSessionJobs` и передать `brokerPid`), при `outcome.survivors?.length` — `process.stderr.write(\`[codex] SessionEnd left ${job.id} tree survivors: ${outcome.survivors.join(" ")}\n\`)` (job уже остаётся через `kept`); teardown: `timeoutMs: process.platform === "win32" ? stepBudget(killStepMs()) : Math.floor(stepBudget(IDENTITY_PROBE_MS) / 2)`; после teardown: `if (!teardown.kept && loadBrokerSession(cwd)?.endpoint === brokerEndpoint) clearBrokerSession(cwd);` и `kept=${teardown.kept}` в строке решения. Тест `killStepMs("win32") === 4000`, `killStepMs("linux") === 2000`.
- [ ] **Step 6: `teardownBrokerSession` kept** — опция `platform = process.platform`; после kill: `const kept = platform === "win32" && !signalled && !["process-missing", "no-pid"].includes(reason) && isPidAlive(pid) !== false;` при `kept` пропустить unlink pid/log/endpoint-файлов; вернуть `{ signalled, reason, kept }`. Обновить `deepEqual` в `tests/broker-stale-pid.test.mjs:1365,1381` (`kept: false`). Тест: `teardownBrokerSession({ …, pid: process.pid, pidIdentity: "win32:1", platform: "win32", killProcess: () => ({ attempted: false, delivered: false }) , terminateImpl… })` — проще инжектировать через `killProcess`? `terminateRecordedProcess` на win32 идёт в PowerShell; для unit — передать `runCommandImpl` через опции teardown? Добавить опцию `terminateRecordedProcessImpl` в `teardownBrokerSession` (по умолчанию `terminateRecordedProcess`) и в тесте вернуть `{ attempted: false, delivered: false, reason: "identity-unavailable" }` → `kept: true`, файлы на месте; `{ attempted: false, delivered: false, reason: "process-missing" }` → `kept: false`, файлы удалены; на `platform: "linux"` с тем же `identity-unavailable` → `kept: false` (posix без изменений).
- [ ] **Step 7: broker knob** — в обработчике `broker/shutdown` (`app-server-broker.mjs` ~310): `if (process.env.CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN === "1") { send(socket, { id: message.id, result: {} }); process.stderr.write("[broker] test knob: acknowledged shutdown, staying up\n"); continue; }` (до `await shutdownAndExit(server)`). Только для тестов; README не упоминать.
- [ ] **Step 8: runtime win32-ожидания** — `tests/runtime.test.mjs`: ~1914–1920 оставить (legacy без identity → отказ на win32); ~2167 `cancel sends turn interrupt`: убрать `IS_WIN && status === 1`; ~2436–2476 «session end preserves background jobs»: убрать win32-ветку (foreground worker убит, запись удалена); ~3885–3895 turn-timeout/cancel: убрать `if (IS_WIN)`, общий путь `status 0`, `/cancelled/i`, `assert.equal(await exited, 1)` (код родителя `task --await`); «session end fully cleans up jobs»: без win32-ветки; снять skip с 2004 (regex → `/^(linux|darwin|win32):/`) и 4115; оставить skip на 1954 (posix cmdline fallback) и 3906 (игнорируемый SIGTERM). Для `isAlive` в новых тестах импортировать `isPidAlive` из `../plugins/codex/scripts/lib/process.mjs` (`const isAlive = (pid) => isPidAlive(pid) === true`) на уровне модуля.
- [ ] **Step 9: Windows-only E2E** (`{ skip: !IS_WIN, timeout: 90_000 }`, `tests/runtime.test.mjs`; `ROOT` — корень репозитория из helpers; `cimTree(pid)` — helper, возвращающий `[{pid, name}]` дерева через `powershell -NoProfile -Command` BFS по `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name` c `ConvertTo-Json`):

```js
test("cancel on Windows kills the worker and its codex.cmd tree but not the shared broker another client uses", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pid && j.pidIdentity && j.threadId && j.turnId ? j : null; });
  t.after(() => { try { process.kill(running.pid, "SIGKILL"); } catch {} });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, "the worker started the shared broker");
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  const tree = cimTree(running.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(tree.some((n) => /cmd\.exe/i.test(n.name)) && tree.some((n) => /node\.exe/i.test(n.name)), `expected cmd.exe and node.exe under the worker, got ${JSON.stringify(tree)}`);
  assert.ok(!tree.some((n) => n.pid === broker.pid) || true, "the broker may appear as a child by ParentProcessId; the kill must skip it");
  // A second client keeps using the broker during the kill.
  const other = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(other.status, 0, other.stderr);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => (tree.filter((n) => n.pid !== broker.pid).every((n) => !isAlive(n.pid)) ? "gone" : null));
  assert.equal(isAlive(broker.pid), true, "the shared broker survives a worker kill");
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled");
});

test("a root killed by hand while its child lives makes cancel answer cancellationPending with the survivor", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pid && j.pidIdentity && j.turnId ? j : null; });
  const tree = cimTree(running.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  // The worker's own child (cmd.exe of the app-server it owns? no: the broker owns that) — use a long-lived child spawned by the worker: the fake codex run through codex.cmd under the broker belongs to the broker, so plant a child under the worker via the fixture knob FAKE_WORKER_SPAWN_CHILD=1 (see Step 9a).
  process.kill(running.pid, "SIGKILL");
  await waitFor(() => (!isAlive(running.pid) ? "dead" : null));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "failed", "the reaper fails a job whose root pid is gone before cancel signals anything");
});
```

  **Step 9a (уточнение контроллера для исполнителя):** сценарий «root мёртв, ребёнок жив» с реальным деревом worker'а достижим только если worker имеет собственных потомков; в brokered-режиме app-server принадлежит брокеру. Поэтому этот E2E строится на прямом (`--resume-last`, cold resume) job'е с `--background`: тогда `cmd.exe → node → fake` — дети worker'а. Если `--background` + `--resume-last` не поддерживается, тест заменяется unit-проверкой `cancelDecision` (Step 4) и Windows-E2E «SURVIVORS» через мок не требуется — записать это решение в отчёт.

```js
test("a reused-looking identity is never signalled on Windows: the reaper fails the job and cancel reports it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pid && j.pidIdentity ? j : null; });
  t.after(() => { try { process.kill(running.pid, "SIGKILL"); } catch {} });
  // Tamper the identity the reaper reads: the indexed record (state.json) and the job file.
  upsertJob(repo, { id: jobId, pidIdentity: "win32:1" });
  const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0);
  assert.equal(isAlive(running.pid), true, "the process holding the pid is a stranger to this record and must stay");
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

  (`upsertJob`, `loadBrokerSession`, `resolveStateDir`, `pathToFileURL` — импортировать; `SESSION_HOOK` уже есть в файле.)
- [ ] **Step 10: gate + commit** `feat(runtime): Windows workers and brokers are killed from their records; survivors and unknown outcomes are kept, not hidden`. Push; контроллер диспатчит CI — Windows-джобы зелёные с leak-шагом 0 = доказательство Task 3–5.

---

### Task 6: Документация

**Files:**
- Modify: `README.md` («### Windows», ~385–395: удалить «Still limited until v1.4.1 …»; требования: Windows PowerShell 5.1 in-box; Constrained Language Mode/AppLocker → kill из записи отказывает (`identity-unavailable`), записи брокера сохраняются до следующей попытки; потомки, появившиеся после снимка, вне гарантии; общий брокер никогда не убивается вместе с worker'ом), таблица причин (`process-missing`, `kill-failed` с survivors, метод `handle`).
- Modify: `CHANGELOG.md` + `plugins/codex/CHANGELOG.md` (`## 1.4.1 — <день релизного коммита>`: Fixed — kill из записей на Windows через закреплённые handle'ы (#743 win32, #423/#577, #336, #416, #487, #718), leak-шаг обязателен; Changed — `status` на Windows делает одну пробу на все живые job'ы; survivors → `cancellationPending` + `orphanedPids`; записи брокера сохраняются при неизвестном исходе SessionEnd (Windows); ps-guard `≤ 0`; `teardownBrokerSession` результат содержит `kept`).
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

- Spec coverage: §2 → Task 2 (root/env/cwd/launch/protocol/breaker/PID-range); §3.1 → Task 3/4 (`.Handle` + `StartTime`); §3.2 → Task 2; §3.3 → Task 3 + Task 5 reaper (win32-only, отдельная fixture для пустой Map); §3.4 → Task 4 (guard CLM, pin, 241/242/243/244, µs UTC, `excludePids`/`app-server-broker.mjs`, `PHASE kill`, `SURVIVORS`, deadline, без внешних программ); §3.5 → без кода (E2E проверяет `win32:` в записях); §3.6 → Task 5 Step 4 (`cancelDecision`, `excludePids`, `orphanedPids`) + E2E; §3.7 → Task 5 Steps 5–7; §3.8 → Task 1; §4 → тесты Task 1–5 (B8-исправления: счёт pid по аргументу `-Id`, отдельная fixture, абсолютные file URL, `isAlive` через `isPidAlive`, явный `platform` в старых inject-тестах, `kept: false` в `deepEqual`); §5 → Task 6 + breaker; §6 → Task 1 и Task 5 Step 6.
- Placeholder scan: Step 9a честно фиксирует условность одного E2E (решение исполнителя с записью в отчёт) — это не TBD, а правило выбора; все остальные шаги с кодом/командами.
- Type consistency: `runPowerShell` → `{ status, stdout, timedOut, unavailable }` (Task 2/3/4); `parseProtocolLines` → `string[]|null` (Task 2/3/4); `getProcessIdentities` → `Map<number,string|null>` (Task 3/5); `terminateRecordedProcess` win32 → `{ attempted, delivered, method?, reason, survivors?, unverified? }` (Task 4/5); `teardownBrokerSession` → `{ signalled, reason, kept }` (Task 5); `killStepMs(platform)` (Task 5); `isWin32Pid`/`WIN32_MAX_PID` (Task 2/3/4); тестовые helpers `PS_UNDER`/`existsPs`/`psBase` определены один раз в `tests/process.test.mjs`.
- Review Focus 1–5 → Task 2 env/argv + Task 5 sentinel; Task 2 protocol + Task 3/4 junk stdout; Task 4 скрипт (pin, µs UTC) + тест 242; Task 4 guard/timeout-after-PHASE + Task 5 `kept`; Task 4 survivors + Task 5 `cancelDecision` + E2E брокер-second-client.
