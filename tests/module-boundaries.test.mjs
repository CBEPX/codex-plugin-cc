import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_ROOT } from "./helpers.mjs";

const SCRIPTS = path.join(PLUGIN_ROOT, "scripts");
const LIB = path.join(SCRIPTS, "lib");
// Leaves may import nothing from lib except the zero-import job-status.mjs (render needs it).
const LEAVES = ["args", "broker-endpoint", "fs", "hook-input", "job-status", "process", "prompts", "render"];
const ENTRY_ALLOW = {
  "app-server-broker.mjs": ["args", "app-server", "broker-endpoint", "broker-lifecycle"],
  "session-lifecycle-hook.mjs": ["process", "app-server", "broker-lifecycle", "state", "job-control", "tracked-jobs", "claude-session-transfer", "workspace", "hook-input", "job-status"],
  "stop-review-gate-hook.mjs": ["codex", "hook-input", "prompts", "state", "job-control", "tracked-jobs", "workspace", "job-status"]
};

// Static import statements only; JSDoc `import("./x")` types do not count.
function imports(file) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/^import\b(?:[^;]*? from)?\s*"(\.[^"]+)";/gm)].map((m) => m[1]);
}
const libName = (spec) => path.basename(spec).replace(/\.mjs$/, "");

test("lib modules import only siblings, never ../", () => {
  assert.ok(imports(path.join(LIB, "job-control.mjs")).length >= 8, "import parser found nothing");
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith(".mjs"))) {
    for (const spec of imports(path.join(LIB, f))) assert.ok(spec.startsWith("./"), `${f} imports ${spec}`);
  }
});

test("leaf modules import nothing from lib (render: job-status only)", () => {
  for (const name of LEAVES) {
    const libImports = imports(path.join(LIB, `${name}.mjs`)).map(libName);
    assert.deepEqual(libImports, name === "render" ? ["job-status"] : [], `${name}.mjs`);
  }
});

test("hooks and the broker stay within their import allow-list", () => {
  for (const [file, allowed] of Object.entries(ENTRY_ALLOW)) {
    const actual = imports(path.join(SCRIPTS, file)).map(libName);
    assert.deepEqual(actual.filter((n) => !allowed.includes(n)), [], `${file} imports outside its allow-list`);
  }
});

test("job-control reaches codex.mjs for getSessionRuntimeStatus only", () => {
  const src = fs.readFileSync(path.join(LIB, "job-control.mjs"), "utf8");
  assert.equal((src.match(/^import \{ getSessionRuntimeStatus \} from "\.\/codex\.mjs";$/m) ?? []).length, 1);
  assert.equal((src.match(/from "\.\/codex\.mjs"/g) ?? []).length, 1);
});

const COMMANDS = path.join(SCRIPTS, "commands");

test("commands/shared.mjs imports only ../lib/**", () => {
  const specs = imports(path.join(COMMANDS, "shared.mjs"));
  assert.ok(specs.length >= 5, "import parser found nothing");
  for (const spec of specs) assert.ok(spec.startsWith("../lib/"), `shared.mjs imports ${spec}`);
});

const COMMAND_MODULES = ["cancel", "review", "setup", "status", "task", "transfer"];

test("command modules import only ../lib/** and ./shared.mjs", () => {
  const present = fs.readdirSync(COMMANDS).filter((n) => n.endsWith(".mjs")).sort();
  assert.deepEqual(present, [...COMMAND_MODULES, "shared"].map((n) => `${n}.mjs`).sort());
  for (const name of COMMAND_MODULES) {
    const specs = imports(path.join(COMMANDS, `${name}.mjs`));
    assert.ok(specs.length >= 2, `${name}.mjs: import parser found nothing`);
    for (const spec of specs) assert.ok(spec.startsWith("../lib/") || spec === "./shared.mjs", `${name}.mjs imports ${spec}`);
  }
});

test("the companion entry imports only lib/cli.mjs and commands/*", () => {
  const allowed = ["./lib/cli.mjs", ...[...COMMAND_MODULES, "shared"].map((n) => `./commands/${n}.mjs`)];
  const specs = imports(path.join(SCRIPTS, "codex-companion.mjs"));
  assert.ok(specs.includes("./lib/cli.mjs"), "import parser found nothing");
  assert.deepEqual(specs.filter((s) => !allowed.includes(s)), [], "codex-companion.mjs imports outside its allow-list");
});
