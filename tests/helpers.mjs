import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { parseProtocolLines, resetWindowsIdentityCircuit, runPowerShell } from "../plugins/codex/scripts/lib/process.mjs";

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
