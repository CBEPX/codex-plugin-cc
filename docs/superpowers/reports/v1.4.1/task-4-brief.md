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

