import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isPidAlive, parseProtocolLines, resetWindowsIdentityCircuit, runPowerShell } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

export const IS_WIN = process.platform === "win32";

// Fake a home directory for both POSIX (HOME) and Windows (USERPROFILE) lookups.
export function homeEnv(home) {
  return { HOME: home, USERPROFILE: home };
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout,
    // Tests spawn process.execPath / git directly, never through a shell.
    shell: options.shell ?? false,
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// Every pid under `rootPid` by ParentProcessId (BFS), with a coarse executable
// class — for Windows-only tests that assert a whole tree died or survived.
// Runs through the plugin's own launcher (validated root, clean env, System32
// cwd, -EncodedCommand) and speaks its protocol: `NODE <pid>`, `CMD <pid>` or
// `OTHER <pid>` per node, nothing else. Throws when the enumeration fails or the
// output is not clean: a silent [] would make "everything is gone" vacuously true.
export function cimTree(rootPid, env = process.env) {
  const script = `$ErrorActionPreference = 'Stop'; $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name | Select-Object ProcessId,ParentProcessId,Name); $q = @(${rootPid}); $seen = @{}; while ($q.Count -gt 0) { $p = $q[0]; $q = @($q | Select-Object -Skip 1); if ($seen.ContainsKey($p)) { continue }; $seen[$p] = $true; $row = $all | Where-Object { $_.ProcessId -eq $p } | Select-Object -First 1; if ($row) { $w = if ($row.Name -match '^(?i)node\\.exe$') { 'NODE' } elseif ($row.Name -match '^(?i)cmd\\.exe$') { 'CMD' } else { 'OTHER' }; [Console]::Out.WriteLine($w + ' ' + [int]$row.ProcessId) }; foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) { $q += [int]$c.ProcessId } }`;
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

// 30 s: hosted Windows VMs have been seen 2-3x slower for hours; a detached
// worker can take >10 s just to reach `running` there.
export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
export const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
export const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
export const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
export const FAKE_RESOLVED_SETTINGS = {
  model: "gpt-5.4",
  modelProvider: "openai",
  reasoningEffort: null,
  sandbox: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false
  }
};

export const isAlive = (pid) => isPidAlive(pid) === true;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A pid that has certainly exited (a finished child), for stale-record fixtures.
export function deadPid() {
  const finished = run(process.execPath, ["-e", ""]);
  if (finished.status !== 0) throw new Error(`deadPid: helper child exited ${finished.status}`);
  return finished.pid;
}

export function waitForExit(child, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Timed out waiting for broker process to exit."));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

// Like waitFor but resolves null on timeout, so the caller's own assertion (and its
// on-failure diagnostic, e.g. the broker-log tail) still runs.
export async function waitUntil(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export function readStateIndex(workspaceRoot) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspaceRoot), "state.json"), "utf8"));
}

export function readJobRecord(workspaceRoot, jobId = null) {
  const resolvedJobId = jobId ?? readStateIndex(workspaceRoot).jobs[0].id;
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspaceRoot), "jobs", `${resolvedJobId}.json`), "utf8"));
}

// Read only on failure: which record a cancel found, who wrote it, and the job-log tail.
export function jobDiagnostics(repo, jobId) {
  try {
    const record = readJobRecord(repo, jobId);
    const log = fs.readFileSync(record.logFile, "utf8").split("\n").slice(-20).join("\n");
    return `record: ${JSON.stringify({ status: record.status, phase: record.phase, transport: record.transport, workerClosed: record.workerClosed, appServerExited: record.appServerExited, errorMessage: record.errorMessage })}\njob log tail:\n${log}`;
  } catch (error) {
    return `(job record unreadable: ${error.message})`;
  }
}

export function seededRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}
