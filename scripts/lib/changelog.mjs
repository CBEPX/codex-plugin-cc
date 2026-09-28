import fs from "node:fs";
import path from "node:path";

const PLUGIN_CHANGELOG = "plugins/codex/CHANGELOG.md";

export function readCurrentVersion(repoRoot = process.cwd()) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (!packageJson?.version || typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version field.");
  }
  return packageJson.version;
}

function readFileOrThrow(repoRoot, relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${relativePath} does not exist.`);
  }
  return fs.readFileSync(filePath);
}

// Headings look like `## 1.3.0 — 2026-09-27`; `## v1.3.0` is accepted too.
export function findVersionSection(version, changelogText) {
  const normalized = String(changelogText ?? "");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = new RegExp(`^##\\s+v?${escaped}(?=\\s|$).*$`, "m").exec(normalized);
  if (!headingMatch) {
    return null;
  }
  const remainder = normalized.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = /^##\s+/m.exec(remainder);
  return {
    heading: headingMatch[0],
    body: nextHeadingMatch ? remainder.slice(0, nextHeadingMatch.index) : remainder,
  };
}

export function assertChangelogIncludesVersion(repoRoot = process.cwd()) {
  const version = readCurrentVersion(repoRoot);
  const changelog = readFileOrThrow(repoRoot, "CHANGELOG.md");
  const section = findVersionSection(version, changelog.toString("utf8"));
  if (!section) {
    throw new Error(
      `CHANGELOG.md is missing a section for ${version}. Add a heading like \`## ${version} — YYYY-MM-DD\` before releasing.`
    );
  }
  const hasBullet = section.body.split("\n").some((line) => /^\s*[-*]\s+\S+/.test(line));
  if (!hasBullet) {
    throw new Error(
      `CHANGELOG.md section for ${version} exists but has no bullet items. Add at least one release note bullet before releasing.`
    );
  }
  const pluginChangelog = readFileOrThrow(repoRoot, PLUGIN_CHANGELOG);
  if (!changelog.equals(pluginChangelog)) {
    throw new Error(
      `${PLUGIN_CHANGELOG} differs from CHANGELOG.md. Run: cp CHANGELOG.md ${PLUGIN_CHANGELOG}`
    );
  }
  return version;
}
