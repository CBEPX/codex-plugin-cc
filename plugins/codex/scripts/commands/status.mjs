import process from "node:process";

import {
  maybePrintCommandHelp,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  parseTimeoutOption,
  resolveCommandCwd
} from "../lib/cli.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot } from "../lib/job-control.mjs";
import { renderJobStatusReport, renderStatusReport } from "../lib/render.mjs";
import { outputJobResult, waitForSingleJobSnapshot, waitForTerminalJobOrHint } from "./shared.mjs";

export async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    if (snapshot.waitTimedOut) {
      const seconds = Math.max(1, Math.round(snapshot.timeoutMs / 1000));
      outputCommandResult(
        snapshot,
        `${renderJobStatusReport(snapshot.job)}\nTimed out after ${seconds}s while the job was still running.\n`,
        options.json
      );
      process.exitCode = 1;
      return;
    }
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

export async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "wait"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  if (options["timeout-ms"] != null && !options.wait) {
    throw new Error("--timeout-ms requires --wait.");
  }
  let reference = positionals[0] ?? "";
  if (options.wait) {
    if (!reference) {
      throw new Error("`result --wait` requires a job id.");
    }
    const jobId = await waitForTerminalJobOrHint(cwd, reference, {
      timeoutMs: parseTimeoutOption(options["timeout-ms"], "--timeout-ms"),
      json: options.json
    });
    if (!jobId) {
      return;
    }
    reference = jobId;
  }

  outputJobResult(cwd, reference, options.json);
}
