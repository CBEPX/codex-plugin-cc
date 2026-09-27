import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs,
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    // A command killed by its timeout (or a signal) has no exit status; reading
    // that as 0 would turn a hung probe into a success.
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// Command line of a running process, or null when it is gone (or the platform
// has no `ps`). Callers use it to prove a recorded PID is still the process they
// believe it is before signalling it — PIDs get recycled.
export function processCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: options.timeoutMs, shell: false });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

const ownIdentityCache = new Map();
// `lstart` is fixed-width in the C locale; the rest of the line is `comm`, an
// executable path that may contain spaces.
const DARWIN_PS_LINE = /^(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+)$/;

// Who a PID belongs to, beyond the number the OS recycles (#743): its start time
// (plus the executable on darwin, where `lstart` only has second resolution).
// Two reads for the same process always agree; a process that inherited the PID
// never does. `null` means "cannot tell" and must never authorise a kill.
export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null; // ponytail: CIM (CreationDate) identity lands in v1.4.0
  }
  if (pid === process.pid && ownIdentityCache.has(platform)) {
    return ownIdentityCache.get(platform);
  }
  let identity = null;
  if (platform === "linux") {
    try {
      const readFileSyncImpl = options.readFileSyncImpl ?? fs.readFileSync;
      const stat = String(readFileSyncImpl(`/proc/${pid}/stat`, "utf8"));
      // Field 22 (starttime) counted from the start; `comm` (field 2) may hold
      // spaces and parentheses, so count from the last ")": state is field 3.
      const starttime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      identity = starttime ? `linux:${starttime}` : null;
    } catch {
      identity = null;
    }
  } else {
    // spawnSync reads a timeout of 0 as "no timeout": a spent budget is no probe.
    const timeoutMs = options.timeoutMs ?? 10000;
    if (!(timeoutMs > 0)) {
      return null;
    }
    const runCommandImpl = options.runCommandImpl ?? runCommand;
    // Identity is recorded by one process and checked by another: pin the
    // locale and zone `lstart` is printed in, or they would never agree.
    const result = runCommandImpl("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
      timeoutMs,
      shell: false,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
    });
    const match = !result.error && result.status === 0 ? DARWIN_PS_LINE.exec(result.stdout.trim()) : null;
    identity = match ? `darwin:${match[1]}|${match[2].trim()}` : null;
  }
  if (pid === process.pid && identity) {
    ownIdentityCache.set(platform, identity);
  }
  return identity;
}

// What a background worker's command line looks like — the check a record
// without an identity (v1.2.x) falls back to. Job ids are generated
// `<prefix>-<base36>-<base36>`, so they need no escaping.
export function workerCommandLine(jobId) {
  return new RegExp(`task-worker.*--job-id ${jobId}(\\s|$)`);
}

// Signals a recorded PID only once it is proven to still be the recorded
// process: by identity when one was recorded, else (posix records from before
// identities) by its command line. Anything unprovable is left alone and the
// reason says why.
export function terminateRecordedProcess(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, reason: "no-pid" };
  }
  const platform = options.platform ?? process.platform;
  const identity = options.identity ?? null;
  let reason;
  if (identity) {
    const actual = getProcessIdentity(pid, options);
    if (!actual) {
      return { attempted: false, delivered: false, reason: "identity-unavailable" };
    }
    if (actual !== identity) {
      return { attempted: false, delivered: false, reason: "identity-mismatch" };
    }
    reason = "identity-match";
  } else {
    if (platform === "win32") {
      return { attempted: false, delivered: false, reason: "identity-unavailable" };
    }
    const commandLine = processCommandLine(pid, options);
    const match = options.commandLineMatch;
    const matched =
      Boolean(commandLine) &&
      (typeof match === "function" ? Boolean(match(commandLine)) : match instanceof RegExp ? match.test(commandLine) : false);
    if (!matched) {
      return { attempted: false, delivered: false, reason: "identity-mismatch" };
    }
    reason = "command-line-match";
  }
  // An injected terminator may report nothing; having been called is the attempt.
  const outcome = (options.terminateImpl ?? terminateProcessTree)(pid, options);
  return { ...(outcome && typeof outcome === "object" ? outcome : { attempted: true, delivered: true }), reason };
}

// True when the PID is running, false when it is provably gone (ESRCH), null
// when the question does not apply (no PID) — EPERM means it exists but belongs
// to someone else. Known limitation: a zombie reads as alive, and a recycled PID
// reads as the process that inherited it.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "ESRCH" ? false : true;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    // ESRCH here only means `pid` leads no process group (a foreground worker,
    // a child spawned without `detached`) — the process itself may be alive.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
