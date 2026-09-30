import process from "node:process";

import { maybePrintCommandHelp, outputCommandResult, parseCommandInput, resolveCommandCwd } from "../lib/cli.mjs";
import { interruptAppServerTurn, TURN_INTERRUPT_ACK_MS } from "../lib/codex.mjs";
import { isTerminalRecord } from "../lib/job-status.mjs";
import { isPidAlive, terminateRecordedProcess, workerCommandLine } from "../lib/process.mjs";
import { nowIso, readStoredJob, resolveJobPid, withStateLock } from "../lib/state.mjs";
import {
  brokerExclusion,
  brokerPresence,
  cancelDecision,
  commitCancel,
  isWorkerProvedRecord,
  isWorkerTerminalRecord,
  resolveCancelableJob
} from "../lib/job-control.mjs";
import { appendLogLine } from "../lib/tracked-jobs.mjs";
import { emitCancelPending, renderCancelReport } from "../lib/render.mjs";

export async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  // A direct worker owns its app-server: a second client cannot reach it (it
  // would start a codex of its own), and the kill below takes it down.
  // Defense in depth: the updater patches the index under the state lock, then
  // the file outside it (the index leads by one write); a file that says direct while
  // the index does not is forged or torn, and the brokered path (no kill
  // without the turn's end) is the safe one.
  const direct = existing.transport === "direct" && job.transport === "direct";

  const interrupt = direct
    ? { attempted: false, interrupted: false, transport: "direct", detail: "direct transport: the kill stops the worker's own app-server" }
    : await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  // Only a pid that is provably still this job's worker is signalled (#743).
  let { pid, identity } = resolveJobPid(workspaceRoot, job);
  // Brokered, or recorded before v1.4.2 (no `transport`): the turn runs in the
  // shared runtime, so a dead worker would not stop it. Only a terminal record
  // ends the wait; polled outside the state lock, which the worker's own
  // terminal write takes. A record that is already terminal ends it at once,
  // whether or not the interrupt was acknowledged (a zero window reads once).
  // No turn recorded → nothing to wait for (v1.4.1 path).
  let turnEnded = false;
  if (!direct && turnId) {
    const stored = await waitForTerminalRecord(workspaceRoot, job.id, interrupt.interrupted ? TURN_INTERRUPT_ACK_MS : 0);
    if (!stored) {
      emitCancelPending({ pending: true, reason: "turn-not-interrupted", survivors: [] }, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
      process.exitCode = 1;
      return;
    }
    // Caused by this cancel only when our interrupt, acknowledged by the shared
    // broker (a stray direct app-server may acknowledge a turn it never ran),
    // met the worker's own record; a record found terminal without that, a
    // crash-guard or a reaper record is kept by commitCancel. Either way the
    // worker is done with the job: nothing is killed.
    turnEnded = interrupt.interrupted && interrupt.transport === "broker" && isWorkerTerminalRecord(stored);
    pid = null;
    identity = null;
  }
  // win32: the broker read, the kill and the record write share one state lock.
  // A broker saves its starting record under the same lock before it spawns, so
  // none can start between this read and the kill script's snapshot. The kill
  // is bounded like SessionEnd's win32 step, under the other takers' lock wait.
  if (process.platform === "win32") {
    withStateLock(workspaceRoot, () => finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded, options }));
  } else {
    finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded, options });
  }
}

// Polls the job file until a terminal record appears, or `null` once the window closes.
async function waitForTerminalRecord(workspaceRoot, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = readStoredJob(workspaceRoot, jobId);
    if (isTerminalRecord(stored)) {
      return stored;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const WIN32_CANCEL_KILL_MS = 4000;

function finishCancel({ workspaceRoot, job, existing, interrupt, pid, identity, turnEnded = false, options }) {
  const win32 = process.platform === "win32";
  const broker = win32 ? brokerPresence(workspaceRoot) : null;
  const exclude = brokerExclusion(broker);
  // A broker record without a win32 identity (a starting one included) cannot be
  // excluded safely: refuse rather than risk killing the shared broker under the worker.
  const kill = broker && exclude === null
    ? { attempted: false, delivered: false, reason: "identity-unavailable" }
    : terminateRecordedProcess(pid, { identity, commandLineMatch: workerCommandLine(job.id), exclude: exclude ?? [], ...(win32 ? { timeoutMs: WIN32_CANCEL_KILL_MS } : {}) });
  // A worker we may not signal, or whose signal reached nothing, but that is
  // still alive is not cancelled: the job stays running, and the sidecar stays
  // so a later cancel or the reaper can still find it.
  // win32, the root was gone before the kill (241): only the worker's own terminal
  // record, read under the kill's lock, proves its tree closed.
  const workerProved = win32 && kill.reason === "process-missing" && isWorkerProvedRecord(readStoredJob(workspaceRoot, job.id));
  const decision = cancelDecision({ pid, kill, alive: isPidAlive(pid), workerProved });
  if (decision.pending) {
    emitCancelPending(decision, pid, job.id, { json: options.json, appendLog: (line) => appendLogLine(job.logFile, line) });
    process.exitCode = 1;
    return;
  }
  // win32: a root proven gone with no orphans was not left running.
  const goneClean = win32 && kill.reason === "process-missing";
  const leftRunning = pid && !kill.attempted && !goneClean ? `worker pid ${pid} left running: ${kill.reason}` : null;

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    pidIdentity: null,
    requestFile: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  // A brokered cancel caused the finish only when its acknowledged interrupt met
  // the worker's own record; neither alone proves it.
  const kept = commitCancel(workspaceRoot, job, nextJob, existing, { leftRunning, causedByCancel: turnEnded || (kill.attempted === true && kill.delivered === true), log: (line) => appendLogLine(job.logFile, line) });
  const common = {
    jobId: job.id,
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  if (kept) {
    // Finished before this cancel could write: the stored outcome stands.
    const text = `Job ${job.id} already ${kept.status}; its record is kept.\n`;
    outputCommandResult({ ...common, status: kept.status, cancellationPending: false }, text, options.json);
    return;
  }

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    workerLeftRunning: leftRunning
  };

  const rendered = renderCancelReport(nextJob);
  outputCommandResult(payload, leftRunning ? `${rendered}${leftRunning}\n` : rendered, options.json);
}
