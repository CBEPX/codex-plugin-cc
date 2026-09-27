import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-changelog.mjs");

function makeRoot(changelog, pluginChangelog = changelog) {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2.5.0" }));
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  fs.mkdirSync(path.join(root, "plugins", "codex"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "codex", "CHANGELOG.md"), pluginChangelog);
  return root;
}

function check(root) {
  return run(process.execPath, [SCRIPT], { cwd: root });
}

const GOOD = "# Changelog\n\n## 2.5.0 — 2026-10-01\n\n### Fixed\n- A fix.\n\n## 2.4.0 — 2026-09-01\n- Old.\n";

test("check-changelog fails when the version has no section", () => {
  const result = check(makeRoot("# Changelog\n\n## 2.4.0 — 2026-09-01\n- Old.\n## 2.5.01\n- Not it.\n"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing a section for 2\.5\.0/);
});

test("check-changelog fails when the section has no bullet", () => {
  const result = check(makeRoot("# Changelog\n\n## 2.5.0 — 2026-10-01\n\nProse only.\n\n## 2.4.0\n- Old.\n"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no bullet items/);
});

test("check-changelog fails with a cp hint when the two copies differ", () => {
  const result = check(makeRoot(GOOD, `${GOOD}\n`));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cp CHANGELOG\.md plugins\/codex\/CHANGELOG\.md/);
});

test("check-changelog passes for an em-dash or v-prefixed heading with identical copies", () => {
  for (const changelog of [GOOD, "## v2.5.0\n- A fix.\n"]) {
    const result = check(makeRoot(changelog));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Changelog OK/);
  }
});
