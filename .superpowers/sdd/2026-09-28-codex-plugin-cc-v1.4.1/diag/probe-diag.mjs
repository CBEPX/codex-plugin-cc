// Temporary Windows diagnostic (v1.4.1 Task 3): minimise the inherited
// environment to the variables that keep powershell.exe starting in <2 s.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { encodePowerShell, powerShellEnvironment, systemPowerShell, systemRoot } from "../../../../plugins/codex/scripts/lib/process.mjs";

const root = systemRoot(process.env);
const clean = powerShellEnvironment(root, process.env);
const launchMs = (env) => {
  const t = Date.now();
  const r = spawnSync(systemPowerShell(root), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell("Write-Output 'OK'")],
    { cwd: path.win32.join(root, "System32"), env, encoding: "utf8", windowsHide: true, timeout: 60000, shell: false });
  return r.status === 0 ? Date.now() - t : 99999;
};
const fast = (keys) => launchMs({ ...clean, ...Object.fromEntries(keys.map((k) => [k, process.env[k]])) }) < 3000;
let keep = Object.keys(process.env).filter((k) => !(k in clean) && !/^(PATH|Path)$/.test(k));
console.log("candidates:", keep.length, "clean+all fast:", fast(keep));
let chunk = Math.ceil(keep.length / 2);
while (chunk >= 1) {
  let i = 0;
  while (i < keep.length) {
    const without = keep.filter((_, j) => j < i || j >= i + chunk);
    if (fast(without)) { keep = without; } else { i += chunk; }
  }
  chunk = Math.floor(chunk / 2);
}
console.log("MINIMAL FAST SET:", JSON.stringify(Object.fromEntries(keep.map((k) => [k, process.env[k]]))));
for (const k of keep) console.log(`== clean + ${k} alone: ${launchMs({ ...clean, [k]: process.env[k] })} ms`);
