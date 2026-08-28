import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isPidAlive } from "./process.mjs";
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

export const REDACTED_CONFIG_VALUE = "[redacted]";

// `status --json` / `result --json` echo the stored job record back to the user
// and to Claude, so a `--config model_providers.x.http_headers.Cookie=…` would end
// up in the transcript and in long-lived state. No key-name heuristic can tell a
// credential from a harmless override — `Cookie` matches no denylist — so every
// value is dropped and only the keys are recorded. The real values reach Codex
// from the private 0600 one-shot payload file instead.
export function redactConfigValues(config) {
  if (!config || typeof config !== "object") {
    return config;
  }
  return Object.fromEntries(Object.keys(config).map((key) => [key, REDACTED_CONFIG_VALUE]));
}

function hasStoredConfigValues(record) {
  const config = record?.request?.config;
  return (
    Boolean(config) &&
    typeof config === "object" &&
    Object.values(config).some((value) => value !== REDACTED_CONFIG_VALUE)
  );
}

function withRedactedRequest(record) {
  return hasStoredConfigValues(record)
    ? { ...record, request: { ...record.request, config: redactConfigValues(record.request.config) } }
    : record;
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Records written before values were redacted (1.1.1 and earlier) carry the raw
// ones under the same STATE_VERSION, so an upgrade alone would keep serving them.
// Redaction happens on every read — that is the boundary every `status`/`result`
// output crosses — and the file is rewritten once so the values stop living in
// long-lived state. The rewrite re-reads inside the lock and never goes through
// `saveState`, whose prune is a diff against a snapshot this does not have.
function migrateStoredConfigValues(cwd, state) {
  if (!state.jobs.some(hasStoredConfigValues)) {
    return state;
  }

  try {
    withStateLock(cwd, () => {
      const current = readJsonOrNull(resolveStateFile(cwd));
      if (!Array.isArray(current?.jobs)) {
        return;
      }
      current.jobs = current.jobs.map(withRedactedRequest);
      writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(current, null, 2)}\n`);
    });
  } catch {
    // Best effort: what this read returns is redacted either way.
  }

  return { ...state, jobs: state.jobs.map(withRedactedRequest) };
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return migrateStoredConfigValues(cwd, {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    });
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

// Every workspace command reads `state.json`, changes it and writes it back, and
// `saveState` deletes the artifacts of every job that was in the file it read but
// is not in the snapshot it writes. Unserialized, a process whose snapshot went
// stale therefore does not merely lose another process's job from the index — it
// deletes that job's file, private payload, PID sidecar and log. The lock is a
// directory, claimed by renaming a staged one onto it: a directory rename fails
// against a non-empty target, so the claim and the holder info inside it land in
// one atomic step. That matters more than the atomicity of `mkdir` — a holder
// killed between `mkdir` and writing its own PID would leave a lock nothing can
// attribute to a process, which is exactly how a SessionEnd hook once sat out
// the whole bounded wait and left a broker running.
// ponytail: one lock per workspace, no reader/writer split — every mutation is a
// few file writes, so a shared-read lock would only add ways to get it wrong.
const LOCK_DIR_NAME = "state.lock";
const LOCK_STAGING_PREFIX = ".state.lock-";
const LOCK_HOLDER_FILE = "holder.json";
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 30000;
// A lock with no readable holder can only be a leftover: acquisition never
// publishes one without holder info, so nobody is coming back for it. Age is all
// there is to go on, and it has to expire well inside the bounded wait.
const LOCK_ORPHAN_MS = 2000;
// Renaming a directory onto a non-empty one fails; the code depends on the
// platform (POSIX ENOTEMPTY/EEXIST, Windows EPERM/EACCES). Anything else is a
// real filesystem error and is rethrown.
const LOCK_CONTENDED_CODES = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]);

// Locks this process already holds, with the token each was claimed under: a
// locked section may call another one (`updateState` → `saveState`) and must not
// deadlock against itself.
const heldLocks = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockHolder(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, LOCK_HOLDER_FILE), "utf8"));
  } catch {
    return null;
  }
}

// Returns the holder snapshot the verdict was based on when the lock is stale —
// `{ missing: true }` when there was no holder file to read — and null when it is
// not. The snapshot is what the breaker re-checks before it touches anything.
function judgeStaleLock(lockDir) {
  const holder = readLockHolder(lockDir);
  if (!holder) {
    return Date.now() - statMtimeMs(lockDir) <= LOCK_ORPHAN_MS ? null : { missing: true };
  }

  const alive = isPidAlive(holder.pid);
  if (alive === true) {
    // Never taken over, however long it has been held. Age cannot tell a slow
    // holder from a stuck one, and evicting a process that is still writing
    // state.json puts two writers in the critical section — the exact corruption
    // this lock exists to prevent. A holder that is genuinely stuck has to be
    // killed by the operator (the wait error names its PID); its death is what
    // makes the lock reclaimable.
    return null;
  }
  if (alive === false) {
    return holder;
  }

  // No usable PID to check, only holder info: age is the only signal left.
  const startedAt = Date.parse(holder.startedAt ?? "");
  const heldSince = Number.isFinite(startedAt) ? startedAt : statMtimeMs(lockDir);
  const expired = Number.isFinite(heldSince) ? Date.now() - heldSince > LOCK_STALE_MS : true;
  return expired ? holder : null;
}

function statMtimeMs(target) {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

function releaseLock(lockDir, token) {
  try {
    // Only ever remove the lock we ourselves claimed. If it was taken over while
    // we held it, the directory belongs to whoever claimed it next — and a PID is
    // no way to tell them apart, since PIDs are reused and the successor can even
    // be this same process on a later acquisition. The token is one-off.
    if (readLockHolder(lockDir)?.token === token) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // A lock we cannot remove is taken over by the next writer once it goes stale.
  }
}

// Claim it before deleting it: two writers can judge the same lock stale at the
// same moment, and a plain delete lets the slower one remove the lock the faster
// one has already re-acquired. A rename can only succeed once, so exactly one
// breaker wins and the loser simply retries.
//
// `judged` is the holder snapshot the staleness decision was made from. It is
// re-checked here because that decision is not the same instant as this rename:
// the faster breaker may already have taken the lock over, and breaking its live
// lock would put two writers in the critical section — with its own release then
// silently doing nothing, since the directory it holds would be gone.
// Exported for the lock's own tests; nothing else calls it.
// ponytail: a re-read, not a compare-and-swap — a directory rename cannot be
// conditional. It narrows the window to two adjacent syscalls; closing it fully
// would need a lock server, which is a lot of machinery for a per-workspace file.
export function breakStaleLock(lockDir, judged) {
  const current = readLockHolder(lockDir);
  if (judged?.missing ? current !== null : current?.token !== judged?.token) {
    return;
  }
  const doomed = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockDir, doomed);
  } catch {
    return;
  }
  try {
    fs.rmSync(doomed, { recursive: true, force: true });
  } catch {
    // Leftover directory, not a lock: nothing ever looks at it again.
  }
}

// Returns the token the lock was claimed under; only that token may release it.
function acquireLock(lockDir, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Stage the lock with its holder info, then publish it with one rename, so
    // the lock never exists in a state where its holder is unknown.
    const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
    const staging = fs.mkdtempSync(path.join(path.dirname(lockDir), LOCK_STAGING_PREFIX));
    fs.writeFileSync(
      path.join(staging, LOCK_HOLDER_FILE),
      `${JSON.stringify({ pid: process.pid, token, startedAt: nowIso() })}\n`,
      "utf8"
    );
    try {
      fs.renameSync(staging, lockDir);
      return token;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (!LOCK_CONTENDED_CODES.has(error.code)) {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      const holderPid = readLockHolder(lockDir)?.pid;
      throw new Error(
        `Timed out after ${waitMs} ms waiting for the Codex state lock (${lockDir}).` +
          (holderPid ? ` It is held by pid ${holderPid}; stop that process if it is stuck.` : " Remove that directory if no Codex command is running.")
      );
    }
    const stale = judgeStaleLock(lockDir);
    if (stale) {
      breakStaleLock(lockDir, stale);
    } else {
      sleepSync(LOCK_POLL_MS);
    }
  }
}

// Runs `fn` — which must be synchronous — as the only writer of this workspace's
// state, across processes. Re-read whatever you are about to change inside it:
// anything read before the call may already be stale.
export function withStateLock(cwd, fn, options = {}) {
  ensureStateDir(cwd);
  return withLockDir(path.join(resolveStateDir(cwd), LOCK_DIR_NAME), fn, options);
}

function withLockDir(lockDir, fn, options = {}) {
  const held = heldLocks.get(lockDir);
  if (held) {
    held.depth += 1;
    try {
      return fn();
    } finally {
      held.depth -= 1;
    }
  }

  const token = acquireLock(lockDir, options.waitMs ?? LOCK_WAIT_MS);
  heldLocks.set(lockDir, { depth: 1, token });
  try {
    return fn();
  } finally {
    heldLocks.delete(lockDir);
    releaseLock(lockDir, token);
  }
}

// The prune below is a diff against what is on disk right now, so both halves —
// the read and the write — belong inside the lock. `state` is the caller's
// snapshot: anything it did not carry over is treated as deleted, which is only
// safe because no other process can have added to the file since the caller
// re-read it under this same lock.
export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state));
}

function saveStateLocked(cwd, state) {
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

// Read, change and write as one indivisible step: the read has to happen inside
// the lock, or the snapshot handed to `mutate` can already be missing a job
// another process just added — which `saveState` would then delete.
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
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
  // newer one. A job that is gone from the index needs no pid at all. The read
  // and the patch share one lock: between them the worker could otherwise report
  // `running`, and the patch would put this stale pid over its own.
  withStateLock(cwd, () => {
    const indexed = listJobs(cwd).find((job) => job.id === jobId);
    if (indexed?.status === "queued") {
      upsertJob(cwd, { id: jobId, pid });
    }
  });
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
  const record = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (!hasStoredConfigValues(record)) {
    return record;
  }

  // Same one-shot migration as the index, plus the move that makes it safe for an
  // active job: 1.1.1 wrote no private payload, so its record is the only copy of
  // the request — and that record is exactly what `handleTaskWorker` falls back to.
  // Redacting it in place would hand the worker "[redacted]" as its Codex config,
  // so the raw request goes to the 0600 payload file the worker consumes first,
  // and only then leaves the record.
  const requestFile = jobFile.replace(/\.json$/, ".request.json");
  try {
    withLockDir(path.join(path.dirname(path.dirname(jobFile)), LOCK_DIR_NAME), () => {
      const current = readJsonOrNull(jobFile);
      if (!current || !hasStoredConfigValues(current)) {
        return;
      }
      // Only a `queued` record still has a worker coming for its request: the
      // worker consumes the payload (or falls back to the record) *before*
      // `runTrackedJob` flips the status to `running`, so staging one for a
      // running job would write plaintext `--config` values that nothing reads
      // and nothing deletes.
      const active = current.status === "queued";
      const migrated = withRedactedRequest(current);
      if (active && !fs.existsSync(requestFile)) {
        // Same shape and mode as `writeJobRequestFile`: the temp file carries the
        // 0600 through the rename, so the payload is never world-readable.
        writeFileAtomic(requestFile, `${JSON.stringify(current.request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        migrated.requestFile = requestFile;
      }
      writeFileAtomic(jobFile, `${JSON.stringify(migrated, null, 2)}\n`);
    });
  } catch {
    // Best effort: the record this returns is redacted either way.
  }

  return withRedactedRequest(record);
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
