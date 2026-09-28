// Critical mutation shard only (Node 24 tooling; runtime stays Node >=18).
export default {
  testRunner: "command",
  commandRunner: {
    command: "npm run test:mutation:critical:unit",
  },
  coverageAnalysis: "off",
  mutate: [
    "plugins/codex/scripts/lib/args.mjs",
    "plugins/codex/scripts/lib/model-catalog.mjs",
  ],
  reporters: ["progress", "clear-text", "html", "json"],
  clearTextReporter: {
    reportMutants: false,
    reportTests: false,
    reportScoreTable: true,
    allowEmojis: false,
  },
  thresholds: {
    high: 80,
    low: 55,
    break: 55,
  },
  concurrency: 4,
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  // Stryker does not read .gitignore; keep worktrees and docs out of the sandbox copy.
  ignorePatterns: ["/.worktrees", "/docs", "/.superpowers", "/reports"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
