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

export const WINDOWS_PROCESS_MISSING_EXIT = 241;
export const WINDOWS_IDENTITY_MISMATCH_EXIT = 242;
export const WINDOWS_TERMINATION_FAILED_EXIT = 243;
export const WINDOWS_IDENTITY_UNAVAILABLE_EXIT = 244;
export const WIN32_MAX_PID = 2147483647;
export const isWin32Pid = (pid) => Number.isInteger(pid) && pid >= 1 && pid <= WIN32_MAX_PID;
const WINDOWS_IDENTITY_CIRCUIT_MS = 60000;
const WINDOWS_ROOT = /^[A-Za-z]:\\[^\\/]+/;
const PROTOCOL_LINE = /^[A-Z]+( \d+)*$/;
let windowsIdentityUnavailableAt = null;

export function resetWindowsIdentityCircuit() {
  windowsIdentityUnavailableAt = null;
}

// The Windows directory, taken from the environment like every other System32
// path since v1.4.0, but only when it is an absolute drive path that really
// holds the in-box PowerShell 5.1 (never `pwsh`, #336; never `.`, never UNC).
export function systemRoot(env, options = {}) {
  const root = env?.SystemRoot ?? env?.SYSTEMROOT;
  if (typeof root !== "string" || !WINDOWS_ROOT.test(root)) {
    return null;
  }
  return (options.existsSyncImpl ?? fs.existsSync)(systemPowerShell(root)) ? root : null;
}

export function systemPowerShell(root) {
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// PowerShell never inherits the job's environment: no PSModulePath pointing at
// a repository, no CLR profiler hooks, no PATH. Exactly what it needs to start.
export function powerShellEnvironment(root, env = process.env) {
  const temp = (name) => (typeof env?.[name] === "string" && path.win32.isAbsolute(env[name]) ? env[name] : path.win32.join(root, "Temp"));
  // Data locations only, they choose no executable (PATH and PSModulePath stay
  // pinned). Without the module-analysis cache every launch re-analyses modules:
  // 22-33 s cold vs 0.3 s warm, measured on the Windows runner.
  const dataDir = (name) => (typeof env?.[name] === "string" && path.win32.isAbsolute(env[name]) ? { [name]: env[name] } : {});
  return {
    ...dataDir("LOCALAPPDATA"),
    ...dataDir("PSModuleAnalysisCachePath"),
    SystemRoot: root,
    windir: root,
    TEMP: temp("TEMP"),
    TMP: temp("TMP"),
    PATH: `${path.win32.join(root, "System32")};${root}`,
    PATHEXT: ".EXE",
    PSModulePath: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    NoDefaultCurrentDirectoryInExePath: "1"
  };
}

export function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

// Scripts speak a machine-only protocol: upper-case words and integers. One
// foreign line (a localised error, a stray prompt) voids the whole answer.
export function parseProtocolLines(stdout) {
  // No trimming: a line is the exact text between line breaks. Only the single
  // newline that terminates the last line is optional.
  const lines = String(stdout ?? "").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.every((line) => PROTOCOL_LINE.test(line)) ? lines : null;
}

// One way to run PowerShell: validated absolute path, clean environment,
// System32 as cwd, script as -EncodedCommand. A launcher that is missing,
// invalid, hangs or reports 244 trips a per-process breaker: for a minute
// every caller gets `unavailable` at once instead of each waiting out its own
// timeout.
export function runPowerShell(script, options = {}) {
  const now = options.now ?? (() => performance.now());
  const unavailable = { status: null, stdout: "", timedOut: false, unavailable: true };
  const trip = () => {
    windowsIdentityUnavailableAt = now();
    return unavailable;
  };
  if (windowsIdentityUnavailableAt !== null && now() - windowsIdentityUnavailableAt < WINDOWS_IDENTITY_CIRCUIT_MS) {
    return unavailable;
  }
  if (!(Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1)) {
    return unavailable;
  }
  const env = options.env ?? process.env;
  const root = systemRoot(env, options);
  if (!root) {
    return trip();
  }
  const result = (options.runCommandImpl ?? runCommand)(
    systemPowerShell(root),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    { cwd: path.win32.join(root, "System32"), env: powerShellEnvironment(root, env), timeoutMs: options.timeoutMs, shell: false }
  );
  const timedOut = result.error?.code === "ETIMEDOUT" || (!result.error && result.status === null);
  if (result.error?.code === "ENOENT" || timedOut || result.status === WINDOWS_IDENTITY_UNAVAILABLE_EXIT) {
    windowsIdentityUnavailableAt = now();
    return { ...unavailable, stdout: String(result.stdout ?? ""), timedOut };
  }
  if (!result.error) {
    windowsIdentityUnavailableAt = null;
  }
  return { status: result.status ?? null, stdout: String(result.stdout ?? ""), timedOut: false, unavailable: false };
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

const WIN32_PROBE_BATCH = 256;
const WIN32_IDENTITY_ROW = /^ID (\d+) (\d+)$/;

function identityProbeScript(pids) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit ${WINDOWS_IDENTITY_UNAVAILABLE_EXIT} }`,
    `foreach ($p in @(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue)) {`,
    "  try { $null = $p.Handle; Write-Output ('ID {0} {1}' -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { }",
    "}"
  ].join("\n");
}

// Several pids, one probe. On win32 that is one PowerShell run for the whole
// list (a cold start costs 0.5-3 s; per pid it would multiply); elsewhere the
// per-pid probe is already cheap and is called unchanged. Unknown, missing or
// unparseable → null; too many pids → the extra ones stay null.
export function getProcessIdentities(pids, options = {}) {
  const platform = options.platform ?? process.platform;
  const wanted = [...new Set(pids.filter(isWin32Pid))];
  const map = new Map(wanted.map((pid) => [pid, null]));
  if (wanted.length === 0) {
    return map;
  }
  if (platform !== "win32") {
    for (const pid of wanted) {
      map.set(pid, getProcessIdentity(pid, options));
    }
    return map;
  }
  const sent = new Set(wanted.slice(0, WIN32_PROBE_BATCH));
  const probe = runPowerShell(identityProbeScript([...sent]), { ...options, timeoutMs: options.timeoutMs ?? 10000 });
  const lines = probe.unavailable || probe.status !== 0 ? null : parseProtocolLines(probe.stdout);
  // The whole answer must be ID rows, each for a pid this run actually sent,
  // each pid at most once. A stray OK, a duplicate or a pid outside the batch
  // voids the answer as a whole: partial trust in a script's output is how a
  // wrong identity gets in.
  const rows = [];
  const seen = new Set();
  for (const line of lines ?? []) {
    const row = WIN32_IDENTITY_ROW.exec(line);
    const pid = row ? Number(row[1]) : null;
    if (!row || !sent.has(pid) || seen.has(pid)) {
      return map;
    }
    seen.add(pid);
    rows.push([pid, `win32:${row[2]}`]);
  }
  for (const [pid, identity] of rows) {
    map.set(pid, identity);
  }
  return map;
}

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
    if (!isWin32Pid(pid)) {
      return null;
    }
    if (pid === process.pid && ownIdentityCache.has(platform)) {
      return ownIdentityCache.get(platform);
    }
    const identity = getProcessIdentities([pid], options).get(pid) ?? null;
    if (pid === process.pid && identity) {
      ownIdentityCache.set(platform, identity);
    }
    return identity;
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
