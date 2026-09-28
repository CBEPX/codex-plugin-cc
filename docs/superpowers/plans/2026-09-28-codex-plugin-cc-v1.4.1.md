# codex-plugin-cc v1.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать Windows ту же гарантию kill-пути, что posix имеет с v1.3.0: записанный PID сигналится только после доказательства, дерево завершается через process handle, четыре win32-отказа (`identity-unavailable`) становятся реальными kill'ами; плюс хвосты v1.4.0.

**Architecture:** Один запускатель `runPowerShell` (валидированный `SystemRoot`, абсолютный путь `System32\WindowsPowerShell\v1.0\powershell.exe`, **чистое** минимальное окружение, cwd = System32, `-EncodedCommand`, числовой вывод, circuit breaker по монотонным часам). Identity = `win32:<FILETIME>` из `.NET Process.StartTime` (handle-based). Проба — batch `Get-Process -Id …` (только win32). Kill — один трёхфазный скрипт: preflight (handle root + `StartTime` сверка; CIM-снимок дерева с проверкой `CreationDate` и временной согласованности каждого узла) → destructive (`.Kill()` по открытым handle'ам, дети → родитель) → verify (`WaitForExit`, survivors → 243). Записи при неизвестном исходе сохраняются. Форматы записей не меняются; posix — только два перечисленных изменения.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test` (`scripts/run-tests.mjs`), fake Codex fixture, Windows PowerShell 5.1 (in-box), .NET `System.Diagnostics.Process`, CIM `Win32_Process` (только снимок дерева), GitHub Actions matrix с обязательным Windows.

**Spec:** `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` (rev. 2, этот worktree); roadmap `/Users/g.mehrenin/.claude/plans/glistening-chasing-backus.md`, разделы «v1.4.1» и «Дизайн: process identity».

## Global Constraints

- Worktree `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.1`, ветка `release/v1.4.1` от `main` (5662171 = v1.4.0). `main` = установленный `codex@cbepx` 1.4.0 — не трогать.
- Гейт на задачу: `npm run check` → exit 0; `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0. Коммит только через `&&` после гейта по exit-кодам (roadmap п. 7): `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add <files> && git commit …`.
- Только `rg`, никаких `git add -A`. Трейлер `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push ветки по ходу разрешён; PR/merge/tag — отдельный вопрос в Task 7.
- Threat-model (spec §2): PowerShell только по валидированному абсолютному пути; **чистое окружение** (никакого наследования `PSModulePath`/`COMPlus_*`/`PATH` из job'а); cwd = System32; никаких голых имён; единственный внешний exe в скриптах — `"$env:SystemRoot\System32\taskkill.exe"`; вывод — только целые числа; `-EncodedCommand`.
- Fail-closed: `null`/ошибка/таймаут/breaker никогда не разрешает kill; записи без identity на win32 остаются `identity-unavailable`; lock-тикеты на win32 — PID-liveness; `terminateProcessTree` (живой handle app-server) — как в v1.4.0.
- posix меняется ровно в двух местах (spec §6): ps-guard `< 1 ms` и новая причина `process-missing` только на win32-пути. Batching, бюджеты хука, интервалы опроса на posix не меняются.
- Тайминги (roadmap п. 8): Windows-only E2E — `{ skip: !IS_WIN, timeout: 90_000 }`, ожидания через `waitFor` (30 s), никаких абсолютных `< N ms` ниже 10 s.
- Windows локально нет: Task 2–5 доказываются inject-тестами на posix + Windows-матрицей после push; при исполнении Task 4 обязателен второй проход `/codex:rescue --effort xhigh` (read-only) с брифом по spec §2 и «PID reuse между снимком и Kill», «CLM», «цикл ParentProcessId», «подмена SystemRoot/PSModulePath».

## Review Focus

1. Подложенный `powershell.exe` (копия `cmd.exe`) или `powershell.cmd` в cwd/относительном `PATH`, а также `PSModulePath`/`COMPlus_*` из окружения job'а никогда не влияют на запуск (Task 2 unit-тесты на argv/env; Task 5 Windows-sentinel из свежего процесса).
2. Не-ASCII путь и не-английская локаль (#310): разбирается только `^\d+ \d+$`/`^\d+$`; localized stdout → `null`/`identity-unavailable` (Task 3/4).
3. Рецикл PID между снимком и kill'ом и устаревший `ParentProcessId`: узлы дерева верифицируются по handle `StartTime` и временной согласованности, root — по handle; Terminate идёт по handle, не по PID (Task 4 скрипт + тест на пропуск узла).
4. Медленный раннер/CLM: холодный PowerShell дольше бюджета или exit 244 → `identity-unavailable`, breaker, записи сохраняются для повторной попытки (Task 2/4/5).
5. Частичное завершение дерева (`ReturnValue`≠0, потомок жив) → `kill-failed` с `survivors`, никогда `delivered:true` (Task 4 тест на 243 + survivors).

---

### Task 1: Хвосты v1.4.0 — обязательный leak-шаг CI, ps-guard, разбор флейка

**Files:**
- Modify: `.github/workflows/pull-request-ci.yml` (шаг «No leaked test processes», ~66–73), `.github/workflows/release-verify.yml` (~75–82)
- Modify: `plugins/codex/scripts/lib/process.mjs:196-207` (`processCommandLine`, ps-ветка)
- Test: `tests/process.test.mjs`
- Investigate: `tests/broker-stale-pid.test.mjs` («session end reaps a SIGKILLed background worker …», ~448–520)

**Interfaces:** `processCommandLine(pid, { timeoutMs })` — сигнатура прежняя; `timeoutMs` задан и `< 1` → `null` без спавна (`0.3` по-прежнему пробует: `runCommand` клэмпит его к 1 ms).

- [ ] **Step 1: failing test** (`tests/process.test.mjs`, рядом с «getProcessIdentity pins the darwin ps locale»):

```js
test("processCommandLine treats a spent budget as no probe on the ps branch", () => {
  for (const timeoutMs of [0, -1]) {
    assert.equal(
      processCommandLine(42, { platform: "darwin", timeoutMs, runCommandImpl: () => assert.fail("must not spawn ps") }),
      null
    );
  }
  // A fractional but positive budget is clamped by runCommand and still probes; an unset one probes too.
  for (const options of [{ timeoutMs: 0.3 }, {}]) {
    assert.equal(processCommandLine(42, { platform: "darwin", ...options, runCommandImpl: () => ({ status: 0, stdout: "node x\n", stderr: "", error: null }) }), "node x");
  }
});
```

- [ ] **Step 2: run** `node --import ./tests/test-env.mjs --test --test-name-pattern="spent budget as no probe" tests/process.test.mjs` → FAIL (`must not spawn ps`).
- [ ] **Step 3: implement** перед `runCommandImpl("ps", …)` в `processCommandLine`:

```js
  // A spent budget is no probe (spawnSync would read 0 as "no timeout").
  if (options.timeoutMs !== undefined && !(options.timeoutMs >= 1) && !(options.timeoutMs > 0)) {
    return null;
  }
```

  (условие: `timeoutMs <= 0` → null; `0 < timeoutMs < 1` → пробует через клэмп; проще записать как `if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) return null;` — это и есть требуемое поведение; используйте эту короткую форму.)
- [ ] **Step 4: run** → PASS; весь `tests/process.test.mjs` → pass.
- [ ] **Step 5: CI leak step** в обоих workflow — Windows-ветка с явной обработкой ошибок и раздельной проверкой статуса:

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

  Комментарий над шагом: «Same check as the local gate on every OS; the Windows count excludes the counting shell itself and an enumeration error fails the step.» Убрать «Windows is reported, not enforced».
- [ ] **Step 6: флейк reaper-теста** — `for i in $(seq 10); do node --import ./tests/test-env.mjs --test --test-name-pattern="session end reaps a SIGKILLed background worker" tests/broker-stale-pid.test.mjs > /tmp/reap-$i.log 2>&1 || echo "FAIL $i"; done`. Любой FAIL → прочитать «broker log tail» и `hook said` из лога; если брокер отвечает `busy` потому, что сокет предыдущего `sendBrokerShutdown` ещё в `sockets` (в логе `client disconnected (1 remaining)` позже ответа busy) — это гонка опроса: поднять `BROKER_BUSY_POLL_MS` в `session-lifecycle-hook.mjs` со 100 до 250 ms (изменение posix-поведения — записать в отчёт и в CHANGELOG «Changed»), повторить 10 прогонов; иная причина — хвост лога в отчёт, тест не трогать (контроллер решает). Без FAIL — «10/10 green locally» в отчёт.
- [ ] **Step 7: gate + commit** `ci(test): enforce the leak step on Windows; ps probe honours a spent budget`. Push; контроллер диспатчит CI и проверяет `Leaked test processes after 10 s: 0 (powershell exit 0)` на Windows.

---

### Task 2: PowerShell-запускатель: валидированный root, чистое окружение, breaker

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (после `systemExe`, ~13)
- Test: `tests/process.test.mjs`

**Interfaces (Produces):**
- `export function systemRoot(env, { existsSyncImpl } = {})` → `string|null`: берёт `env.SystemRoot ?? env.SYSTEMROOT`, требует `/^[A-Za-z]:\\[^\\/]+/` и существование `<root>\System32\WindowsPowerShell\v1.0\powershell.exe`; иначе `null`.
- `export function powerShellEnvironment(root, env)` → чистый объект: `{ SystemRoot: root, windir: root, TEMP, TMP, PATH: "<root>\\System32;<root>", PATHEXT: ".EXE", PSModulePath: "<root>\\System32\\WindowsPowerShell\\v1.0\\Modules", NoDefaultCurrentDirectoryInExePath: "1" }`, где `TEMP`/`TMP` = `env.TEMP`/`env.TMP`, если они `path.win32.isAbsolute`, иначе `<root>\Temp`.
- `export function encodePowerShell(script)` → base64 UTF-16LE.
- `export function runPowerShell(script, { timeoutMs, env, runCommandImpl, existsSyncImpl, now })` → `{ status: number|null, stdout: string, timedOut: boolean, unavailable: boolean }`. `unavailable` при: breaker открыт, `systemRoot` = null, `timeoutMs` не `>= 1`, `error.code` ∈ {`ENOENT`, `ETIMEDOUT`}, exit 244. Breaker: `WINDOWS_IDENTITY_CIRCUIT_MS = 60000` по `now()` (по умолчанию `performance.now`); `export function resetWindowsIdentityCircuit()` для тестов.
- Константы (экспорт): `WINDOWS_PROCESS_MISSING_EXIT = 241`, `WINDOWS_IDENTITY_MISMATCH_EXIT = 242`, `WINDOWS_TERMINATION_FAILED_EXIT = 243`, `WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244`, `WINDOWS_EXITED_DURING_TERMINATION_EXIT = 245`.

- [ ] **Step 1: failing tests**

```js
const PS_UNDER = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const existsPs = (p) => p === PS_UNDER;

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

test("runPowerShell launches the in-box powershell.exe by absolute path, clean env, System32 cwd and an encoded script", () => {
  resetWindowsIdentityCircuit();
  let seen = null;
  const result = runPowerShell("Write-Output 7", {
    env: { SystemRoot: "D:\\Win", PSModulePath: "C:\\repo" }, timeoutMs: 1234, existsSyncImpl: existsPs,
    runCommandImpl: (file, args, options) => { seen = { file, args, options }; return { status: 0, stdout: "7\r\n", stderr: "", error: null }; }
  });
  assert.equal(seen.file, PS_UNDER);
  assert.deepEqual(seen.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.equal(Buffer.from(seen.args[6], "base64").toString("utf16le"), "Write-Output 7");
  assert.equal(seen.options.timeoutMs, 1234);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.cwd, "D:\\Win\\System32");
  assert.equal(seen.options.env.PSModulePath, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.equal("COMPlus_EnableDiagnostics" in seen.options.env, false);
  assert.deepEqual(result, { status: 0, stdout: "7\r\n", timedOut: false, unavailable: false });
});

test("runPowerShell is unavailable without a valid root or budget and never spawns then", () => {
  resetWindowsIdentityCircuit();
  const never = () => assert.fail("must not spawn");
  assert.equal(runPowerShell("x", { env: { SystemRoot: "." }, timeoutMs: 1000, existsSyncImpl: existsPs, runCommandImpl: never }).unavailable, true);
  assert.equal(runPowerShell("x", { env: { SystemRoot: "D:\\Win" }, timeoutMs: 0, existsSyncImpl: existsPs, runCommandImpl: never }).unavailable, true);
});

test("runPowerShell opens the circuit on ENOENT, ETIMEDOUT or exit 244 and closes it after a minute", () => {
  resetWindowsIdentityCircuit();
  const base = { env: { SystemRoot: "D:\\Win" }, timeoutMs: 1000, existsSyncImpl: existsPs };
  let clock = 1_000_000;
  const now = () => clock;
  let calls = 0;
  const enoent = () => { calls += 1; return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }; };
  assert.equal(runPowerShell("x", { ...base, runCommandImpl: enoent, now }).unavailable, true);
  assert.equal(runPowerShell("x", { ...base, runCommandImpl: enoent, now }).unavailable, true);
  assert.equal(calls, 1, "the open circuit must not spawn again");
  clock += 60_001;
  assert.equal(runPowerShell("x", { ...base, runCommandImpl: () => { calls += 1; return { status: 0, stdout: "1", stderr: "", error: null }; }, now }).unavailable, false);
  assert.equal(calls, 2);
  for (const result of [
    { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), signal: "SIGTERM" },
    { status: 244, stdout: "", stderr: "", error: null }
  ]) {
    resetWindowsIdentityCircuit();
    const first = runPowerShell("x", { ...base, runCommandImpl: () => result, now });
    assert.equal(first.unavailable, true);
    assert.equal(first.timedOut, result.error?.code === "ETIMEDOUT");
    assert.equal(runPowerShell("x", { ...base, runCommandImpl: () => assert.fail("circuit must be open"), now }).unavailable, true);
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
export const WINDOWS_EXITED_DURING_TERMINATION_EXIT = 245;
const WINDOWS_IDENTITY_CIRCUIT_MS = 60000;
const WINDOWS_ROOT = /^[A-Za-z]:\\[^\\/]+/;
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
  const exists = options.existsSyncImpl ?? fs.existsSync;
  return exists(systemPowerShell(root)) ? root : null;
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

// One way to run PowerShell: validated absolute path, clean environment,
// System32 as cwd, script as -EncodedCommand. A launcher that is missing,
// hangs or reports 244 trips a per-process breaker: for a minute every caller
// gets `unavailable` at once instead of each waiting out its own timeout.
export function runPowerShell(script, options = {}) {
  const now = options.now ?? (() => performance.now());
  const unavailable = { status: null, stdout: "", timedOut: false, unavailable: true };
  if (windowsIdentityUnavailableAt !== null && now() - windowsIdentityUnavailableAt < WINDOWS_IDENTITY_CIRCUIT_MS) {
    return unavailable;
  }
  const env = options.env ?? process.env;
  const root = systemRoot(env, options);
  if (!root || !(options.timeoutMs >= 1)) {
    return unavailable;
  }
  const result = (options.runCommandImpl ?? runCommand)(
    systemPowerShell(root),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    { cwd: path.win32.join(root, "System32"), env: powerShellEnvironment(root, env), timeoutMs: options.timeoutMs, shell: false }
  );
  const timedOut = result.error?.code === "ETIMEDOUT" || (!result.error && result.status === null);
  const tripped = result.error?.code === "ENOENT" || timedOut || result.status === WINDOWS_IDENTITY_UNAVAILABLE_EXIT;
  if (tripped) {
    windowsIdentityUnavailableAt = now();
    return { ...unavailable, timedOut };
  }
  if (!result.error) {
    windowsIdentityUnavailableAt = null;
  }
  return { status: result.status ?? null, stdout: String(result.stdout ?? ""), timedOut: false, unavailable: false };
}
```

  `performance` — глобал Node ≥16; импорт не нужен. На posix (тесты) `runCommand` с абсолютным путём спавнит напрямую, поэтому inject-тесты не зависят от платформы.
- [ ] **Step 4: run** → PASS; `npx eslint plugins/codex/scripts/lib/process.mjs tests/process.test.mjs`.
- [ ] **Step 5: gate + commit** `feat(process): in-box PowerShell launcher with a validated root, clean environment and identity circuit breaker`.

---

### Task 3: Identity на win32 — batch-проба `getProcessIdentities`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`getProcessIdentity` win32-ветка ~217–223; новая `getProcessIdentities`)
- Test: `tests/process.test.mjs` (заменить `assert.equal(getProcessIdentity(42, { platform: "win32" }), null)` на inject-тест ниже)

**Interfaces (Produces):**
- `export function getProcessIdentities(pids, options)` → `Map<number, string|null>`; options `{ platform, timeoutMs, env, runCommandImpl, existsSyncImpl, now, readFileSyncImpl }`. win32: один `runPowerShell` на ≤ 256 pid (дедуп, `uint32`); лишние остаются `null`. posix: цикл `getProcessIdentity(pid, options)`.
- `getProcessIdentity(pid, options)` на win32 → `win32:<FILETIME>` или `null`; `timeoutMs` по умолчанию 10000; own-pid кэш.
- Скрипт пробы (`identityProbeScript(pids)`):

```powershell
$ErrorActionPreference = 'Stop'
foreach ($p in @(Get-Process -Id <a,b,...> -ErrorAction SilentlyContinue)) {
  try { Write-Output ('{0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }
}
```

  (`Get-Process -Id` принимает массив без WQL; недоступный `StartTime` — access denied/exited — пропускается: тот pid остаётся `null`.)

- [ ] **Step 1: failing tests**

```js
test("getProcessIdentities on win32 probes every pid in one PowerShell run and parses only integer rows", () => {
  resetWindowsIdentityCircuit();
  let script = null;
  const runCommandImpl = (file, args) => {
    script = Buffer.from(args[6], "base64").toString("utf16le");
    return { status: 0, stdout: "4242 133700000000000000\r\n7 133700000000000001\r\nINFO: localized noise\r\n", stderr: "", error: null };
  };
  const options = { platform: "win32", runCommandImpl, env: { SystemRoot: "D:\\Win" }, existsSyncImpl: existsPs };
  const map = getProcessIdentities([4242, 7, 99, 7], options);
  assert.match(script, /Get-Process -Id 4242,7,99 /);
  assert.equal(map.get(4242), "win32:133700000000000000");
  assert.equal(map.get(7), "win32:133700000000000001");
  assert.equal(map.get(99), null, "a pid the probe did not print is null");
  assert.equal(map.size, 3);
  assert.equal(getProcessIdentity(4242, options), "win32:133700000000000000");
});

test("getProcessIdentities caps a batch at 256 pids and never marks the launcher unavailable for size", () => {
  resetWindowsIdentityCircuit();
  const pids = Array.from({ length: 300 }, (_, i) => 1000 + i);
  let asked = null;
  const map = getProcessIdentities(pids, { platform: "win32", env: { SystemRoot: "D:\\Win" }, existsSyncImpl: existsPs, runCommandImpl: (file, args) => { asked = Buffer.from(args[6], "base64").toString("utf16le").match(/\d+/g).length; return { status: 0, stdout: "", stderr: "", error: null }; } });
  assert.equal(asked, 256);
  assert.equal(map.size, 300);
  assert.equal(runPowerShell("x", { env: { SystemRoot: "D:\\Win" }, timeoutMs: 1000, existsSyncImpl: existsPs, runCommandImpl: () => ({ status: 0, stdout: "", stderr: "", error: null }) }).unavailable, false);
});

test("getProcessIdentity on win32 is null on junk output, timeout, exit 244, a spent budget or an invalid pid", () => {
  const base = { platform: "win32", env: { SystemRoot: "D:\\Win" }, existsSyncImpl: existsPs };
  for (const result of [
    { status: 0, stdout: "not a number\r\n", stderr: "", error: null },
    { status: 0, stdout: "", stderr: "", error: null },
    { status: null, stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) },
    { status: 244, stdout: "", stderr: "", error: null }
  ]) {
    resetWindowsIdentityCircuit();
    assert.equal(getProcessIdentity(4242, { ...base, runCommandImpl: () => result }), null);
  }
  resetWindowsIdentityCircuit();
  assert.equal(getProcessIdentity(4242, { ...base, timeoutMs: 0, runCommandImpl: () => assert.fail("must not probe") }), null);
  assert.equal(getProcessIdentity(-1, { ...base, runCommandImpl: () => assert.fail("must not probe") }), null);
  assert.equal(getProcessIdentity(2 ** 32, { ...base, runCommandImpl: () => assert.fail("must not probe") }), null);
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
const WIN32_IDENTITY_ROW = /^(\d+) (\d+)$/;
const WIN32_PROBE_BATCH = 256;
const isWin32Pid = (pid) => Number.isInteger(pid) && pid > 0 && pid < 2 ** 32;

function identityProbeScript(pids) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `foreach ($p in @(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue)) {`,
    "  try { Write-Output ('{0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }",
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
  const batch = wanted.slice(0, WIN32_PROBE_BATCH);
  const probe = runPowerShell(identityProbeScript(batch), { ...options, timeoutMs: options.timeoutMs ?? 10000 });
  if (probe.unavailable || probe.status !== 0) {
    return map;
  }
  for (const line of probe.stdout.split(/\r?\n/)) {
    const row = WIN32_IDENTITY_ROW.exec(line.trim());
    if (row && map.has(Number(row[1]))) {
      map.set(Number(row[1]), `win32:${row[2]}`);
    }
  }
  return map;
}
```

  В `getProcessIdentity` заменить `if (platform === "win32") { return null; … }` на:

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

  Удалить `// ponytail: CIM (CreationDate) identity lands in v1.4.0`. Windows-only тест (`{ skip: !IS_WIN, timeout: 60_000 }`): запустить **свежий** процесс `node --import ./tests/test-env.mjs -e "import('<process.mjs url>').then(m => { const a = m.getProcessIdentity(process.pid); const b = m.getProcessIdentity(process.pid, { timeoutMs: 9000 }); console.log(JSON.stringify([a, b])) })"` дважды (два процесса) и долгоживущего ребёнка `node -e "setTimeout(()=>{},30000); console.log(process.pid)"` (не убитого таймаутом, `spawn` + `t.after(kill)`): identity свежего процесса совпадает с самой собой в обоих чтениях (кэш ставится только после первого — второе чтение до кэша сделать через `getProcessIdentities([process.pid])`, которая кэш не использует), начинается с `win32:\d+`, отличается от identity ребёнка, и `getProcessIdentity(child.pid)` из двух разных процессов совпадает.
- [ ] **Step 4: run** → PASS; eslint.
- [ ] **Step 5: gate + commit** `feat(process): Windows process identity from the process start time, batched per probe`.

---

### Task 4: Verify-and-kill на win32 в `terminateRecordedProcess`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`terminateRecordedProcess` ~274–326; новая `terminateWindowsRecordedProcess`, `terminateScript`)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:318-326` (комментарий `ownsBrokerProcess`) и `:340-341` (enum причин: добавить `process-missing`)
- Modify: `README.md` таблица причин teardown (строка `identity-unavailable`… добавить `process-missing`, метод `handle`)
- Test: `tests/process.test.mjs`

**Interfaces (Consumes):** `runPowerShell`, константы Task 2. **Produces:** `terminateRecordedProcess(pid, { identity, platform: "win32", timeoutMs, env, runCommandImpl, existsSyncImpl, now })` → `{ attempted, delivered, method: "handle", reason, survivors?: number[] }`; `reason` ∈ прежний словарь + `process-missing` (доказанно отсутствует, ничего не сделано).

Скрипт `terminateScript(pid, fileTime)` (оба аргумента — только цифры; `$phase` определяет код ошибки):

```powershell
$ErrorActionPreference = 'Stop'
$phase = 'preflight'
try {
  $target = <pid>
  try { $root = [System.Diagnostics.Process]::GetProcessById($target) } catch { exit 241 }
  if ($root.StartTime.ToFileTimeUtc().ToString() -ne '<fileTime>') { exit 242 }
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
  $byPid = @{}
  foreach ($r in $rows) { $byPid[[int]$r.ProcessId] = $r }
  $tree = @($root)               # verified handles, root first
  $seen = @{ $target = $true }
  $queue = @($target)
  while ($queue.Count -gt 0) {
    $parentPid = $queue[0]; $queue = @($queue | Select-Object -Skip 1)
    $parentStart = ($tree | Where-Object { $_.Id -eq $parentPid } | Select-Object -First 1).StartTime
    foreach ($r in $rows) {
      if ([int]$r.ParentProcessId -ne $parentPid -or $seen.ContainsKey([int]$r.ProcessId)) { continue }
      $seen[[int]$r.ProcessId] = $true
      try { $h = [System.Diagnostics.Process]::GetProcessById([int]$r.ProcessId) } catch { continue }
      $rowStart = [DateTime]$r.CreationDate
      if ([Math]::Abs(($h.StartTime - $rowStart).TotalMilliseconds) -gt 1) { continue }   # snapshot row is not this live process
      if ($h.StartTime -lt $parentStart) { continue }                                     # stale ParentProcessId (reused pid)
      $tree += $h; $queue += [int]$r.ProcessId
    }
  }
} catch { exit 244 }
$phase = 'kill'
try {
  [array]::Reverse($tree)          # children first, root last
  foreach ($h in $tree) { try { $h.Kill() } catch { } }
  $survivors = @()
  foreach ($h in $tree) { try { if (-not $h.WaitForExit(2000)) { $survivors += $h.Id } } catch { } }
  if ($survivors.Count -eq 0) { exit 0 }
  if ($survivors -contains $target) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $target /F | Out-Null
    try { $again = [System.Diagnostics.Process]::GetProcessById($target); $again.WaitForExit(1000) | Out-Null; if ($again.HasExited) { $survivors = @($survivors | Where-Object { $_ -ne $target }) } } catch { $survivors = @($survivors | Where-Object { $_ -ne $target }) }
    if ($survivors.Count -eq 0) { exit 245 }
  }
  Write-Output ($survivors -join ' ')
  exit 243
} catch { Write-Output ($tree | ForEach-Object { $_.Id }) -join ' '; exit 243 }
```

  Замечания для исполнителя: `GetProcessById` открывает handle — `Kill()`/`WaitForExit()` идут по нему, PID-рецикл после снимка невозможен; узлы, не прошедшие проверки (a)–(c) spec §3.4, не попадают в `$tree` и не сигналятся; генериков `New-Object` нет (CLM-дружественный preflight); в фазе `kill` любая ошибка → 243, в preflight → 244; вывод только цифры.

- [ ] **Step 1: failing tests**

```js
test("terminateRecordedProcess on win32 runs the handle-based verify-and-kill script and maps its exit codes", () => {
  const base = { identity: "win32:133700000000000000", platform: "win32", env: { SystemRoot: "D:\\Win" }, existsSyncImpl: existsPs, timeoutMs: 3000 };
  const cases = [
    [0, "", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }],
    [245, "", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }],
    [241, "", { attempted: false, delivered: false, method: "handle", reason: "process-missing" }],
    [242, "", { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }],
    [243, "4300 4301\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [4300, 4301] }],
    [244, "", { attempted: false, delivered: false, reason: "identity-unavailable" }]
  ];
  for (const [status, stdout, expected] of cases) {
    resetWindowsIdentityCircuit();
    let script = null;
    const result = terminateRecordedProcess(4242, { ...base, runCommandImpl: (file, args) => { script = Buffer.from(args[6], "base64").toString("utf16le"); return { status, stdout, stderr: "", error: null }; } });
    assert.deepEqual(result, expected, `exit ${status}`);
    assert.match(script, /\$target = 4242\b/);
    assert.match(script, /-ne '133700000000000000'/);
    assert.match(script, /GetProcessById/);
    assert.match(script, /\.Kill\(\)/);
    assert.doesNotMatch(script, /taskkill\.exe \/PID \$target \/T/, "the tree is walked through verified handles, never taskkill /T");
    assert.match(script, /"\$env:SystemRoot\\System32\\taskkill\.exe"/, "the only external tool is the one under the validated root");
  }
  // A timeout is not evidence either way: refuse.
  resetWindowsIdentityCircuit();
  const slow = terminateRecordedProcess(4242, { ...base, runCommandImpl: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }) });
  assert.deepEqual([slow.attempted, slow.delivered, slow.reason], [false, false, "identity-unavailable"]);
  // Malformed or missing identity never reaches PowerShell.
  for (const identity of ["win32:abc", "linux:5", null]) {
    resetWindowsIdentityCircuit();
    assert.equal(terminateRecordedProcess(4242, { ...base, identity, runCommandImpl: () => assert.fail("must not run") }).reason, "identity-unavailable");
  }
});
```

  Существующий тест «terminateRecordedProcess refuses on identity mismatch and without identity on win32» остаётся как есть (legacy без identity).
- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement** — в `terminateRecordedProcess` перед `const refusal = …`:

```js
  if (platform === "win32") {
    return terminateWindowsRecordedProcess(pid, identity, options);
  }
```

  и:

```js
// One PowerShell run proves the pid is still the recorded process (start time
// read through a handle), builds the tree from a CIM snapshot admitting only
// nodes whose live start time matches the snapshot and their parent, kills
// children-first through those handles (a recycled pid cannot be hit), and
// waits for every one of them. Every answer is an exit code, survivors are
// digits on stdout; nothing localised is parsed.
function terminateWindowsRecordedProcess(pid, identity, options) {
  const fileTime = typeof identity === "string" ? /^win32:(\d+)$/.exec(identity)?.[1] : null;
  const refused = (reason) => ({ attempted: false, delivered: false, reason });
  if (!fileTime) {
    return refused("identity-unavailable");
  }
  const run = runPowerShell(terminateScript(pid, fileTime), { ...options, timeoutMs: options.timeoutMs ?? 10000 });
  if (run.unavailable) {
    return refused("identity-unavailable");
  }
  switch (run.status) {
    case 0:
    case WINDOWS_EXITED_DURING_TERMINATION_EXIT:
      return { attempted: true, delivered: true, method: "handle", reason: "identity-match" };
    case WINDOWS_PROCESS_MISSING_EXIT:
      return { attempted: false, delivered: false, method: "handle", reason: "process-missing" };
    case WINDOWS_IDENTITY_MISMATCH_EXIT:
      return { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" };
    case WINDOWS_TERMINATION_FAILED_EXIT:
      return { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: (run.stdout.match(/\d+/g) ?? []).map(Number) };
    default:
      return refused("identity-unavailable");
  }
}
```

  `terminateScript(pid, fileTime)` — массив строк скрипта выше `.join("\n")` с подстановкой `${pid}`/`${fileTime}` (только цифры — проверено регэкспом/`isWin32Pid`; инъекция в скрипт невозможна).
- [ ] **Step 4:** обновить JSDoc/комментарии причин в `broker-lifecycle.mjs:318-341` (добавить `process-missing`, убрать «CIM identity is v1.4.0») и README-таблицу причин (строка `process-missing` — «the pid was provably gone before anything was signalled; the record is cleaned up»). `tests/commands.test.mjs` README-assertions — проверить.
- [ ] **Step 5: run** → PASS; eslint.
- [ ] **Step 6: второй проход Codex** (контроллер): `/codex:rescue --effort xhigh`, read-only, бриф = spec §2 + «PID reuse между снимком и Kill», «устаревший ParentProcessId», «CLM/AppLocker», «цикл ParentProcessId», «подмена SystemRoot/PSModulePath/TEMP», «survivors и delivered». Замечания → fix-раунд до Task 5.
- [ ] **Step 7: gate + commit** `feat(process): Windows kill from a stored record verifies the start time through a handle and terminates the verified tree`.

---

### Task 5: Reaper (win32 batch), бюджеты и сохранение записей, runtime-ожидания, Windows E2E

**Files:**
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs:380-440` (`reapDeadJobs`)
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs` (константы ~22–45; `cleanupSessionJobs` ~138; teardown ~298–322)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:342-380` (`teardownBrokerSession`: pid/log/session-файлы удаляются только при `delivered`, `process-missing`, `no-pid` или `isPidAlive(pid) === false`)
- Modify: `tests/runtime.test.mjs` (win32-ветки: ~1914–1920 оставить (legacy без identity); ~2167 `cancel sends turn interrupt` → без win32-исключения; ~2436–2476 «session end preserves background jobs» → foreground worker убит и на win32; ~3885–3895 turn-timeout/cancel → `cancelled`, `exited` строго `1` (это код родителя `task --await`); `session end fully cleans up jobs` → без win32-ветки; skip снять с 2004 (regex `^(linux|darwin|win32):`) и 4115; оставить skip на 1954 (posix cmdline fallback) и 3906 (игнорируемый SIGTERM))
- Test: `tests/tracked-jobs.test.mjs` (или файл, где тестируется `reapDeadJobs`: `rg -n 'reapDeadJobs' tests/`), `tests/broker-stale-pid.test.mjs`, Windows E2E в `tests/runtime.test.mjs`

**Interfaces (Consumes):** `getProcessIdentities`, `terminateRecordedProcess` win32 (`process-missing`, `survivors`). **Produces:** `reapDeadJobs(…, { getProcessIdentitiesImpl })` (только win32-ветка использует его; старый `getProcessIdentityImpl` — posix как прежде); `teardownBrokerSession` возвращает `{ signalled, reason, kept: boolean }`.

- [ ] **Step 1: failing tests** (reaper, win32-ветка через `platform: "win32"`):

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
      getProcessIdentitiesImpl: (pids) => { probes.push([...pids].sort()); return new Map(pids.map((pid) => [pid, pid === process.pid ? "win32:1" : "win32:other"])); }
    });
    assert.deepEqual(probes, [[process.pid, child.pid].sort()], "one probe, only for the records that passed the terminal/liveness checks");
    assert.equal(reaped.find((j) => j.id === "job-a").status, "running");
    assert.equal(reaped.find((j) => j.id === "job-b").status, "failed");
    assert.match(reaped.find((j) => j.id === "job-b").errorMessage, /pid reused/);
    // An empty batch means "unknown": nothing is reaped.
    const untouched = reapDeadJobs(workspace, jobs.slice(0, 2), { platform: "win32", getProcessIdentitiesImpl: () => new Map() });
    assert.deepEqual(untouched.map((j) => j.status), ["running", "running"]);
  } finally {
    child.kill("SIGKILL");
  }
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

  Подготовка записей — как в существующих тестах `reapDeadJobs` (`writeJobFile`/`upsertJob` из `lib/state.mjs`; повторить их паттерн).
- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement reaper** — в `reapDeadJobs` добавить опцию `getProcessIdentitiesImpl = getProcessIdentities`; после вычисления списка кандидатов (running/queued, не terminal on disk, `isPidAlive(pid) !== false`, `pid && identity`) — **только при `platform === "win32"`** один вызов `const batch = safe(() => getProcessIdentitiesImpl(candidatePids, { platform, timeoutMs: remainingMs ? Math.min(IDENTITY_PROBE_MS, remainingMs()) : IDENTITY_PROBE_MS }), new Map())`, и в цикле на win32 `actual = batch.get(pid) ?? null` вместо `getProcessIdentityImpl`; posix-ветка не меняется (тот же код, тот же per-pid `timeoutMs`). Реализация: предварительный проход по `jobs` собирает `candidatePids` теми же проверками, что и основной цикл (вынести в helper `liveIdentityCandidate(job)` → `{pid, identity}|null`, использовать в обоих местах).
- [ ] **Step 4: бюджеты хука** (`session-lifecycle-hook.mjs`): `const KILL_STEP_MS = process.platform === "win32" ? 4000 : IDENTITY_PROBE_MS;` — в `cleanupSessionJobs` `probeMs = Math.floor(Math.min(KILL_STEP_MS, remainingMs() / 2))`; teardown `timeoutMs: process.platform === "win32" ? stepBudget(KILL_STEP_MS) : Math.floor(stepBudget(IDENTITY_PROBE_MS) / 2)` (на win32 второй пробы нет — kill-скрипт один). Тест в `tests/commands.test.mjs`/`broker-stale-pid.test.mjs`: с `platform` инъекцией через env? Проще unit: экспортировать `killStepMs(platform)` и проверить 4000/2000.
- [ ] **Step 5: записи при неизвестном исходе** — `teardownBrokerSession`: вычислить `const provenGone = reason === "process-missing" || reason === "no-pid" || signalled || isPidAlive(pid) === false`; удалять `pidFile`/`logFile`/endpoint-файл и возвращать `kept: !provenGone`; хук: `if (!teardown.kept && loadBrokerSession(cwd)?.endpoint === brokerEndpoint) clearBrokerSession(cwd);` и в строке решения `kept=${teardown.kept}`. Тест (`tests/broker-stale-pid.test.mjs`): teardown с `terminateRecordedProcess`, возвращающим `identity-unavailable` для живого pid (`process.pid`, `pidIdentity: "win32:1"`, `platform` через inject `terminateImpl`? — проще: `killProcess` не вызывается, потому что `identity` не совпадает: использовать posix `identity: "linux:0"` mismatch) → pid-файл и запись остаются; с `isPidAlive(pid) === false` (несуществующий pid) → удаляются.
- [ ] **Step 6: runtime win32-ожидания** — по списку в Files; при снятии skip с 2004 заменить `/^(linux|darwin):/` на `/^(linux|darwin|win32):/`; в 3885–3895 удалить `if (IS_WIN) {…}` (общий путь: `status 0`, `/cancelled/i`, `assert.equal(await exited, 1)`); в 2436–2476 удалить win32-ветку (foreground worker убит, запись удалена, background сохранён); в `session end fully cleans up jobs` — то же.
- [ ] **Step 7: Windows-only E2E** (`{ skip: !IS_WIN, timeout: 90_000 }`, `tests/runtime.test.mjs`):

```js
test("cancel on Windows kills the worker and the whole codex.cmd tree it started", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pid && j.pidIdentity ? j : null; });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  // Every pid under the worker (cmd.exe -> node -> fake codex), captured before the kill.
  const tree = JSON.parse(run("powershell", ["-NoProfile", "-Command", `$all = Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId; $q = @(${running.pid}); $out = @(); while ($q.Count) { $p = $q[0]; $q = @($q | Select -Skip 1); $out += $p; $q += @($all | ? { $_.ParentProcessId -eq $p } | % { $_.ProcessId }) }; ConvertTo-Json @($out)`], { env }).stdout);
  assert.ok(tree.length >= 2, `expected a tree under the worker, got ${JSON.stringify(tree)}`);
  t.after(() => { for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => (tree.every((pid) => !isAlive(pid)) ? "gone" : null));
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled");
});

test("a reused-looking identity is never signalled on Windows: the reaper fails the job and cancel reports it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pid && j.pidIdentity ? j : null; });
  t.after(() => { try { process.kill(running.pid, "SIGKILL"); } catch {} });
  const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0);
  assert.equal(isAlive(running.pid), true, "the process holding the pid is a stranger to this record and must stay");
  const stored = readPersistedJob(repo, jobId);
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage ?? "", /pid reused/);
});

test("a planted PowerShell in the workspace or a relative PATH entry is never what the identity probe runs", { skip: !IS_WIN, timeout: 90_000 }, () => {
  const repo = makeTempDir(); fs.mkdirSync(path.join(repo, "tools"));
  const marker = path.join(repo, "HIJACKED");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(repo, "powershell.exe"));
  for (const planted of ["powershell.cmd", path.join("tools", "powershell.cmd"), path.join("tools", "powershell.exe.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), `@echo off\r\necho x> "${marker}"\r\n`);
  }
  const probe = run(process.execPath, ["--import", "./tests/test-env.mjs", "-e", "import('./plugins/codex/scripts/lib/process.mjs').then(m => console.log(m.getProcessIdentity(process.pid) ?? 'null'))"], {
    cwd: repo, env: { ...process.env, PATH: `.;tools;${process.env.PATH}`, PSModulePath: path.join(repo, "tools") }
  });
  assert.match(probe.stdout.trim(), /^win32:\d+$/, probe.stderr);
  assert.equal(fs.existsSync(marker), false);
});
```

  (`import('./plugins/…')` в `-e` резолвится относительно cwd = repo — заменить на абсолютный `pathToFileURL(path.join(ROOT, "plugins/codex/scripts/lib/process.mjs")).href`, `ROOT` — корень репозитория из helpers.) Плюс адаптация posix-теста «session end tears down the session broker» на Windows (снять skip; teardown идёт по identity) и проверка после него, что broker pid и pid его app-server (из дерева, снятого как выше) мертвы.
- [ ] **Step 8: gate + commit** `feat(runtime): Windows workers and brokers are killed from their records; records survive an unknown outcome`. Push; контроллер диспатчит CI — Windows-джобы зелёные с leak-шагом 0 = доказательство Task 3–5.

---

### Task 6: Документация

**Files:**
- Modify: `README.md` («### Windows», ~385–395: удалить «Still limited until v1.4.1 …»; требования: Windows PowerShell 5.1 in-box; при Constrained Language Mode/AppLocker kill из записи отказывает с `identity-unavailable`, записи сохраняются до следующей попытки; потомки, появившиеся после снимка, вне гарантии), таблица причин (`process-missing`, метод `handle`).
- Modify: `CHANGELOG.md` + `plugins/codex/CHANGELOG.md` (`## 1.4.1 — <день релизного коммита>`: Fixed — kill из записей на Windows (#743 win32, #423/#577, #336, #416, #487, #718), дерево через verified handles, leak-шаг обязателен; Changed — `status` на Windows делает одну пробу на все живые job'ы; записи брокера/job сохраняются при неизвестном исходе; ps-guard; (если менялся) `BROKER_BUSY_POLL_MS`).
- Modify: `docs/superpowers/triage/2026-09-27-upstream-triage.md` — статусы `fixed-in v1.4.1`.
- Test: `tests/commands.test.mjs` README-assertions.

- [ ] **Step 1**: правки; `cp CHANGELOG.md plugins/codex/CHANGELOG.md`; `node scripts/check-changelog.mjs`.
- [ ] **Step 2: gate + commit** `docs: Windows kill path, 1.4.1 changelog, triage statuses`.

---

### Task 7: Release v1.4.1

- [ ] `node scripts/bump-version.mjs 1.4.1 && npm run check-version && npm run check:changelog` (дата в заголовке = день релиза).
- [ ] `npm run check` + leak-check + `claude plugin validate . --strict` + `npm audit --omit=dev` + `npm pack --dry-run`; принять Dependabot-PR по `qs`, если открыт (после merge — `git pull` в worktree и повторный гейт).
- [ ] Whole-branch Claude review (Opus), затем `/codex:adversarial-review --base main --effort max` с брифом по spec §2 и «PID reuse между снимком и Kill», «CLM», «survivors»; DO-NOT-SHIP блокирует; закладывать 3–5 проходов.
- [ ] Финальный CI на релизном SHA: 9 джобов + quality, Windows leak-шаг 0.
- [ ] По команде пользователя: PR → merge → tag → `npm pack` + sha256 → `gh release create` → `claude plugin update codex@cbepx`; smoke в свежей сессии.
- [ ] Черновик `docs/superpowers/triage/upstream-comments-v1.4.1.md` (#743 win32, #423/#577, #336, #416, #487, #718; #70 только если UNC подтверждён; retest-просьбы #113 #236 #285 #295 #310) → одобрение → `gh issue comment`; статусы; архив SDD в `docs/superpowers/reports/v1.4.1/`; удалить worktree/ветку.

## Self-review

- Spec coverage: §2 → Task 2 (root, env, cwd, launch) + Task 4 (taskkill under root); §3.1 → Task 3/4 (`StartTime`); §3.2 → Task 2; §3.3 → Task 3 + Task 5 reaper (win32-only); §3.4 → Task 4; §3.5 → без кода (Task 5 E2E проверяет `win32:` в записи); §3.6 → Task 4/5 (cancel-контракт = reaper first, E2E «pid reused»); §3.7 → Task 5 Steps 4–5; §3.8 → Task 1; §4 → тесты Task 1–5; §5 → Task 6 + breaker Task 2; §6 → Task 1 (ps-guard) и Task 4 (`process-missing` только win32).
- Placeholder scan: дата CHANGELOG — правило (день релиза); все шаги с кодом/командами; тест-заготовки ссылаются на существующие helpers (`makeTempDir`, `seededRepo`, `installFakeCodex`, `buildEnv`, `waitFor`, `readPersistedJob`, `resolveStateDir`, `isAlive`, `IS_WIN`, `writeJobFile`).
- Type consistency: `runPowerShell` → `{ status, stdout, timedOut, unavailable }` (Task 2/3/4); `getProcessIdentities` → `Map<number, string|null>` (Task 3/5); `terminateRecordedProcess` win32 → `{ attempted, delivered, method: "handle", reason, survivors? }` (Task 4/5); `teardownBrokerSession` → `{ signalled, reason, kept }` (Task 5); константы 241–245 (Task 2/4); `existsPs`/`PS_UNDER` — тестовые helpers, определить один раз в `tests/process.test.mjs` перед первым использованием.
- Review Focus 1–5 → Task 2 env/argv + Task 5 sentinel; Task 3/4 junk stdout; Task 4 скрипт (handle + проверки узлов) и тест на 242; Task 2/4/5 breaker + сохранение записей; Task 4 тест 243+survivors.
