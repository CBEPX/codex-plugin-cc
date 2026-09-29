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

