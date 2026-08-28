import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { reapDeadJobs, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import {
  listJobs,
  readJobFile,
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

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

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

  const reaped = reapDeadJobs(workspace, listJobs(workspace));

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
  assert.equal(resolveJobPid(workspace, stored), 424242, "readers must find the pid in the sidecar");
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
  assert.equal(resolveJobPid(workspace, stored), null, "a terminal record never reports a pid");
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
