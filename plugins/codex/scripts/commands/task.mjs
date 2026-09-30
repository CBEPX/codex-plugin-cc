import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputCommandResult,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  PROMPT_STDIN_FLAG,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "../lib/cli.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  runAppServerTurn
} from "../lib/codex.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { isActiveJobStatus } from "../lib/job-status.mjs";
import { listJobs } from "../lib/state.mjs";
import { sortJobsNewestFirst } from "../lib/job-control.mjs";
import { filterJobsForSession, getCurrentSessionId, reapDeadJobs } from "../lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { renderTaskResult, shorten } from "../lib/render.mjs";
import {
  createCompanionJob,
  enqueueBackgroundJob,
  ensureCodexAvailable,
  firstMeaningfulLine,
  outputJobResult,
  renderQueuedLaunch,
  runForegroundCommand,
  waitForTerminalJobOrHint
} from "./shared.mjs";

const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

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

export async function executeTaskRun(request) {
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

export async function handleTask(argv) {
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
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    if (!options.await) {
      outputCommandResult(payload, renderQueuedLaunch(payload), options.json);
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

export function handleTaskResumeCandidate(argv) {
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
