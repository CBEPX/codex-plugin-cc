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
