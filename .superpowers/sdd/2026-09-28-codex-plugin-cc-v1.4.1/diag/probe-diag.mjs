// Temporary Windows diagnostic (v1.4.1 Task 3): which inherited variable makes
// PowerShell start in 0.4 s instead of 22 s under the clean environment.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { encodePowerShell, powerShellEnvironment, systemPowerShell, systemRoot } from "../../../../plugins/codex/scripts/lib/process.mjs";

const root = systemRoot(process.env);
const clean = powerShellEnvironment(root, process.env);
console.log("clean env:", JSON.stringify(clean));
console.log("inherited PSModulePath:", JSON.stringify(process.env.PSModulePath));
const script = "Write-Output 'OK'";
const launch = (env) => {
  const t = Date.now();
  const r = spawnSync(systemPowerShell(root), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    { cwd: path.win32.join(root, "System32"), env, encoding: "utf8", windowsHide: true, timeout: 60000, shell: false });
  return `${Date.now() - t} ms status ${r.status} stdout ${JSON.stringify(r.stdout)} stderr-len ${r.stderr.length}`;
};
const pick = (...names) => Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
const groups = {
  baseline_clean: {},
  inherited_full: null,
  USERPROFILE: pick("USERPROFILE"),
  APPDATA_LOCALAPPDATA: pick("APPDATA", "LOCALAPPDATA"),
  HOME: pick("HOMEDRIVE", "HOMEPATH"),
  SystemDrive: pick("SystemDrive"),
  ProgramFiles: pick("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"),
  ProgramData: pick("ProgramData", "ALLUSERSPROFILE", "PUBLIC"),
  ComSpec: pick("ComSpec"),
  USER: pick("USERNAME", "USERDOMAIN", "COMPUTERNAME", "LOGONSERVER"),
  PROCESSOR: pick("PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS", "OS"),
  inherited_PSModulePath: pick("PSModulePath"),
  inherited_PATH: pick("PATH", "Path"),
};
for (const [name, extra] of Object.entries(groups)) {
  const env = extra === null ? process.env : { ...clean, ...extra };
  console.log(`== ${name}: ${launch(env)}`);
}
// Complement: inherited env minus one group each (which removal makes it slow?)
for (const name of ["USERPROFILE", "APPDATA_LOCALAPPDATA", "HOME", "SystemDrive", "ProgramFiles", "ProgramData", "ComSpec", "USER", "PROCESSOR"]) {
  const env = { ...process.env };
  for (const k of Object.keys(groups[name])) delete env[k];
  console.log(`== inherited minus ${name}: ${launch(env)}`);
}
