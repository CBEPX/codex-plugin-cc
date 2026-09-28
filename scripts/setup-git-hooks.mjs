#!/usr/bin/env node
// Points git at the tracked .githooks directory (pre-commit: lint + typecheck).
import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
