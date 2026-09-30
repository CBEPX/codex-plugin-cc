#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  applyArgsStdin,
  COMPANION_SCRIPT,
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputCommandResult,
  outputResult,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  printUsage,
  PROMPT_STDIN_FLAG,
  resolveCommandCwd,
  resolveCommandWorkspace,
  REVIEW_SCHEMA,
  ROOT_DIR
} from "./lib/cli.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    TURN_INTERRUPT_ACK_MS
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { isActiveJobStatus, isTerminalRecord } from "./lib/job-status.mjs";
import { binaryAvailable, isPidAlive, terminateRecordedProcess, workerCommandLine } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  consumeJobRequestFile,
  generateJobId,
  getConfig,
  listJobs,
  nowIso,
  readStoredJob,
  recordWorkerPid,
  redactConfigValues,
  removeJobRequestFile,
  resolveJobPid,
  setConfig,
  upsertJob,
  withStateLock,
  writeJobFile,
  writeJobRequestFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  brokerExclusion,
  brokerPresence,
  buildStatusSnapshot,
  cancelDecision,
  commitCancel,
  isWorkerProvedRecord,
  isWorkerTerminalRecord,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  filterJobsForSession,
  getCurrentSessionId,
  reapDeadJobs,
  registerWorkerCrashGuard,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  emitCancelPending,
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  shorten
} from "./lib/render.mjs";

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
// Claude Code kills a Bash tool call at 600000ms, so an awaited task has to
// hand control back before that with a resumable hint.
const DEFAULT_AWAIT_TIMEOUT_MS = 540000;
const DEFAULT_AWAIT_POLL_INTERVAL_MS = 1000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    reviewGateModel: config.stopReviewGateModel ?? null,
    reviewGateEffort: config.stopReviewGateEffort ?? null,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "review-gate-model", "review-gate-effort"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  // Validate everything before writing anything: a rejected effort must not
  // leave a half-applied gate configuration behind.
  const isInherit = (value) => String(value).trim().toLowerCase() === "inherit";
  const modelGiven = options["review-gate-model"] != null;
  const effortGiven = options["review-gate-effort"] != null;
  for (const flag of ["review-gate-model", "review-gate-effort"]) {
    if (options[flag] != null && String(options[flag]).trim() === "") {
      throw new Error(`--${flag} needs a value; use inherit to clear it.`);
    }
  }
  const config = getConfig(workspaceRoot);
  const newModel = modelGiven && !isInherit(options["review-gate-model"]) ? normalizeRequestedModel(options["review-gate-model"]) : null;
  const effectiveModel = modelGiven ? newModel : (config.stopReviewGateModel ?? null);
  const newEffort =
    effortGiven && !isInherit(options["review-gate-effort"]) ? normalizeReasoningEffort(options["review-gate-effort"], effectiveModel) : null;
  // A model-only change must still fit the effort already stored with it.
  if (modelGiven && !effortGiven) {
    normalizeReasoningEffort(config.stopReviewGateEffort ?? null, effectiveModel);
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }
  if (modelGiven) {
    setConfig(workspaceRoot, "stopReviewGateModel", newModel);
    actionsTaken.push(newModel ? `Stop-time review gate model set to ${newModel}.` : "Stop-time review gate model now inherits Codex config.");
  }
  if (effortGiven) {
    setConfig(workspaceRoot, "stopReviewGateEffort", newEffort);
    actionsTaken.push(newEffort ? `Stop-time review gate effort set to ${newEffort}.` : "Stop-time review gate effort now inherits Codex config.");
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        !isActiveJobStatus(job.status)
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
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
async function waitForTerminalJobOrHint(cwd, reference, options = {}) {
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
function outputJobResult(cwd, reference, asJson) {
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  if (isActiveJobStatus(job.status)) {
    outputActiveJobHint(buildSingleJobSnapshot(cwd, job.id), `Job ${job.id} is still ${job.status}.`, asJson);
    return job;
  }

  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), asJson);
  return job;
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentSessionId();
  const jobs = sortJobsNewestFirst(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot))).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      effort: request.effort,
      config: request.config,
      turnTimeoutMs: request.turnTimeoutMs,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      resolved: result.resolved,
      appServerExited: result.appServerExited,
      payload,
      rendered,
      errorMessage: result.error?.message ?? null,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    config: request.config,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    turnTimeoutMs: request.turnTimeoutMs,
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    resolved: result.resolved,
    appServerExited: result.appServerExited,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    errorMessage: result.error?.message ?? null,
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    excludeJobId: request.jobId,
    prompt: request.prompt,
    promptRaw: request.promptRaw,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    config: request.config,
    approvalPolicy: request.write ? "on-request" : "never",
    sandbox: request.write ? "workspace-write" : "read-only",
    turnTimeoutMs: request.turnTimeoutMs,
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const turnStatus = result.turnStatus ?? null;
  const failureMessage =
    result.error?.message ??
    (result.status !== 0 ? (result.stderr || `Codex turn ended with status "${turnStatus ?? "failed"}"`) : "");
  const rendered = renderTaskResult({
    rawOutput,
    failureMessage,
    reasoningSummary: result.reasoningSummary
  });
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    resolved: result.resolved,
    appServerExited: result.appServerExited,
    payload,
    rendered,
    errorMessage: failureMessage || null,
    summary:
      result.status === 0
        ? firstMeaningfulLine(rawOutput, `${taskMetadata.title} finished.`)
        : firstMeaningfulLine(failureMessage, firstMeaningfulLine(rawOutput, `${taskMetadata.title} failed.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary, 96)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, background = false }) {
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

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, config, prompt, promptRaw, write, resumeLast, turnTimeoutMs, jobId }) {
  return {
    cwd,
    model,
    effort,
    config,
    prompt,
    promptRaw,
    write,
    resumeLast,
    // Persisted so the detached worker runs under the same budget: it is a
    // separate process and never sees this command's flags.
    turnTimeoutMs,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-stdin"]) {
    if (options["prompt-file"] || positionals.length > 0) {
      throw new Error(`${PROMPT_STDIN_FLAG} cannot be combined with --prompt-file or prompt text.`);
    }
    // Raw bytes, no tokenization: only the one trailing newline the caller's
    // heredoc adds is removed, so indentation and blank lines survive.
    const prompt = readStdinIfPiped().replace(/\r?\n$/, "");
    if (!prompt.trim()) {
      throw new Error(`${PROMPT_STDIN_FLAG} was set but stdin was empty.`);
    }
    return prompt;
  }

  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
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

function enqueueBackgroundTask(cwd, job, request) {
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

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"],
    booleanOptions: ["json", "background", "wait"],
    repeatableOptions: ["config"],
    // Only the adversarial variant takes free-form focus text; stop option
    // parsing there so option-looking prompt words survive (#547).
    stopAtFirstPositional: Boolean(config.acceptsFocusText),
    aliasMap: {
      m: "model"
    }
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort, model);
  const configOverrides = parseConfigOverrides(options.config);
  const turnTimeoutMs = parseTimeoutOption(options["turn-timeout-ms"], "--turn-timeout-ms");
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    // A `--background` review is dispatched (under `nohup`/`&`) to outlive the
    // session that started it, so its record has to outlive it too.
    background: Boolean(options.background)
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        config: configOverrides,
        focusText,
        reviewName: config.reviewName,
        turnTimeoutMs,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "await-timeout-ms", "turn-timeout-ms"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "await", "prompt-stdin"],
    repeatableOptions: ["config"],
    stopAtFirstPositional: true,
    aliasMap: {
      m: "model"
    }
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort, model);
  const configOverrides = parseConfigOverrides(options.config);
  // Every flag conflict is decided before the prompt is read: `--prompt-stdin`
  // blocks on an open stdin, so a usage error must never wait for EOF.
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (options.await && options.background) {
    throw new Error("Choose either --await or --background.");
  }
  if (options["await-timeout-ms"] != null && !options.await) {
    throw new Error("--await-timeout-ms requires --await.");
  }
  const awaitTimeoutMs = parseTimeoutOption(options["await-timeout-ms"], "--await-timeout-ms");
  const turnTimeoutMs = parseTimeoutOption(options["turn-timeout-ms"], "--turn-timeout-ms");

  const prompt = readTaskPrompt(cwd, options, positionals);
  // A `--prompt-stdin` prompt is already exactly what the caller typed; nothing
  // downstream may trim it further.
  const promptRaw = Boolean(options["prompt-stdin"]);
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  // `--await` runs the same detached worker as `--background` — same job
  // record, so status/result/cancel work on it — and only differs in waiting for
  // it here instead of returning the queued line.
  if (options.background || options.await) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      config: configOverrides,
      prompt,
      promptRaw,
      write,
      resumeLast,
      turnTimeoutMs,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    if (!options.await) {
      outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
      return;
    }

    const jobId = await waitForTerminalJobOrHint(cwd, job.id, {
      timeoutMs: awaitTimeoutMs,
      json: options.json
    });
    if (jobId && outputJobResult(cwd, jobId, options.json).status !== "completed") {
      process.exitCode = 1;
    }
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        config: configOverrides,
        prompt,
        promptRaw,
        write,
        resumeLast,
        turnTimeoutMs,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
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
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
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
  outputResult(renderStatusPayload(report, options.json), options.json);
}

async function handleResult(argv) {
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

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentSessionId();
  const jobs = filterJobsForSession(sortJobsNewestFirst(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot))));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  // A direct worker owns its app-server: a second client cannot reach it (it
  // would start a codex of its own), and the kill below takes it down.
  // Defense in depth: the updater patches the index under the state lock, then
  // the file outside it (the index leads by one write); a file that says direct while
  // the index does not is forged or torn, and the brokered path (no kill
  // without the turn's end) is the safe one.
  const direct = existing.transport === "direct" && job.transport === "direct";

  const interrupt = direct
    ? { attempted: false, interrupted: false, transport: "direct", detail: "direct transport: the kill stops the worker's own app-server" }
    : await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  // Only a pid that is provably still this job's worker is signalled (#743).
  let { pid, identity } = resolveJobPid(workspaceRoot, job);
  // Brokered, or recorded before v1.4.2 (no `transport`): the turn runs in the
  // shared runtime, so a dead worker would not stop it. Only a terminal record
  // ends the wait; polled outside the state lock, which the worker's own
  // terminal write takes. A record that is already terminal ends it at once,
  // whether or not the interrupt was acknowledged (a zero window reads once).
  // No turn recorded → nothing to wait for (v1.4.1 path).
  let turnEnded = false;
  if (!direct && turnId) {
    const stored = await waitForTerminalRecord(workspaceRoot, job.id, interrupt.interrupted ? TURN_INTERRUPT_ACK_MS : 0);
    if (!stored) {
      emitCancelPending({ pending: true, reason: "turn-not-interrupted", survivors: [] }, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
      process.exitCode = 1;
      return;
    }
    // Caused by this cancel only when our interrupt, acknowledged by the shared
    // broker (a stray direct app-server may acknowledge a turn it never ran),
    // met the worker's own record; a record found terminal without that, a
    // crash-guard or a reaper record is kept by commitCancel. Either way the
    // worker is done with the job: nothing is killed.
    turnEnded = interrupt.interrupted && interrupt.transport === "broker" && isWorkerTerminalRecord(stored);
    pid = null;
    identity = null;
  }
  // win32: the broker read, the kill and the record write share one state lock.
  // A broker saves its starting record under the same lock before it spawns, so
  // none can start between this read and the kill script's snapshot. The kill
  // is bounded like SessionEnd's win32 step, under the other takers' lock wait.
  if (process.platform === "win32") {
    withStateLock(workspaceRoot, () => finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded, options }));
  } else {
    finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded, options });
  }
}

// Polls the job file until a terminal record appears, or `null` once the window closes.
async function waitForTerminalRecord(workspaceRoot, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = readStoredJob(workspaceRoot, jobId);
    if (isTerminalRecord(stored)) {
      return stored;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const WIN32_CANCEL_KILL_MS = 4000;

function finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded = false, options }) {
  const win32 = process.platform === "win32";
  const broker = win32 ? brokerPresence(workspaceRoot) : null;
  const exclude = brokerExclusion(broker);
  // A broker record without a win32 identity (a starting one included) cannot be
  // excluded safely: refuse rather than risk killing the shared broker under the worker.
  const kill = broker && exclude === null
    ? { attempted: false, delivered: false, reason: "identity-unavailable" }
    : terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id), exclude: exclude ?? [], ...(win32 ? { timeoutMs: WIN32_CANCEL_KILL_MS } : {}) });
  // A worker we may not signal, or whose signal reached nothing, but that is
  // still alive is not cancelled: the job stays running, and the sidecar stays
  // so a later cancel or the reaper can still find it.
  // win32, the root was gone before the kill (241): only the worker's own terminal
  // record, read under the kill's lock, proves its tree closed.
  const workerProved = win32 && kill.reason === "process-missing" && isWorkerProvedRecord(readStoredJob(workspaceRoot, job.id));
  const decision = cancelDecision({ pid, kill, alive: isPidAlive(pid), workerProved });
  if (decision.pending) {
    emitCancelPending(decision, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
    process.exitCode = 1;
    return;
  }
  // win32: a root proven gone with no orphans was not left running.
  const goneClean = win32 && kill.reason === "process-missing";
  const leftRunning = pid && !kill.attempted && !goneClean ? `worker pid ${pid} left running: ${kill.reason}` : null;

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    pidIdentity: null,
    requestFile: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  // A brokered cancel caused the finish only when its acknowledged interrupt met
  // the worker's own record; neither alone proves it.
  const kept = commitCancel(workspaceRoot, job, nextJob, existing, { leftRunning, causedByCancel: turnEnded || (kill.attempted === true && kill.delivered === true), log: (line) => appendLogLine(job.logFile, line) });
  const common = {
    jobId: job.id,
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  if (kept) {
    // Finished before this cancel could write: the stored outcome stands.
    const text = `Job ${job.id} already ${kept.status}; its record is kept.\n`;
    outputCommandResult({ ...common, status: kept.status, cancellationPending: false }, text, options.json);
    return;
  }

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    workerLeftRunning: leftRunning
  };

  const rendered = renderCancelReport(nextJob);
  outputCommandResult(payload, leftRunning ? `${rendered}${leftRunning}\n` : rendered, options.json);
}

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
      await handleTaskWorker(argv);
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
