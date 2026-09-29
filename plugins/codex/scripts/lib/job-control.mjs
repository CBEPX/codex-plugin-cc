import fs from "node:fs";

import { BROKER_ENDPOINT_ENV } from "./app-server.mjs";
import { loadBrokerSession, resolveBrokerStateFile } from "./broker-lifecycle.mjs";
import { getSessionRuntimeStatus } from "./codex.mjs";
import { getConfig, listJobs, readJobFile, removeJobPidFile, removeJobRequestFile, resolveJobFile, upsertJob, withStateLock, writeJobFile } from "./state.mjs";
import { DEAD_WORKER_MESSAGE, reapDeadJobs, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true, options = {}) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  if (options.optional) {
    return null;
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot)), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot)));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

// Resolves the job `result` should report on: a finished one when there is one,
// otherwise the still-active job the reference points at. Filtering by terminal
// status *before* matching used to make `result <running-id>` fail with
// "No job found" (#498/#524); the caller decides how to report an active job.
export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? reapDeadJobs(workspaceRoot, listJobs(workspaceRoot)) : filterJobsForCurrentSession(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot))));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled",
    { optional: true }
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "queued" || job.status === "running",
    { optional: true }
  );
  if (active) {
    return { workspaceRoot, job: active };
  }

  if (reference) {
    throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot)));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}

// The cancel's terminal write, one locked step: another process's `saveState`
// prune works off a diff of the index, so a cancel split across the write can
// have its record pruned away, or the payload it deleted counted as still owned.
// A record already terminal is kept and returned for the caller to report when
// the reaper wrote it (its dead-worker failure, whatever this cancel did), or
// when this cancel did not cause it. The worker's own record after this cancel's
// acknowledged interrupt or delivered kill is a consequence of the cancel and is
// overwritten with `cancelled` (v1.4.0). Otherwise `null` once written.
export function commitCancel(workspaceRoot, job, nextJob, existing, { leftRunning, log, causedByCancel = false }) {
  return withStateLock(workspaceRoot, () => {
    const stored = readStoredJob(workspaceRoot, job.id);
    const terminal = stored && stored.status !== "queued" && stored.status !== "running";
    // The reaper's variants all start with its message ("… (pid reused: …)").
    const reaped = terminal && typeof stored.errorMessage === "string" && stored.errorMessage.startsWith(DEAD_WORKER_MESSAGE);
    if (terminal && (reaped || causedByCancel !== true)) {
      log(`cancel: record already ${stored.status}, kept (${reaped ? "written by the reaper" : "interrupt not acknowledged"})`);
      return stored;
    }
    if (leftRunning) {
      log(leftRunning);
    }
    log("Cancelled by user.");
    // A worker cancelled inside the queued window may never have consumed its
    // private payload, and a cancelled job is terminal — the reaper will never
    // look at it again — so the 0600 file (possibly holding `--config` secrets)
    // has to be released here.
    removeJobRequestFile(workspaceRoot, job.id);
    removeJobPidFile(workspaceRoot, job.id);
    writeJobFile(workspaceRoot, job.id, { ...(stored ?? existing), ...nextJob, cancelledAt: nextJob.completedAt });
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      pidIdentity: null,
      requestFile: null,
      errorMessage: nextJob.errorMessage,
      completedAt: nextJob.completedAt
    });
    return null;
  });
}

// What cancel does with a kill outcome. posix keeps its v1.4.0 answer; win32
// treats survivors and an unverified attempt as "not cancelled": the job stays
// running and the survivors are reported, never followed by a record (spec §1).
export function cancelDecision({ pid, kill, alive, platform = process.platform }) {
  if (!pid) {
    return { pending: false, reason: null, survivors: [] };
  }
  // win32, the root was already gone (241): the kill script looked for orphans it
  // left. Any → pending with them; none → the worker is gone, cancel proceeds.
  if (platform === "win32" && kill.attempted === false && kill.reason === "process-missing") {
    const survivors = kill.survivors ?? [];
    return survivors.length > 0 ? { pending: true, reason: kill.reason, survivors, rootAlive: alive } : { pending: false, reason: null, survivors: [] };
  }
  // win32, the kill was refused and the root is dead: its tree was never
  // examined, so "cancelled" is a guess — the reaper judges the job.
  if (platform === "win32" && kill.attempted === false && kill.reason !== "no-pid" && alive === false) {
    return { pending: true, reason: kill.reason, survivors: [], rootAlive: alive };
  }
  const win32Unknown = platform === "win32" && kill.attempted && (kill.survivors?.length > 0 || kill.unverified === true);
  const stillHere = (!kill.attempted || !kill.delivered) && alive === true;
  if (!stillHere && !win32Unknown) {
    return { pending: false, reason: null, survivors: [] };
  }
  const reason = kill.attempted ? (platform === "win32" ? "kill-failed" : "not-delivered") : kill.reason;
  return { pending: true, reason, survivors: platform === "win32" ? (kill.survivors ?? []) : [], rootAlive: alive };
}

// The loaded broker record, `"unknown"` when none is readable but an endpoint is
// advertised (a broker is presumed until proven absent), or `null`.
export function brokerPresence(workspaceRoot, env = process.env, { record = loadBrokerSession(workspaceRoot) } = {}) {
  if (record) {
    return record;
  }
  // A record file that exists but did not load is unreadable: presume a broker.
  if (fs.existsSync(resolveBrokerStateFile(workspaceRoot))) {
    return "unknown";
  }
  return typeof env[BROKER_ENDPOINT_ENV] === "string" && env[BROKER_ENDPOINT_ENV] !== "" ? "unknown" : null;
}

// The pairs a worker kill must skip: `[]` without a broker, one verified
// `{ pid, identity }` pair, or `null` when a broker is recorded but cannot be
// excluded safely (no win32 identity) — the caller then refuses the kill.
export function brokerExclusion(broker) {
  if (!broker) {
    return [];
  }
  if (broker === "unknown") {
    return null;
  }
  const identity = typeof broker.pidIdentity === "string" && /^win32:\d+$/.test(broker.pidIdentity) ? broker.pidIdentity : null;
  return Number.isInteger(broker.pid) && broker.pid >= 1 && identity ? [{ pid: broker.pid, identity }] : null;
}

// Pending cancel, rendered once for the three sinks. On posix `survivors` is
// always [] and `reason` is v1.4.0's, so json/text/logLine are byte-identical
// to v1.4.0 there; only win32 adds a survivors suffix and a stderr diagnostic.
export function renderCancelPending(decision, pid, jobId) {
  const survivors = decision.survivors ?? [];
  const pending = `cancellation not confirmed: worker pid ${pid} left running (${decision.reason})`;
  const survivorText = survivors.map((s) => `${s.pid}:${s.identity ?? "unknown"}`).join(" ");
  const suffix = survivors.length > 0
    ? ` worker tree survivors: ${survivorText}`
    : decision.reason === "kill-failed" ? " (unverified)" : "";
  // The root exited but part of its tree did not: nothing "waits for the worker".
  const rootGone = survivors.length > 0 && decision.rootAlive === false;
  const tail = rootGone
    ? `worker pid ${pid} exited but part of its tree is still running (survivors: ${survivorText}); the job stays running until the reaper judges it.`
    : (decision.reason === "identity-unavailable" || decision.reason === "identity-mismatch") && decision.rootAlive === false
    ? `worker pid ${pid} exited before it could be verified; the job stays running until the reaper judges it.`
    : "the job stays running until the worker exits.";
  return {
    json: { jobId, status: "running", cancellationPending: true, reason: decision.reason, ...(survivors.length > 0 ? { survivors } : {}) },
    text: `${pending}\nThe turn interrupt was sent; ${tail} Re-run cancel or wait for result.\n`,
    logLine: `${pending}${suffix}`,
    diagnostic: survivors.length > 0 ? `[codex] worker tree survivors: ${survivorText}\n` : null,
  };
}

// The caller's side of a pending cancel: one JSON document or the text on
// stdout, the diagnostic (if any) on stderr, one line in the job log.
export function emitCancelPending(decision, pid, jobId, { json, appendLog, stdout = process.stdout, stderr = process.stderr }) {
  const rendered = renderCancelPending(decision, pid, jobId);
  appendLog(rendered.logLine);
  if (rendered.diagnostic) {
    stderr.write(rendered.diagnostic);
  }
  stdout.write(json ? `${JSON.stringify(rendered.json, null, 2)}\n` : rendered.text);
  return rendered;
}
