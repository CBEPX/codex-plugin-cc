import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Windows has no $SHELL to lean on: Git Bash (the usual one on CI) mangles
// `taskkill /PID` and other Windows-style arguments. So on win32 nothing runs
// through a shell — a bare name is resolved with where.exe, .exe/.com run directly, and
// .cmd/.bat shims run under cmd.exe with every argument escaped for it.
const LAUNCHABLE = /\.(com|exe|bat|cmd)$/i;
// In-box tools by absolute path: libuv searches the child's cwd before PATH, so a
// bare "where.exe" would run a same-named file planted in the reviewed repo.
export function systemExe(name, env = process.env) {
  return path.win32.join(env?.SystemRoot || env?.SYSTEMROOT || "C:\\Windows", "System32", name);
}
// cmd.exe metacharacters, escaped with ^ (cross-spawn's set).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// First PATH directory holding `<command><ext>` for a PATHEXT extension we can
// launch (.com/.exe/.bat/.cmd), or null. Done with fs rather than where.exe: no
// child process, no guessing the console code page of its output (a non-ASCII
// install path must survive), and never the current directory — a repo must not
// plant a codex.cmd, so relative PATH entries are skipped as well. An
// extensionless file (npm's bash shim next to codex.cmd) is never a hit.
// PATH as absolute directories only: relative entries (".", "tools") would be
// resolved against the cwd, i.e. the reviewed repo. Returns the env key that
// carried it (win32 env keys are case-insensitive; injected objects are not).
export function absolutePathEntries(env) {
  const key = Object.keys(env ?? {}).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const dirs = String(env?.[key] ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir && path.win32.isAbsolute(dir));
  return { key, dirs };
}

export function resolveExecutable(command, options = {}) {
  const env = options.env ?? process.env;
  const exists = options.existsSyncImpl ?? fs.existsSync;
  const extensions = String(env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => LAUNCHABLE.test(ext));
  const { dirs } = absolutePathEntries(env);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.win32.join(dir, command + ext);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// One argument for a cmd.exe line that a .cmd shim forwards with %*: CRT
// quoting for the final program, then every metacharacter caret-escaped twice —
// once for `cmd /c`, once for the shim's own parse of %*. Escaped quotes never
// open a quoted region, so `a&b` and `%PATH%` stay literal.
// A line break cannot be escaped at all (cmd.exe stops reading at it), so it is
// refused instead of silently dropping the rest of the arguments.
// ponytail: assumes the .cmd forwards %* (npm shims do); one that reads %1 itself sees carets.
// ponytail: `%VAR:a=b%` substitution still expands (cmd has no escape for it in
// command-line mode); every caller passes fixed literals, revisit if user text ever lands here.
export function quoteForCmd(arg) {
  if (/[\r\n]/.test(String(arg))) {
    throw new TypeError("cmd.exe cannot carry a line break in an argument");
  }
  const quoted = `"${String(arg)
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

export function buildLaunch(file, args, env = process.env) {
  if (!/\.(bat|cmd)$/i.test(file)) {
    return { file, args, env, windowsVerbatimArguments: false };
  }
  const { key, dirs } = absolutePathEntries(env);
  const line = [file.replace(CMD_META, "^$1"), ...args.map(quoteForCmd)].join(" ");
  return {
    file: env?.ComSpec || systemExe("cmd.exe", env),
    args: ["/d", "/s", "/v:off", "/c", `"${line}"`],
    // The shim itself runs a bare `node`, which cmd.exe would look up in the
    // cwd (the reviewed repo) before PATH; the flag turns that off and the
    // shim sees only the absolute PATH entries the resolver used.
    env: { ...env, [key]: dirs.join(";"), NoDefaultCurrentDirectoryInExePath: "1" },
    windowsVerbatimArguments: true
  };
}

// Shaped like spawnSync's own ENOENT so binaryAvailable() reads it as "not found".
export function notFound(command) {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT", errno: -4058, syscall: `spawn ${command}`, path: command });
}

export function runCommand(command, args = [], options = {}) {
  const windows = (options.platform ?? process.platform) === "win32";
  // win32: a path is used as is, a bare name goes through where.exe. Nothing
  // found is reported as ENOENT without spawning: libuv would otherwise search
  // the cwd (the reviewed repo) for a same-named .exe.
  const target = !windows || /[\\/]/.test(command) ? command : resolveExecutable(command, options);
  if (target === null) {
    return { command, args, status: null, signal: null, stdout: "", stderr: "", error: notFound(command) };
  }
  const launch = windows ? buildLaunch(target, args, options.env) : { file: command, args, env: options.env };
  const result = (options.spawnSyncImpl ?? spawnSync)(launch.file, launch.args, {
    cwd: options.cwd,
    env: launch.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    // spawnSync throws on a fractional timeout and reads 0 as "no timeout":
    // whatever budget arithmetic a caller did, a bound stays a bound.
    timeout: Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : undefined,
    shell: windows ? false : (options.shell ?? false),
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
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

// Command line of a running process, or null when it is gone, unreadable or
// empty (or the platform has no `ps`), and "<defunct>" for a zombie. Callers use it to prove a recorded PID is
// still the process they believe it is before signalling it — PIDs get recycled.
// It must be whole: `ps` cuts at $COLUMNS (procps, even when piped), and a cut
// line can lose the marker a caller matches on.
export function processCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }

  if (platform === "linux") {
    try {
      const readFileSyncImpl = options.readFileSyncImpl ?? fs.readFileSync;
      const raw = String(readFileSyncImpl(`/proc/${pid}/cmdline`, "utf8"));
      const line = raw.split("\0").filter(Boolean).join(" ").trim();
      if (line) {
        return line;
      }
      // A zombie's cmdline is empty too. Say so the way `ps` does — no companion
      // marker, so callers treat it as not theirs and never signal it. State is
      // field 3, right after the last ")" (`comm` may hold parentheses).
      const stat = String(readFileSyncImpl(`/proc/${pid}/stat`, "utf8"));
      const state = stat.charAt(stat.lastIndexOf(")") + 2);
      return state === "Z" || state === "X" ? "<defunct>" : null;
    } catch {
      return null;
    }
  }

  // A spent budget is no probe (spawnSync would read 0 as "no timeout").
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
    return null;
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    timeoutMs: options.timeoutMs,
    shell: false,
    env: { ...process.env, COLUMNS: "10000", LC_ALL: "C" }
  });
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
// without an identity (v1.2.x) falls back to. The id is matched literally.
export function workerCommandLine(jobId) {
  const escaped = String(jobId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`task-worker.*--job-id ${escaped}(\\s|$)`);
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
  // null when the pid is still provably the recorded process, else why not.
  const refusal = () => {
    if (identity) {
      const actual = getProcessIdentity(pid, options);
      return !actual ? "identity-unavailable" : actual !== identity ? "identity-mismatch" : null;
    }
    if (platform === "win32") {
      return "identity-unavailable";
    }
    const commandLine = processCommandLine(pid, options);
    const match = options.commandLineMatch;
    const matched =
      Boolean(commandLine) &&
      (typeof match === "function" ? Boolean(match(commandLine)) : match instanceof RegExp ? match.test(commandLine) : false);
    return matched ? null : "identity-mismatch";
  };
  const refused = refusal();
  if (refused) {
    return { attempted: false, delivered: false, reason: refused };
  }
  const reason = identity ? "identity-match" : "command-line-match";
  // An injected terminator may report nothing; having been called is the attempt.
  const outcome = (options.terminateImpl ?? terminateProcessTree)(pid, options);
  if (outcome?.groupGone) {
    // The pid leads no group (a foreground worker): signal it alone, but only
    // after proving again that it is still ours — it may have exited and been
    // recycled since the first check.
    const again = refusal();
    if (again) {
      return { attempted: true, delivered: false, method: "process", reason: again };
    }
    try {
      (options.killImpl ?? process.kill.bind(process))(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process", reason };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process", reason };
      }
      throw error;
    }
  }
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
    const result = runCommandImpl(systemExe("taskkill.exe", options.env), ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      shell: false
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
  } catch (error) {
    // ESRCH here only means `pid` leads no process group (a foreground worker,
    // a child spawned without `detached`) — the process itself may be alive.
    // Signalling the bare pid is the caller's call: only it can re-prove the
    // pid is still the process it meant (see terminateRecordedProcess).
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group", groupGone: true };
    }
    throw error;
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
