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

