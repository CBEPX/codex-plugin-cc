import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { IS_WIN, makeTempDir, run } from "./helpers.mjs";
import {
  buildLaunch,
  getProcessIdentities,
  getProcessIdentity,
  isPidAlive,
  parseProtocolLines,
  powerShellEnvironment,
  processCommandLine,
  quoteForCmd,
  resetWindowsIdentityCircuit,
  resolveExecutable,
  runCommand,
  runPowerShell,
  systemRoot,
  terminateProcessTree,
  terminateRecordedProcess,
  workerCommandLine
} from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ENV_URL = pathToFileURL(path.join(ROOT, "tests", "test-env.mjs")).href;
const PROCESS_MJS_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "process.mjs")).href;

const PS_UNDER = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const existsPs = (p) => p === PS_UNDER;
const psBase = { env: { SystemRoot: "D:\\Win" }, timeoutMs: 1000, existsSyncImpl: existsPs };

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, shell: options.shell };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  // Direct taskkill.exe, never through a shell: Git Bash's $SHELL mangles /PID.
  assert.deepEqual(captured, {
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "1234", "/T", "/F"],
    shell: false
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

// ESRCH on the group means the pid leads no group (or is gone). Signalling the
// bare pid is a second syscall on a number that may have been recycled since the
// caller proved it, so the primitive stops here and says so.
test("terminateProcessTree never signals the bare pid after the group kill fails", () => {
  const calls = [];
  const outcome = terminateProcessTree(4242, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
  });

  assert.deepEqual(calls, [[-4242, "SIGTERM"]]);
  assert.deepEqual([outcome.attempted, outcome.delivered, outcome.method, outcome.groupGone], [true, false, "process-group", true]);
});

const LINUX_STAT = (starttime) => `42 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 ${starttime} 0 0 0`;
const groupEsrchKill = (calls) => (pid, signal) => {
  calls.push([pid, signal]);
  if (pid < 0) {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  }
};

test("terminateRecordedProcess re-verifies the identity before signalling a pid that leads no group", () => {
  const calls = [];
  let reads = 0;
  const outcome = terminateRecordedProcess(42, {
    identity: "linux:999",
    platform: "linux",
    readFileSyncImpl: () => { reads += 1; return LINUX_STAT(999); },
    killImpl: groupEsrchKill(calls)
  });
  assert.deepEqual(calls, [[-42, "SIGTERM"], [42, "SIGTERM"]]);
  assert.equal(reads, 2);
  assert.deepEqual([outcome.attempted, outcome.delivered, outcome.method, outcome.reason], [true, true, "process", "identity-match"]);
});

test("terminateRecordedProcess refuses the bare pid when its identity changed after the group kill", () => {
  const calls = [];
  const stats = [LINUX_STAT(999), LINUX_STAT(1000)];
  const outcome = terminateRecordedProcess(42, {
    identity: "linux:999",
    platform: "linux",
    readFileSyncImpl: () => stats.shift(),
    killImpl: groupEsrchKill(calls)
  });
  assert.deepEqual(calls, [[-42, "SIGTERM"]]);
  assert.deepEqual([outcome.attempted, outcome.delivered, outcome.reason], [true, false, "identity-mismatch"]);
});

test("terminateRecordedProcess refuses the bare pid when its command line changed after the group kill", () => {
  const calls = [];
  const lines = ["node codex-companion.mjs task-worker --job-id job-1\n", "bash\n"];
  const outcome = terminateRecordedProcess(42, {
    identity: null,
    platform: "darwin",
    commandLineMatch: /task-worker/,
    runCommandImpl: () => ({ status: 0, stdout: lines.shift(), stderr: "", error: null }),
    killImpl: groupEsrchKill(calls)
  });
  assert.deepEqual(calls, [[-42, "SIGTERM"]]);
  assert.deepEqual([outcome.attempted, outcome.delivered, outcome.reason], [true, false, "identity-mismatch"]);
});

test("processCommandLine reads the command line of a live process", { skip: process.platform === "win32" }, () => {
  const line = processCommandLine(process.pid);
  assert.ok(line, "expected a command line for the current process");
  assert.ok(line.includes(path.basename(process.execPath)), line);
});

test("processCommandLine returns null for a pid that is not running", { skip: process.platform === "win32" }, () => {
  assert.equal(processCommandLine(2 ** 31 - 1), null);
});

// `ps -o command=` is cut at $COLUMNS on Linux procps even when piped: a long
// install path could lose the `codex-companion.mjs` marker the reaper and the
// teardowns look for. Linux reads the kernel's copy; other posix asks ps for
// the unlimited width.
test("processCommandLine reads /proc/<pid>/cmdline on linux", () => {
  let readPath = null;
  const line = processCommandLine(42, {
    platform: "linux",
    readFileSyncImpl: (file) => { readPath = file; return `node\0/very/long/${"x/".repeat(80)}codex-companion.mjs\0task-worker\0`; },
    runCommandImpl: () => assert.fail("linux must not run ps")
  });
  assert.equal(readPath, "/proc/42/cmdline");
  assert.ok(line.includes("codex-companion.mjs task-worker"), line);
  assert.ok(!line.includes("\0"));
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: () => "" }), null);
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: () => { throw new Error("ENOENT"); } }), null);
});

// A zombie keeps its pid (alive to kill 0) but its /proc cmdline is empty: the
// state field is what tells it from a live process whose line cannot be read.
test("processCommandLine reports a linux zombie as <defunct> and nothing else", () => {
  const read = (state) => (file) => (file.endsWith("/cmdline") ? "" : `42 (node (x) y) ${state} 1 42 42 0 -1 0`);
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: read("Z") }), "<defunct>");
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: read("X") }), "<defunct>");
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: read("S") }), null);
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: read("R") }), null);
  const statThrows = (file) => { if (file.endsWith("/stat")) { throw new Error("ENOENT"); } return ""; };
  assert.equal(processCommandLine(42, { platform: "linux", readFileSyncImpl: statThrows }), null);
});

test("processCommandLine asks ps for unlimited width off linux", () => {
  let seen = null;
  const line = processCommandLine(42, {
    platform: "darwin",
    runCommandImpl: (command, args, options) => { seen = { command, args, options }; return { status: 0, stdout: "node /x/codex-companion.mjs task-worker\n", stderr: "", error: null }; }
  });
  assert.equal(line, "node /x/codex-companion.mjs task-worker");
  assert.equal(seen.command, "ps");
  assert.ok(seen.args.includes("-ww"), seen.args.join(" "));
  assert.equal(seen.options.env.COLUMNS, "10000");
  assert.equal(seen.options.env.LC_ALL, "C");
  assert.equal(seen.options.shell, false);
  assert.equal(processCommandLine(42, { platform: "darwin", runCommandImpl: () => ({ status: 0, stdout: "  \n", stderr: "", error: null }) }), null);
});

// spawnSync reads a timeout of 0 as "no timeout": a spent budget must be no
// probe at all, not a probe with no bound.
test("processCommandLine treats a spent budget as no probe on the ps branch", () => {
  for (const timeoutMs of [0, -1]) {
    assert.equal(processCommandLine(42, { platform: "darwin", timeoutMs, runCommandImpl: () => assert.fail("must not spawn ps") }), null);
  }
  // A fractional positive budget is clamped by runCommand and still probes; an unset one probes too.
  for (const options of [{ timeoutMs: 0.3 }, {}]) {
    assert.equal(processCommandLine(42, { platform: "darwin", ...options, runCommandImpl: () => ({ status: 0, stdout: "node x\n", stderr: "", error: null }) }), "node x");
  }
});

// A pid alone cannot tell the process that was recorded from the one that
// inherited the number (#743): identity is the start time, which a recycled pid
// cannot share.
test("getProcessIdentity is stable for the same process and differs for another one", { skip: process.platform === "win32" }, () => {
  const mine = getProcessIdentity(process.pid);
  assert.ok(mine && mine.length > 0);
  assert.equal(getProcessIdentity(process.pid), mine);
  const child = spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 2000); console.log(process.pid)"], { encoding: "utf8", timeout: 100 });
  // The child was killed by the timeout; its identity, if any, must not equal ours.
  assert.notEqual(getProcessIdentity(Number(child.stdout.trim()) || 999999), mine);
});

test("getProcessIdentity parses linux /proc stat and darwin ps output", () => {
  assert.equal(getProcessIdentity(42, { platform: "linux", readFileSyncImpl: () => "42 (node (x)) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 123456 1 2 3" }), "linux:123456");
  assert.equal(getProcessIdentity(42, { platform: "darwin", runCommandImpl: () => ({ status: 0, stdout: "Mon Sep 27 10:00:00 2026 node\n", stderr: "", error: null }) }), "darwin:Mon Sep 27 10:00:00 2026|node");
});

// `comm` on darwin is the executable path, which can hold spaces; and `lstart`
// follows the locale and time zone unless they are pinned — a process recorded
// under one locale and checked under another must not read as a different one.
test("getProcessIdentity pins the darwin ps locale and keeps a comm path with spaces whole", () => {
  let seen = null;
  const identity = getProcessIdentity(42, {
    platform: "darwin",
    runCommandImpl: (command, args, options) => {
      seen = { command, args, options };
      return { status: 0, stdout: "Sun Sep  7 09:00:00 2026     /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n", stderr: "", error: null };
    }
  });
  assert.equal(identity, "darwin:Sun Sep  7 09:00:00 2026|/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.env.LC_ALL, "C");
  assert.equal(seen.options.env.TZ, "UTC");
  // A spent budget is not "no timeout": spawnSync reads 0 as unbounded.
  assert.equal(getProcessIdentity(42, { platform: "darwin", timeoutMs: 0, runCommandImpl: () => assert.fail("must not probe") }), null);
});

test("runCommand reports a timed-out command as having no exit status", { skip: process.platform === "win32" }, () => {
  const result = runCommand(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 100 });
  assert.equal(result.status, null);
  assert.notEqual(result.status, 0);
});

// spawnSync throws ERR_OUT_OF_RANGE on a fractional timeout and reads 0 as
// "unbounded": budgets halved or spent must still reach it as an integer >= 1.
test("runCommand clamps a fractional, zero or negative timeout to an integer >= 1", { skip: process.platform === "win32" }, () => {
  const fractional = runCommand(process.execPath, ["-e", ""], { timeoutMs: 500.5 });
  assert.equal(fractional.status, 0);
  for (const timeoutMs of [0, 0.4, -5]) {
    const started = Date.now();
    const result = runCommand(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs });
    assert.equal(result.status, null, `timeoutMs ${timeoutMs} must stay bounded`);
    assert.ok(Date.now() - started < 4000);
  }
});

test("terminateRecordedProcess refuses on identity mismatch and without identity on win32", () => {
  let killed = false;
  const mismatch = terminateRecordedProcess(4242, { identity: "linux:1", platform: "linux", readFileSyncImpl: () => "4242 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 999 0 0 0", killImpl: () => { killed = true; } });
  assert.equal(mismatch.attempted, false);
  assert.equal(mismatch.reason, "identity-mismatch");
  assert.equal(killed, false);
  const win = terminateRecordedProcess(4242, { identity: null, platform: "win32", killImpl: () => { killed = true; } });
  assert.deepEqual([win.attempted, win.reason, killed], [false, "identity-unavailable", false]);
});

test("terminateRecordedProcess signals on a matching identity and refuses when it is unavailable", () => {
  const calls = [];
  const stat = "4242 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 999 0 0 0";
  const ok = terminateRecordedProcess(4242, { identity: "linux:999", platform: "linux", readFileSyncImpl: () => stat, killImpl: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual([ok.attempted, ok.reason], [true, "identity-match"]);
  assert.deepEqual(calls, [[-4242, "SIGTERM"]]);
  const gone = terminateRecordedProcess(4242, { identity: "linux:999", platform: "linux", readFileSyncImpl: () => { throw new Error("ENOENT"); }, killImpl: () => calls.push("must not") });
  assert.deepEqual([gone.attempted, gone.reason], [false, "identity-unavailable"]);
  assert.equal(terminateRecordedProcess(Number.NaN).reason, "no-pid");
  assert.equal(calls.length, 1);
});

test("terminateRecordedProcess falls back to the command line on posix when no identity was recorded", () => {
  const calls = [];
  const ok = terminateRecordedProcess(4242, { identity: null, platform: "darwin", commandLineMatch: /app-server-broker\.mjs/, runCommandImpl: () => ({ status: 0, stdout: "node app-server-broker.mjs serve\n", stderr: "", error: null }), killImpl: (pid, sig) => calls.push([pid, sig]) });
  assert.equal(ok.attempted, true);
  assert.equal(ok.reason, "command-line-match");
  assert.deepEqual(calls[0], [-4242, "SIGTERM"]);
  const no = terminateRecordedProcess(4242, { identity: null, platform: "darwin", commandLineMatch: /app-server-broker\.mjs/, runCommandImpl: () => ({ status: 0, stdout: "bash\n", stderr: "", error: null }), killImpl: () => calls.push("must not") });
  assert.equal(no.attempted, false);
  assert.equal(calls.length, 1);
});

test("terminateRecordedProcess hands a verified pid to an injected terminateImpl", () => {
  const terminated = [];
  const outcome = terminateRecordedProcess(4242, {
    platform: "darwin",
    commandLineMatch: () => true,
    runCommandImpl: () => ({ status: 0, stdout: "node x\n", stderr: "", error: null }),
    terminateImpl: (pid) => terminated.push(pid)
  });
  assert.deepEqual(terminated, [4242]);
  assert.deepEqual([outcome.attempted, outcome.delivered, outcome.reason], [true, true, "command-line-match"]);
});

// Windows spawning without $SHELL: where.exe resolves the real file, .cmd/.bat
// shims go through cmd.exe with every argument escaped, .exe/.com run directly.
test("resolveExecutable walks PATH x PATHEXT with fs, skips the extensionless shim and never the cwd", () => {
  // A case-insensitive stand-in for the Windows file system.
  const present = new Set(["c:\\tools.d\\codex", "c:\\npm\\codex", "c:\\npm\\codex.cmd", "c:\\bin\\codex.exe", "c:\\w\\codex.exe", "c:\\users\\项\\npm\\codex.cmd"]);
  const existsSyncImpl = (candidate) => present.has(candidate.toLowerCase());
  const env = { PATH: 'C:\\tools.d;.;"C:\\npm";C:\\bin', PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolveExecutable("codex", { env, cwd: "C:\\w", existsSyncImpl }), "C:\\npm\\codex.CMD");
  // PATHEXT decides: without .CMD in it the .exe wins.
  assert.equal(resolveExecutable("codex", { env: { ...env, PATHEXT: ".EXE" }, existsSyncImpl }), "C:\\bin\\codex.EXE");
  // A non-ASCII install directory is a plain string here, not decoded console output.
  assert.equal(resolveExecutable("codex", { env: { PATH: "C:\\Users\\项\\npm", PATHEXT: ".CMD" }, existsSyncImpl }), "C:\\Users\\项\\npm\\codex.CMD");
  // "." and the cwd are never searched; PATHEXT entries we cannot launch (.JS) are ignored; a lowercase Path key works.
  assert.equal(resolveExecutable("codex", { env: { PATH: ".;C:\\nowhere", PATHEXT: ".JS;.CMD" }, cwd: "C:\\w", existsSyncImpl }), null);
  assert.equal(resolveExecutable("codex", { env: { Path: "C:\\bin", PATHEXT: ".EXE" }, existsSyncImpl }), "C:\\bin\\codex.EXE");
  assert.equal(resolveExecutable("codex", { env: { PATH: "", PATHEXT: ".EXE" }, existsSyncImpl }), null);
});

test("quoteForCmd escapes every argument so cmd.exe and the shim's %* both pass it through", () => {
  assert.throws(() => quoteForCmd("a\nb"), /line break/);
  assert.throws(() => quoteForCmd("a\rb"), /line break/);
  const table = [
    ["plain", '^^^"plain^^^"'],
    ["with space", '^^^"with^^^ space^^^"'],
    ['q"uote', '^^^"q\\^^^"uote^^^"'],
    ["", '^^^"^^^"'],
    ["%PATH%", '^^^"^^^%PATH^^^%^^^"'],
    ["a&b", '^^^"a^^^&b^^^"'],
    ["trail\\", '^^^"trail\\\\^^^"']
  ];
  for (const [arg, expected] of table) {
    assert.equal(quoteForCmd(arg), expected, JSON.stringify(arg));
  }
});

test("buildLaunch runs .exe directly and .cmd through cmd.exe /d /s /c with verbatim arguments", () => {
  assert.deepEqual(buildLaunch("C:\\bin\\codex.exe", ["a b"], {}), { file: "C:\\bin\\codex.exe", args: ["a b"], env: {}, windowsVerbatimArguments: false });
  assert.deepEqual(buildLaunch("C:\\Program Files\\npm\\codex.cmd", ["app-server", "a&b"], { ComSpec: "C:\\Windows\\system32\\cmd.exe", Path: '.;tools;"C:\\npm";C:\\node' }), {
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", '"C:\\Program^ Files\\npm\\codex.cmd ^^^"app-server^^^" ^^^"a^^^&b^^^""'],
    // cmd.exe must not find the shim's bare `node` in the cwd or via a relative PATH entry.
    env: { ComSpec: "C:\\Windows\\system32\\cmd.exe", Path: "C:\\npm;C:\\node", NoDefaultCurrentDirectoryInExePath: "1" },
    windowsVerbatimArguments: true
  });
  assert.equal(buildLaunch("C:\\x\\run.BAT", [], {}).file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(buildLaunch("C:\\x\\run.BAT", [], { SystemRoot: "D:\\Win" }).file, "D:\\Win\\System32\\cmd.exe");
});

test("runCommand on win32 resolves a bare name through PATH and launches the shim without a shell", () => {
  const calls = [];
  const spawnSyncImpl = (file, args, options) => {
    calls.push({ file, args, options });
    return { status: 0, stdout: "codex 1.0\n", stderr: "" };
  };
  const existsSyncImpl = (candidate) => candidate.toLowerCase() === "c:\\npm\\codex.cmd";
  const result = runCommand("codex", ["--version"], { platform: "win32", env: { PATH: "C:\\npm", PATHEXT: ".EXE;.cmd" }, existsSyncImpl, spawnSyncImpl });
  assert.deepEqual([result.command, result.args, result.stdout], ["codex", ["--version"], "codex 1.0\n"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[0].args, ["/d", "/s", "/v:off", "/c", '"C:\\npm\\codex.cmd ^^^"--version^^^""']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.env.NoDefaultCurrentDirectoryInExePath, "1");

  // A path is launched as is; a bare name that resolves to nothing is ENOENT without any spawn.
  calls.length = 0;
  runCommand("C:\\Windows\\System32\\taskkill.exe", ["/PID", "1"], { platform: "win32", spawnSyncImpl });
  runCommand("C:\\node\\node.exe", [], { platform: "win32", spawnSyncImpl });
  assert.deepEqual(calls.map((call) => [call.file, call.options.shell, call.options.windowsVerbatimArguments]), [
    ["C:\\Windows\\System32\\taskkill.exe", false, false],
    ["C:\\node\\node.exe", false, false]
  ]);
  calls.length = 0;
  const missing = runCommand("npm", [], { platform: "win32", env: { PATH: "C:\\npm" }, existsSyncImpl: () => false, spawnSyncImpl });
  assert.equal(missing.error.code, "ENOENT");
  assert.equal(missing.status, null);
  // Nothing found: ENOENT is reported without any spawn (libuv would search the cwd).
  assert.deepEqual(calls, []);
});

// Only CI runs this: a real cmd.exe parses the line, then the shim's %* re-parses it.
test("runCommand round-trips awkward arguments through a .cmd shim in a directory with a space", { skip: !IS_WIN }, () => {
  const dir = path.join(makeTempDir(), "shim dir");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "argv.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(dir, "argv-shim.cmd"), '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n');
  const args = ["plain", "with space", 'q"uote', "", "%PATH%", "a&b", "trail\\", "^caret", "!bang!", "C:\\Program Files (x86)\\x"];
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  // A `node.cmd` planted in the cwd, or under a relative PATH entry, must not be
  // what the shim's bare `node` resolves to.
  const repo = makeTempDir();
  fs.mkdirSync(path.join(repo, "tools"));
  for (const planted of ["node.cmd", path.join("tools", "node.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), "@echo off\r\necho HIJACKED\r\n");
  }
  const result = runCommand("argv-shim", args, { env: { ...env, PATH: `.;tools;${env.PATH}` }, cwd: repo });
  assert.equal(result.error, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("workerCommandLine matches the job id literally", () => {
  assert.ok(workerCommandLine("task-a.b").test("node companion.mjs task-worker --job-id task-a.b"));
  assert.equal(workerCommandLine("task-a.b").test("node companion.mjs task-worker --job-id task-aXb"), false);
  assert.equal(workerCommandLine("task-a+").test("node companion.mjs task-worker --job-id task-aaa"), false);
});

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

test("powerShellEnvironment passes through only absolute LOCALAPPDATA and PSModuleAnalysisCachePath", () => {
  const withBoth = powerShellEnvironment("D:\\Win", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", PSModuleAnalysisCachePath: "C:\\cache\\mac" });
  assert.equal(withBoth.LOCALAPPDATA, "C:\\Users\\x\\AppData\\Local");
  assert.equal(withBoth.PSModuleAnalysisCachePath, "C:\\cache\\mac");
  for (const bad of [{ LOCALAPPDATA: "relative", PSModuleAnalysisCachePath: "" }, {}, { LOCALAPPDATA: 5 }]) {
    const env = powerShellEnvironment("D:\\Win", bad);
    assert.equal("LOCALAPPDATA" in env, false, JSON.stringify(bad));
    assert.equal("PSModuleAnalysisCachePath" in env, false, JSON.stringify(bad));
  }
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

// Two fresh, unrelated node processes must agree on the same live pid's win32
// identity (batched and single-pid alike) and on their own, while telling that
// pid apart from their own — proof against a fluke read or a stale cache.
test("getProcessIdentity and getProcessIdentities agree on a live win32 process across fresh processes", { skip: !IS_WIN, timeout: 60_000 }, (t) => {
  // A repeating interval, not a one-shot timeout: the child must still be alive
  // for every probe below, not just the ones that land inside its first 30 s.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => child.kill());

  const probe = () => {
    const result = run(process.execPath, [
      "--import", TEST_ENV_URL, "-e",
      `import(${JSON.stringify(PROCESS_MJS_URL)}).then(m => console.log(JSON.stringify([m.getProcessIdentities([process.pid]).get(process.pid), m.getProcessIdentity(process.pid), m.getProcessIdentity(${child.pid})])))`
    ], { timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };

  const [ownBatch1, ownSingle1, childIdentity1] = probe();
  const [ownBatch2, ownSingle2, childIdentity2] = probe();

  assert.equal(ownBatch1, ownSingle1);
  assert.match(ownBatch1, /^win32:\d+$/);
  assert.equal(ownBatch2, ownSingle2);
  assert.match(ownBatch2, /^win32:\d+$/);

  assert.match(childIdentity1, /^win32:\d+$/);
  assert.equal(childIdentity1, childIdentity2);
  assert.notEqual(childIdentity1, ownBatch1);
  assert.notEqual(childIdentity1, ownBatch2);
});

test("terminateRecordedProcess on win32 runs the pinned verify-and-kill script and maps its protocol", () => {
  const clock = () => 1_700_000_000_000; // ms; deadline = clock + 3000 - 500
  const expectedDeadline = (BigInt(1_700_000_000_000 + 2500) * 10000n + 116444736000000000n).toString();
  const base = { identity: "win32:133700000000000000", platform: "win32", ...psBase, timeoutMs: 3000, exclude: [{ pid: 555, identity: "win32:133700000000000000" }, { pid: 556, identity: "linux:5" }, { pid: 0, identity: "win32:1" }], clock };
  const cases = [
    [0, "KILL\r\nOK\r\n", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }],
    [0, "failure 5\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [0, "KILL\r\nZugriff verweigert\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [241, "", { attempted: false, delivered: false, method: "handle", reason: "process-missing" }],
    [241, "SURVIVOR 4300 1337\r\nSURVIVOR 4301 1338\r\n", { attempted: false, delivered: false, method: "handle", reason: "process-missing", survivors: [{ pid: 4300, identity: "win32:1337" }, { pid: 4301, identity: "win32:1338" }] }],
    [241, "SURVIVOR 4300 1\r\nSURVIVOR 4300 2\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [241, "SURVIVOR 0 0\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [241, "SURVIVOR 4300 1337\r\nOK\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [241, "KILL\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [242, "", { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }],
    [241, "junk\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [242, "OK\r\n", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [245, "", { attempted: false, delivered: false, reason: "identity-unavailable" }],
    [245, "KILL\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "KILL\r\nSURVIVOR 0 0\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
    [243, "KILL\r\nSURVIVOR 4300 1\r\nSURVIVOR 4300 2\r\n", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }],
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
    assert.match(script, /\$exclude = @\{ 555 = '133700000000000000' \}\n/, "only the verified win32 exclusion survives");
    assert.ok(script.indexOf("$exclude.ContainsKey($cid)") > script.indexOf("$live = Micro $h.StartTime"), "exclusion is decided after the pin and start-time read");
    assert.match(script, /\$code = 245\n/);
    assert.match(script, /Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate \|/, "provider-side projection");
    assert.doesNotMatch(script, /CommandLine|app-server-broker|shielded/, "no command-line shielding: a child mentioning the broker is an ordinary child");
    assert.match(script, /\$code = 245; throw 'budget'/);
    assert.equal(script.match(/exit 244/g).length, 1, "244 is only the CLM guard");
    assert.match(script, new RegExp(`FromFileTimeUtc\\(${expectedDeadline}\\)`), "absolute deadline counts the PowerShell start-up");
    assert.match(script, /\$null = \$h\.Handle/, "the handle is pinned before StartTime is read");
    // 241: the root is gone; its orphans (the same walk as the kill tree: transitive, time-ordered, the
    // verified exclusion skipped) are reported, never killed.
    const missingAt = script.indexOf("try { $root = Pin $target } catch [System.ArgumentException] {");
    const missingEnd = script.indexOf("$code = 241; throw 'missing'");
    assert.ok(missingAt > 0 && missingEnd > missingAt, "241 is decided after the orphan report");
    const missing = script.slice(missingAt, missingEnd);
    assert.match(missing, /\$floor = Micro \(\[DateTime\]::FromFileTimeUtc\(\[long\]\$expected\)\)/, "the recorded start in the microsecond domain");
    assert.match(missing, /foreach \(\$h in @\(Walk \$target \$floor\)\)/, "the orphans come from the kill tree's own walk, rooted at the recorded start");
    assert.match(script, /\$tree = @\(\$root\) \+ @\(Walk \$target \(Micro \$root\.StartTime\)\)/, "the kill tree uses the same walk");
    assert.doesNotMatch(missing, /Kill\(\)|-Filter/, "orphans are reported, never killed; no direct-children-only query");
    assert.ok(missing.indexOf("Write-Output") > missing.indexOf("$orphans +="), "rows are printed only after a complete pass (245 until then)");
    const walk = script.slice(script.indexOf("function Walk("), script.indexOf("$tree = @()"));
    assert.ok(walk.length > 0, "one walk function");
    assert.match(walk, /if \(\$exclude\.ContainsKey\(\$cid\) -and \$exclude\[\$cid\] -eq \$h\.StartTime\.ToFileTimeUtc\(\)\.ToString\(\)\) \{ continue \}/, "an excluded broker is never in the tree nor an orphan");
    assert.match(walk, /if \(\$live -ne \(Micro \$r\.CreationDate\)\) \{ continue \}/, "a reused pid is not ours");
    assert.match(walk, /if \(\$live -lt \$starts\[\$pp\]\) \{ continue \}/, "time-ordered: never older than its parent (or the recorded root)");
    assert.match(walk, /\$queue \+= \$cid/, "transitive: children of found processes are walked too");
    assert.match(script, /catch \[System\.ArgumentException\] \{ continue \}/, "a child that is already gone is skipped, any other pin error aborts with 245");
    assert.match(script, /\$t - \(\$t % 10\)/, "exact Int64 microsecond truncation");
    assert.match(script, /\.Kill\(\)/);
    assert.doesNotMatch(script, /taskkill|& "|Start-Process/, "no external program is ever started");
    assert.match(script, /finally \{\n {2}foreach \(\$h in \$pinned\)/);
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

test("terminateRecordedProcess win32: empty exclusion is an empty hashtable and a kill timeout leaves the breaker closed", () => {
  const base = { identity: "win32:1337", platform: "win32", ...psBase, timeoutMs: 3000 };
  resetWindowsIdentityCircuit();
  let script = "";
  terminateRecordedProcess(4242, { ...base, exclude: [], runCommandImpl: (f, a) => { script = Buffer.from(a[6], "base64").toString("utf16le"); return { status: 0, stdout: "KILL\r\nOK\r\n", stderr: "", error: null }; } });
  assert.match(script, /\$exclude = @\{\}\n/);
  const timedOut = { status: null, stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) };
  const working = { status: 0, stdout: "", stderr: "", error: null };
  resetWindowsIdentityCircuit();
  terminateRecordedProcess(4242, { ...base, runCommandImpl: () => timedOut });
  let ran = false;
  runPowerShell("x", { ...psBase, runCommandImpl: () => { ran = true; return working; } });
  assert.ok(ran, "a timed-out kill does not open the breaker");
  resetWindowsIdentityCircuit();
  runPowerShell("x", { ...psBase, runCommandImpl: () => timedOut });
  ran = false;
  runPowerShell("x", { ...psBase, runCommandImpl: () => { ran = true; return working; } });
  assert.equal(ran, false, "a timed-out probe still opens it");
  resetWindowsIdentityCircuit();
  runPowerShell("x", { ...psBase, runCommandImpl: () => ({ ...working, status: 245 }) });
  ran = false;
  runPowerShell("x", { ...psBase, runCommandImpl: () => { ran = true; return working; } });
  assert.ok(ran, "exit 245 never trips the breaker");
});

// Live: the real kill script's 241 (gone before the pin) and 242 (identity mismatch).
function spawnIdler(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  return child;
}

test("terminateRecordedProcess on live win32 reports process-missing for a pid that is gone", { skip: !IS_WIN, timeout: 90_000 }, (t) => {
  resetWindowsIdentityCircuit();
  const child = spawnIdler(t);
  const identity = getProcessIdentity(child.pid);
  assert.match(identity, /^win32:\d+$/);
  child.kill();
  const deadline = Date.now() + 10_000;
  while (isPidAlive(child.pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.equal(isPidAlive(child.pid), false);
  const outcome = terminateRecordedProcess(child.pid, { identity, timeoutMs: 30_000 });
  assert.equal(outcome.reason, "process-missing");
  assert.equal(outcome.survivors, undefined, "no orphans: nothing to report");
});

test("terminateRecordedProcess on live win32 reports, and never kills, an orphan the gone root left", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  resetWindowsIdentityCircuit();
  // detached: libuv puts a non-detached child in its parent's kill-on-close job object, so killing the
  // parent would take the grandchild with it (the CI failure of 7f765b4: process-missing, no survivors).
  const parent = spawn(process.execPath, ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  let orphan = null;
  t.after(() => {
    try { parent.kill(); } catch { /* already gone */ }
    try { if (orphan) process.kill(orphan); } catch { /* already gone */ }
  });
  orphan = Number(await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
  const identity = getProcessIdentity(parent.pid);
  const orphanIdentity = getProcessIdentity(orphan);
  assert.match(identity, /^win32:\d+$/);
  assert.match(orphanIdentity, /^win32:\d+$/);
  parent.kill();
  const deadline = Date.now() + 10_000;
  while (isPidAlive(parent.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isPidAlive(parent.pid), false);
  assert.equal(isPidAlive(orphan), true, "the orphan outlived its parent");
  // The raw script answer goes into the failure message, so a red CI run diagnoses itself.
  let raw = null;
  const outcome = terminateRecordedProcess(parent.pid, { identity, timeoutMs: 30_000, runCommandImpl: (...args) => (raw = runCommand(...args)) });
  assert.deepEqual(outcome, {
    attempted: false, delivered: false, method: "handle", reason: "process-missing", survivors: [{ pid: orphan, identity: orphanIdentity }]
  }, `parent ${parent.pid} ${identity}, orphan ${orphan} ${orphanIdentity}; script exit ${raw?.status} stdout ${JSON.stringify(raw?.stdout)} stderr ${JSON.stringify(raw?.stderr)}`);
  assert.equal(isPidAlive(orphan), true, "an orphan is reported, never killed");
});

test("terminateRecordedProcess on live win32 refuses a wrong identity and leaves the process alive", { skip: !IS_WIN, timeout: 90_000 }, (t) => {
  resetWindowsIdentityCircuit();
  const child = spawnIdler(t);
  assert.ok(getProcessIdentity(child.pid));
  assert.equal(terminateRecordedProcess(child.pid, { identity: "win32:1", timeoutMs: 30_000 }).reason, "identity-mismatch");
  assert.equal(isPidAlive(child.pid), true);
});
