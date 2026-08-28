import fs from "node:fs";
import process from "node:process";

import {
  readJobFile,
  removeJobRequestFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      resolved: value.resolved && typeof value.resolved === "object" && !Array.isArray(value.resolved) ? value.resolved : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    resolved: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastResolved = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.resolved && normalized.resolved !== lastResolved) {
      lastResolved = normalized.resolved;
      patch.resolved = normalized.resolved;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // A run that fails without throwing (a timed-out or interrupted turn) still
    // has to say why: `status`/`result` read the reason off the record.
    const errorMessage = completionStatus === "failed" ? execution.errorMessage ?? null : null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      errorMessage,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      resolved: execution.resolved ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      errorMessage,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      resolved: execution.resolved ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists but not ours — treat as alive.
    return error?.code === "ESRCH" ? false : true;
  }
}

function markJobDead(workspaceRoot, jobSummary, errorMessage) {
  const jobFile = resolveJobFile(workspaceRoot, jobSummary.id);
  const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
  const base = stored ?? jobSummary;
  if (base.status !== "running" && base.status !== "queued") {
    // The job finished between the caller's read and now — keep the real result.
    return base;
  }
  const completedAt = nowIso();
  // Nothing will ever read the private payload now, so it must not stay on disk
  // (0600, possibly holding `--config` secrets) until the job is pruned. Only
  // its path is cleared on the record: the values themselves are never lifted
  // into the record or the state index, which `status`/`result` echo back.
  removeJobRequestFile(workspaceRoot, jobSummary.id);
  const record = {
    ...base,
    status: "failed",
    phase: "failed",
    errorMessage,
    pid: null,
    requestFile: null,
    completedAt,
    // Keep updatedAt current so the reaped job sorts newest-first in the same
    // read that recorded it — otherwise a stale updatedAt can page it out of
    // the first /codex:status report.
    updatedAt: completedAt
  };
  writeJobFile(workspaceRoot, jobSummary.id, record);
  upsertJob(workspaceRoot, {
    id: jobSummary.id,
    status: "failed",
    phase: "failed",
    pid: null,
    requestFile: null,
    errorMessage,
    completedAt
  });
  appendLogLine(base.logFile ?? null, `Marked failed: ${errorMessage}`);
  return record;
}

const DEAD_WORKER_MESSAGE = "worker exited before completing";

// How long a queued job may sit without a recorded pid before it counts as dead.
// `enqueueBackgroundTask` patches the pid in immediately after the spawn, so the
// window is milliseconds wide in practice; the grace period only has to outlast
// a heavily loaded machine.
const QUEUED_WITHOUT_PID_GRACE_MS = 30000;

// A worker killed between the spawn and `updateJobPid` leaves a queued record
// with no pid at all. `isPidAlive(null)` cannot tell that apart from a record
// that was written microseconds ago, so age decides it.
function isQueuedWithoutWorker(job) {
  if (job.status !== "queued" || job.pid != null) {
    return false;
  }
  const createdAt = Date.parse(job.createdAt ?? "");
  return Number.isFinite(createdAt) && Date.now() - createdAt > QUEUED_WITHOUT_PID_GRACE_MS;
}

// A worker that dies without throwing (SIGKILL, OOM, native crash) never
// reaches runTrackedJob's catch, so its job stays "running" — or, if it died
// before taking the record over, "queued" — forever. Rewrite any active job
// whose worker is gone as failed. Known limitation (upstream too): `kill(pid, 0)`
// reads a zombie as alive and cannot see a recycled pid.
export function reapDeadJobs(workspaceRoot, jobs) {
  return jobs.map((job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }
    if (isPidAlive(job.pid) === false || isQueuedWithoutWorker(job)) {
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE);
    }
    return job;
  });
}

// Guards only against in-process crashes (uncaughtException / unhandledRejection)
// where a precise error is available and no other command is writing the job.
// Signal-based deaths (SIGTERM/SIGINT/SIGHUP/SIGKILL) are intentionally NOT
// caught here: SIGKILL is uncatchable so the reader-side reapDeadJobs must cover
// it regardless, and /codex:cancel delivers SIGTERM as its teardown signal after
// writing the job "cancelled" — catching it here would race that terminal state
// back to "failed". reapDeadJobs handles every signal death and never rewrites a
// job that already reached a terminal status.
export function registerWorkerCrashGuard(workspaceRoot, jobId, logFile = null) {
  const mark = (label) => (reason) => {
    try {
      const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason ?? "");
      appendLogLine(logFile, `Worker ${label}: ${detail}`);
      markJobDead(workspaceRoot, { id: jobId, status: "running", logFile }, `worker ${label}: ${detail.split("\n")[0]}`);
    } catch {
      // Never let the guard itself throw during teardown.
    }
    process.exit(1);
  };
  process.on("uncaughtException", mark("uncaughtException"));
  process.on("unhandledRejection", mark("unhandledRejection"));
}
