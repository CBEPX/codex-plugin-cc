# codex-plugin-cc v1.4.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать Windows ту же гарантию kill-пути, что posix имеет с v1.3.0: записанный PID сигналится только после доказательства (CIM `CreationDate`), дерево завершается целиком, четыре win32-отказа (`identity-unavailable`) становятся реальными kill'ами; плюс хвосты v1.4.0.

**Architecture:** Один запускатель `runPowerShell` (абсолютный путь `System32\WindowsPowerShell\v1.0\powershell.exe`, `-EncodedCommand`, только числовой вывод, circuit breaker); над ним batch-проба `getProcessIdentities` (одна CIM-выборка на все pid) и один verify-and-kill скрипт в `terminateRecordedProcess` (проверка `CreationDate` → дерево через CIM `Terminate()` дети→родитель → `taskkill.exe /F` fallback → exit-коды 241–245). Форматы записей (`pidIdentity`, sidecar) не меняются: identity `win32:<FILETIME>`. posix-ветки байт-в-байт как в v1.4.0.

**Tech Stack:** Node ≥18.18, ESM `.mjs`, `node --test` (`scripts/run-tests.mjs`), fake Codex fixture, Windows PowerShell 5.1 (in-box), CIM (`Get-CimInstance`/`Invoke-CimMethod`), GitHub Actions matrix с обязательным Windows.

**Spec:** `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` (этот же worktree); roadmap `/Users/g.mehrenin/.claude/plans/glistening-chasing-backus.md`, разделы «v1.4.1» и «Дизайн: process identity».

## Global Constraints

- Worktree `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.1`, ветка `release/v1.4.1` от `main` (5662171 = v1.4.0). `main` = установленный `codex@cbepx` 1.4.0 — не трогать.
- Гейт на задачу: `npm run check` → exit 0 (lint, build, typecheck:tests, check:changelog, тесты); `sleep 10; pgrep -f codex-plugin-test- | wc -l` → 0. Коммит только через `&&` после гейта по exit-кодам (roadmap п. 7), никогда по grep-совпадению в логе.
- Только `rg`, никаких `git add -A`. Трейлер `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push ветки по ходу разрешён пользователем; PR/merge/tag — отдельный вопрос в Task 7.
- Threat-model Windows-спавна (roadmap п. 9) обязательна для Task 2–4: PowerShell только по абсолютному пути System32, никаких голых имён, никакого PATH/cwd-поиска внутри скриптов (единственный внешний exe — `$env:SystemRoot\System32\taskkill.exe`), вывод — только целые числа, CR/LF-безопасно (`-EncodedCommand`).
- Тайминги (roadmap п. 8): никаких абсолютных `< N ms` ниже 10 s; `waitFor` 30 s; Windows-only E2E — `{ skip: !IS_WIN }` и `{ timeout: 60_000 }`.
- Fail-closed не меняется: `null`/ошибка/таймаут пробы никогда не разрешает kill; записи без identity на win32 остаются `identity-unavailable`; lock-тикеты на win32 — PID-liveness без identity; `terminateProcessTree` (живой handle app-server) — как в v1.4.0.
- Локально Windows нет: Task 2–5 доказываются inject-тестами на posix и Windows-матрицей CI после push; при исполнении Task 4 обязателен второй проход `/codex:rescue --effort xhigh` (read-only) с брифом по п. 9.

## Review Focus

1. Планируемый `powershell.cmd`/`powershell.exe` в cwd репозитория или в относительной записи PATH никогда не исполняется (Task 2 unit-тест на argv + Task 5 Windows-sentinel).
2. Не-ASCII путь установки и не-английская локаль (zh-TW, #310) не ломают ни пробу, ни kill: разбирается только `^\d+( \d+)?$` (Task 3/4 тесты с мусорным/локализованным stdout → `null`/`identity-unavailable`).
3. Рецикл PID между пробой и kill'ом: kill-скрипт сам сверяет `CreationDate` (Task 4 тест: exit 242 → `identity-mismatch`, `delivered:false`).
4. Медленный раннер: холодный PowerShell дольше бюджета → `status`/SessionEnd не зависают (Task 3 тест таймаута → `null` + breaker; Task 5 тест SessionEnd с `runCommandImpl`, который спит дольше `probeMs`).
5. PowerShell отсутствует/заблокирован (Constrained Language, AppLocker): `ENOENT`/exit 244 → поведение v1.4.0 (`identity-unavailable`), без исключений наружу (Task 2/4 тесты).

---

### Task 1: Хвосты v1.4.0 — обязательный leak-шаг CI, ps-guard, разбор флейка

**Files:**
- Modify: `.github/workflows/pull-request-ci.yml` (шаг «No leaked test processes», ~66–73), `.github/workflows/release-verify.yml` (тот же шаг, ~75–82)
- Modify: `plugins/codex/scripts/lib/process.mjs:196-207` (`processCommandLine`, ps-ветка)
- Test: `tests/process.test.mjs`
- Investigate: `tests/broker-stale-pid.test.mjs` («session end reaps a SIGKILLed background worker …», ~448–520)

**Interfaces:** `processCommandLine(pid, { timeoutMs })` — сигнатура не меняется; `timeoutMs <= 0` теперь возвращает `null` без спавна `ps` (как уже делает `getProcessIdentity` darwin).

- [ ] **Step 1: failing test** (`tests/process.test.mjs`, рядом с тестом «getProcessIdentity pins the darwin ps locale»):

```js
test("processCommandLine treats a spent budget as no probe on the ps branch", () => {
  for (const timeoutMs of [0, -1, 0.3]) {
    assert.equal(
      processCommandLine(42, { platform: "darwin", timeoutMs, runCommandImpl: () => assert.fail("must not spawn ps") }),
      null
    );
  }
  // An unset budget still probes.
  assert.equal(processCommandLine(42, { platform: "darwin", runCommandImpl: () => ({ status: 0, stdout: "node x\n", stderr: "", error: null }) }), "node x");
});
```

- [ ] **Step 2: run** `node --import ./tests/test-env.mjs --test --test-name-pattern="spent budget as no probe" tests/process.test.mjs` → FAIL (`must not spawn ps`).
- [ ] **Step 3: implement** в `processCommandLine` перед `runCommandImpl("ps", …)`:

```js
  // spawnSync reads a timeout of 0 as "no timeout": a spent budget is no probe.
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
    return null;
  }
```

- [ ] **Step 4: run** the test → PASS; `node --import ./tests/test-env.mjs --test tests/process.test.mjs` → all pass.
- [ ] **Step 5: CI leak step** — в обоих workflow заменить Windows-ветку шага «No leaked test processes» на подсчёт без собственного процесса и с `exit 1` при утечке:

```bash
          if [ "$RUNNER_OS" = "Windows" ]; then
            leaked=$(powershell -NoProfile -Command "\$p = @(Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'codex-plugin-test-' -and \$_.ProcessId -ne \$PID }); \$p | Select-Object ProcessId,ParentProcessId,Name,@{n='Cmd';e={\$_.CommandLine.Substring(0,[Math]::Min(160,\$_.CommandLine.Length))}} | Format-Table -AutoSize | Out-String -Width 220 | Write-Host; Write-Output \$p.Count" | tail -1 | tr -d '\r ')
            echo "Leaked test processes after 10 s: $leaked" | tee -a "$GITHUB_STEP_SUMMARY"
            [ "$leaked" = "0" ] || exit 1
          elif pgrep -af codex-plugin-test- ; then echo "leaked test processes" >&2; exit 1; fi
```

  Комментарий над шагом: «Same check as the local gate on every OS; the Windows count excludes the counting shell itself.» Убрать фразу «Windows is reported, not enforced».
- [ ] **Step 6: флейк reaper-теста** — 10 прогонов подряд: `for i in $(seq 10); do node --import ./tests/test-env.mjs --test --test-name-pattern="session end reaps a SIGKILLed background worker" tests/broker-stale-pid.test.mjs > /tmp/reap-$i.log 2>&1 || echo "FAIL $i"; done`. Любой FAIL → прочитать «broker log tail» из лога: если брокер отвечает `busy` из-за сокета предыдущего `sendBrokerShutdown`-повтора (в логе `client disconnected (1 remaining)` появляется позже ответа busy) — увеличить `BROKER_BUSY_POLL_MS` в хуке с 100 до 250 ms и повторить 10 прогонов; если причина иная — записать хвост лога в отчёт задачи и оставить тест как есть (контроллер решает). Без FAIL — записать «10/10 green locally» в отчёт.
- [ ] **Step 7: gate + commit** — `npm run check && sleep 10 && [ "$(pgrep -f codex-plugin-test- | wc -l | tr -d ' ')" = 0 ] && git add .github/workflows/pull-request-ci.yml .github/workflows/release-verify.yml plugins/codex/scripts/lib/process.mjs tests/process.test.mjs && git commit -m "ci(test): enforce the leak step on Windows; ps probe honours a spent budget"` (+ трейлер). Push; контроллер диспатчит CI и проверяет, что Windows-джобы зелёные с `Leaked test processes after 10 s: 0`.

---

### Task 2: PowerShell-запускатель с circuit breaker

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (рядом с `systemExe`, ~13)
- Test: `tests/process.test.mjs`

**Interfaces (Produces):**
- `export function systemPowerShell(env = process.env)` → `path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")`.
- `export function encodePowerShell(script)` → base64 of UTF-16LE.
- `export function runPowerShell(script, { timeoutMs, env, runCommandImpl, now })` → `{ status: number|null, stdout: string, timedOut: boolean, unavailable: boolean }`; `unavailable: true` когда breaker открыт (спавна не было) или спавн дал `ENOENT`/таймаут/exit 244; при этом breaker открывается на `WINDOWS_IDENTITY_CIRCUIT_MS = 60000` (per process). `export function resetWindowsIdentityCircuit()` — только для тестов.
- Константы: `WINDOWS_PROCESS_MISSING_EXIT = 241`, `WINDOWS_IDENTITY_MISMATCH_EXIT = 242`, `WINDOWS_TERMINATION_FAILED_EXIT = 243`, `WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244`, `WINDOWS_EXITED_DURING_TERMINATION_EXIT = 245` (экспортировать для тестов).

- [ ] **Step 1: failing tests**

```js
test("runPowerShell launches the in-box powershell.exe by absolute path with an encoded script", () => {
  resetWindowsIdentityCircuit();
  let seen = null;
  const result = runPowerShell("Write-Output 7", {
    env: { SystemRoot: "D:\\Win" },
    timeoutMs: 1234,
    runCommandImpl: (file, args, options) => { seen = { file, args, options }; return { status: 0, stdout: "7\r\n", stderr: "", error: null }; }
  });
  assert.equal(seen.file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(seen.args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.equal(seen.args[5], "-EncodedCommand");
  assert.equal(Buffer.from(seen.args[6], "base64").toString("utf16le"), "Write-Output 7");
  assert.equal(seen.options.timeoutMs, 1234);
  assert.equal(seen.options.shell, false);
  assert.deepEqual(result, { status: 0, stdout: "7\r\n", timedOut: false, unavailable: false });
});

test("runPowerShell opens the circuit on ENOENT, timeout or exit 244 and closes it after a minute", () => {
  resetWindowsIdentityCircuit();
  let calls = 0;
  const enoent = () => { calls += 1; return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }; };
  let clock = 1_000_000;
  const now = () => clock;
  assert.equal(runPowerShell("x", { runCommandImpl: enoent, now }).unavailable, true);
  assert.equal(runPowerShell("x", { runCommandImpl: enoent, now }).unavailable, true);
  assert.equal(calls, 1, "the open circuit must not spawn again");
  clock += 60_001;
  assert.equal(runPowerShell("x", { runCommandImpl: () => { calls += 1; return { status: 0, stdout: "1", stderr: "", error: null }; }, now }).unavailable, false);
  assert.equal(calls, 2);
  for (const result of [
    { status: null, stdout: "", stderr: "", error: null, signal: "SIGTERM" },
    { status: 244, stdout: "", stderr: "", error: null }
  ]) {
    resetWindowsIdentityCircuit();
    assert.equal(runPowerShell("x", { runCommandImpl: () => result, now }).unavailable, true);
    assert.equal(runPowerShell("x", { runCommandImpl: () => assert.fail("circuit must be open"), now }).unavailable, true);
  }
});
```

- [ ] **Step 2: run** → FAIL (`runPowerShell is not exported`).
- [ ] **Step 3: implement** в `process.mjs` после `systemExe`:

```js
export const WINDOWS_PROCESS_MISSING_EXIT = 241;
export const WINDOWS_IDENTITY_MISMATCH_EXIT = 242;
export const WINDOWS_TERMINATION_FAILED_EXIT = 243;
export const WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244;
export const WINDOWS_EXITED_DURING_TERMINATION_EXIT = 245;
const WINDOWS_IDENTITY_CIRCUIT_MS = 60000;
let windowsIdentityUnavailableAt = 0;

export function resetWindowsIdentityCircuit() {
  windowsIdentityUnavailableAt = 0;
}

// In-box Windows PowerShell 5.1, never `pwsh` (#336) and never a bare name.
export function systemPowerShell(env = process.env) {
  return path.win32.join(env?.SystemRoot || env?.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

// One way to run PowerShell: absolute path, no profile, script as
// -EncodedCommand (no quoting layer sees it). A launcher that is missing, hangs
// or reports 244 trips a per-process breaker: for a minute every caller gets
// `unavailable` at once instead of each waiting out its own timeout.
export function runPowerShell(script, options = {}) {
  const now = options.now ?? Date.now;
  if (windowsIdentityUnavailableAt && now() - windowsIdentityUnavailableAt < WINDOWS_IDENTITY_CIRCUIT_MS) {
    return { status: null, stdout: "", timedOut: false, unavailable: true };
  }
  const env = options.env ?? process.env;
  const result = (options.runCommandImpl ?? runCommand)(
    systemPowerShell(env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    { env, timeoutMs: options.timeoutMs, shell: false }
  );
  const timedOut = !result.error && result.status === null;
  const unavailable = result.error?.code === "ENOENT" || timedOut || result.status === WINDOWS_IDENTITY_UNAVAILABLE_EXIT;
  if (unavailable) {
    windowsIdentityUnavailableAt = now();
  } else if (!result.error) {
    windowsIdentityUnavailableAt = 0;
  }
  return { status: result.status ?? null, stdout: String(result.stdout ?? ""), timedOut, unavailable };
}
```

  Примечание: `runCommand` с абсолютным путём на win32 идёт в `buildLaunch` как `.exe` → прямой спавн, `windowsHide`, `shell:false`; на posix (тесты) — тоже прямой спавн, поэтому inject-тесты не зависят от платформы.
- [ ] **Step 4: run** tests → PASS; `npx eslint plugins/codex/scripts/lib/process.mjs tests/process.test.mjs`.
- [ ] **Step 5: gate + commit** `feat(process): in-box PowerShell launcher with an identity circuit breaker`.

---

### Task 3: Identity на win32 — batch-проба `getProcessIdentities`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`getProcessIdentity` win32-ветка ~217–223; новая `getProcessIdentities`)
- Test: `tests/process.test.mjs` (заменить `assert.equal(getProcessIdentity(42, { platform: "win32" }), null)` на inject-тест)

**Interfaces (Produces):**
- `export function getProcessIdentities(pids, options)` → `Map<number, string|null>`; options: `{ platform, timeoutMs, runCommandImpl, env, readFileSyncImpl, now }`. win32: один `runPowerShell`; posix: `getProcessIdentity` на каждый pid.
- `getProcessIdentity(pid, options)` на win32 возвращает `win32:<FILETIME>` или `null`; `timeoutMs` по умолчанию 10000; `!(timeoutMs > 0)` → `null` без спавна; own-pid кэш как на posix.
- Скрипт пробы (константа `IDENTITY_PROBE_SCRIPT(pids)`):

```powershell
$ErrorActionPreference = 'Stop'
try {
  $rows = Get-CimInstance Win32_Process -Filter '<ProcessId = a OR ProcessId = b ...>'
  foreach ($r in @($rows)) { Write-Output ('{0} {1}' -f $r.ProcessId, ([DateTime]$r.CreationDate).ToFileTimeUtc()) }
} catch { exit 244 }
```

- [ ] **Step 1: failing tests**

```js
test("getProcessIdentities on win32 probes every pid in one PowerShell run and parses only integer rows", () => {
  resetWindowsIdentityCircuit();
  let script = null;
  const runCommandImpl = (file, args) => {
    script = Buffer.from(args[6], "base64").toString("utf16le");
    return { status: 0, stdout: "4242 133700000000000000\r\n7 133700000000000001\r\nINFO: localized noise\r\n", stderr: "", error: null };
  };
  const map = getProcessIdentities([4242, 7, 99], { platform: "win32", runCommandImpl, env: {} });
  assert.match(script, /ProcessId = 4242 OR ProcessId = 7 OR ProcessId = 99/);
  assert.equal(map.get(4242), "win32:133700000000000000");
  assert.equal(map.get(7), "win32:133700000000000001");
  assert.equal(map.get(99), null, "a pid the snapshot does not list is null");
  assert.equal(getProcessIdentity(4242, { platform: "win32", runCommandImpl, env: {} }), "win32:133700000000000000");
});

test("getProcessIdentity on win32 is null on junk output, timeout, exit 244 or a spent budget", () => {
  for (const result of [
    { status: 0, stdout: "not a number\r\n", stderr: "", error: null },
    { status: 0, stdout: "", stderr: "", error: null },
    { status: null, stdout: "", stderr: "", error: null, signal: "SIGTERM" },
    { status: 244, stdout: "", stderr: "", error: null }
  ]) {
    resetWindowsIdentityCircuit();
    assert.equal(getProcessIdentity(4242, { platform: "win32", runCommandImpl: () => result, env: {} }), null);
  }
  resetWindowsIdentityCircuit();
  assert.equal(getProcessIdentity(4242, { platform: "win32", timeoutMs: 0, runCommandImpl: () => assert.fail("must not probe"), env: {} }), null);
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

function identityProbeScript(pids) {
  const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $rows = Get-CimInstance Win32_Process -Filter '${filter}'`,
    "  foreach ($r in @($rows)) { Write-Output ('{0} {1}' -f $r.ProcessId, ([DateTime]$r.CreationDate).ToFileTimeUtc()) }",
    `} catch { exit ${WINDOWS_IDENTITY_UNAVAILABLE_EXIT} }`
  ].join("\n");
}

// Several pids, one probe. On win32 that is one PowerShell run for the whole
// list (a cold start costs 0.5-3 s; per pid it would multiply); elsewhere the
// per-pid probe is already cheap. Unknown, missing or unparseable → null.
export function getProcessIdentities(pids, options = {}) {
  const platform = options.platform ?? process.platform;
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
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
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!(timeoutMs > 0)) {
    return map;
  }
  const probe = runPowerShell(identityProbeScript(wanted), { timeoutMs, env: options.env, runCommandImpl: options.runCommandImpl, now: options.now });
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

  Убрать `// ponytail: CIM (CreationDate) identity lands in v1.4.0`. Windows-only тест (`{ skip: !IS_WIN }`): `getProcessIdentity(process.pid)` стабильна, начинается с `win32:`, отличается от identity дочернего `node -e "setTimeout(()=>{},2000)"` (pid из stdout, как в posix-тесте выше).
- [ ] **Step 4: run** tests → PASS; eslint.
- [ ] **Step 5: gate + commit** `feat(process): Windows process identity from CIM CreationDate, batched per probe`.

---

### Task 4: Verify-and-kill на win32 в `terminateRecordedProcess`

**Files:**
- Modify: `plugins/codex/scripts/lib/process.mjs` (`terminateRecordedProcess` ~274–326; новая `terminateWindowsRecordedProcess`)
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs:318-326` (комментарий `ownsBrokerProcess`: «CIM identity is v1.4.0» → «identity is what teardown checks on Windows since v1.4.1»)
- Test: `tests/process.test.mjs`

**Interfaces (Consumes):** `runPowerShell`, exit-константы из Task 2. **Produces:** `terminateRecordedProcess(pid, { identity, platform: "win32", timeoutMs, env, runCommandImpl })` → `{ attempted, delivered, method: "cim", reason }`; словарь `reason` прежний (`identity-match`, `identity-mismatch`, `identity-unavailable`, `kill-failed`); без identity на win32 — по-прежнему `identity-unavailable` без спавна.

Скрипт (`terminateScript(pid, expectedFileTime)`):

```powershell
$ErrorActionPreference = 'Stop'
$target = <pid>
try { $t = Get-CimInstance Win32_Process -Filter "ProcessId = $target" } catch { exit 244 }
if ($null -eq $t) { exit 241 }
if (([DateTime]$t.CreationDate).ToFileTimeUtc().ToString() -ne '<expectedFileTime>') { exit 242 }
try { $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId) } catch { exit 244 }
$seen = @{}; $order = New-Object System.Collections.Generic.List[int]
$queue = New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($target)
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue(); if ($seen.ContainsKey($p)) { continue }; $seen[$p] = $true; $order.Add($p)
  foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and $c.ProcessId -ne $p) { $queue.Enqueue([int]$c.ProcessId) } }
}
$order.Reverse()
foreach ($p in $order) { try { $x = Get-CimInstance Win32_Process -Filter "ProcessId = $p"; if ($x) { Invoke-CimMethod -InputObject $x -MethodName Terminate | Out-Null } } catch { } }
Start-Sleep -Milliseconds 200
try { $left = Get-CimInstance Win32_Process -Filter "ProcessId = $target" } catch { exit 244 }
if ($null -eq $left) { exit 0 }
& "$env:SystemRoot\System32\taskkill.exe" /PID $target /F | Out-Null
try { $left = Get-CimInstance Win32_Process -Filter "ProcessId = $target" } catch { exit 244 }
if ($null -eq $left) { exit 245 }
exit 243
```

- [ ] **Step 1: failing tests**

```js
test("terminateRecordedProcess on win32 verifies the CreationDate and kills the tree in one PowerShell run", () => {
  resetWindowsIdentityCircuit();
  const outcomes = [
    [0, { attempted: true, delivered: true, reason: "identity-match" }],
    [245, { attempted: true, delivered: true, reason: "identity-match" }],
    [241, { attempted: false, delivered: false, reason: "identity-mismatch" }],
    [242, { attempted: false, delivered: false, reason: "identity-mismatch" }],
    [243, { attempted: true, delivered: false, reason: "kill-failed" }],
    [244, { attempted: false, delivered: false, reason: "identity-unavailable" }]
  ];
  for (const [status, expected] of outcomes) {
    resetWindowsIdentityCircuit();
    let script = null;
    const result = terminateRecordedProcess(4242, {
      identity: "win32:133700000000000000", platform: "win32", env: { SystemRoot: "C:\\Windows" }, timeoutMs: 3000,
      runCommandImpl: (file, args) => { script = Buffer.from(args[6], "base64").toString("utf16le"); return { status, stdout: "", stderr: "", error: null }; }
    });
    assert.deepEqual({ attempted: result.attempted, delivered: result.delivered, reason: result.reason }, expected, `exit ${status}`);
    assert.equal(result.method, status === 244 ? undefined : "cim");
    assert.match(script, /ProcessId = 4242/);
    assert.match(script, /'133700000000000000'/);
    assert.match(script, /Invoke-CimMethod .* -MethodName Terminate/);
    assert.doesNotMatch(script, /taskkill \/T/, "the tree is walked through CIM, never taskkill /T");
  }
  // A timeout is not evidence either way: refuse, and open the circuit.
  resetWindowsIdentityCircuit();
  const slow = terminateRecordedProcess(4242, { identity: "win32:1", platform: "win32", env: {}, runCommandImpl: () => ({ status: null, stdout: "", stderr: "", error: null, signal: "SIGTERM" }) });
  assert.deepEqual([slow.attempted, slow.reason], [false, "identity-unavailable"]);
  // A malformed recorded identity never reaches PowerShell.
  assert.deepEqual(terminateRecordedProcess(4242, { identity: "win32:abc", platform: "win32", runCommandImpl: () => assert.fail("must not run") }).reason, "identity-unavailable");
  // Legacy records (no identity) still refuse on win32.
  assert.equal(terminateRecordedProcess(4242, { identity: null, platform: "win32", runCommandImpl: () => assert.fail("must not run") }).reason, "identity-unavailable");
});
```

  Существующий тест «terminateRecordedProcess refuses on identity mismatch and without identity on win32» остаётся (его win32-часть — legacy без identity).
- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement** — в `terminateRecordedProcess` перед `const refusal = …`:

```js
  if (platform === "win32") {
    if (!identity) {
      return { attempted: false, delivered: false, reason: "identity-unavailable" };
    }
    return terminateWindowsRecordedProcess(pid, identity, options);
  }
```

  и новая функция:

```js
// One PowerShell run proves the pid is still the recorded process (CreationDate)
// and, only then, terminates its tree children-first through CIM — `taskkill /T`
// failed for grandchildren on CI. Every answer is an exit code; nothing
// localised is parsed.
function terminateWindowsRecordedProcess(pid, identity, options) {
  const fileTime = /^win32:(\d+)$/.exec(identity)?.[1];
  if (!fileTime) {
    return { attempted: false, delivered: false, reason: "identity-unavailable" };
  }
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!(timeoutMs > 0)) {
    return { attempted: false, delivered: false, reason: "identity-unavailable" };
  }
  const run = runPowerShell(terminateScript(pid, fileTime), { timeoutMs, env: options.env, runCommandImpl: options.runCommandImpl, now: options.now });
  if (run.unavailable) {
    return { attempted: false, delivered: false, reason: "identity-unavailable" };
  }
  switch (run.status) {
    case 0:
    case WINDOWS_EXITED_DURING_TERMINATION_EXIT:
      return { attempted: true, delivered: true, method: "cim", reason: "identity-match" };
    case WINDOWS_PROCESS_MISSING_EXIT:
    case WINDOWS_IDENTITY_MISMATCH_EXIT:
      return { attempted: false, delivered: false, method: "cim", reason: "identity-mismatch" };
    case WINDOWS_TERMINATION_FAILED_EXIT:
      return { attempted: true, delivered: false, method: "cim", reason: "kill-failed" };
    default:
      return { attempted: false, delivered: false, method: "cim", reason: "identity-unavailable" };
  }
}
```

  `terminateScript(pid, fileTime)` возвращает скрипт выше как массив строк `.join("\n")` с подстановкой `${pid}` и `'${fileTime}'` (оба — только цифры, проверено регэкспом: инъекция в скрипт невозможна). Тест на `method` для 244: функция возвращает `method: undefined` только на пути `unavailable` (`run.unavailable` true при 244) — согласовано с тестом.
- [ ] **Step 4: run** → PASS; eslint; обновить комментарий в `broker-lifecycle.mjs:318-326`.
- [ ] **Step 5: второй проход Codex** (контроллер): `/codex:rescue --effort xhigh`, read-only, бриф = п. 9 roadmap + «рецикл PID между проверкой и Terminate», «CIM недоступен/CLM», «дерево с циклом ParentProcessId», «`$env:SystemRoot` подменён в окружении job'а». Замечания → fix-раунд до Task 5.
- [ ] **Step 6: gate + commit** `feat(process): Windows kill from a stored record verifies CreationDate and terminates the tree through CIM`.

---

### Task 5: Reaper на batch-пробе, снятие отказов в потоках и Windows E2E

**Files:**
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs:380-440` (`reapDeadJobs`)
- Modify: `tests/runtime.test.mjs` — win32-ветки, ставшие неверными: `cancel sends turn interrupt …` (~2167: `if (IS_WIN && cancelResult.status === 1)`), `task --turn-timeout-ms / cancel` блок ~3885–3895 (`cancellationPending`, `identity-unavailable`), `session end fully cleans up jobs …` (win32 ожидание `{status:"running",pid}` + stderr `SessionEnd left … identity-unavailable`), плюс `{ skip: process.platform === "win32" }` на тестах 2004, 3906, 4115 — снять, если тест не зависит от posix-групп процессов (иначе оставить с комментарием «process-group semantics»).
- Test: `tests/tracked-jobs.test.mjs` (или где тестируется `reapDeadJobs` — `rg -n 'reapDeadJobs' tests/`), новые Windows-only E2E в `tests/runtime.test.mjs`.

**Interfaces (Consumes):** `getProcessIdentities` (Task 3), `terminateRecordedProcess` win32 (Task 4). `reapDeadJobs(workspaceRoot, jobs, options)` получает `getProcessIdentitiesImpl = getProcessIdentities` (старый `getProcessIdentityImpl` остаётся для совместимости тестов и используется только если передан).

- [ ] **Step 1: failing test** (reaper):

```js
test("reapDeadJobs probes all live identities in one call and fails only the reused pid", () => {
  const workspace = makeTempDir();
  // two running jobs with sidecar identities, both pids alive (use process.pid for one and a spawned child for the other)
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore" });
  try {
    const jobs = [
      { id: "job-a", status: "running", pid: process.pid, pidIdentity: "x:same" },
      { id: "job-b", status: "running", pid: child.pid, pidIdentity: "x:recorded" }
    ];
    for (const job of jobs) writeJobFile(workspace, job.id, job);
    let probes = 0;
    const reaped = reapDeadJobs(workspace, jobs, {
      getProcessIdentitiesImpl: (pids) => { probes += 1; return new Map(pids.map((pid) => [pid, pid === process.pid ? "x:same" : "x:different"])); }
    });
    assert.equal(probes, 1, "one probe for every live pid");
    assert.equal(reaped.find((j) => j.id === "job-a").status, "running");
    assert.equal(reaped.find((j) => j.id === "job-b").status, "failed");
    assert.match(reaped.find((j) => j.id === "job-b").errorMessage, /pid reused/);
  } finally {
    child.kill("SIGKILL");
  }
});
```

  (`writeJobFile` — из `lib/state.mjs`; если существующие тесты reaper строят состояние иначе — повторить их подготовку, суть теста: один вызов пробы, разные исходы.)
- [ ] **Step 2: run** → FAIL (`probes` = 2 или `getProcessIdentitiesImpl` не используется).
- [ ] **Step 3: implement** в `reapDeadJobs`: перед `jobs.map` собрать `live = jobs.filter(running|queued).map(resolveJobPid)`, отфильтровать `pid && identity`, один вызов `const identities = getProcessIdentitiesImpl(pids, { timeoutMs: remainingMs ? Math.min(IDENTITY_PROBE_MS, remainingMs()) : IDENTITY_PROBE_MS, platform })` (внутри `try`, при исключении — пустая Map), затем в цикле вместо `getProcessIdentityImpl(pid, …)` использовать `identities.get(pid) ?? null`; если вызывающий передал `getProcessIdentityImpl` (старые тесты), строить `getProcessIdentitiesImpl` из него (`pids.map(pid => [pid, impl(pid, opts)])`). Импортировать `getProcessIdentities` из `./process.mjs`.
- [ ] **Step 4: run** reaper-тесты + `tests/runtime.test.mjs` → PASS на posix.
- [ ] **Step 5: runtime win32-ветки** — заменить ожидания отказа на ожидания успеха: в `cancel sends turn interrupt …` убрать ветку `IS_WIN && status === 1`, на всех платформах `assert.equal(cancel.status, 0)` и `cancelled`; в блоке ~3885 — `assert.equal(cancelled.status, 0)`, `/cancelled/i`, затем `await exited` и `assert.equal(await exited, 1)` только на posix (на win32 `TerminateProcess` даёт код 1 — тоже `1`; проверить, иначе `assert.ok([1, null].includes(code))`); в `session end fully cleans up jobs` win32-ветку удалить (общее ожидание: запись удалена, worker мёртв). Снять `skip: win32` с 2004 («sidecar carries its identity and cancel signals it») — идентичность теперь есть; 3906 и 4115 оставить skip только если они шлют SIGTERM в группу (`process.kill(-pid)`), с комментарием.
- [ ] **Step 6: Windows-only E2E** (`{ skip: !IS_WIN, timeout: 90_000 }`, в `tests/runtime.test.mjs`):

```js
test("a tampered sidecar identity leaves the Windows worker alive and names the mismatch", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "20000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const stateDir = resolveStateDir(repo);
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pid && j.pidIdentity ? j : null; });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  t.after(() => { try { process.kill(running.pid, "SIGKILL"); } catch {} });
  // Tamper: same pid, other identity.
  const jobFile = path.join(stateDir, "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 1);
  assert.deepEqual(JSON.parse(cancel.stdout), { jobId, status: "running", cancellationPending: true, reason: "identity-mismatch" });
  assert.equal(isAlive(running.pid), true);
});

test("a planted powershell in the cwd or a relative PATH entry is never what the kill path runs", { skip: !IS_WIN, timeout: 90_000 }, () => {
  const repo = makeTempDir(); fs.mkdirSync(path.join(repo, "tools"));
  const marker = path.join(repo, "HIJACKED");
  for (const planted of ["powershell.cmd", "powershell.exe.cmd", path.join("tools", "powershell.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), `@echo off\r\necho x> "${marker}"\r\n`);
  }
  const identity = getProcessIdentity(process.pid, { env: { ...process.env, PATH: `.;tools;${process.env.PATH}` }, cwd: repo });
  assert.match(identity, /^win32:\d+$/);
  assert.equal(fs.existsSync(marker), false);
});
```

  Плюс: «cancel kills a Windows background worker» (обычный `cancel` → `status 0`, `waitFor(() => !isAlive(pid))`), «SessionEnd tears down the session broker from its record on Windows» (адаптация posix-теста `session end tears down …` без skip), «a codex.cmd app-server tree is gone after teardown» (после SessionEnd ни один процесс с `codex-plugin-test-` в command line не жив — через `getProcessIdentities`? проще: `tasklist`-free проверка `isAlive` для broker.pid и worker pid).
- [ ] **Step 7: gate + commit** `feat(runtime): Windows workers and brokers are killed from their records; reaper probes identities in one call`. Push; контроллер диспатчит CI; Windows-джобы обязаны быть зелёными вместе с leak-шагом = 0 — это доказательство Task 3–5.

---

### Task 6: Документация

**Files:**
- Modify: `README.md` (раздел «### Windows», ~385–395: удалить абзац «Still limited until v1.4.1 …», добавить требования: Windows PowerShell 5.1 in-box, CIM; при Constrained Language Mode/AppLocker kill из записи отказывает с `identity-unavailable`), таблица причин teardown (`cim` как метод), «Development» — без изменений.
- Modify: `CHANGELOG.md` + `plugins/codex/CHANGELOG.md` (секция `## 1.4.1 — <дата релизного коммита>`: Fixed — kill из сохранённых записей на Windows (#743 win32, #423/#577, #336, #416, #487, #718), дерево через CIM вместо `taskkill /T`, leak-шаг обязателен; Changed — `status` на Windows делает одну CIM-пробу на все живые job'ы; ps-guard).
- Modify: `docs/superpowers/triage/2026-09-27-upstream-triage.md` — статусы `fixed-in v1.4.1` для перечисленных; `verify`-корзина без изменений.
- Test: `tests/commands.test.mjs` README-assertions (`rg -n 'README' tests/commands.test.mjs`) — обновить те, что цитируют удалённый абзац.

- [ ] **Step 1**: правки; `cp CHANGELOG.md plugins/codex/CHANGELOG.md`; `node scripts/check-changelog.mjs` (секция 1.4.0 всё ещё есть → OK до bump).
- [ ] **Step 2: gate + commit** `docs: Windows kill path, 1.4.1 changelog, triage statuses`.

---

### Task 7: Release v1.4.1

- [ ] `node scripts/bump-version.mjs 1.4.1 && npm run check-version && npm run check:changelog` (дата в заголовке = день релиза).
- [ ] `npm run check` + leak-check + `claude plugin validate . --strict` + `npm audit --omit=dev` + `npm pack --dry-run`; принять Dependabot-PR по `qs`, если он открыт (после merge — `git pull` в worktree и повторный гейт).
- [ ] Whole-branch Claude review (Opus; фокус: посадочные места win32-веток, posix байт-в-байт, тайминги), затем `/codex:adversarial-review --base main --effort max` с брифом по п. 9 roadmap и «рецикл PID между проверкой и Terminate»; DO-NOT-SHIP блокирует; закладывать 3–5 проходов.
- [ ] Финальный CI на релизном SHA: все 9 джобов + quality, Windows leak-шаг = 0.
- [ ] По команде пользователя: PR → merge → tag → `npm pack` + sha256 → `gh release create` → `claude plugin update codex@cbepx`; smoke в свежей сессии (status, task sync/background PONG, review --background → result).
- [ ] Черновик `docs/superpowers/triage/upstream-comments-v1.4.1.md` (#743 win32, #423/#577, #336, #416, #487, #718; #70 только если UNC подтверждён; retest-просьбы #113 #236 #285 #295 #310) → одобрение → `gh issue comment`; статусы триажа `fixed-in v1.4.1`; архив SDD в `docs/superpowers/reports/v1.4.1/`; удалить worktree/ветку.

## Self-review

- Spec coverage: §2 → Global Constraints + Task 2; §3.1–3.2 → Task 2/3; §3.3 → Task 3 + Task 5 (reaper); §3.4 → Task 4; §3.5 → без кода (Task 5 E2E проверяет, что `pidIdentity` записывается); §3.6 → Task 4/5; §3.7 → Task 5 (SessionEnd не меняется; тест с медленным `runCommandImpl` — добавить в Task 5 Step 1 как второй кейс: `getProcessIdentitiesImpl` спит дольше `remainingMs` → job остаётся running, ничего не сигналится); §3.8 → Task 1; §4 → тесты в Task 1–5; §5 → Task 6 (README про CLM/AppLocker) + Task 2 (breaker).
- Placeholder scan: дата в CHANGELOG определяется днём релиза (правило, не TBD); все шаги содержат код/команды.
- Type consistency: `runPowerShell` → `{ status, stdout, timedOut, unavailable }` используется в Task 3/4 одинаково; `getProcessIdentities` → `Map<number, string|null>` в Task 3 и Task 5; `terminateRecordedProcess` результат `{ attempted, delivered, method, reason }` совпадает с v1.4.0 контрактом.
- Review Focus 1–5 → Task 5 sentinel / Task 3+4 junk-stdout / Task 4 exit 242 / Task 3 timeout + Task 5 slow-probe / Task 2+4 ENOENT/244.
