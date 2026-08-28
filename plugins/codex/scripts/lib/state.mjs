import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

// Every reader of these files tolerates a corrupt one by falling back to a
// default (`loadState` returns an empty job list), so a reader that catches a
// plain `writeFileSync` mid-flight cannot tell a truncated file from an idle
// workspace — that is how a SessionEnd with a live job shut the shared broker.
// Writing a sibling temp file and renaming it swaps the content in one step:
// a reader sees either the old file or the new one, never half of either.
/** @param {import("node:fs").WriteFileOptions} options */
function writeFileAtomic(filePath, contents, options = "utf8") {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, contents, options);
  fs.renameSync(tempFile, filePath);
  return filePath;
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(resolveJobRequestFile(cwd, job.id));
    removeFileIfExists(resolveJobPidFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

// The queued record is written before the worker is spawned, so its pid can only
// be filled in afterwards — and the worker owns the job file from its first line
// (`runTrackedJob` writes `running` with the same pid). So the parent never
// writes that file back: a read-modify-write from the parent could put a queued
// snapshot over a record the worker had already completed, losing its result,
// threadId and turnId. The pid goes into an atomic sidecar plus the pid-only
// index patch, and readers fall back to the sidecar (`resolveJobPid`) only while
// the job is still active.
export function updateJobPid(cwd, jobId, pid) {
  writeJobPidFile(cwd, jobId, pid);
  // The index is patch-based, so it cannot lose a field — but a worker that
  // already reported `running` wrote its own pid there, and that record is the
  // newer one. A job that is gone from the index needs no pid at all.
  const indexed = listJobs(cwd).find((job) => job.id === jobId);
  if (indexed?.status === "queued") {
    upsertJob(cwd, { id: jobId, pid });
  }
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobPidFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.pid`);
}

export function writeJobPidFile(cwd, jobId, pid) {
  return writeFileAtomic(resolveJobPidFile(cwd, jobId), `${pid}\n`);
}

export function removeJobPidFile(cwd, jobId) {
  removeFileIfExists(resolveJobPidFile(cwd, jobId));
}

function readJobPidSidecar(cwd, jobId) {
  try {
    const pid = Number.parseInt(fs.readFileSync(resolveJobPidFile(cwd, jobId), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// The pid every reader (cancel, reaper, SessionEnd cleanup) should use: the
// record's own pid once the worker has taken the record over, the sidecar during
// the queued window before that. A terminal job never reports one — its worker
// is gone and the sidecar may name a pid the OS has recycled.
export function resolveJobPid(cwd, job) {
  if (job?.pid != null) {
    return job.pid;
  }
  if (job?.status !== "queued" && job?.status !== "running") {
    return null;
  }
  return readJobPidSidecar(cwd, job.id);
}

// The full task request can carry secrets (`--config` values such as auth
// headers), so background workers read it from a private one-shot file instead
// of the job record that `status`/`result` echo back to the user.
export function resolveJobRequestFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.request.json`);
}

export function writeJobRequestFile(cwd, jobId, payload) {
  // The temp file carries the 0600 mode through the rename, so the payload is
  // never briefly world-readable.
  return writeFileAtomic(resolveJobRequestFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function removeJobRequestFile(cwd, jobId) {
  removeFileIfExists(resolveJobRequestFile(cwd, jobId));
}

export function consumeJobRequestFile(cwd, jobId) {
  const requestFile = resolveJobRequestFile(cwd, jobId);
  if (!fs.existsSync(requestFile)) {
    return null;
  }
  const payload = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  fs.unlinkSync(requestFile);
  return payload;
}
