// Temporary Windows diagnostic for the v1.4.1 identity probe (Task 3 CI failure).
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  encodePowerShell, powerShellEnvironment, resetWindowsIdentityCircuit, runPowerShell,
  systemPowerShell, systemRoot, getProcessIdentity, getProcessIdentities
} from "../../../../plugins/codex/scripts/lib/process.mjs";

const probe = (pids) => [
  "$ErrorActionPreference = 'Stop'",
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 244 }",
  `foreach ($p in @(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue)) {`,
  "  try { $null = $p.Handle; Write-Output ('ID {0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }",
  "}"
].join("\n");
const timed = (label, fn) => { const t = Date.now(); const r = fn(); console.log(`== ${label} (${Date.now() - t} ms):`, JSON.stringify(r)); return r; };
const root = systemRoot(process.env);
console.log("systemRoot:", root, "exe:", root && systemPowerShell(root));
console.log("env keys:", Object.keys(powerShellEnvironment(root, process.env)).join(","));
for (const [label, script, ms] of [
  ["trivial 60s", "Write-Output 'OK'", 60000],
  ["probe self 60s", probe([process.pid]), 60000],
  ["probe self 10s", probe([process.pid]), 10000],
  ["probe self 10s again (warm)", probe([process.pid]), 10000],
]) {
  resetWindowsIdentityCircuit();
  timed(label, () => runPowerShell(script, { timeoutMs: ms }));
}
// Raw spawn with stderr, same launch as runPowerShell.
const t = Date.now();
const raw = spawnSync(systemPowerShell(root), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(probe([process.pid]))],
  { cwd: path.win32.join(root, "System32"), env: powerShellEnvironment(root, process.env), encoding: "utf8", windowsHide: true, timeout: 60000, shell: false });
console.log(`== raw spawn (${Date.now() - t} ms): status`, raw.status, "signal", raw.signal, "error", raw.error?.code, "\nstdout:", JSON.stringify(raw.stdout), "\nstderr:", JSON.stringify(raw.stderr));
// Same with the inherited environment, to isolate the clean-env variable.
const t2 = Date.now();
const raw2 = spawnSync(systemPowerShell(root), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(probe([process.pid]))],
  { cwd: path.win32.join(root, "System32"), env: process.env, encoding: "utf8", windowsHide: true, timeout: 60000, shell: false });
console.log(`== raw spawn inherited env (${Date.now() - t2} ms): status`, raw2.status, "\nstdout:", JSON.stringify(raw2.stdout), "\nstderr:", JSON.stringify(raw2.stderr));
resetWindowsIdentityCircuit();
timed("getProcessIdentity(self) default", () => getProcessIdentity(process.pid));
resetWindowsIdentityCircuit();
timed("getProcessIdentities([self]) 60s", () => [...getProcessIdentities([process.pid], { timeoutMs: 60000 })]);
// Hypothesis: without LOCALAPPDATA PowerShell cannot persist its module analysis
// cache, so every launch is a 20-30 s "first use". Clean env + LOCALAPPDATA only.
for (const extra of [{ LOCALAPPDATA: process.env.LOCALAPPDATA }, { LOCALAPPDATA: process.env.LOCALAPPDATA }, { PSModuleAnalysisCachePath: path.win32.join(process.env.TEMP, "codex-psmac.cache") }, { PSModuleAnalysisCachePath: path.win32.join(process.env.TEMP, "codex-psmac.cache") }]) {
  const t3 = Date.now();
  const r = spawnSync(systemPowerShell(root), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(probe([process.pid]))],
    { cwd: path.win32.join(root, "System32"), env: { ...powerShellEnvironment(root, process.env), ...extra }, encoding: "utf8", windowsHide: true, timeout: 60000, shell: false });
  console.log(`== clean env + ${Object.keys(extra)[0]} (${Date.now() - t3} ms): status`, r.status, "stdout:", JSON.stringify(r.stdout), "stderr-len:", r.stderr.length);
}
