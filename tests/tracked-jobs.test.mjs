import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { reapDeadJobs } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobRequestFile,
  resolveStateFile,
  updateJobPid,
  upsertJob,
  writeJobFile,
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

test("reapDeadJobs leaves jobs without a recorded pid untouched", () => {
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

test("updateJobPid records the worker pid without touching the rest of the queued record", () => {
  const workspace = makeTempDir();
  const job = seedQueuedJobWithPayload(workspace, "job-pid");

  updateJobPid(workspace, "job-pid", 424242);

  const stored = readJobFile(resolveJobFile(workspace, "job-pid"));
  assert.equal(stored.pid, 424242);
  assert.equal(stored.status, "queued");
  assert.equal(stored.phase, "queued");
  assert.equal(stored.requestFile, job.requestFile);
  assert.equal(listJobs(workspace).find((entry) => entry.id === "job-pid").pid, 424242);
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
