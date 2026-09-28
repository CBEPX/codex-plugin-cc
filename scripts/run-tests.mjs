// Cross-platform test runner: `node --test tests/` fails on Node 22+ (directory
// import) and would pick up tests/test-env.mjs on Node 18; cmd.exe does not
// expand globs. List the files explicitly and forward extra CLI args.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const files = fs
  .readdirSync("tests")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `tests/${name}`);
const result = spawnSync(
  process.execPath,
  ["--import", "./tests/test-env.mjs", "--test", ...process.argv.slice(2), ...files],
  { stdio: "inherit" }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
