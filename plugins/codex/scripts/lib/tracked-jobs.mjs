import fs from "node:fs";
import process from "node:process";

import { isActiveJobStatus, isTerminalRecord, JOB_STATUS } from "./job-status.mjs";
import { getProcessIdentities, getProcessIdentity, isPidAlive, processCommandLine } from "./process.mjs";

import {
  nowIso,
  readJobFile,
  readStoredJob,
  removeJobPidFile,
  removeJobRequestFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobPid,
  upsertJob,
  withStateLock,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      transport: value.transport === "broker" || value.transport === "direct" ? value.transport : null,
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
    transport: null,
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
  let lastTransport = null;
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

    // Arrives with `turnId` in the same event, so both land in one patch.
    if (normalized.transport && normalized.transport !== lastTransport) {
      lastTransport = normalized.transport;
      patch.transport = normalized.transport;
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

// A cancel that was acknowledged already wrote the terminal record and released
// the artifacts; a worker that outlives it must not replace `cancelled` with its
// own outcome. Read and write share the lock so a cancel cannot land in between.
function writeTerminalUnlessCancelled(workspaceRoot, jobId, logFile, write) {
  return withStateLock(workspaceRoot, () => {
    if (readStoredJob(workspaceRoot, jobId)?.status === "cancelled") {
      appendLogLine(logFile, "Worker finished after the job was cancelled; the cancelled record is kept.");
      return;
    }
    write();
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  // Probed outside the lock: on win32 it is a PowerShell start.
  const pidIdentity = getProcessIdentity(process.pid);
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    pidIdentity,
    logFile: options.logFile ?? job.logFile ?? null
  };
  // A cancel between the spawn and here already wrote a terminal record: the
  // check and the takeover share the lock so none can land in between, and a
  // job that is no longer queued or running is never run.
  const refused = withStateLock(job.workspaceRoot, () => {
    const stored = readStoredJob(job.workspaceRoot, job.id);
    if (stored && !isActiveJobStatus(stored.status)) {
      appendLogLine(runningRecord.logFile, `Worker started after the job was ${stored.status}; the turn was not run.`);
      removeJobPidFile(job.workspaceRoot, job.id);
      removeJobRequestFile(job.workspaceRoot, job.id);
      return true;
    }
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
    return false;
  });
  if (refused) {
    return null;
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // A run that fails without throwing (a timed-out or interrupted turn) still
    // has to say why: `status`/`result` read the reason off the record.
    const errorMessage = completionStatus === "failed" ? execution.errorMessage ?? null : null;
    const logFile = options.logFile ?? job.logFile ?? null;
    writeTerminalUnlessCancelled(job.workspaceRoot, job.id, logFile, () => {
      // `runningRecord` predates `turn/started`, which is where the progress
      // updater stored the transport; read it back so the final record keeps it.
      const stored = readStoredJob(job.workspaceRoot, job.id);
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        transport: stored?.transport ?? runningRecord.transport ?? null,
        status: completionStatus,
        errorMessage,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        resolved: execution.resolved ?? null,
        pid: null,
        pidIdentity: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        // `runner()` resolved, so withAppServer already awaited client.close().
        // `workerClosed`: that close returned. `appServerExited`: it saw the
        // direct child exit (a broker connection always counts); a close that hit
        // its 5 s deadline with the child alive records false, and so does a
        // runner that does not say. Only this cooperative write sets either
        // (crash guard and reaper never do).
        workerClosed: true,
        appServerExited: execution.appServerExited === true,
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
        pidIdentity: null,
        workerClosed: true,
        appServerExited: execution.appServerExited === true,
        completedAt
      });
      removeJobPidFile(job.workspaceRoot, job.id);
      // Nothing revisits a terminal job, so this is the last chance to release a
      // payload the worker never consumed (a crash before the read, or one staged
      // by the legacy-record migration).
      removeJobRequestFile(job.workspaceRoot, job.id);
    });
    appendLogBlock(logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeTerminalUnlessCancelled(job.workspaceRoot, job.id, options.logFile ?? job.logFile ?? null, () => {
      const existing = readStoredJob(job.workspaceRoot, job.id) ?? runningRecord;
      const completedAt = nowIso();
      writeJobFile(job.workspaceRoot, job.id, {
        ...existing,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        pidIdentity: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "failed",
        phase: "failed",
        pid: null,
        pidIdentity: null,
        errorMessage,
        completedAt
      });
      removeJobPidFile(job.workspaceRoot, job.id);
      // Nothing revisits a terminal job, so this is the last chance to release a
      // payload the worker never consumed (a crash before the read, or one staged
      // by the legacy-record migration).
      removeJobRequestFile(job.workspaceRoot, job.id);
    });
    throw error;
  }
}

// Reconciles a job the caller believes is dead. Everything here — the job file
// it trusts, the index entry it rewrites, the artifacts it deletes — has to move
// as one step, or a concurrent writer's prune can delete the files this just
// wrote (or resurrect the ones it deleted).
function markJobDead(workspaceRoot, jobSummary, errorMessage, lockWaitMs = undefined) {
  return withStateLock(workspaceRoot, () => markJobDeadLocked(workspaceRoot, jobSummary, errorMessage), {
    waitMs: lockWaitMs
  });
}

function markJobDeadLocked(workspaceRoot, jobSummary, errorMessage) {
  const jobFile = resolveJobFile(workspaceRoot, jobSummary.id);
  const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
  const base = stored ?? jobSummary;
  if (!isActiveJobStatus(base.status)) {
    // The job finished between the caller's read and now — keep the real result,
    // and put it in the index too: a worker that died between its terminal
    // `writeJobFile` and its `upsertJob` leaves an active index entry that
    // `assertThreadIsFree` reads as a phantom running job, blocking every later
    // resume of that thread.
    upsertJob(workspaceRoot, {
      id: jobSummary.id,
      status: base.status,
      phase: base.phase ?? null,
      errorMessage: base.errorMessage ?? null,
      threadId: base.threadId ?? null,
      turnId: base.turnId ?? null,
      resolved: base.resolved ?? null,
      requestFile: base.requestFile ?? null,
      pid: null,
      pidIdentity: null,
      completedAt: base.completedAt ?? null
    });
    return base;
  }
  const completedAt = nowIso();
  // Nothing will ever read the private payload now, so it must not stay on disk
  // (0600, possibly holding `--config` secrets) until the job is pruned. Only
  // its path is cleared on the record: the values themselves are never lifted
  // into the record or the state index, which `status`/`result` echo back.
  removeJobRequestFile(workspaceRoot, jobSummary.id);
  removeJobPidFile(workspaceRoot, jobSummary.id);
  const record = {
    ...base,
    status: "failed",
    phase: "failed",
    errorMessage,
    pid: null,
    pidIdentity: null,
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
    pidIdentity: null,
    requestFile: null,
    errorMessage,
    completedAt
  });
  appendLogLine(base.logFile ?? null, `Marked failed: ${errorMessage}`);
  return record;
}

export const DEAD_WORKER_MESSAGE = "worker exited before completing";

// How long a queued job may sit without a recorded pid before it counts as dead.
// `enqueueBackgroundTask` patches the pid in immediately after the spawn, so the
// window is milliseconds wide in practice; the grace period only has to outlast
// a heavily loaded machine.
const QUEUED_WITHOUT_PID_GRACE_MS = 30000;

// A worker killed between the spawn and `updateJobPid` leaves a queued record
// with no pid at all — not in the record and not in the sidecar. `isPidAlive(null)`
// cannot tell that apart from a record that was written microseconds ago, so age
// decides it.
function isQueuedWithoutWorker(job, pid) {
  if (job.status !== JOB_STATUS.QUEUED || pid != null) {
    return false;
  }
  const createdAt = Date.parse(job.createdAt ?? "");
  return Number.isFinite(createdAt) && Date.now() - createdAt > QUEUED_WITHOUT_PID_GRACE_MS;
}

// A worker that dies without throwing (SIGKILL, OOM, native crash) never
// reaches runTrackedJob's catch, so its job stays "running" — or, if it died
// before taking the record over, "queued" — forever. Rewrite any active job
// whose worker is gone as failed.
//
// The job file is read first, for every active entry: it is the authoritative
// record, and a worker that died between writing it and updating the index
// leaves an index entry PID liveness cannot correct — `kill(pid, 0)` reads a
// zombie as alive and cannot see a recycled pid, so that phantom `running` entry
// would block resume on its thread for as long as anything held that pid. Pid
// liveness is only consulted for jobs whose own file still says they are active.
// Below this there is no point starting another lock wait.
const REAP_MIN_STEP_MS = 100;
const IDENTITY_PROBE_MS = 2000;
const WIN32_BATCH_PROBE_MS = 6000; // one cold PowerShell start (<=3 s) with margin
// win32 polls (`status`, `--await`) reap on every tick; a live pid's identity
// does not change, so a fresh answer (a null too) is reused for this long.
// Only the reaper reads it: a kill re-verifies in its own script.
const WIN32_PROBE_MEMO_MS = 2000;
const win32ProbeMemo = new Map();

export function resetWin32ProbeMemo() {
  win32ProbeMemo.clear();
}

/**
 * @param {{ lockWaitMs?: number, remainingMs?: () => number, getProcessIdentityImpl?: typeof getProcessIdentity, getProcessIdentitiesImpl?: typeof getProcessIdentities, processCommandLineImpl?: typeof processCommandLine, platform?: string, now?: () => number }} [options] Bounds the
 * reaper's own state-lock waits. Each dead job costs one acquisition, so a caller
 * working to a deadline passes `remainingMs` and every wait is clamped to what is
 * left of it; once that is spent the remaining jobs are left for the next run
 * rather than reaped past the caller's budget.
 */
export function reapDeadJobs(workspaceRoot, jobs, options = {}) {
  const {
    lockWaitMs,
    remainingMs,
    getProcessIdentityImpl = getProcessIdentity,
    getProcessIdentitiesImpl = getProcessIdentities,
    processCommandLineImpl = processCommandLine,
    platform = process.platform,
    now = () => performance.now()
  } = options;
  const waitFor = () => {
    if (!remainingMs) {
      return lockWaitMs;
    }
    const left = Math.max(0, remainingMs());
    return lockWaitMs === undefined ? left : Math.min(lockWaitMs, left);
  };
  const probeMs = () => (remainingMs ? Math.min(IDENTITY_PROBE_MS, remainingMs()) : IDENTITY_PROBE_MS);
  // One PowerShell for the whole batch may start cold (up to 3 s on a slow
  // runner); a budget under that trips the launcher's breaker and blocks the
  // next minute of kills. Still bounded by the caller's deadline.
  const batchProbeMs = () => (remainingMs ? Math.min(WIN32_BATCH_PROBE_MS, remainingMs()) : WIN32_BATCH_PROBE_MS);
  // The jobs the identity probe can judge: still running by the index and on
  // disk, with a live pid that carries an identity — the same tests the loop
  // below applies, so the batch never probes a pid the loop would not.
  const liveIdentityCandidate = (job) => {
    if (!isActiveJobStatus(job.status)) {
      return null;
    }
    const stored = readStoredJob(workspaceRoot, job.id);
    if (isTerminalRecord(stored)) {
      return null;
    }
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (!pid || !identity || isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return null;
    }
    return { pid, identity };
  };
  // win32: one PowerShell for every candidate instead of one per job — a cold
  // start costs up to 3 s against a 12 s SessionEnd. posix probes stay per job
  // (a /proc read or one ps). A batch that fails judges nothing.
  // ponytail: each win32 candidate's job file is read twice (here and in the loop).
  let batch = new Map();
  if (platform === "win32") {
    const candidates = jobs.map(liveIdentityCandidate).filter(Boolean);
    const identityByPid = new Map(candidates.map((candidate) => [candidate.pid, candidate.identity]));
    const allPids = [...identityByPid.keys()];
    const at = now();
    const candidatePids = [];
    for (const pid of allPids) {
      const memo = win32ProbeMemo.get(pid);
      // Only a cached match is reused: a cached mismatch (or a `null`, "not
      // judged") may belong to another process that had this pid, so it is probed fresh.
      if (memo && at - memo.at < WIN32_PROBE_MEMO_MS && memo.identity === identityByPid.get(pid)) {
        batch.set(pid, memo.identity);
      } else {
        candidatePids.push(pid);
      }
    }
    if (candidatePids.length > 0 && !(remainingMs && remainingMs() < REAP_MIN_STEP_MS)) {
      try {
        const fresh = getProcessIdentitiesImpl(candidatePids, { platform, timeoutMs: batchProbeMs() });
        const stamp = now();
        for (const pid of candidatePids) {
          const identity = fresh.get(pid) ?? null;
          batch.set(pid, identity);
          win32ProbeMemo.set(pid, { identity, at: stamp });
        }
      } catch {
        // A failed launcher yields an empty Map, which memoises `null` ("not
        // judged"); a `null` memo is never reused, so it judges nothing later either.
      }
    }
  }
  const deferred = [];
  const reaped = jobs.map((job) => {
    if (remainingMs && remainingMs() < REAP_MIN_STEP_MS) {
      // Left as-is for the next run — say so, or a job that is dead but still
      // listed as running looks like a live one to whoever reads the decision.
      deferred.push(job.id);
      return job;
    }
    if (!isActiveJobStatus(job.status)) {
      return job;
    }
    const stored = readStoredJob(workspaceRoot, job.id);
    if (isTerminalRecord(stored)) {
      // Terminal on disk: markJobDead keeps the real result and reconciles it
      // into the index rather than failing the job.
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    // The queued record carries no pid of its own — the parent records it in an
    // atomic sidecar instead of rewriting the worker's job file.
    const { pid, identity } = resolveJobPid(workspaceRoot, job);
    if (isPidAlive(pid) === false || isQueuedWithoutWorker(job, pid)) {
      return markJobDead(workspaceRoot, job, DEAD_WORKER_MESSAGE, waitFor());
    }
    // Alive is not enough: the pid may now belong to another process (#743).
    // A probe that fails or times out proves nothing, so the job is left alone.
    if (pid && identity) {
      let actual = null;
      if (platform === "win32") {
        actual = batch.get(pid) ?? null;
      } else {
        try {
          actual = getProcessIdentityImpl(pid, { timeoutMs: probeMs() });
        } catch {
          actual = null;
        }
      }
      if (actual && actual !== identity) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (pid reused: ${pid} now belongs to another process)`, waitFor());
      }
    } else if (pid && platform !== "win32") {
      // A legacy record has no identity; a readable command line that is plainly
      // not a companion is proof enough to stop waiting on it. Nothing is signalled.
      let commandLine = null;
      try {
        commandLine = processCommandLineImpl(pid, { timeoutMs: probeMs() });
      } catch {
        commandLine = null;
      }
      if (typeof commandLine === "string" && commandLine && !commandLine.includes("codex-companion.mjs")) {
        return markJobDead(workspaceRoot, job, `${DEAD_WORKER_MESSAGE} (worker pid ${pid} now belongs to an unrelated process)`, waitFor());
      }
    }
    return job;
  });
  if (deferred.length > 0) {
    process.stderr.write(`[codex] Reaper ran out of budget; not judged this run: ${deferred.join(", ")}.\n`);
  }
  return reaped;
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
