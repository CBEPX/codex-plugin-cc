import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function slug(heading) {
  return heading.trim().toLowerCase().replace(/[`*]/g, "").replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

function headingSlugs(text) {
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
}

const DOCS = ["AGENTS.md", "README.md", ...fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`), ...fs.readdirSync(path.join(ROOT, "docs", "agent")).map((f) => `docs/agent/${f}`)];

test("every plugin command has a README section", () => {
  const readme = read("README.md");
  for (const file of fs.readdirSync(path.join(ROOT, "plugins", "codex", "commands"))) {
    const name = file.replace(/\.md$/, "");
    assert.match(readme, new RegExp(`^### \`/codex:${name}\``, "m"), `README lacks a section for /codex:${name}`);
  }
});

test("AGENTS.md stays short and CLAUDE.md imports it", () => {
  assert.ok(read("AGENTS.md").split("\n").length <= 50, "AGENTS.md must stay under 50 lines");
  assert.equal(read("CLAUDE.md").trim(), "@AGENTS.md");
});

test("relative links and anchors in the docs resolve", () => {
  for (const doc of DOCS) {
    const text = read(doc);
    const own = headingSlugs(text);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [file, anchor] = target.split("#");
      const resolved = file ? path.resolve(ROOT, path.dirname(doc), file) : null;
      if (file) assert.ok(fs.existsSync(resolved), `${doc}: missing link target ${target}`);
      if (anchor !== undefined) {
        const slugs = file ? headingSlugs(fs.readFileSync(resolved, "utf8").replace(/\r\n/g, "\n")) : own;
        assert.ok(slugs.has(anchor), `${doc}: missing anchor #${anchor} in ${file || doc}`);
      }
    }
  }
});

test("README describes behaviour by observable outputs, not code paths", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /scripts\/lib\//, "README must not name scripts/lib paths");
  // Code spans are stripped first: a pinned command line may legitimately contain `word()`.
  assert.doesNotMatch(readme.replace(/`[^`\n]*`/g, ""), /\b[a-z][A-Za-z]+\(\)/, "README must not name functions");
});
