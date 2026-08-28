#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveJobPid, resolveStateFile, saveState, withStateLock } from "./lib/state.mjs";
import { reapDeadJobs } from "./lib/tracked-jobs.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
// How long a `busy` broker is given to shed a client this hook has just reaped,
// and how often to ask. Bounded: a broker that is really in use stays busy for the
// whole window and keeps everything it owns.
const BROKER_BUSY_RETRY_MS = 1000;
const BROKER_BUSY_POLL_MS = 100;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }

  const line = `export ${name}=${shellEscape(value)}`;

  let lines = [];

  try {
    lines = fs
      .readFileSync(process.env.CLAUDE_ENV_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.startsWith(`export ${name}=`));
  } catch {
    // File doesn't exist yet.
  }

  lines.push(line);

  fs.writeFileSync(
    process.env.CLAUDE_ENV_FILE,
    lines.join("\n") + "\n",
    "utf8"
  );
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // One locked read-modify-write: the jobs this decides to stop and the list it
  // writes back have to come from the same snapshot, or another session's job —
  // created between the read and the write — is dropped from the index and its
  // files are pruned with it.
  withStateLock(workspaceRoot, () => {
    const state = loadState(workspaceRoot);
    const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    if (sessionJobs.length === 0) {
      return;
    }

    for (const job of sessionJobs) {
      // Background jobs are explicitly dispatched to outlive the session that
      // started them. Leave them running and leave their state entry intact so
      // any session in the workspace can still poll for status/results.
      if (job.background) {
        continue;
      }
      const stillRunning = job.status === "queued" || job.status === "running";
      if (!stillRunning) {
        continue;
      }
      try {
        terminateProcessTree(resolveJobPid(workspaceRoot, job) ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }

    saveState(workspaceRoot, {
      ...state,
      jobs: state.jobs.filter((job) => job.sessionId !== sessionId || job.background)
    });
  });
}

// Read AFTER cleanupSessionJobs: the state it saved is the one that decides.
// Every kind of job counts, from every session — a foreground job of another
// Claude session survives this session's cleanup and is talking to the same
// shared broker, so tearing the broker down here would break its live turn.
function activeWorkspaceJobs(cwd) {
  if (!cwd) {
    return [];
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return [];
  }
  const state = loadState(workspaceRoot);
  // Reap first: a worker killed outright (SIGKILL, OOM) leaves `running` behind,
  // and trusting that record would keep this broker — and every later session's —
  // alive forever, with the dead job's private payload still on disk.
  return reapDeadJobs(workspaceRoot, state.jobs)
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => `${job.id}:${job.status}`);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);

  // Every job in this workspace — background worker or another session's
  // foreground run — reaches Codex through the same broker. If any of them is
  // still active, leave the broker running; a later SessionEnd (or the broker
  // itself) tears it down once nothing depends on it anymore.
  //
  // What keeps this bounded is the broker's own idle self-terminate (#457):
  // once the last client disconnects it exits and clears its own record. With
  // `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS=0` that safety net is off, and a
  // broker kept alive here for an active job never exits on its own.
  const activeJobs = activeWorkspaceJobs(cwd);
  if (activeJobs.length > 0) {
    process.stderr.write(`[codex] Workspace jobs still active (${activeJobs.join(", ")}); leaving the broker running.\n`);
    return;
  }

  // The check above is a snapshot; the broker itself has the live answer. If a
  // job started in that gap the broker refuses, and refusing means every teardown
  // step below would be wrong: the endpoint, pid file and record all still belong
  // to a broker somebody is talking to. Leave it to the next SessionEnd or to its
  // own idle timeout.
  // Only a broker that answered "not busy" (or is provably gone) may be torn
  // down. An unanswered or unreadable handshake is not evidence of an idle
  // broker, and every step below assumes there is nothing left to talk to.
  let busyRetries = 0;
  if (brokerEndpoint) {
    let shutdown = await sendBrokerShutdown(brokerEndpoint);
    // A `busy` answer straight after this hook reaped the workspace's jobs is
    // usually a phantom: the broker counts every connected socket, and a worker
    // that was just killed still has one until its close event is processed. That
    // clears in milliseconds, so ask again for a moment before believing it. A
    // broker that is genuinely serving someone stays busy for the whole window and
    // is left alone, exactly as before.
    const deadline = Date.now() + BROKER_BUSY_RETRY_MS;
    while (shutdown.busy === true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, BROKER_BUSY_POLL_MS));
      shutdown = await sendBrokerShutdown(brokerEndpoint);
      busyRetries += 1;
    }
    if (shutdown.busy !== false) {
      process.stderr.write(
        shutdown.busy === true
          ? `[codex] Shared broker is still serving another session (busyRetries=${busyRetries}); leaving it running.\n`
          : `[codex] Shared broker did not confirm it is idle (busyRetries=${busyRetries}); leaving it running.\n`
      );
      return;
    }
  }

  const teardown = teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  // Every branch of this hook says what it decided: when a broker outlives a
  // SessionEnd the only question worth asking is which of these four paths ran.
  process.stderr.write(
    `[codex] Broker teardown: endpoint=${brokerEndpoint ?? "none"} pid=${pid ?? "none"} signalled=${teardown.signalled} busyRetries=${busyRetries}\n`
  );

  // A replacement broker can have started — and recorded itself — while this one
  // was shutting down. Clearing unconditionally would delete the live broker's
  // ownership record, which is exactly what the broker's own endpoint-guarded
  // `clearOwnSessionRecord` avoids on its side.
  if (loadBrokerSession(cwd)?.endpoint === brokerEndpoint) {
    clearBrokerSession(cwd);
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
