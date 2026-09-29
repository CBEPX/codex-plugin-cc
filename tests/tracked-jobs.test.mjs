import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { getProcessIdentity } from "../plugins/codex/scripts/lib/process.mjs";
import { reapDeadJobs, resetWin32ProbeMemo, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import {
  listJobs,
  readJobFile,
  recordWorkerPid,
  removeJobPidFile,
  resolveJobFile,
  resolveJobPid,
  resolveJobPidFile,
  resolveJobRequestFile,
  resolveStateFile,
  updateJobPid,
  upsertJob,
  writeJobFile,
  writeJobPidFile,
  writeJobRequestFile
} from "../plugins/codex/scripts/lib/state.mjs";

// What a legacy (identity-less) record's live worker looks like to `ps`.
const LIVE_WORKER_COMMAND_LINE = "node /plugin/scripts/codex-companion.mjs task-worker --job-id job-live";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_JOBS_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs")).href;

function seedJob(workspace, job) {
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
}

function spawnDeadPid() {
  const result = run(process.execPath, ["-e", ""]);
  assert.equal(result.status, 0);
  return result.pid;
}

test.beforeEach(() => resetWin32ProbeMemo());

test("reapDeadJobs marks a running job with a dead pid as failed", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-dead", status: "running", phase: "delegating", pid: spawnDeadPid(), logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].status, "failed");
  assert.equal(reaped[0].pid, null);
  assert.match(reaped[0].errorMessage, /worker exited before completing/);

  const stored = readJobFile(resolveJobFile(workspace, "job-dead"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.pid, null);
  assert.equal(listJobs(workspace).find((job) => job.id === "job-dead").status, "failed");
});

test("reapDeadJobs refreshes updatedAt so the reaped job sorts newest-first", () => {
  const workspace = makeTempDir();
  const stale = "2000-01-01T00:00:00.000Z";
  seedJob(workspace, { id: "job-stale", status: "running", phase: "delegating", pid: spawnDeadPid(), updatedAt: stale, logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.notEqual(reaped[0].updatedAt, stale);
  assert.equal(reaped[0].updatedAt, reaped[0].completedAt);
  assert.equal(readJobFile(resolveJobFile(workspace, "job-stale")).updatedAt, reaped[0].updatedAt);
});

test("reapDeadJobs leaves a running job with a live pid untouched", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-live", status: "running", phase: "delegating", pid: process.pid, logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace), { processCommandLineImpl: () => LIVE_WORKER_COMMAND_LINE });

  assert.equal(reaped[0].status, "running");
  assert.equal(readJobFile(resolveJobFile(workspace, "job-live")).status, "running");
});

test("reapDeadJobs leaves a pid-less queued job untouched inside the grace window", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-no-pid", status: "queued", phase: "queued", pid: null, logFile: null });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "queued");
});

test("reapDeadJobs keeps the stored result when the job finished between read and probe", () => {
  const workspace = makeTempDir();
  const deadPid = spawnDeadPid();
  writeJobFile(workspace, "job-raced", { id: "job-raced", status: "completed", phase: "completed", result: "done" });
  upsertJob(workspace, { id: "job-raced", status: "running", phase: "delegating", pid: deadPid, logFile: null });

  const reaped = reapDeadJobs(workspace, [{ id: "job-raced", status: "running", pid: deadPid, logFile: null }]);

  assert.equal(reaped[0].status, "completed");
  assert.equal(reaped[0].result, "done");
  assert.equal(readJobFile(resolveJobFile(workspace, "job-raced")).status, "completed");
});

test("registerWorkerCrashGuard marks the job failed when the worker dies on an unhandled rejection", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-crash", status: "running", phase: "delegating", pid: null, logFile: null });

  const workerFile = path.join(makeTempDir(), "crashing-worker.mjs");
  fs.writeFileSync(
    workerFile,
    [
      `import { registerWorkerCrashGuard } from ${JSON.stringify(TRACKED_JOBS_URL)};`,
      "registerWorkerCrashGuard(process.argv[2], process.argv[3], null);",
      'Promise.reject(new Error("boom"));',
      "setTimeout(() => {}, 5000);",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = run(process.execPath, [workerFile, workspace, "job-crash"]);

  assert.equal(result.status, 1);
  const stored = readJobFile(resolveJobFile(workspace, "job-crash"));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /unhandledRejection/);
  assert.match(stored.errorMessage, /boom/);
  assert.equal(stored.workerClosed, undefined, "the crash guard never proves a closed worker");
});

test("registerWorkerCrashGuard does not rewrite a cancelled job when the worker is SIGTERMed", async () => {
  const workspace = makeTempDir();
  // Simulate handleCancel having already written the terminal state before the
  // worker processes the teardown SIGTERM it delivered.
  seedJob(workspace, { id: "job-cancelled", status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user." });

  const workerFile = path.join(makeTempDir(), "long-worker.mjs");
  fs.writeFileSync(
    workerFile,
    [
      `import { registerWorkerCrashGuard } from ${JSON.stringify(TRACKED_JOBS_URL)};`,
      "registerWorkerCrashGuard(process.argv[2], process.argv[3], null);",
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"),
    "utf8"
  );

  const child = spawn(process.execPath, [workerFile, workspace, "job-cancelled"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) {
        resolve();
      }
    });
    child.on("error", reject);
  });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const { signal } = await exited;

  assert.equal(signal, "SIGTERM");
  const stored = readJobFile(resolveJobFile(workspace, "job-cancelled"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.errorMessage, "Cancelled by user.");
});

// A `--config model_providers.x.http_headers.Authorization=...` value only ever
// lives in the private `jobs/<id>.request.json`; the reaper must delete that file
// and must never lift it into the record it rewrites.
const REQUEST_SECRET = "sk-reaper-secret-value";
const STALE_CREATED_AT = new Date(Date.now() - 120000).toISOString();

function seedQueuedJobWithPayload(workspace, id, overrides = {}) {
  const requestFile = writeJobRequestFile(workspace, id, {
    prompt: "investigate",
    config: { auth_header: REQUEST_SECRET }
  });
  const job = {
    id,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile: null,
    createdAt: STALE_CREATED_AT,
    requestFile,
    request: { prompt: "investigate", config: { auth_header: "[redacted]" } },
    ...overrides
  };
  seedJob(workspace, job);
  return job;
}

// The fork writes the queued record before the spawn, so a worker killed before
// it consumed the payload leaves a `queued` job with no usable pid: without the
// grace-period rule it would stay queued forever and keep its 0600 payload.
test("reapDeadJobs fails a queued job whose worker died before it consumed the request payload", () => {
  const workspace = makeTempDir();
  seedQueuedJobWithPayload(workspace, "job-queued-dead");

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "failed");
  assert.match(reaped[0].errorMessage, /worker exited before completing/);
  assert.equal(reaped[0].requestFile, null);
  assert.equal(fs.existsSync(resolveJobRequestFile(workspace, "job-queued-dead")), false);
  assert.equal(readJobFile(resolveJobFile(workspace, "job-queued-dead")).requestFile, null);
});

test("reapDeadJobs deletes the private request payload of a dead running job", () => {
  const workspace = makeTempDir();
  seedQueuedJobWithPayload(workspace, "job-running-dead", {
    status: "running",
    phase: "delegating",
    pid: spawnDeadPid()
  });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "failed");
  assert.equal(reaped[0].requestFile, null);
  assert.equal(fs.existsSync(resolveJobRequestFile(workspace, "job-running-dead")), false);
});

test("reapDeadJobs never touches a live worker or its request payload", () => {
  const workspace = makeTempDir();
  const job = seedQueuedJobWithPayload(workspace, "job-live-payload", { pid: process.pid });

  const reaped = reapDeadJobs(workspace, listJobs(workspace), { processCommandLineImpl: () => LIVE_WORKER_COMMAND_LINE });

  assert.equal(reaped[0].status, "queued");
  assert.equal(reaped[0].requestFile, job.requestFile);
  assert.equal(fs.existsSync(job.requestFile), true);
  assert.equal(JSON.parse(fs.readFileSync(job.requestFile, "utf8")).config.auth_header, REQUEST_SECRET);
});

test("reapDeadJobs leaves a cancelled job with a dead pid in its terminal state", () => {
  const workspace = makeTempDir();
  seedJob(workspace, {
    id: "job-cancelled-dead",
    status: "cancelled",
    phase: "cancelled",
    pid: spawnDeadPid(),
    errorMessage: "Cancelled by user.",
    createdAt: STALE_CREATED_AT,
    logFile: null
  });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "cancelled");
  assert.equal(reaped[0].errorMessage, "Cancelled by user.");
  assert.equal(readJobFile(resolveJobFile(workspace, "job-cancelled-dead")).status, "cancelled");
});

test("a reaped job leaves no private --config secret behind in state.json", () => {
  const workspace = makeTempDir();
  seedQueuedJobWithPayload(workspace, "job-secret");

  reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8").includes(REQUEST_SECRET), false);
  assert.equal(fs.readFileSync(resolveJobFile(workspace, "job-secret"), "utf8").includes(REQUEST_SECRET), false);
});

// The worker owns its job file from its first line, so the parent must never
// write that file back — not even to add the pid. It goes to an atomic sidecar
// and to the pid-only index patch instead.
test("updateJobPid records the worker pid without rewriting the job file", () => {
  const workspace = makeTempDir();
  const job = seedQueuedJobWithPayload(workspace, "job-pid");
  const jobFile = resolveJobFile(workspace, "job-pid");
  const before = fs.readFileSync(jobFile, "utf8");

  updateJobPid(workspace, "job-pid", 424242);

  assert.equal(fs.readFileSync(jobFile, "utf8"), before, "the parent must not rewrite the worker's job file");
  const stored = readJobFile(jobFile);
  assert.equal(stored.status, "queued");
  assert.equal(stored.requestFile, job.requestFile);
  assert.deepEqual(resolveJobPid(workspace, stored), { pid: 424242, identity: null }, "readers must find the pid in the sidecar");
  assert.equal(listJobs(workspace).find((entry) => entry.id === "job-pid").pid, 424242);
});

// The race the sidecar removes: the worker finishes between the parent's read
// and its write, and the parent puts the queued snapshot back — losing the
// result, threadId and turnId while the index already says completed.
test("updateJobPid leaves a record the worker already completed intact", () => {
  const workspace = makeTempDir();
  seedQueuedJobWithPayload(workspace, "job-raced");

  const completed = {
    id: "job-raced",
    status: "completed",
    phase: "done",
    pid: null,
    threadId: "thr_1",
    turnId: "turn_1",
    result: { status: 0, finalMessage: "done" },
    completedAt: "2026-03-18T15:31:00.000Z"
  };
  writeJobFile(workspace, "job-raced", completed);
  upsertJob(workspace, completed);

  updateJobPid(workspace, "job-raced", 424242);

  const stored = readJobFile(resolveJobFile(workspace, "job-raced"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.threadId, "thr_1");
  assert.equal(stored.turnId, "turn_1");
  assert.deepEqual(stored.result, completed.result);
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-raced");
  assert.equal(indexed.status, "completed");
  assert.equal(indexed.pid, null, "a finished job must not get its pid back");
  assert.deepEqual(resolveJobPid(workspace, stored), { pid: null, identity: null }, "a terminal record never reports a pid");
});

// A worker that took the record over but has not written its own pid yet is
// still reapable through the sidecar, and the sidecar goes away with the job.
test("reapDeadJobs resolves a pid from the sidecar and releases it", () => {
  const workspace = makeTempDir();
  seedQueuedJobWithPayload(workspace, "job-sidecar", { status: "running", phase: "starting" });
  writeJobPidFile(workspace, "job-sidecar", spawnDeadPid());

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "failed");
  assert.match(reaped[0].errorMessage, /worker exited before completing/);
  assert.equal(fs.existsSync(resolveJobPidFile(workspace, "job-sidecar")), false, "a terminal job must not keep a stale pid file");
});

// The parent patches the pid in after the spawn, but the worker owns the record
// from its first line: a load-mutate-save of the whole record would rewind
// `running` back to `queued`.
test("updateJobPid never rewinds a worker that already reported running", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-started", status: "running", phase: "starting", pid: 777, logFile: null });

  updateJobPid(workspace, "job-started", 424242);

  const stored = readJobFile(resolveJobFile(workspace, "job-started"));
  assert.equal(stored.status, "running");
  assert.equal(stored.pid, 777);
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-started");
  assert.equal(indexed.status, "running");
  assert.equal(indexed.pid, 777);
});

// PID liveness cannot settle this: a zombie and a recycled pid both read as
// alive, so a worker that died right after its terminal `writeJobFile` kept a
// phantom `running` entry in the index — blocking resume on that thread — for as
// long as some process held its pid. The job file is the authoritative record,
// so it is read first, for every active entry, whatever the pid says.
test("reapDeadJobs reconciles a terminal job file even when the recorded pid is alive", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "job-zombie", status: "running", phase: "running", threadId: "thr_1", pid: process.pid });
  writeJobFile(workspace, "job-zombie", {
    id: "job-zombie",
    status: "completed",
    phase: "done",
    pid: null,
    threadId: "thr_1",
    turnId: "turn_9",
    result: { status: 0, finalMessage: "done" },
    completedAt: "2026-03-24T20:06:00.000Z"
  });

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

  assert.equal(reaped[0].status, "completed", "the authoritative job file decides");
  assert.equal(reaped[0].turnId, "turn_9");
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-zombie");
  assert.equal(indexed.status, "completed", "the terminal record must reach the index");
  assert.equal(indexed.pid, null);
});

// The payload is a 0600 file that can hold `--config` credentials. The worker
// consumes it on the way in, but a job that never got that far (or a migration
// that staged one) leaves it behind: nothing revisits a terminal job, so its
// terminal write is the last chance to release it.
test("a terminal write releases the job's private request payload", async () => {
  const workspace = makeTempDir();

  writeJobRequestFile(workspace, "job-done", { prompt: "x", config: { "http_headers.Cookie": "SECRET" } });
  await runTrackedJob({ id: "job-done", workspaceRoot: workspace, logFile: null }, async () => ({
    exitStatus: 0,
    payload: { ok: true },
    rendered: "done\n",
    summary: "done"
  }));
  assert.equal(fs.existsSync(resolveJobRequestFile(workspace, "job-done")), false, "a completed job must not keep its payload");

  writeJobRequestFile(workspace, "job-thrown", { prompt: "x", config: { "http_headers.Cookie": "SECRET" } });
  await assert.rejects(
    runTrackedJob({ id: "job-thrown", workspaceRoot: workspace, logFile: null }, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(fs.existsSync(resolveJobRequestFile(workspace, "job-thrown")), false, "a failed job must not keep its payload");
});

test("runTrackedJob sets workerClosed only on its cooperative terminal write, after the runner returned", async () => {
  const workspace = makeTempDir();
  const job = { id: "job-marker", status: "queued", workspaceRoot: workspace, logFile: null };
  seedJob(workspace, job);
  const seen = [];
  await runTrackedJob(job, async () => {
    // Still inside the runner (the app-server client is not closed yet): no marker.
    seen.push(readJobFile(resolveJobFile(workspace, job.id)));
    return { exitStatus: 0, payload: {}, rendered: "ok\n", summary: "ok" };
  });
  assert.equal(seen[0].status, "running");
  assert.equal(seen[0].workerClosed, undefined);
  assert.equal(readJobFile(resolveJobFile(workspace, job.id)).workerClosed, true);
  assert.equal(listJobs(workspace).find((entry) => entry.id === job.id).workerClosed, true);

  // A thrown runner (client state unknown) never claims it.
  const thrown = { id: "job-marker-thrown", status: "queued", workspaceRoot: workspace, logFile: null };
  seedJob(workspace, thrown);
  await assert.rejects(runTrackedJob(thrown, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(readJobFile(resolveJobFile(workspace, thrown.id)).workerClosed, undefined);
});

test("runTrackedJob records whether the app-server exit was observed; a silent runner records false", async () => {
  const workspace = makeTempDir();
  for (const [id, reported, expected] of [["job-exit-seen", true, true], ["job-exit-unseen", false, false], ["job-exit-unsaid", undefined, false]]) {
    const job = { id, status: "queued", workspaceRoot: workspace, logFile: null };
    seedJob(workspace, job);
    await runTrackedJob(job, async () => ({ exitStatus: 0, payload: {}, rendered: "ok\n", summary: "ok", appServerExited: reported }));
    assert.equal(readJobFile(resolveJobFile(workspace, id)).appServerExited, expected, id);
    assert.equal(listJobs(workspace).find((entry) => entry.id === id).appServerExited, expected, id);
  }
});

// A live pid is not proof of a live worker: the OS may have handed the number to
// something else (#743). The recorded identity tells them apart.
test("reapDeadJobs fails a running job whose pid was recycled by another process", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-recycled", status: "running", phase: "delegating", pid: process.pid, pidIdentity: "linux:not-this-process", logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { platform: "linux", getProcessIdentityImpl: () => "linux:something-else" });
  assert.equal(reaped[0].status, "failed");
  assert.match(reaped[0].errorMessage, /pid reused/);
  assert.equal(reaped[0].pidIdentity, null);
});

test("reapDeadJobs leaves a running job alone when the identity probe fails", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-probe-fails", status: "running", phase: "delegating", pid: process.pid, pidIdentity: "linux:x", logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { platform: "linux", getProcessIdentityImpl: () => { throw new Error("ps unavailable"); } });
  assert.equal(reaped[0].status, "running");
});

test("reapDeadJobs keeps a running job whose identity still matches", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-same", status: "running", phase: "delegating", pid: process.pid, pidIdentity: "linux:same", logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { platform: "linux", getProcessIdentityImpl: () => "linux:same" });
  assert.equal(reaped[0].status, "running");
});

// A legacy record (no identity) whose pid now runs something that is plainly not
// a companion worker can never be cancelled or finish: the reaper fails it, by
// command line, without signalling anything.
test("reapDeadJobs fails a legacy running job whose pid now runs an unrelated process", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-legacy-recycled", status: "running", phase: "delegating", pid: process.pid, logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), {
    platform: "linux",
    processCommandLineImpl: () => "/usr/sbin/unrelated-daemon"
  });
  assert.equal(reaped[0].status, "failed");
  assert.equal(reaped[0].errorMessage, `worker exited before completing (worker pid ${process.pid} now belongs to an unrelated process)`);
});

test("reapDeadJobs keeps a legacy running job whose pid still runs the companion", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-legacy-live", status: "running", phase: "delegating", pid: process.pid, logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), {
    platform: "linux",
    processCommandLineImpl: () => "node /x/codex-companion.mjs task-worker --job-id job-legacy-live"
  });
  assert.equal(reaped[0].status, "running");
});

// A legacy worker that died but was never reaped by its parent stays a zombie:
// alive to kill 0, `<defunct>` to processCommandLine. It is failed, not signalled.
test("reapDeadJobs fails a legacy running job whose worker is a zombie", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-legacy-zombie", status: "running", phase: "delegating", pid: process.pid, logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { platform: "linux", processCommandLineImpl: () => "<defunct>" });
  assert.equal(reaped[0].status, "failed");
  assert.equal(reaped[0].errorMessage, `worker exited before completing (worker pid ${process.pid} now belongs to an unrelated process)`);
});

test("reapDeadJobs keeps a legacy running job whose command line cannot be read", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-legacy-unknown", status: "running", phase: "delegating", pid: process.pid, logFile: null });
  const reaped = reapDeadJobs(workspace, listJobs(workspace), { platform: "linux", processCommandLineImpl: () => null });
  assert.equal(reaped[0].status, "running");
});

test("pid sidecar round-trips identity and still reads the legacy bare integer", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-sidecar", status: "queued", phase: "queued", pid: null, logFile: null });
  updateJobPid(workspace, "job-sidecar", 777, "linux:777");
  assert.deepEqual(resolveJobPid(workspace, listJobs(workspace)[0]), { pid: 777, identity: "linux:777" });
  fs.writeFileSync(resolveJobPidFile(workspace, "job-sidecar"), "778\n");
  assert.deepEqual(resolveJobPid(workspace, { id: "job-sidecar", status: "queued", pid: null }), { pid: 778, identity: null });
  updateJobPid(workspace, "job-sidecar", 779, "linux:779");
  assert.deepEqual(resolveJobPid(workspace, { id: "job-sidecar", status: "queued", pid: null }), { pid: 779, identity: "linux:779" });
});

test("runTrackedJob records the worker identity and clears it with the pid", async () => {
  const workspace = makeTempDir();
  const job = { id: "job-identity", workspaceRoot: workspace, status: "queued", logFile: null };
  seedJob(workspace, job);
  let running = null;
  await runTrackedJob(job, async () => {
    running = readJobFile(resolveJobFile(workspace, "job-identity"));
    return { exitStatus: 0, payload: {}, rendered: "", summary: "" };
  });
  assert.equal(running.pid, process.pid);
  const ownIdentity = getProcessIdentity(process.pid);
  assert.equal(running.pidIdentity, ownIdentity);
  if (process.platform === "win32") {
    assert.match(String(running.pidIdentity), /^win32:\d+$/, "a Windows worker records its start-time identity");
  }
  const done = readJobFile(resolveJobFile(workspace, "job-identity"));
  assert.deepEqual([done.pid, done.pidIdentity], [null, null]);
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-identity");
  assert.deepEqual([indexed.pid, indexed.pidIdentity], [null, null]);
});

test("reapDeadJobs on win32 probes the live identities in one batch after the cheap checks and fails only the reused pid", () => {
  const workspace = makeTempDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore" });
  try {
    const jobs = [
      { id: "job-a", status: "running", pid: process.pid, pidIdentity: "win32:1" },
      { id: "job-b", status: "running", pid: child.pid, pidIdentity: "win32:2" },
      { id: "job-c", status: "completed", pid: 1, pidIdentity: "win32:9" }
    ];
    for (const job of jobs) seedJob(workspace, job);
    const probes = [];
    const reaped = reapDeadJobs(workspace, jobs, {
      platform: "win32",
      getProcessIdentitiesImpl: (pids) => { probes.push([...pids].sort((a, b) => a - b)); return new Map(pids.map((pid) => [pid, pid === process.pid ? "win32:1" : "win32:other"])); }
    });
    assert.deepEqual(probes, [[process.pid, child.pid].sort((a, b) => a - b)], "one probe, only for records that passed the terminal/liveness checks");
    assert.equal(reaped.find((j) => j.id === "job-a").status, "running");
    assert.equal(reaped.find((j) => j.id === "job-b").status, "failed");
    assert.match(reaped.find((j) => j.id === "job-b").errorMessage, /pid reused/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("reapDeadJobs on win32 memoises a matching probe for 2 s and never reuses a null", () => {
  const workspace = makeTempDir();
  const jobs = [{ id: "j", status: "running", pid: process.pid, pidIdentity: "win32:1" }];
  seedJob(workspace, jobs[0]);
  for (const answer of ["win32:1", null]) {
    resetWin32ProbeMemo();
    let clock = 1000;
    let calls = 0;
    const options = { platform: "win32", now: () => clock, getProcessIdentitiesImpl: (pids) => { calls += 1; return new Map(pids.map((pid) => [pid, answer])); } };
    reapDeadJobs(workspace, jobs, options);
    clock += 1999;
    reapDeadJobs(workspace, jobs, options);
    assert.equal(calls, answer === null ? 2 : 1, `within the TTL (${answer}) only a match is served from the memo`);
    clock += 2;
    reapDeadJobs(workspace, jobs, options);
    assert.equal(calls, answer === null ? 3 : 2, `after the TTL (${answer}) it probes again`);
  }
});

test("reapDeadJobs on win32 reuses a memo only for a cached match; a different recorded identity is probed fresh", () => {
  const workspace = makeTempDir();
  resetWin32ProbeMemo();
  let clock = 1000;
  let calls = 0;
  const options = { platform: "win32", now: () => clock, getProcessIdentitiesImpl: (pids) => { calls += 1; return new Map(pids.map((pid) => [pid, "win32:A"])); } };
  const a = { id: "j-a", status: "running", pid: process.pid, pidIdentity: "win32:A" };
  seedJob(workspace, a);
  reapDeadJobs(workspace, [a], options);
  reapDeadJobs(workspace, [a], options);
  assert.equal(calls, 1, "a cached match skips the probe");
  const b = { id: "j-b", status: "running", pid: process.pid, pidIdentity: "win32:B" };
  seedJob(workspace, b);
  clock += 100;
  const reaped = reapDeadJobs(workspace, [b], options);
  assert.equal(calls, 2, "the cached identity differs from the record: probe fresh");
  assert.equal(reaped[0].status, "failed", "the fresh probe (not the cache) judges the reused pid");
  // A cached mismatch never changes job state on its own.
  resetWin32ProbeMemo();
  calls = 0;
  const mismatch = { platform: "win32", now: () => clock, getProcessIdentitiesImpl: (pids) => { calls += 1; return new Map(pids.map((pid) => [pid, calls === 1 ? "win32:X" : "win32:B"])); } };
  const c = { id: "j-c", status: "running", pid: process.pid, pidIdentity: "win32:B" };
  seedJob(workspace, c);
  reapDeadJobs(workspace, [c], mismatch);
  const d = { id: "j-d", status: "running", pid: process.pid, pidIdentity: "win32:B" };
  seedJob(workspace, d);
  const again = reapDeadJobs(workspace, [d], mismatch);
  assert.equal(calls, 2);
  assert.equal(again[0].status, "running", "the second probe matched; the earlier mismatch was not trusted");
});

test("reapDeadJobs on win32 leaves every job alone when the batch answers nothing", () => {
  const workspace = makeTempDir();
  const jobs = [{ id: "job-x", status: "running", pid: process.pid, pidIdentity: "win32:1" }];
  seedJob(workspace, jobs[0]);
  const reaped = reapDeadJobs(workspace, jobs, { platform: "win32", getProcessIdentitiesImpl: () => new Map() });
  assert.equal(reaped[0].status, "running");
});

test("reapDeadJobs on posix keeps its per-pid probe and per-pid budget", () => {
  const seen = [];
  let clock = 0;
  const workspace = makeTempDir();
  const job = { id: "j", status: "running", pid: process.pid, pidIdentity: "x:1" };
  seedJob(workspace, job);
  reapDeadJobs(workspace, [job], {
    platform: "linux",
    remainingMs: () => 1500 - clock,
    getProcessIdentityImpl: (pid, opts) => { seen.push(opts.timeoutMs); clock += 700; return "x:1"; },
    getProcessIdentitiesImpl: () => assert.fail("posix must not batch")
  });
  assert.deepEqual(seen, [1500]);
});

// A 2 s budget is shorter than a cold PowerShell start (up to 3 s): the probe
// times out, the launcher's breaker opens for a minute, and the cancel that
// follows is refused as identity-unavailable without ever running.
test("reapDeadJobs on win32 gives the batch probe a cold-start budget bounded by the deadline", () => {
  const seen = [];
  const impl = (pids, opts) => { seen.push(opts.timeoutMs); return new Map(pids.map((p) => [p, null])); };
  const workspace = makeTempDir();
  const jobs = [{ id: "j", status: "running", pid: process.pid, pidIdentity: "win32:1" }];
  seedJob(workspace, jobs[0]);
  reapDeadJobs(workspace, jobs, { platform: "win32", getProcessIdentitiesImpl: impl });
  resetWin32ProbeMemo();
  reapDeadJobs(workspace, jobs, { platform: "win32", getProcessIdentitiesImpl: impl, remainingMs: () => 1500 });
  assert.deepEqual(seen, [6000, 1500]);
});

// A cancel between the spawn and a slow (win32 PowerShell) identity probe must
// already find the worker's pid: the sidecar is written first, the identity after.
test("recordWorkerPid writes the pid sidecar before the identity probe runs", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-spawned", status: "queued", pid: null, logFile: null });
  let seenDuringProbe = null;
  recordWorkerPid(workspace, "job-spawned", 4242, {
    getProcessIdentityImpl: (pid) => {
      seenDuringProbe = resolveJobPid(workspace, { id: "job-spawned", status: "queued", pid: null });
      return `win32:${pid}`;
    }
  });
  assert.deepEqual(seenDuringProbe, { pid: 4242, identity: null }, "the pid must be recorded before the probe returns");
  assert.deepEqual(resolveJobPid(workspace, { id: "job-spawned", status: "queued", pid: null }), { pid: 4242, identity: "win32:4242" });
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-spawned");
  assert.deepEqual([indexed.pid, indexed.pidIdentity], [4242, "win32:4242"]);
});

// A cancel inside the (win32, seconds-long) identity probe removes the sidecar
// and writes `cancelled`; the probe's second write must not bring the pid back.
test("recordWorkerPid does not revive the sidecar of a job cancelled during the probe", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-mid-probe", status: "queued", pid: null, logFile: null });
  recordWorkerPid(workspace, "job-mid-probe", 4244, {
    getProcessIdentityImpl: (pid) => {
      upsertJob(workspace, { id: "job-mid-probe", status: "cancelled", pid: null, pidIdentity: null });
      removeJobPidFile(workspace, "job-mid-probe");
      return `win32:${pid}`;
    }
  });
  assert.equal(fs.existsSync(resolveJobPidFile(workspace, "job-mid-probe")), false, "a cancelled job must not get its sidecar back");
  const indexed = listJobs(workspace).find((entry) => entry.id === "job-mid-probe");
  assert.deepEqual([indexed.status, indexed.pid, indexed.pidIdentity], ["cancelled", null, null]);
});

// A cancel that landed between the spawn and the worker's start already wrote
// the terminal record: the worker must not take it over and run the turn.
test("runTrackedJob refuses a job that is already cancelled and leaves its record alone", async () => {
  const workspace = makeTempDir();
  const cancelled = { id: "job-cancelled", workspaceRoot: workspace, status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user.", logFile: null };
  seedJob(workspace, cancelled);
  writeJobPidFile(workspace, "job-cancelled", 4243, null);
  writeJobRequestFile(workspace, "job-cancelled", { prompt: "x" });
  let ran = false;
  const execution = await runTrackedJob(cancelled, async () => {
    ran = true;
    return { exitStatus: 0, payload: {}, rendered: "", summary: "" };
  });
  assert.equal(ran, false, "the turn must not run");
  assert.equal(execution, null);
  const stored = readJobFile(resolveJobFile(workspace, "job-cancelled"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.startedAt, undefined, "no running record was written");
  assert.equal(listJobs(workspace).find((entry) => entry.id === "job-cancelled").status, "cancelled");
  assert.equal(fs.existsSync(resolveJobPidFile(workspace, "job-cancelled")), false);
  assert.equal(fs.existsSync(resolveJobRequestFile(workspace, "job-cancelled")), false);
});
