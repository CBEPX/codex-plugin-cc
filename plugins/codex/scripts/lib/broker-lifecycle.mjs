import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { getProcessIdentity, isPidAlive, processCommandLine, terminateProcessTree, terminateRecordedProcess } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

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

function resolveBrokerStateFile(cwd) {
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
  for (const key of ["pidFile", "logFile", "sessionDir"]) {
    if (record[key] != null && !(typeof record[key] === "string" && path.isAbsolute(record[key]))) {
      return `${key} is not an absolute path`;
    }
  }
  return null;
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(stateFile, "utf8"));
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

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
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

export async function ensureBrokerSession(cwd, options = {}) {
  const killProcess = options.killProcess ?? terminateProcessTree;
  const isAliveImpl = options.isAliveImpl ?? isPidAlive;
  const ownsProcessImpl = options.ownsProcessImpl ?? ownsBrokerProcess;
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    const pid = Number.isFinite(existing.pid) ? existing.pid : null;
    const liveOwned = pid !== null && isAliveImpl(pid) === true && ownsProcessImpl(pid, existing.endpoint ?? null, options.timeoutMs);
    // A live broker that missed the 150 ms probe is not a dead one (#768): give it the
    // full window before deciding it is wedged.
    if (liveOwned) {
      const ready = await waitForBrokerEndpoint(existing.endpoint, options.retryTimeoutMs ?? STALE_BROKER_RETRY_MS).catch(() => false);
      if (ready) {
        return existing;
      }
    }
    teardownBrokerSession({
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
      ownsProcess: ownsProcessImpl
    });
    // Compare before delete: a concurrent caller may already have replaced it.
    if (loadBrokerSession(cwd)?.endpoint === existing.endpoint) {
      clearBrokerSession(cwd);
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

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });
  // Recorded for later teardowns, which only trust a stored pid by identity.
  const pidIdentity = (options.getProcessIdentityImpl ?? getProcessIdentity)(child.pid ?? Number.NaN);

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    // A child that already exited is not signalled at all: its pid may belong to
    // someone else by now. A live, unreaped one is a detached group leader whose
    // pid/pgid cannot be reused while our handle has not seen it exit, so its
    // whole group is killed — a broker stuck in connect has no cleanup handlers
    // yet and would leave its app-server child behind. The handle is the fallback.
    if (child.exitCode === null && child.signalCode === null) {
      let delivered = false;
      try {
        delivered = killProcess(child.pid)?.delivered !== false;
      } catch {}
      if (!delivered) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }
    teardownBrokerSession({ endpoint, pidFile, logFile, sessionDir });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    pidIdentity
  };
  saveBrokerSession(cwd, session);
  return session;
}

// A recorded PID is only worth signalling while it still belongs to this
// session's broker: an idle self-terminate (or any abnormal exit) can leave the
// record behind long enough for the OS to hand the PID — and with it the process
// group `terminateProcessTree` kills — to something unrelated. This command-line
// check is what a record without an identity falls back to. It answers `true` on
// Windows, which has no cheap probe, but teardown itself refuses to signal there
// without an identity (`identity-unavailable`, CIM identity is v1.4.0).
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
// `command-line-match` (proven ours and signalled), `identity-mismatch`,
// `identity-unavailable` (refused), `kill-failed` (the probe or kill threw).
export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, pidIdentity = null, killProcess = null, timeoutMs = undefined, ownsProcess = ownsBrokerProcess }) {
  let signalled = false;
  let reason = "no-pid";
  if (Number.isFinite(pid) && killProcess) {
    try {
      const outcome = terminateRecordedProcess(pid, {
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

  return { signalled, reason };
}
