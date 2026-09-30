#!/usr/bin/env node

import process from "node:process";

import { applyArgsStdin, printUsage } from "./lib/cli.mjs";
import { handleCancel } from "./commands/cancel.mjs";
import { handleReview, handleReviewCommand } from "./commands/review.mjs";
import { handleSetup } from "./commands/setup.mjs";
import { handleTaskWorker } from "./commands/shared.mjs";
import { handleResult, handleStatus } from "./commands/status.mjs";
import { executeTaskRun, handleTask, handleTaskResumeCandidate } from "./commands/task.mjs";
import { handleTransfer } from "./commands/transfer.mjs";

async function main() {
  const [subcommand, ...rawArgv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  const argv = applyArgsStdin(rawArgv);

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review",
        acceptsFocusText: true
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv, { task: executeTaskRun });
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
