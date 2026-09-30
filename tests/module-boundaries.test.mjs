import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_ROOT, makeTempDir } from "./helpers.mjs";

const SCRIPTS = path.join(PLUGIN_ROOT, "scripts");
const LIB = path.join(SCRIPTS, "lib");
// Leaves may import nothing from lib except the zero-import job-status.mjs (render needs it).
const LEAVES = ["args", "broker-endpoint", "fs", "hook-input", "job-status", "process", "prompts", "read-views", "render"];
const ENTRY_ALLOW = {
  "app-server-broker.mjs": ["args", "app-server", "broker-endpoint", "broker-lifecycle"],
  "session-lifecycle-hook.mjs": ["process", "app-server", "broker-lifecycle", "state", "job-control", "tracked-jobs", "claude-session-transfer", "workspace", "hook-input", "job-status"],
  "stop-review-gate-hook.mjs": ["codex", "hook-input", "prompts", "state", "job-control", "tracked-jobs", "workspace", "job-status"]
};

// Relative specifiers of every static `import … from`, side-effect `import "…"` and
// `export … from` statement, in either quote style; JSDoc `import("./x")` types and
// non-relative specifiers do not count.
function imports(file) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/^[ \t]*(?:import|export)\b(?:[^;'"(]*?\bfrom)?\s*(["'])(\.[^"']*)\1/gm)].map((m) => m[2]);
}
// Resolve against the importing file, so `../lib/../commands/x.mjs` is judged by where it lands.
const target = (file, spec) => path.resolve(path.dirname(file), spec);
const inDir = (dir, file, spec) => path.dirname(target(file, spec)) === dir;
const libName = (file, spec) => path.basename(target(file, spec)).replace(/\.mjs$/, "");

test("lib modules import only siblings, never ../", () => {
  assert.ok(imports(path.join(LIB, "job-control.mjs")).length >= 8, "import parser found nothing");
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith(".mjs"))) {
    const file = path.join(LIB, f);
    for (const spec of imports(file)) assert.ok(inDir(LIB, file, spec), `${f} imports ${spec}`);
  }
});

test("leaf modules import nothing from lib (render: job-status only)", () => {
  for (const name of LEAVES) {
    const file = path.join(LIB, `${name}.mjs`);
    const libImports = imports(file).map((spec) => (inDir(LIB, file, spec) ? libName(file, spec) : spec));
    assert.deepEqual(libImports, name === "render" ? ["job-status"] : [], `${name}.mjs`);
  }
});

test("hooks and the broker stay within their import allow-list", () => {
  for (const [file, allowed] of Object.entries(ENTRY_ALLOW)) {
    const entry = path.join(SCRIPTS, file);
    const allowedFiles = allowed.map((n) => path.join(LIB, `${n}.mjs`));
    const outside = imports(entry).filter((spec) => !allowedFiles.includes(target(entry, spec)));
    assert.deepEqual(outside, [], `${file} imports outside its allow-list`);
  }
});

test("job-control reaches codex.mjs for getSessionRuntimeStatus only", () => {
  const src = fs.readFileSync(path.join(LIB, "job-control.mjs"), "utf8");
  assert.equal((src.match(/^import \{ getSessionRuntimeStatus \} from "\.\/codex\.mjs";$/m) ?? []).length, 1);
  assert.equal((src.match(/from "\.\/codex\.mjs"/g) ?? []).length, 1);
});

const COMMANDS = path.join(SCRIPTS, "commands");

test("commands/shared.mjs imports only ../lib/**", () => {
  const file = path.join(COMMANDS, "shared.mjs");
  const specs = imports(file);
  assert.ok(specs.length >= 5, "import parser found nothing");
  for (const spec of specs) assert.ok(inDir(LIB, file, spec), `shared.mjs imports ${spec}`);
});

const COMMAND_MODULES = ["cancel", "review", "setup", "status", "task", "transfer"];

test("command modules import only ../lib/** and ./shared.mjs", () => {
  const present = fs.readdirSync(COMMANDS).filter((n) => n.endsWith(".mjs")).sort();
  assert.deepEqual(present, [...COMMAND_MODULES, "shared"].map((n) => `${n}.mjs`).sort());
  for (const name of COMMAND_MODULES) {
    const file = path.join(COMMANDS, `${name}.mjs`);
    const specs = imports(file);
    assert.ok(specs.length >= 2, `${name}.mjs: import parser found nothing`);
    for (const spec of specs) {
      assert.ok(inDir(LIB, file, spec) || target(file, spec) === path.join(COMMANDS, "shared.mjs"), `${name}.mjs imports ${spec}`);
    }
  }
});

test("the companion entry imports only lib/cli.mjs and commands/*", () => {
  const entry = path.join(SCRIPTS, "codex-companion.mjs");
  const allowed = [path.join(LIB, "cli.mjs"), ...[...COMMAND_MODULES, "shared"].map((n) => path.join(COMMANDS, `${n}.mjs`))];
  const specs = imports(entry);
  assert.ok(specs.includes("./lib/cli.mjs"), "import parser found nothing");
  assert.deepEqual(specs.filter((s) => !allowed.includes(target(entry, s))), [], "codex-companion.mjs imports outside its allow-list");
});

test("the import parser sees every static form", () => {
  const file = path.join(makeTempDir(), "sample.mjs");
  fs.writeFileSync(file, [
    'import a from "./double.mjs";',
    "import b from './single.mjs';",
    'import "./side-effect.mjs";',
    'export { c } from "../lib/reexport.mjs";',
    "import {",
    "  d,",
    "  e",
    "} from './multi-line.mjs';",
    '/** @type {import("./jsdoc-type.mjs")} */',
    'import fsx from "node:fs";',
    'export const notAnImport = "./string.mjs";',
    ""
  ].join("\n"));
  assert.deepEqual(imports(file), ["./double.mjs", "./single.mjs", "./side-effect.mjs", "../lib/reexport.mjs", "./multi-line.mjs"]);
  assert.equal(inDir("/x/lib", "/x/commands/a.mjs", "../lib/../commands/b.mjs"), false);
  assert.equal(inDir("/x/lib", "/x/lib/a.mjs", "./../commands/b.mjs"), false);
  assert.equal(inDir("/x/lib", "/x/lib/a.mjs", "./b.mjs"), true);
});
