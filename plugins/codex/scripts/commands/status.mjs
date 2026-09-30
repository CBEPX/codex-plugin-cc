import process from "node:process";

import {
  maybePrintCommandHelp,
  outputReadView,
  parseCommandInput,
  parseTimeoutOption,
  resolveCommandCwd
} from "../lib/cli.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot } from "../lib/job-control.mjs";
import { assertOutputPathFree, statusNextStep } from "../lib/read-views.mjs";
import { renderJobStatusReport, renderStatusReport } from "../lib/render.mjs";
import { outputJobResult, waitForSingleJobSnapshot, waitForTerminalJobOrHint } from "./shared.mjs";

export async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "output"],
    booleanOptions: ["json", "all", "wait"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  // Rows 1, 2 and 7: every status read is a bounded summary (no `request`,
  // `result`, `rendered`), or the full payload exported with `--output`.
  const readView = { asJson: options.json, summary: true, outputPath: options.output ?? null, cwd };
  if (readView.outputPath != null) {
    // Fail before a --wait that may last minutes; exportReadPayload's `wx` open stays the guard.
    assertOutputPathFree(readView.outputPath, cwd);
  }
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
      outputReadView(
        snapshot,
        (view) => `${renderJobStatusReport(view.job)}\nTimed out after ${seconds}s while the job was still running.\n`,
        { ...readView, nextStep: statusNextStep(0) }
      );
      process.exitCode = 1;
      return;
    }
    outputReadView(snapshot, (view) => renderJobStatusReport(view.job), { ...readView, nextStep: statusNextStep(0) });
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputReadView(report, renderStatusReport, { ...readView, nextStep: statusNextStep(report.omittedJobs) });
}

export async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "output"],
    booleanOptions: ["json", "wait"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  if (options["timeout-ms"] != null && !options.wait) {
    throw new Error("--timeout-ms requires --wait.");
  }
  if (options.output != null && options.wait) {
    throw new Error("--output cannot be combined with --wait; result --wait already prints the full record.");
  }
  const reference = positionals[0] ?? "";
  if (options.wait) {
    if (!reference) {
      throw new Error("`result --wait` requires a job id.");
    }
    const jobId = await waitForTerminalJobOrHint(cwd, reference, {
      timeoutMs: parseTimeoutOption(options["timeout-ms"], "--timeout-ms"),
      json: options.json
    });
    if (jobId) {
      // Row 5: the full record, exactly as 1.4.3 printed it.
      outputJobResult(cwd, jobId, options.json);
    }
    return;
  }

  // Rows 3, 4 and 7: the only caller that passes a read view.
  outputJobResult(cwd, reference, options.json, { outputPath: options.output ?? null, cwd });
}
