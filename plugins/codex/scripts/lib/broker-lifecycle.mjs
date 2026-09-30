import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { getProcessIdentity, isPidAlive, processCommandLine, terminateProcessTree, terminateRecordedProcess } from "./process.mjs";
import { resolveStateDir, retryOnWindows, STATE_LOCK_TIMEOUT_CODE, withStateLock } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

const PROBE_ATTEMPT_MS = 500;

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000, options = {}) {
  const connectImpl = options.connectImpl ?? ((socketPath) => net.createConnection({ path: socketPath }));
  const target = parseBrokerEndpoint(endpoint);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const attemptMs = Math.max(1, Math.min(PROBE_ATTEMPT_MS, timeoutMs - (Date.now() - start)));
    const ready = await new Promise((resolve) => {
      const socket = connectImpl(target.path);
      let connected = false;
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      };
      // A socket stuck in `connecting` fires neither connect nor error (#773).
      // A socket that already connected but closes slowly is still a live broker.
      const timer = setTimeout(() => {
        socket.destroy();
        finish(connected);
      }, attemptMs);
      socket.on("connect", () => {
        connected = true;
        socket.end();
      });
      // Report ready only once the probe connection is fully closed. A probe the
      // broker still sees as open is a phantom client: it holds off the idle
      // timer and makes the broker refuse a shutdown.
      socket.on("close", () => finish(connected));
      socket.on("error", () => finish(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const SHUTDOWN_REQUEST_ID = 1;
// A broker that has not answered by now is not going to: the handshake is one
// round trip to a local socket. Without this bound a peer that connects and
// stays silent blocks the SessionEnd hook forever.
const SHUTDOWN_HANDSHAKE_MS = 5000;

// Three answers, not two:
//   `false` — the broker said it is idle, or it is gone (connection error, or the
//             socket closed without answering): the caller must clean up after it.
//   `true`  — the broker refused because another client is still using it.
//   `null`  — nothing usable came back before the deadline, or the reply was not
//             parsable JSONL. The caller cannot prove the broker is idle, so it
//             must leave it alone.
// The reply is framed by newline and matched by request id: a socket is a byte
// stream, and parsing whatever a single `data` event happened to carry turned a
// split `{"busy":true}` into "not busy" — a broker destroyed under a live turn.
export async function sendBrokerShutdown(endpoint, { timeoutMs = SHUTDOWN_HANDSHAKE_MS } = {}) {
  return await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    let buffer = "";
    const finish = (busy) => {
      clearTimeout(deadline);
      socket.destroy();
      resolve({ busy });
    };
    const deadline = setTimeout(() => finish(null), timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: SHUTDOWN_REQUEST_ID, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(null);
          return;
        }
        if (message.id !== SHUTDOWN_REQUEST_ID) {
          continue;
        }
        finish(message.result?.busy === true);
        return;
      }
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

export function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

function describeBrokerRecordProblem(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return "not an object";
  }
  if (typeof record.endpoint !== "string") {
    return "endpoint is not a string";
  }
  try {
    parseBrokerEndpoint(record.endpoint);
  } catch (error) {
    return error.message.replace(/\.$/, "");
  }
  if (record.pid != null && !(Number.isInteger(record.pid) && record.pid > 0)) {
    return "pid is not a positive integer";
  }
  if (record.pidIdentity != null && typeof record.pidIdentity !== "string") {
    return "pidIdentity is not a string";
  }
  // Legacy records carry no state and count as ready.
  if (record.state != null && !BROKER_STATES.includes(record.state)) {
    return "state is not starting, replacing or ready";
  }
  for (const key of ["startedAt", "replacingAt"]) {
    if (record[key] != null && !Number.isFinite(record[key])) {
      return `${key} is not a number`;
    }
  }
  for (const key of ["pidFile", "logFile", "sessionDir"]) {
    if (record[key] != null && !(typeof record[key] === "string" && path.isAbsolute(record[key]))) {
      return `${key} is not an absolute path`;
    }
  }
  return null;
}

// starting: spawned (or about to be) by a start in progress; replacing: reserved
// by a stale caller or a failed start that is tearing it down; ready: the start finished.
const BROKER_STATES = ["starting", "replacing", "ready"];

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  let record;
  try {
    record = JSON.parse(retryOnWindows(() => fs.readFileSync(stateFile, "utf8"), ["EPERM", "EBUSY", "EACCES"]));
  } catch {
    return null;
  }
  const problem = describeBrokerRecordProblem(record);
  if (problem) {
    process.stderr.write(`[codex] Ignoring malformed broker.json at ${stateFile}: ${problem}.\n`);
    return null;
  }
  return record;
}

export function saveBrokerSession(cwd, session, { renameImpl = (from, to) => fs.renameSync(from, to), platform = process.platform } = {}) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  // Tmp + rename: a reader sees the old record or the new one, never a truncated
  // file that reads as "no broker" (same pattern as state.mjs).
  const stateFile = resolveBrokerStateFile(cwd);
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  retryOnWindows(() => renameImpl(tempFile, stateFile), ["EPERM", "EBUSY", "EACCES"], { platform });
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  try {
    fs.unlinkSync(stateFile);
  } catch (error) {
    // A concurrently self-cleaning broker (`clearOwnSessionRecord`) can already
    // have removed this same file: an `existsSync` pre-check does not close that
    // race, it only narrows it.
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

// The one conditional write: re-load the record, test it and save `next` (or
// clear it, `next === null`; a function derives it from the current record)
// inside a single state-lock section, so a record written by another start or
// replacer after the caller decided is left alone.
// `loadBrokerSessionImpl` and `saveImpl` are test seams.
function writeBrokerSessionIf(cwd, matches, next, { waitMs = undefined, loadBrokerSessionImpl = loadBrokerSession, saveImpl = saveBrokerSession } = {}) {
  return withStateLock(
    cwd,
    () => {
      const current = loadBrokerSessionImpl(cwd);
      if (!matches(current)) {
        return false;
      }
      const record = typeof next === "function" ? next(current) : next;
      if (record === null) {
        clearBrokerSession(cwd);
      } else {
        saveImpl(cwd, record);
      }
      return true;
    },
    { waitMs }
  );
}

export function clearBrokerSessionIfEndpoint(cwd, endpoint, options = {}) {
  return writeBrokerSessionIf(cwd, (record) => record?.endpoint === endpoint, null, options);
}

// A bound broker writes its own pid into its record (state and every other
// field untouched), so a live broker that answers is never behind a pid-less
// record. It probes no identity (a PowerShell run on win32 would block its event
// loop while its starter waits for the endpoint): the starter's probe or the next
// caller's adoption records that; an identity kept for another pid is dropped.
export function registerBrokerProcess(cwd, endpoint, pid, options = {}) {
  return writeBrokerSessionIf(
    cwd,
    (record) => record?.endpoint === endpoint,
    (record) => ({ ...record, pid, pidIdentity: record.pid === pid ? record.pidIdentity : null }),
    options
  );
}

// The claim a stale decision was made on: any change (a pid or identity saved, a
// promotion, a reservation, another endpoint) invalidates the decision.
function sameClaim(record, claim) {
  return (
    Boolean(record) &&
    record.endpoint === claim.endpoint &&
    record.pid === claim.pid &&
    record.pidIdentity === claim.pidIdentity &&
    record.state === claim.state &&
    record.replacer === claim.replacer
  );
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

const STALE_BROKER_RETRY_MS = 2000;

// The verified teardown of a failed start: one kill-script run on win32
// (SessionEnd's per-job step), one identity probe plus a signal on posix.
const FAILED_START_KILL_MS = 4000;
// How long a failed start waits for its killed child to exit before keeping it.
const FAILED_START_EXIT_WAIT_MS = 2000;
// A start that finds another start's record inside the lock takes the stale/wait
// path for it again; bounded, so records that keep appearing cannot loop forever.
const CLAIM_ATTEMPTS = 3;
const READY_SAVE_RETRY_MS = 250;
// How long a starting record without a pid, or a replacing record, is presumed to
// belong to a start or a teardown still in progress. Past it the claim is settled:
// a crashed spawner or replacer blocks the broker for at most this long.
export const STARTING_GRACE_MS = 60_000;

function withinGrace(at, now = Date.now) {
  return Number.isFinite(at) && now() - at <= STARTING_GRACE_MS;
}

export async function ensureBrokerSession(cwd, options = {}, attempt = 1) {
  try {
    return await ensureBrokerSessionLocked(cwd, options, attempt);
  } catch (error) {
    if (error?.code !== STATE_LOCK_TIMEOUT_CODE) {
      throw error;
    }
    process.stderr.write(`[codex] broker start gave up: ${error.message}\n`);
    return null;
  }
}

async function ensureBrokerSessionLocked(cwd, options, attempt) {
  const killProcess = options.killProcess ?? terminateProcessTree;
  const isAliveImpl = options.isAliveImpl ?? isPidAlive;
  const ownsProcessImpl = options.ownsProcessImpl ?? ownsBrokerProcess;
  const getProcessIdentityImpl = options.getProcessIdentityImpl ?? getProcessIdentity;
  const platform = options.platform ?? process.platform;
  const now = options.nowImpl ?? Date.now;
  const retryClaim = async (why) => {
    if (attempt >= CLAIM_ATTEMPTS) {
      process.stderr.write(`[codex] broker start gave up: ${why} (${attempt} attempts).\n`);
      return null;
    }
    return await ensureBrokerSession(cwd, options, attempt + 1);
  };

  // A broker whose endpoint answers is used; a starting (or, past its grace, a
  // replacing) one is first promoted to ready with its identity, so no live
  // broker stays starting for life. A pid-bearing record without an identity
  // is bound to the answering instance: the pid is probed before the readiness
  // check (`pre`) and again after it, outside the lock (a PowerShell run each
  // on win32), and the record is promoted only when both probes are equal and
  // non-null, i.e. the process at that pid lived across the answering window (a
  // replacement broker would have registered another pid and fails the claim).
  // Otherwise the record is kept as is and this request takes the direct
  // transport. The promotion itself is claim-guarded under the lock.
  const probeBefore = (record) =>
    (record?.state === "starting" || record?.state === "replacing") && record.pid != null && !record.pidIdentity
      ? { pid: record.pid, identity: getProcessIdentityImpl(record.pid) }
      : null;
  const adoptOrRetry = async (record, pre) => {
    if (record.state !== "starting" && record.state !== "replacing") {
      return record;
    }
    const current = loadBrokerSession(cwd);
    if (!current || current.endpoint !== record.endpoint) {
      return await retryClaim("the broker record kept changing");
    }
    if (current.state !== "starting" && current.state !== "replacing") {
      return current;
    }
    if (current.state === "replacing" && withinGrace(current.replacingAt, now)) {
      process.stderr.write(`[codex] broker ${current.endpoint} is being replaced; this request uses the direct transport.\n`);
      return null;
    }
    if (current.pid == null) {
      if (platform === "win32") {
        process.stderr.write(`[codex] broker pid none answers but has no identity; its record is kept and this request uses the direct transport.\n`);
        return null;
      }
      return current;
    }
    let identity = current.pidIdentity ?? null;
    if (!identity) {
      if (pre?.pid !== current.pid) {
        return await retryClaim("the broker record kept changing");
      }
      const post = getProcessIdentityImpl(current.pid);
      if (!pre.identity || pre.identity !== post) {
        process.stderr.write(`[codex] broker pid ${current.pid} answers but its identity could not be confirmed across the probe (${pre.identity ?? "none"} then ${post ?? "none"}); its record is kept and this request uses the direct transport.\n`);
        return null;
      }
      identity = post;
    }
    const { replacer: _replacer, replacingAt: _replacingAt, ...rest } = current;
    const promoted = { ...rest, state: "ready", pidIdentity: identity };
    return writeBrokerSessionIf(cwd, (latest) => sameClaim(latest, current), promoted) ? promoted : await retryClaim("the broker record kept changing");
  };

  // The one teardown of a recorded broker, for the stale path and a failed
  // start alike: reserve `claim` under the lock (full-claim compare, then
  // `replacing` with a fresh nonce), re-check the reservation under the lock
  // right before the kill (still ours, still inside its grace: past it the claim
  // may have been adopted), kill outside the lock, then clear — or, when the
  // kill settled nothing, write `restore` — only while the record is still
  // exactly the reservation. `terminate` resolves to true when the broker must be
  // kept. Outcomes: changed (not reserved), fenced (no kill), kept, cleared.
  const reserveAndTerminate = async (claim, terminate, restore) => {
    const reserved = { ...claim, state: "replacing", replacer: randomUUID(), replacingAt: now() };
    if (!writeBrokerSessionIf(cwd, (current) => sameClaim(current, claim), reserved)) {
      return "changed";
    }
    const stillOurs = withStateLock(cwd, () => {
      const current = loadBrokerSession(cwd);
      return sameClaim(current, reserved) && withinGrace(current.replacingAt, now);
    });
    if (!stillOurs) {
      process.stderr.write(`[codex] broker ${claim.endpoint} teardown reservation expired or changed before the kill; nothing is killed and this request uses the direct transport.\n`);
      return "fenced";
    }
    const kept = await terminate();
    writeBrokerSessionIf(cwd, (current) => sameClaim(current, reserved), kept ? restore : null);
    return kept ? "kept" : "cleared";
  };

  const existing = loadBrokerSession(cwd);
  const pre = probeBefore(existing);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return await adoptOrRetry(existing, pre);
  }

  if (existing) {
    const pid = Number.isFinite(existing.pid) ? existing.pid : null;
    const replacing = existing.state === "replacing";
    const liveOwned = pid !== null && isAliveImpl(pid) === true && ownsProcessImpl(pid, existing.endpoint ?? null, options.timeoutMs);
    // A live broker that missed the 150 ms probe is not a dead one (#768), and a
    // starting record belongs to a start in progress: give either the full window
    // before deciding it is wedged. A replacing one inside its grace is being
    // torn down: no wait; past it, it is probed like any other before settling.
    if ((!replacing || !withinGrace(existing.replacingAt, now)) && (liveOwned || existing.state === "starting" || replacing)) {
      const ready = await waitForBrokerEndpoint(existing.endpoint, options.retryTimeoutMs ?? STALE_BROKER_RETRY_MS).catch(() => false);
      if (ready) {
        return await adoptOrRetry(loadBrokerSession(cwd) ?? existing, pre);
      }
    }
    // No pid to verify (a start still spawning, or one whose pid save failed) or
    // a teardown in progress: kept until the grace period says it is abandoned.
    // Past the grace such a record is settled only because its endpoint did not
    // answer: a bound broker registers its own pid, so an answering one is adopted.
    const graceFrom = replacing ? existing.replacingAt : existing.state === "starting" && pid === null ? existing.startedAt : undefined;
    if (withinGrace(graceFrom, now)) {
      process.stderr.write(`[codex] broker record ${existing.endpoint} is ${existing.state} and within its grace period; it is kept and this request uses the direct transport.\n`);
      return null;
    }
    // Reserved on the current claim — not the snapshot: another start may have
    // saved its pid/identity, promoted it or replaced it while this call waited.
    // A reserved record refuses the starter's later saves, so nothing can promote
    // the broker this call is about to kill.
    const outcome = await reserveAndTerminate(
      existing,
      () => {
        const teardown = teardownBrokerSession({
          endpoint: existing.endpoint ?? null,
          pidFile: existing.pidFile ?? null,
          logFile: existing.logFile ?? null,
          sessionDir: existing.sessionDir ?? null,
          // Only a live broker that is provably ours gets a signal (#762); a dead or
          // recycled pid is left alone (#749) — the files are stale either way.
          pid: liveOwned ? pid : null,
          pidIdentity: existing.pidIdentity ?? null,
          killProcess: liveOwned ? killProcess : null,
          // Re-checked at kill time: the pid may have been recycled during the retry.
          ownsProcess: ownsProcessImpl,
          terminateRecordedProcessImpl: options.terminateRecordedProcessImpl ?? terminateRecordedProcess,
          // An unsettled kill keeps the record: a live broker with no record could
          // never be torn down verifiably later.
          keepOnUnknown: true,
          keepOnUnknownAnyPlatform: true
        });
        if (teardown.kept) {
          process.stderr.write(`[codex] stale broker pid ${pid} could not be verified stopped (${teardown.reason}); its record is kept and this request uses the direct transport.\n`);
        }
        return teardown.kept;
      },
      // Back to the claim it was, so SessionEnd or the next start retries it.
      existing
    );
    if (outcome === "changed" && loadBrokerSession(cwd)) {
      return await retryClaim("the broker record kept changing");
    }
    if (outcome === "fenced" || outcome === "kept") {
      return null;
    }
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  // The start window is closed by order and lock: a "starting" record exists
  // before the broker does, and the spawn plus the pid save happen under the
  // state lock a win32 cancel holds from its broker read through its kill. A
  // record without a win32 identity refuses kills (fail closed) until the
  // identity is saved below; `state: "starting"` marks it until the ready save. The claim is made inside the lock: a record found
  // there (another start's, starting or ready) means this call spawns nothing.
  const base = { endpoint, pidFile, logFile, sessionDir };
  const starting = { ...base, state: "starting", startedAt: now() };
  let pidSaveFailed = false;
  // The last record this start wrote: the claim its failed-start teardown reserves.
  let claimed = { ...starting, pid: null, pidIdentity: null };
  const child = withStateLock(cwd, () => {
    if (loadBrokerSession(cwd)) {
      return null;
    }
    saveBrokerSession(cwd, { ...starting, pid: null, pidIdentity: null });
    let spawned;
    try {
      spawned = (options.spawnBrokerProcessImpl ?? spawnBrokerProcess)({ scriptPath, cwd, endpoint, pidFile, logFile, env: options.env ?? process.env });
    } catch (error) {
      clearBrokerSessionIfEndpoint(cwd, endpoint);
      throw error;
    }
    if (Number.isInteger(spawned.pid) && spawned.pid > 0) {
      try {
        (options.saveBrokerSessionImpl ?? saveBrokerSession)(cwd, { ...starting, pid: spawned.pid, pidIdentity: null });
        claimed = { ...starting, pid: spawned.pid, pidIdentity: null };
      } catch (error) {
        // The child is running behind a pid-null record: it is torn down below.
        process.stderr.write(`[codex] broker pid ${spawned.pid} could not be recorded: ${error.message}\n`);
        pidSaveFailed = true;
      }
    }
    return spawned;
  });
  if (!child) {
    try {
      fs.rmdirSync(sessionDir);
    } catch {
      // Ignore: nothing was spawned into it.
    }
    return await retryClaim("another start kept claiming the broker record");
  }

  // Every later save is guarded by the claim: the record on disk must still be
  // this start's (its endpoint, unique to its session dir, and its pid) and not
  // reserved by a teardown. One that was replaced, reserved or
  // cleared meanwhile is left alone.
  const saveImpl = options.saveBrokerSessionImpl ?? saveBrokerSession;
  const saveClaimed = (record, what) => {
    try {
      const saved = writeBrokerSessionIf(
        cwd,
        (current) => current?.endpoint === endpoint && current.pid === (child.pid ?? null) && current.state !== "replacing",
        record,
        { saveImpl }
      );
      if (!saved) {
        process.stderr.write(`[codex] broker ${what} not saved: the record no longer belongs to broker pid ${child.pid} or is reserved for replacement.\n`);
      }
      return saved;
    } catch (error) {
      if (error?.code !== STATE_LOCK_TIMEOUT_CODE) {
        throw error;
      }
      process.stderr.write(`[codex] broker ${what} not saved: ${error.message}\n`);
      return false;
    }
  };

  // Recorded for later teardowns, which only trust a stored pid by identity.
  let pidIdentity = getProcessIdentityImpl(child.pid ?? Number.NaN);
  if (!pidSaveFailed && pidIdentity && Number.isInteger(child.pid) && child.pid > 0) {
    const record = { ...starting, pid: child.pid, pidIdentity };
    if (saveClaimed(record, "identity")) {
      claimed = record;
    }
  }

  const abandonStart = async () => {
    // A child that already exited is not signalled at all: its pid may belong to
    // someone else by now. A live one is killed through the verified kill with
    // the identity captured above (win32: the pinned tree kill; posix: its group,
    // proven ours by the unexited child handle when there is no identity) — a
    // broker stuck in connect has no cleanup handlers yet and would leave its
    // app-server child behind. Only its exit settles it: a refused kill or a
    // delivered signal the child ignores does not.
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) {
      teardownBrokerSession({ ...base });
      clearBrokerSessionIfEndpoint(cwd, endpoint);
      return null;
    }
    // Reserved first, on the last record this start wrote: a record another
    // caller promoted, adopted, reserved or replaced meanwhile is not killed.
    const outcome = await reserveAndTerminate(
      claimed,
      async () => {
        try {
          (options.terminateRecordedProcessImpl ?? terminateRecordedProcess)(child.pid, {
            identity: pidIdentity,
            commandLineMatch: () => !exited(),
            timeoutMs: FAILED_START_KILL_MS,
            terminateImpl: (target) => killProcess(target)
          });
        } catch {
          // Judged by the exit below.
        }
        const waitUntil = Date.now() + FAILED_START_EXIT_WAIT_MS;
        while (!exited() && Date.now() < waitUntil) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (exited()) {
          teardownBrokerSession({ ...base });
          return false;
        }
        pidIdentity ??= getProcessIdentityImpl(child.pid);
        return true;
      },
      // Kept, files and record, and the record names the live child — its pid,
      // and an identity when one can still be read — so SessionEnd or the next
      // start can kill it verifiably; a pid-null record would read as a start
      // still spawning.
      () => ({ ...starting, pid: child.pid, pidIdentity })
    );
    if (outcome === "changed") {
      process.stderr.write(`[codex] broker pid ${child.pid} failed to start, but its record changed meanwhile (adopted, reserved or replaced); it is not killed.\n`);
    } else if (outcome === "kept") {
      process.stderr.write(`[codex] broker pid ${child.pid} was not stopped after the failed start; its record and files are kept.\n`);
    }
    return null;
  };

  if (pidSaveFailed) {
    return await abandonStart();
  }

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    return await abandonStart();
  }

  // win32 excludes the broker from worker kills only by its identity: without
  // one it stays starting (its pid saved) and a later call promotes it once the
  // identity can be read (the next caller's adopt probe).
  if (platform === "win32" && !pidIdentity) {
    process.stderr.write(`[codex] broker pid ${child.pid} has no identity yet; it stays starting and this request uses the direct transport.\n`);
    return null;
  }

  const session = {
    ...base,
    state: "ready",
    pid: child.pid ?? null,
    pidIdentity
  };
  // Never return a session whose on-disk record does not name it: one retry after
  // a short wait, then the verified failed-start teardown.
  if (!saveClaimed(session, "ready record")) {
    await new Promise((resolve) => setTimeout(resolve, READY_SAVE_RETRY_MS));
    if (!saveClaimed(session, "ready record")) {
      return await abandonStart();
    }
  }
  return session;
}

// A recorded PID is only worth signalling while it still belongs to this
// session's broker: an idle self-terminate (or any abnormal exit) can leave the
// record behind long enough for the OS to hand the PID — and with it the process
// group `terminateProcessTree` kills — to something unrelated. This command-line
// check is what a record without an identity falls back to. It answers `true` on
// Windows, which has no cheap probe, but teardown itself refuses to signal there
// without an identity (`identity-unavailable`); with one, the kill pins the
// process and verifies its start time first (`terminateRecordedProcess`).
export function ownsBrokerProcess(pid, endpoint, timeoutMs, commandLine = processCommandLine(pid, { timeoutMs })) {
  if (process.platform === "win32") {
    return true;
  }
  if (!commandLine || !commandLine.includes("app-server-broker.mjs")) {
    return false;
  }
  return !endpoint || commandLine.includes(endpoint);
}

// Reports whether the recorded process was actually signalled, and why not: a
// PID whose identity (or, for a record without one, command line) no longer
// matches this broker is deliberately left alone (#743), and a caller that
// wonders why a broker outlived its teardown needs to know which it was.
// `reason` is one of: `no-pid` (nothing to signal), `identity-match` /
// `command-line-match` (proven ours, signal attempted), `identity-mismatch`,
// `identity-unavailable` (refused), `process-missing` (Windows: provably gone
// before anything was signalled), `kill-failed` (the probe or kill threw, or a
// Windows kill left survivors), `starting` (`state: "starting"`, pid or not: its
// broker is being started) and `replacing` (a stale caller or a failed start is tearing it down):
// both kept with their files on every platform.
export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  pidIdentity = null,
  killProcess = null,
  timeoutMs = undefined,
  ownsProcess = ownsBrokerProcess,
  platform = process.platform,
  keepOnUnknown = false,
  keepOnUnknownAnyPlatform = false,
  state = undefined,
  terminateRecordedProcessImpl = terminateRecordedProcess
}) {
  if (state === "starting" || state === "replacing") {
    return { signalled: false, reason: state, kept: true };
  }
  let signalled = false;
  let reason = "no-pid";
  let outcome = null;
  if (Number.isFinite(pid) && killProcess) {
    try {
      outcome = terminateRecordedProcessImpl(pid, {
        identity: pidIdentity,
        commandLineMatch: (commandLine) => ownsProcess(pid, endpoint, timeoutMs, commandLine),
        timeoutMs,
        terminateImpl: (target) => killProcess(target)
      });
      signalled = outcome.attempted && outcome.delivered;
      reason = outcome.reason;
    } catch {
      // Ignore missing or already-exited broker processes.
      reason = "kill-failed";
    }
  }

  // An outcome that proves nothing about the broker — no probe, a kill that did
  // not verify, survivors — keeps every record when the caller asks (SessionEnd
  // on win32 by default, any platform with `keepOnUnknownAnyPlatform`), so the
  // next SessionEnd can try again. A missing or
  // foreign process is a settled answer and is cleaned up as before; a dead
  // root does not settle an unknown outcome.
  const unknown =
    (platform === "win32" || keepOnUnknownAnyPlatform) &&
    (["identity-unavailable", "kill-failed"].includes(reason) || outcome?.unverified === true || (outcome?.survivors?.length ?? 0) > 0);
  const kept = keepOnUnknown && !signalled && unknown;
  if (kept) {
    return { signalled, reason, kept };
  }

  // Best-effort: a self-cleaning broker or a locked file must not fail the hook.
  if (pidFile) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
      // upstream #633/#626 report EPERM here on Windows).
    }
  }

  if (logFile) {
    try {
      fs.unlinkSync(logFile);
    } catch {
      // Ignore — missing, already removed, or not removable (e.g. EPERM/ENOTDIR;
      // upstream #633/#626 report EPERM here on Windows).
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown
      // (this already swallowed ENOENT, and every other error, before this fix).
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }

  return { signalled, reason, kept: false };
}
