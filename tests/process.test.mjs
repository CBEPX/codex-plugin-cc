import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { IS_WIN, makeTempDir } from "./helpers.mjs";
import {
  buildLaunch,
  getProcessIdentity,
  processCommandLine,
  quoteForCmd,
  resolveExecutable,
  runCommand,
  terminateProcessTree,
  terminateRecordedProcess,
  workerCommandLine
} from "../plugins/codex/scripts/lib/process.mjs";

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
  assert.equal(getProcessIdentity(42, { platform: "win32" }), null);
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
test("resolveExecutable takes where.exe's first PATHEXT hit and skips the extensionless shim", () => {
  let seen = null;
  const spawnSyncImpl = (file, args, options) => {
    seen = { file, args, options };
    return { status: 0, stdout: "C:\\tools.d\\codex\r\nC:\\npm\\codex\r\nC:\\npm\\codex.CMD\r\nC:\\bin\\codex.exe\r\n", stderr: "" };
  };
  assert.equal(resolveExecutable("codex", { env: { PATHEXT: ".COM;.EXE;.BAT;.CMD" }, cwd: "C:\\w", spawnSyncImpl }), "C:\\npm\\codex.CMD");
  assert.equal(seen.file, "C:\\Windows\\System32\\where.exe");
  assert.deepEqual(seen.args, ["$PATH:codex"]);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.timeout, 5000);
  assert.equal(seen.options.cwd, "C:\\w");
  // The lookup never outlives the caller's own budget.
  resolveExecutable("codex", { env: {}, timeoutMs: 250, spawnSyncImpl });
  assert.equal(seen.options.timeout, 250);
  // PATHEXT decides: without .CMD in it the .exe wins.
  assert.equal(resolveExecutable("codex", { env: { PATHEXT: ".EXE" }, spawnSyncImpl }), "C:\\bin\\codex.exe");
  assert.equal(resolveExecutable("codex", { env: {}, spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "INFO: Could not find files" }) }), null);
  assert.equal(resolveExecutable("codex", { env: {}, spawnSyncImpl: () => ({ status: 0, stdout: "C:\\npm\\codex\r\n", stderr: "" }) }), null);
  assert.equal(resolveExecutable("codex", { env: {}, spawnSyncImpl: () => ({ error: new Error("ENOENT"), stdout: "" }) }), null);
});

// The table pins the caret strings; the Windows-only round-trip test below is the
// behavioural oracle.
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
  assert.deepEqual(buildLaunch("C:\\bin\\codex.exe", ["a b"], {}), { file: "C:\\bin\\codex.exe", args: ["a b"], windowsVerbatimArguments: false });
  assert.deepEqual(buildLaunch("C:\\Program Files\\npm\\codex.cmd", ["app-server", "a&b"], { ComSpec: "C:\\Windows\\system32\\cmd.exe" }), {
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", '"C:\\Program^ Files\\npm\\codex.cmd ^^^"app-server^^^" ^^^"a^^^&b^^^""'],
    windowsVerbatimArguments: true
  });
  assert.equal(buildLaunch("C:\\x\\run.BAT", [], {}).file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(buildLaunch("C:\\x\\run.BAT", [], { SystemRoot: "D:\\Win" }).file, "D:\\Win\\System32\\cmd.exe");
});

test("runCommand on win32 resolves a bare name with where.exe and launches the shim without a shell", () => {
  const calls = [];
  const spawnSyncImpl = (file, args, options) => {
    calls.push({ file, args, options });
    return file.endsWith("\\where.exe")
      ? { status: 0, stdout: "C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n", stderr: "" }
      : { status: 0, stdout: "codex 1.0\n", stderr: "" };
  };
  const result = runCommand("codex", ["--version"], { platform: "win32", env: { PATHEXT: ".EXE;.CMD" }, spawnSyncImpl });
  assert.deepEqual([result.command, result.args, result.stdout], ["codex", ["--version"], "codex 1.0\n"]);
  assert.equal(calls[1].file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[1].args, ["/d", "/s", "/v:off", "/c", '"C:\\npm\\codex.cmd ^^^"--version^^^""']);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.windowsVerbatimArguments, true);

  // A path skips where.exe; a bare name that resolves to nothing is ENOENT without any spawn.
  calls.length = 0;
  runCommand("C:\\Windows\\System32\\taskkill.exe", ["/PID", "1"], { platform: "win32", spawnSyncImpl });
  runCommand("C:\\node\\node.exe", [], { platform: "win32", spawnSyncImpl });
  assert.deepEqual(calls.map((call) => [call.file, call.options.shell, call.options.windowsVerbatimArguments]), [
    ["C:\\Windows\\System32\\taskkill.exe", false, false],
    ["C:\\node\\node.exe", false, false]
  ]);
  calls.length = 0;
  const missing = runCommand("npm", [], { platform: "win32", spawnSyncImpl: (file, args, options) => { calls.push({ file, options }); return file.endsWith("\\where.exe") ? { status: 1, stdout: "" } : { error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) }; } });
  assert.equal(missing.error.code, "ENOENT");
  assert.equal(missing.status, null);
  // Nothing found: ENOENT is reported without a second spawn (libuv would search the cwd).
  assert.deepEqual(calls.map((call) => [call.file, call.options.shell]), [["C:\\Windows\\System32\\where.exe", false]]);
});

// Only CI runs this: a real cmd.exe parses the line, then the shim's %* re-parses it.
test("runCommand round-trips awkward arguments through a .cmd shim in a directory with a space", { skip: !IS_WIN }, () => {
  const dir = path.join(makeTempDir(), "shim dir");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "argv.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(dir, "argv-shim.cmd"), '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n');
  const args = ["plain", "with space", 'q"uote', "", "%PATH%", "a&b", "trail\\", "^caret", "!bang!", "C:\\Program Files (x86)\\x"];
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  const result = runCommand("argv-shim", args, { env });
  assert.equal(result.error, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("workerCommandLine matches the job id literally", () => {
  assert.ok(workerCommandLine("task-a.b").test("node companion.mjs task-worker --job-id task-a.b"));
  assert.equal(workerCommandLine("task-a.b").test("node companion.mjs task-worker --job-id task-aXb"), false);
  assert.equal(workerCommandLine("task-a+").test("node companion.mjs task-worker --job-id task-aaa"), false);
});
