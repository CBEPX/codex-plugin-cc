import { spawn } from "node:child_process";
import process from "node:process";

import {
  COMPANION_SCRIPT,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  resolveCommandWorkspace
} from "../lib/cli.mjs";
import { getCodexAvailability } from "../lib/codex.mjs";
import { isActiveJobStatus } from "../lib/job-status.mjs";
import {
  consumeJobRequestFile,
  generateJobId,
  readStoredJob,
  recordWorkerPid,
  redactConfigValues,
  removeJobRequestFile,
  upsertJob,
  writeJobFile,
  writeJobRequestFile
} from "../lib/state.mjs";
import { buildSingleJobSnapshot, resolveResultJob } from "../lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  registerWorkerCrashGuard,
  runTrackedJob
} from "../lib/tracked-jobs.mjs";
import { renderStoredJobResult } from "../lib/render.mjs";

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
// Claude Code kills a Bash tool call at 600000ms, so an awaited task has to
// hand control back before that with a resumable hint.
const DEFAULT_AWAIT_TIMEOUT_MS = 540000;
const DEFAULT_AWAIT_POLL_INTERVAL_MS = 1000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

export function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

export async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

function buildResumeWaitCommand(jobId) {
  return `node "${COMPANION_SCRIPT}" result ${jobId} --wait --timeout-ms ${DEFAULT_AWAIT_TIMEOUT_MS}`;
}

// Every "the job outlived this command" exit looks the same: the lead-in, the
// exact command that resumes the wait, and exit code 3.
function outputActiveJobHint(snapshot, leadIn, asJson) {
  const resumeCommand = buildResumeWaitCommand(snapshot.job.id);
  outputCommandResult({ ...snapshot, resumeCommand }, `${leadIn} Re-run: ${resumeCommand}\n`, asJson);
  process.exitCode = 3;
}

// Waits for a job to reach a terminal status and returns its id. On timeout it
// prints the re-run hint, sets exit code 3 and returns null, so the caller
// (`task --await`, `result --wait`) hands control back before Claude Code's
// Bash timeout kills it mid-run.
export async function waitForTerminalJobOrHint(cwd, reference, options = {}) {
  const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
    timeoutMs: Number(options.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS),
    pollIntervalMs: DEFAULT_AWAIT_POLL_INTERVAL_MS
  });
  if (!snapshot.waitTimedOut) {
    return snapshot.job.id;
  }

  outputActiveJobHint(snapshot, `Still running: job ${snapshot.job.id}.`, options.json);
  return null;
}

// Prints exactly what `result <reference>` prints — the awaited task path reuses
// it so both commands stay on one rendering — and returns the resolved job.
export function outputJobResult(cwd, reference, asJson) {
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  if (isActiveJobStatus(job.status)) {
    outputActiveJobHint(buildSingleJobSnapshot(cwd, job.id), `Job ${job.id} is still ${job.status}.`, asJson);
    return job;
  }

  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), asJson);
  return job;
}

export function renderQueuedLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

export function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, background = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    // Marks a job SessionEnd must leave alone — and whose record it must keep,
    // so `result` still works after the dispatching session is gone.
    ...(background ? { background: true } : {})
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

export async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const child = spawn(process.execPath, [COMPANION_SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

export function enqueueBackgroundJob(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // Persist before spawning: a worker that starts instantly must find its
  // record, otherwise it exits while the parent reports `queued`.
  const requestFile = writeJobRequestFile(job.workspaceRoot, job.id, request);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    // Marks the job as one SessionEnd must leave running (#355). The pid is null
    // here because this record is written BEFORE the spawn; `updateJobPid`
    // patches the real one in as soon as the worker exists.
    background: true,
    pid: null,
    pidIdentity: null,
    logFile,
    requestFile,
    request: { ...request, config: redactConfigValues(request.config) }
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  let child;
  try {
    child = spawnDetachedTaskWorker(cwd, job.id);
    if (child.pid === undefined) {
      throw new Error("Could not spawn the background Codex worker.");
    }
  } catch (error) {
    // No worker will ever read the payload, so do not leave it (0600, possibly
    // holding `--config` secrets) on disk until the job is pruned.
    removeJobRequestFile(job.workspaceRoot, job.id);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedRecord = { ...queuedRecord, status: "failed", phase: "failed", errorMessage, requestFile: null };
    writeJobFile(job.workspaceRoot, job.id, failedRecord);
    upsertJob(job.workspaceRoot, failedRecord);
    throw error;
  }

  // The record was written before the spawn, so this is the first moment the
  // worker's pid exists. `recordWorkerPid` never touches the job file — the
  // worker owns it — it writes an atomic `jobs/<id>.pid` sidecar plus a pid-only
  // index patch, the pid first and the identity once probed. Without it a
  // `cancel` inside the queued window signals nothing and the reaper cannot tell
  // a dead queued worker from a live one.
  recordWorkerPid(job.workspaceRoot, job.id, child.pid);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

export async function handleTaskWorker(argv, runners) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  // The private payload carries the unredacted request; fall back to the record
  // for jobs queued before that file existed.
  const request = consumeJobRequestFile(workspaceRoot, options["job-id"]) ?? storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  registerWorkerCrashGuard(workspaceRoot, options["job-id"], logFile);
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      runners.task({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}
