#!/usr/bin/env node

import { assertChangelogIncludesVersion } from "./lib/changelog.mjs";

try {
  const version = assertChangelogIncludesVersion();
  process.stdout.write(
    `Changelog OK: CHANGELOG.md has a non-empty section for ${version} and matches plugins/codex/CHANGELOG.md.\n`
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
