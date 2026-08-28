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
// deletes that job's file, private payload, PID sidecar and log.
//
// The lock is a Lamport bakery on files. Every scheme that takes a lock away from
// its owner is a check-then-act on a shared path — judge it, then remove or
// replace it — and POSIX gives no conditional replace, so whatever was judged can
// change before the act. Here nothing shared is ever replaced or removed: an
// acquirer only ever creates files whose names are unique to it
// (`choosing.<token>`, `<n>.<token>.ticket`), and the only deletions are `unlink`s
// of one exact name whose content never changes — so a verdict about that file
// cannot go stale between the verdict and the unlink. The directory itself is
// created once and never removed.
//
// A pre-1.2.0 `state.lock` directory, if one is left over, is not read, removed or
// otherwise touched: that format never shipped.
// ponytail: one lock per workspace, no reader/writer split — every mutation is a
// few file writes, so a shared-read lock would only add ways to get it wrong.
const LOCK_DIR_NAME = "state.lock.d";
const LOCK_CHOOSING_PREFIX = "choosing.";
const LOCK_TICKET_SUFFIX = ".ticket";
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
// How long an entry nothing can be learned from — unreadable, or written by a
// process that died between the two syscalls — may sit before it counts as debris.
const LOCK_ORPHAN_MS = 2000;
// ... and how long one whose PID cannot be checked at all may hold up the queue.
const LOCK_STALE_MS = 30000;

// Locks this process already holds, with the ticket each was taken under: a locked
// section may call another one (`updateState` → `saveState`) and must not deadlock
// against itself.
const heldLocks = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Three answers about a foreign entry, and every other outcome is an error worth
// failing on. `GONE` — it left the queue between the listing and the look, so it
// blocks nobody and there is nothing to unlink. `HELD` — someone is using it.
// `ABANDONED` — its owner is provably gone, or nothing can be learned from it and
// it is old enough to be debris.
const LOCK_ENTRY_GONE = "gone";
const LOCK_ENTRY_HELD = "held";
const LOCK_ENTRY_ABANDONED = "abandoned";

// Only the entry having disappeared is an answer. Every other stat failure —
// EACCES, EIO, ELOOP — says nothing about the owner, and guessing there is how a
// live holder's ticket gets unlinked: swallowing the error left the age comparison
// with NaN, which reads as infinitely old.
function statLockEntry(entryPath) {
  try {
    return fs.statSync(entryPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// Only the entry having disappeared is an answer here too. A read that fails for
// any other reason (EACCES, EIO, EISDIR) says nothing about the owner, so it fails
// the acquisition rather than letting the entry be aged out.
//
// Content that reads but does not parse is different: entries are published by
// rename, so a live holder's entry is never half-written — junk can only be debris,
// and debris is judged by its age.
function readLockEntryOwner(entryPath) {
  let contents;
  try {
    contents = fs.readFileSync(entryPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { present: false, owner: null };
    }
    throw error;
  }

  try {
    return { present: true, owner: JSON.parse(contents) };
  } catch {
    return { present: true, owner: null };
  }
}

// A live owner is never evicted, whatever the clock says: from out here a slow
// process and a stuck one look identical, and evicting either puts two writers in
// the critical section. A dead one releases its place at once; an entry whose
// content is junk is debris after a short grace; one that carries no usable PID to
// check after a long one. (A PID that exists but belongs to another user reads
// as alive, which is the safe answer.) A stuck live owner is the operator's call —
// the timeout error names it.
function judgeLockEntry(entryPath) {
  const { present, owner } = readLockEntryOwner(entryPath);
  if (!present) {
    return LOCK_ENTRY_GONE;
  }

  if (owner) {
    const alive = isPidAlive(owner.pid);
    if (alive === true) {
      return LOCK_ENTRY_HELD;
    }
    if (alive === false) {
      return LOCK_ENTRY_ABANDONED;
    }
  }

  // Age is the only signal left, and it has to be a real one — a timestamp we
  // could not read must never decide that somebody else's entry is stale.
  const stats = statLockEntry(entryPath);
  if (!stats) {
    return LOCK_ENTRY_GONE;
  }
  const startedAt = owner ? Date.parse(owner.startedAt ?? "") : Number.NaN;
  const since = Number.isFinite(startedAt) ? startedAt : stats.mtimeMs;
  if (!Number.isFinite(since)) {
    throw new Error(`Cannot judge the Codex state lock entry ${entryPath}: it has no usable timestamp.`);
  }
  // An entry that says nothing about its owner gets the short grace; one that
  // named a PID nothing can check gets the long one.
  const grace = owner ? LOCK_STALE_MS : LOCK_ORPHAN_MS;
  return Date.now() - since > grace ? LOCK_ENTRY_ABANDONED : LOCK_ENTRY_HELD;
}

// A queue that cannot be read is not an empty queue: answering a listing failure
// with "nobody is ahead of me" would put two processes in the critical section.
// Every error propagates and fails the acquisition. The one exception is a missing
// directory on the numbering read: something removed the whole directory — and our
// own choosing file with it — from underneath us, so it is recreated and read once
// more rather than failing a command over someone else's `rm -rf`.
function readLockEntries(lockDir, { createMissing = false } = {}) {
  const choosing = [];
  const tickets = [];
  let names;
  try {
    names = fs.readdirSync(lockDir);
  } catch (error) {
    if (error.code !== "ENOENT" || !createMissing) {
      throw error;
    }
    fs.mkdirSync(lockDir, { recursive: true });
    names = fs.readdirSync(lockDir);
  }

  for (const name of names) {
    if (name.startsWith(LOCK_CHOOSING_PREFIX)) {
      const token = name.slice(LOCK_CHOOSING_PREFIX.length);
      if (token) {
        choosing.push({ name, token });
      }
      continue;
    }
    if (!name.endsWith(LOCK_TICKET_SUFFIX)) {
      continue;
    }
    const [rawNumber, token] = name.slice(0, -LOCK_TICKET_SUFFIX.length).split(".");
    const number = Number.parseInt(rawNumber, 10);
    if (Number.isInteger(number) && token) {
      tickets.push({ name, number, token });
    }
  }
  return { choosing, tickets };
}

// The destination name is unique to this acquisition, so the rename creates it and
// can never replace anyone else's entry; the staging name is unique too, and the
// rename is what makes the entry appear complete or not at all.
function writeLockEntry(lockDir, name, token, contents) {
  const staged = path.join(lockDir, `${token}.tmp`);
  fs.writeFileSync(staged, contents, "utf8");
  fs.renameSync(staged, path.join(lockDir, name));
}

function unlinkLockEntry(lockDir, name) {
  try {
    fs.unlinkSync(path.join(lockDir, name));
  } catch {
    // Already gone: someone else judged the same entry abandoned, or its owner
    // released it. Either way the name is retired for good — tokens are one-off.
  }
}

// Numbers can tie (two acquirers reading the ticket list at the same moment), so
// the token settles the order. Both parts are fixed at acquisition, so every
// process derives the same queue from the same directory listing.
function ticketIsBefore(left, right) {
  return left.number === right.number ? left.token < right.token : left.number < right.number;
}

function lockTimeoutError(lockDir, blockers, waitMs) {
  // The remembered blockers are from the last scan, and some may have been cleared
  // since — including by this waiter. Name one that is still there, or say plainly
  // that there is nothing left to name.
  let visible = blockers;
  try {
    const names = new Set(fs.readdirSync(lockDir));
    visible = blockers.filter((entry) => names.has(entry.name));
  } catch {
    // Re-listing failed (quite possibly the reason we are here): fall back to what
    // the last scan saw.
  }
  const lowest =
    visible
      .filter((entry) => entry.number !== undefined)
      .sort((left, right) => (ticketIsBefore(left, right) ? -1 : 1))[0] ?? visible[0];
  if (!lowest) {
    return new Error(
      `Timed out after ${waitMs} ms waiting for the Codex state lock (${lockDir}); no blocker visible now.`
    );
  }
  // The blocker may be a ticket or a client still choosing its number.
  const entryPath = path.join(lockDir, lowest.name);
  const pid = readJsonOrNull(entryPath)?.pid ?? "unknown";
  return new Error(
    `Timed out after ${waitMs} ms waiting for the Codex state lock. It is held by pid ${pid} (entry ${entryPath}). ` +
      `Stop that process if it is stuck; if pid ${pid} is not a Codex process (pid reuse), remove that entry file.`
  );
}

// The bakery's doorway: announce the choice, take a number one higher than any on
// display, then stop announcing. A later acquirer is therefore always visible as
// `choosing` to anyone still deciding, which is what stops it slipping in with a
// lower number behind a holder's back.
function acquireTicket(lockDir, waitMs) {
  fs.mkdirSync(lockDir, { recursive: true });
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const owner = `${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`;
  const choosingName = `${LOCK_CHOOSING_PREFIX}${token}`;

  writeLockEntry(lockDir, choosingName, token, owner);
  let ticket;
  try {
    const highest = readLockEntries(lockDir, { createMissing: true }).tickets.reduce(
      (max, entry) => Math.max(max, entry.number),
      0
    );
    ticket = { number: highest + 1, token, name: `${highest + 1}.${token}${LOCK_TICKET_SUFFIX}` };
    writeLockEntry(lockDir, ticket.name, token, owner);
  } finally {
    // The choosing file must go before the wait, not after it: two acquirers that
    // waited for each other's choosing files would deadlock.
    unlinkLockEntry(lockDir, choosingName);
  }

  try {
    waitForTurn(lockDir, ticket, waitMs);
  } catch (error) {
    // We are not holding the lock, so our ticket must leave the queue — this
    // process is alive, so nothing would ever judge it abandoned and everyone
    // behind it would wait on an acquisition that was given up. Only our own
    // entries are touched, whatever went wrong.
    unlinkLockEntry(lockDir, ticket.name);
    throw error;
  }
  return ticket;
}

function waitForTurn(lockDir, ticket, waitMs) {
  const deadline = Date.now() + waitMs;
  let blockers = [];
  let scanned = false;
  for (;;) {
    // Checked before every scan but the first, so no path can skip the bound: an
    // entry judged abandoned that cannot actually be unlinked (a permission problem
    // on a foreign entry) would otherwise be re-judged forever. The first scan
    // always happens, so a lock nobody else wants is taken whatever the budget was.
    if (scanned && Date.now() >= deadline) {
      throw lockTimeoutError(lockDir, blockers, waitMs);
    }
    scanned = true;

    const { choosing, tickets } = readLockEntries(lockDir);
    blockers = [
      // Everyone still choosing may yet take a number below ours.
      ...choosing.filter((entry) => entry.token !== ticket.token),
      ...tickets.filter((entry) => entry.token !== ticket.token && ticketIsBefore(entry, ticket))
    ];
    if (blockers.length === 0) {
      return;
    }

    // Judge every blocker before touching any of them. Done in one pass, a verdict
    // that throws halfway through would leave the entries it had already evicted
    // gone — breaking the one promise a failed acquisition makes, that it removed
    // nothing but its own files.
    const verdicts = blockers.map((blocker) => ({
      blocker,
      verdict: judgeLockEntry(path.join(lockDir, blocker.name))
    }));

    let evicted = false;
    for (const { blocker, verdict } of verdicts) {
      if (verdict === LOCK_ENTRY_ABANDONED) {
        unlinkLockEntry(lockDir, blocker.name);
        evicted = true;
      }
    }
    // Only actually removing something earns an immediate re-scan. A queue that
    // merely keeps changing under us — entries appearing and vanishing — must not
    // turn the wait into a spin.
    if (!evicted) {
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

  const ticket = acquireTicket(lockDir, options.waitMs ?? LOCK_WAIT_MS);
  heldLocks.set(lockDir, { depth: 1, ticket });
  try {
    return fn();
  } finally {
    heldLocks.delete(lockDir);
    // Leaving the queue is one unlink of one name only this acquisition ever had.
    unlinkLockEntry(lockDir, ticket.name);
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
