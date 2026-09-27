import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  getProcessIdentity,
  processCommandLine,
  runCommand,
  terminateProcessTree,
  terminateRecordedProcess
} from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
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

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
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
