import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import { readJobFile, resolveJobFile, resolveStateDir, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { BROKER_ENDPOINT_ENV } from "../plugins/codex/scripts/lib/app-server.mjs";
import { saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { DEAD_WORKER_MESSAGE, filterJobsForSession, SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import assert from "node:assert/strict";

import { brokerExclusion, brokerPresence, buildStatusSnapshot, cancelDecision, commitCancel, isWorkerProvedRecord, isWorkerTerminalRecord } from "../plugins/codex/scripts/lib/job-control.mjs";
import { emitCancelPending, renderCancelPending } from "../plugins/codex/scripts/lib/render.mjs";

const SURVIVORS = [{ pid: 4301, identity: "win32:7" }];

test("cancelDecision: what each kill outcome means for the job", () => {
  const cases = [
    [{ pid: 1, kill: { attempted: true, delivered: true }, alive: false, platform: "win32" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false, survivors: SURVIVORS }, alive: false, platform: "win32" }, { pending: true, reason: "kill-failed", survivors: SURVIVORS, rootAlive: false }],
    [{ pid: 1, kill: { attempted: true, delivered: false, survivors: SURVIVORS }, alive: false, platform: "linux" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: true, platform: "win32" }, { pending: true, reason: "identity-unavailable", survivors: [], rootAlive: true }],
    [{ pid: 1, kill: { attempted: true, delivered: false, unverified: true }, alive: false, platform: "win32" }, { pending: true, reason: "kill-failed", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "win32", workerProved: true }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "win32", workerProved: false }, { pending: true, reason: "process-missing", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "win32" }, { pending: true, reason: "process-missing", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "linux" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing", survivors: SURVIVORS }, alive: false, platform: "win32" }, { pending: true, reason: "process-missing", survivors: SURVIVORS, rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing", survivors: SURVIVORS }, alive: false, platform: "win32", workerProved: true }, { pending: true, reason: "process-missing", survivors: SURVIVORS, rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: false, platform: "win32" }, { pending: true, reason: "identity-unavailable", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-mismatch" }, alive: false, platform: "win32" }, { pending: true, reason: "identity-mismatch", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: false, platform: "linux" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false }, alive: true, platform: "linux" }, { pending: true, reason: "not-delivered", survivors: [], rootAlive: true }],
    [{ pid: null, kill: { attempted: false, reason: "no-pid" }, alive: null, platform: "win32" }, { pending: false, reason: null, survivors: [] }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(cancelDecision(input), expected, JSON.stringify(input));
  }
});

test("brokerExclusion: none, a verified pair, or null when the broker cannot be excluded", () => {
  assert.deepEqual(brokerExclusion(null), []);
  assert.deepEqual(brokerExclusion({ pid: 555, pidIdentity: "win32:12" }), [{ pid: 555, identity: "win32:12" }]);
  assert.equal(brokerExclusion({ pid: 555, pidIdentity: null }), null);
  assert.equal(brokerExclusion({ pid: 555, pidIdentity: "linux:12" }), null);
  assert.equal(brokerExclusion("unknown"), null);
});

test("brokerPresence: a record, unknown while an endpoint is advertised, or null", () => {
  const workspace = makeTempDir();
  assert.equal(brokerPresence(workspace, {}), null);
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "" }), null);
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "unix:/tmp/x.sock" }), "unknown");
  // A pre-loaded record is used as is: no second read.
  assert.deepEqual(brokerPresence(workspace, {}, { record: { endpoint: "e" } }), { endpoint: "e" });
  assert.equal(brokerPresence(workspace, {}, { record: null }), null);
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "x" }, { record: null }), "unknown");
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null });
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "unix:/tmp/x.sock" }).endpoint, "unix:/tmp/x.sock");
  assert.equal(brokerPresence(workspace, {}).endpoint, "unix:/tmp/x.sock");
});

test("brokerPresence: an existing but unreadable broker.json presumes a broker", () => {
  const workspace = makeTempDir();
  const dir = resolveStateDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "broker.json"), "{not json");
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(brokerPresence(workspace, {}), "unknown");
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("renderCancelPending reports the orphans a vanished worker left", () => {
  const rendered = renderCancelPending({ pending: true, reason: "process-missing", survivors: SURVIVORS, rootAlive: false }, 4300, "job-1");
  assert.equal(rendered.logLine, "cancellation not confirmed: worker pid 4300 left running (process-missing) worker tree survivors: 4301:win32:7");
  assert.ok(rendered.text.includes("worker pid 4300 exited but part of its tree is still running (survivors: 4301:win32:7); the job stays running until the reaper judges it."));
  assert.equal(rendered.json.reason, "process-missing");
  assert.deepEqual(rendered.json.survivors, SURVIVORS);
  assert.equal(rendered.diagnostic, "[codex] worker tree survivors: 4301:win32:7\n");
});

test("renderCancelPending says an unverifiable dead worker waits for the reaper", () => {
  for (const reason of ["identity-unavailable", "identity-mismatch", "process-missing"]) {
    const rendered = renderCancelPending({ pending: true, reason, survivors: [], rootAlive: false }, 4300, "job-1");
    assert.match(rendered.text, /worker pid 4300 exited before it could be verified; the job stays running until the reaper judges it\./);
  }
});

test("renderCancelPending says a brokered turn that did not end leaves the job running", () => {
  const rendered = renderCancelPending({ pending: true, reason: "turn-not-interrupted", survivors: [] }, 4300, "job-1");
  assert.deepEqual(rendered.json, { jobId: "job-1", status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(rendered.logLine, "cancellation not confirmed: worker pid 4300 left running (turn-not-interrupted)");
  assert.match(rendered.text, /the shared runtime has not ended the turn, so the worker was not stopped; the job stays running\. Re-run cancel or wait for result\./);
  assert.equal(rendered.diagnostic, null);
});

test("renderCancelPending names no pid when there is none", () => {
  const rendered = renderCancelPending({ pending: true, reason: "turn-not-interrupted", survivors: [] }, null, "job-1");
  assert.equal(rendered.logLine, "cancellation not confirmed: worker left running (turn-not-interrupted)");
  assert.match(rendered.text, /^cancellation not confirmed: worker left running \(turn-not-interrupted\)\n/);
  assert.doesNotMatch(rendered.text, /null|undefined/);
});

test("renderCancelPending reports survivors on win32", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS }, 4300, "job-1");
  assert.deepEqual(rendered.json.survivors, SURVIVORS);
  assert.ok(rendered.logLine.endsWith(" worker tree survivors: 4301:win32:7"));
  assert.equal(rendered.diagnostic, "[codex] worker tree survivors: 4301:win32:7\n");
});

test("renderCancelPending says the root exited when only its tree survives", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS, rootAlive: false }, 4300, "job-1");
  assert.ok(rendered.text.includes("worker pid 4300 exited but part of its tree is still running (survivors: 4301:win32:7); the job stays running until the reaper judges it."));
  assert.ok(!rendered.text.includes("until the worker exits"));
  const alive = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS, rootAlive: true }, 4300, "job-1");
  assert.ok(alive.text.includes("until the worker exits"));
});

test("renderCancelPending marks an unverified kill without survivors", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: [] }, 4300, "job-1");
  assert.equal("survivors" in rendered.json, false);
  assert.ok(rendered.logLine.endsWith(" (unverified)"));
  assert.equal(rendered.diagnostic, null);
});

test("renderCancelPending is byte-identical to v1.4.0 on posix", () => {
  const rendered = renderCancelPending({ pending: true, reason: "not-delivered", survivors: [] }, 4300, "job-1");
  assert.deepEqual(rendered.json, { jobId: "job-1", status: "running", cancellationPending: true, reason: "not-delivered" });
  assert.equal(rendered.logLine, "cancellation not confirmed: worker pid 4300 left running (not-delivered)");
  assert.equal(rendered.diagnostic, null);
});

test("emitCancelPending never puts the diagnostic on stdout", () => {
  for (const json of [true, false]) {
    const out = [];
    const err = [];
    const log = [];
    const rendered = emitCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS }, 4300, "job-1", {
      json,
      appendLog: (line) => log.push(line),
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) }
    });
    assert.equal(out.length, 1);
    if (json) {
      assert.deepEqual(JSON.parse(out[0]).survivors, SURVIVORS);
    } else {
      assert.equal(out[0], rendered.text);
    }
    assert.deepEqual(err, ["[codex] worker tree survivors: 4301:win32:7\n"]);
    assert.equal(log.length, 1);
    assert.ok(log[0].endsWith("worker tree survivors: 4301:win32:7"));
  }
});

test("isWorkerTerminalRecord requires the workerClosed marker on a terminal record", () => {
  const done = { status: "completed", phase: "done" };
  assert.equal(isWorkerTerminalRecord({ ...done, workerClosed: true }), true);
  assert.equal(isWorkerTerminalRecord({ status: "failed", errorMessage: "worker uncaughtException: boom" }), false, "crash guard");
  assert.equal(isWorkerTerminalRecord({ status: "failed", errorMessage: DEAD_WORKER_MESSAGE }), false, "reaper");
  assert.equal(isWorkerTerminalRecord(done), false, "legacy v1.4.0 record");
  assert.equal(isWorkerTerminalRecord({ status: "running", workerClosed: true }), false);
  assert.equal(isWorkerTerminalRecord(null), false);
});

test("isWorkerProvedRecord also needs the app-server exit observed; a pre-1.4.2 record without the field counts", () => {
  const done = { status: "failed", phase: "failed", workerClosed: true };
  assert.equal(isWorkerProvedRecord({ ...done, appServerExited: true }), true);
  assert.equal(isWorkerProvedRecord(done), true, "v1.4.1 record");
  assert.equal(isWorkerProvedRecord({ ...done, appServerExited: false }), false, "close deadline passed, child alive");
  assert.equal(isWorkerProvedRecord({ status: "failed", appServerExited: true }), false, "crash guard / reaper: no marker");
});

test("commitCancel writes cancelled over an active record and keeps a terminal one", () => {
  const workspace = makeTempDir();
  const job = { id: "task-1", status: "running", title: "T" };
  const next = { ...job, status: "cancelled", phase: "cancelled", pid: null, pidIdentity: null, requestFile: null, completedAt: "2026-09-29T00:00:00.000Z", errorMessage: "Cancelled by user." };
  const log = [];
  writeJobFile(workspace, "task-1", { ...job, threadId: "th" });
  assert.equal(commitCancel(workspace, job, next, {}, { leftRunning: null, log: (line) => log.push(line) }), null);
  const written = readJobFile(resolveJobFile(workspace, "task-1"));
  assert.equal(written.status, "cancelled");
  assert.equal(written.threadId, "th", "the stored record is the base");
  assert.equal(written.cancelledAt, next.completedAt);
  assert.deepEqual(log, ["Cancelled by user."]);

  // The worker (or the reaper) already finished it: kept, reported, not overwritten.
  const finished = { ...job, status: "failed", phase: "failed", errorMessage: "Turn interrupted.", workerClosed: true };
  writeJobFile(workspace, "task-1", finished);
  log.length = 0;
  assert.deepEqual(commitCancel(workspace, job, next, {}, { leftRunning: "worker pid 5 left running: identity-mismatch", log: (line) => log.push(line) }), finished);
  assert.deepEqual(readJobFile(resolveJobFile(workspace, "task-1")), finished);
  assert.deepEqual(log, ["cancel: record already failed, kept (not caused by this cancel)"]);

  // This cancel caused the finish (acknowledged interrupt, or delivered kill): cancelled wins (v1.4.0).
  log.length = 0;
  assert.equal(commitCancel(workspace, job, next, {}, { leftRunning: null, causedByCancel: true, log: (line) => log.push(line) }), null);
  assert.equal(readJobFile(resolveJobFile(workspace, "task-1")).status, "cancelled");
  assert.deepEqual(log, ["Cancelled by user."]);
});

test("commitCancel keeps a reaper-written failure even when this cancel's interrupt was acknowledged", () => {
  const job = { id: "task-1", status: "running", title: "T" };
  const next = { ...job, status: "cancelled", phase: "cancelled", pid: null, pidIdentity: null, requestFile: null, completedAt: "2026-09-29T00:00:00.000Z", errorMessage: "Cancelled by user." };
  // Only the reaper's records (DEAD_WORKER_MESSAGE prefix) are kept unconditionally; any other
  // terminal record is kept only when this cancel did not cause it.
  // [stored errorMessage, workerClosed, causedByCancel, kept]
  const cases = [
    [DEAD_WORKER_MESSAGE, undefined, true, true],
    [DEAD_WORKER_MESSAGE, undefined, false, true],
    [`${DEAD_WORKER_MESSAGE} (pid reused: 5 now belongs to another process)`, undefined, true, true],
    ["worker uncaughtException: boom", undefined, true, false],
    ["Turn interrupted.", undefined, true, false],
    ["Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.", undefined, true, false],
    ["worker uncaughtException: boom", undefined, false, true],
    ["Turn interrupted.", undefined, false, true],
    ["Turn interrupted.", true, true, false],
    ["Turn interrupted.", true, false, true]
  ];
  for (const [errorMessage, workerClosed, causedByCancel, kept] of cases) {
    const workspace = makeTempDir();
    const stored = { ...job, status: "failed", phase: "failed", errorMessage, ...(workerClosed ? { workerClosed } : {}) };
    writeJobFile(workspace, "task-1", stored);
    const result = commitCancel(workspace, job, next, {}, { leftRunning: null, causedByCancel, log: () => {} });
    const label = `${errorMessage} workerClosed=${workerClosed} causedByCancel=${causedByCancel}`;
    assert.deepEqual(result, kept ? stored : null, label);
    assert.equal(readJobFile(resolveJobFile(workspace, "task-1")).status, kept ? "failed" : "cancelled", label);
  }
});

test("filterJobsForSession: keeps the current session's jobs, or all jobs without a session", () => {
  const jobs = [{ sessionId: "a" }, { sessionId: "b" }];
  assert.deepEqual(filterJobsForSession(jobs, { [SESSION_ID_ENV]: "a" }), [{ sessionId: "a" }]);
  const original = process.env[SESSION_ID_ENV];
  delete process.env[SESSION_ID_ENV];
  try {
    assert.deepEqual(filterJobsForSession(jobs, {}), jobs);
  } finally {
    if (original !== undefined) process.env[SESSION_ID_ENV] = original;
  }
});

// Twelve finished jobs, newest first by `updatedAt`; the last two belong to another session.
function seedFinishedJobs(workspace) {
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const jobs = Array.from({ length: 12 }, (_, index) => {
    const at = `2026-03-18T15:${String(59 - index).padStart(2, "0")}:00.000Z`;
    return { id: `task-${String(index).padStart(2, "0")}`, status: "completed", jobClass: "task", sessionId: index < 10 ? "sess-a" : "sess-b", createdAt: at, updatedAt: at };
  });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`, "utf8");
}

test("buildStatusSnapshot counts the session's jobs and the finished ones past the list", () => {
  const workspace = makeTempDir();
  seedFinishedJobs(workspace);
  const listed = buildStatusSnapshot(workspace, { env: {} });
  assert.deepEqual([listed.totalJobs, listed.omittedJobs, listed.latestFinished.id, listed.recent.length], [12, 4, "task-00", 7]);
  const all = buildStatusSnapshot(workspace, { env: {}, all: true });
  assert.deepEqual([all.totalJobs, all.omittedJobs, all.recent.length], [12, 0, 11]);
  const otherSession = buildStatusSnapshot(workspace, { env: { [SESSION_ID_ENV]: "sess-b" } });
  assert.deepEqual([otherSession.totalJobs, otherSession.omittedJobs], [2, 0]);
});
