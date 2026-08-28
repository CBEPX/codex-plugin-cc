import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  breakStaleLock,
  consumeJobRequestFile,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobRequestFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  withStateLock,
  writeJobRequestFile
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "codex",
  "scripts",
  "lib",
  "state.mjs"
);

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("job request payloads are written owner-only and consumed exactly once", () => {
  const workspace = makeTempDir();
  const payload = { prompt: "go", config: { "http_headers.Authorization": "SECRET" } };

  const requestFile = writeJobRequestFile(workspace, "task-1", payload);
  assert.equal(requestFile, resolveJobRequestFile(workspace, "task-1"));
  assert.equal(fs.statSync(requestFile).mode & 0o777, 0o600);

  assert.deepEqual(consumeJobRequestFile(workspace, "task-1"), payload);
  assert.equal(fs.existsSync(requestFile), false);
  assert.equal(consumeJobRequestFile(workspace, "task-1"), null);
});

test("saveState drops the private request payload of pruned jobs", () => {
  const workspace = makeTempDir();
  const requestFile = writeJobRequestFile(workspace, "task-dropped", { prompt: "go" });

  saveState(workspace, { jobs: [{ id: "task-dropped", updatedAt: "2026-01-01T00:00:00.000Z" }] });
  assert.equal(fs.existsSync(requestFile), true);

  saveState(workspace, { jobs: [] });
  assert.equal(fs.existsSync(requestFile), false);
});

// A reader that catches `state.json` mid-write parses a truncated file, and
// `loadState` turns that into "no jobs" — which is how a SessionEnd with a live
// job decided the workspace was idle and shut the shared broker down. Writers
// must swap the file in atomically so a reader sees the old or the new one.
test("concurrent writers never leave a torn state.json for a reader", async () => {
  const workspace = makeTempDir();
  const jobs = Array.from({ length: 50 }, (_, index) => ({
    id: `job-${index}`,
    status: "running",
    updatedAt: `2026-03-18T15:${String(index % 60).padStart(2, "0")}:00.000Z`,
    summary: "x".repeat(2048)
  }));
  saveState(workspace, { jobs });
  const stateFile = resolveStateFile(workspace);

  const writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { saveState } from ${JSON.stringify(pathToFileURL(STATE_MODULE).href)};
       const jobs = ${JSON.stringify(jobs)};
       const deadline = Date.now() + 2000;
       while (Date.now() < deadline) {
         saveState(${JSON.stringify(workspace)}, { jobs });
       }`
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] }
  );
  let writerStderr = "";
  writer.stderr.on("data", (chunk) => {
    writerStderr += chunk;
  });

  let reads = 0;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const raw = fs.readFileSync(stateFile, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      assert.fail(`torn read after ${reads} reads (${raw.length} bytes): ${error.message}`);
    }
    assert.equal(parsed.jobs.length, 50, `torn read after ${reads} reads: lost jobs`);
    reads += 1;
  }

  await new Promise((resolve) => writer.on("exit", resolve));
  assert.equal(writerStderr, "");
  assert.ok(reads > 100, `expected the reader to race the writer, got ${reads} reads`);
});

const STATE_MODULE_URL = JSON.stringify(pathToFileURL(STATE_MODULE).href);

function runModule(source) {
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"]
  });
}

function collectExit(child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
}

// `updateState` reads, mutates and writes without serialization, and `saveState`
// deletes the artifacts of every job that is in the file it read but not in the
// snapshot it is about to write. A second process that creates a job inside that
// window is therefore not just lost from the index: its job file, private request
// payload, PID sidecar and log are deleted under it.
test("a job created during another process's read-modify-write survives it", async () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [{ id: "job-a", status: "completed", updatedAt: "2026-03-18T15:00:00.000Z" }] });

  const holder = runModule(`
    import { updateState } from ${STATE_MODULE_URL};
    updateState(${JSON.stringify(workspace)}, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    });
  `);
  const holderExit = collectExit(holder);

  // Let the holder get past its read and into the slow part of its mutation.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const enqueue = run(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { upsertJob, writeJobFile, writeJobRequestFile } from ${STATE_MODULE_URL};
    const workspace = ${JSON.stringify(workspace)};
    writeJobFile(workspace, "job-b", { id: "job-b", status: "queued" });
    writeJobRequestFile(workspace, "job-b", { prompt: "hello" });
    upsertJob(workspace, { id: "job-b", status: "queued" });
    `
  ], { env: process.env });
  assert.equal(enqueue.status, 0, enqueue.stderr);

  const finished = await holderExit;
  assert.equal(finished.code, 0, finished.stderr);

  const ids = listJobs(workspace).map((job) => job.id).sort();
  assert.deepEqual(ids, ["job-a", "job-b"], "neither writer may lose the other's job");
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-b")), true, "the new job's file must not be pruned");
  assert.equal(fs.existsSync(resolveJobRequestFile(workspace, "job-b")), true, "the new job's payload must not be pruned");
});

// A holder that dies with the lock held (SIGKILL, OOM, host reboot) must not
// wedge the workspace: the next writer proves the holder is gone and takes over
// on the spot.
test("a state lock whose holder is gone is taken over", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const dead = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "holder.json"),
    JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString() }),
    "utf8"
  );

  const started = Date.now();
  upsertJob(workspace, { id: "job-after-crash", status: "queued" });

  assert.ok(Date.now() - started < 1000, `a dead holder must be taken over at once, took ${Date.now() - started} ms`);
  assert.deepEqual(listJobs(workspace).map((job) => job.id), ["job-after-crash"]);
});

// The lock that actually wedged a SessionEnd: a worker killed mid-acquire left a
// directory nothing could attribute to a process, so the dead-holder rule had
// nothing to read and only the 30 s age rule was left — long past the bounded
// wait. Acquisition is atomic now, and a lock without usable holder info is
// treated as abandoned after a couple of seconds.
test("a state lock with no usable holder info does not outlast the bounded wait", () => {
  const lockDirFor = (workspace) => path.join(resolveStateDir(workspace), "state.lock");

  const emptyLock = makeTempDir();
  saveState(emptyLock, { jobs: [] });
  fs.mkdirSync(lockDirFor(emptyLock), { recursive: true });
  let started = Date.now();
  upsertJob(emptyLock, { id: "job-after-empty-lock", status: "queued" });
  assert.ok(Date.now() - started < 3000, "a lock left half-taken must not block a writer");
  assert.deepEqual(listJobs(emptyLock).map((job) => job.id), ["job-after-empty-lock"]);

  const junkLock = makeTempDir();
  saveState(junkLock, { jobs: [] });
  fs.mkdirSync(lockDirFor(junkLock), { recursive: true });
  fs.writeFileSync(path.join(lockDirFor(junkLock), "holder.json"), "{not json", "utf8");
  started = Date.now();
  upsertJob(junkLock, { id: "job-after-junk-lock", status: "queued" });
  assert.ok(Date.now() - started < 3000, "an unreadable holder file must not block a writer");
  assert.deepEqual(listJobs(junkLock).map((job) => job.id), ["job-after-junk-lock"]);
});

// The bounded wait is what keeps a wedged holder from hanging every command in
// the workspace: the writer reports the lock instead of blocking forever.
test("withStateLock gives up when a live holder never releases", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");

  assert.throws(
    () => withStateLock(workspace, () => "never runs", { waitMs: 150 }),
    /state lock/i
  );
});

// Both writers find the same dead holder at the same moment. Takeover has to be a
// single winner-takes-it step, or both delete and both enter: two processes doing
// read-modify-write on state.json is precisely the data loss the lock exists to
// prevent.
test("two writers that both find a stale lock still run one at a time", async () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const dead = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "holder.json"),
    JSON.stringify({ pid: dead.pid, token: dead.pid + "-gone", startedAt: new Date().toISOString() }),
    "utf8"
  );

  const trace = path.join(workspace, "trace.log");
  const contender = (name) => `
    import fs from "node:fs";
    import { upsertJob, withStateLock } from ${STATE_MODULE_URL};
    const workspace = ${JSON.stringify(workspace)};
    const trace = ${JSON.stringify(trace)};
    withStateLock(workspace, () => {
      fs.appendFileSync(trace, "enter ${name}" + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      upsertJob(workspace, { id: "job-${name}", status: "queued" });
      fs.appendFileSync(trace, "leave ${name}" + "\\n");
    });
  `;

  const [first, second] = await Promise.all([
    collectExit(runModule(contender("a"))),
    collectExit(runModule(contender("b")))
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const steps = fs.readFileSync(trace, "utf8").trim().split("\n");
  assert.deepEqual(
    steps.map((line) => line.split(" ")[0]),
    ["enter", "leave", "enter", "leave"],
    `critical sections overlapped: ${steps.join(" | ")}`
  );
  assert.deepEqual(listJobs(workspace).map((job) => job.id).sort(), ["job-a", "job-b"]);
});

// Age says nothing about health: a holder that is alive may simply be slow, and
// stealing its lock puts a second writer inside the critical section. Only a
// holder that is gone can be evicted; a genuinely stuck one is the operator's
// call, and the waiter says so instead of helping itself.
test("a lock held by a live process is never taken over, however old it is", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const holder = {
    pid: process.pid,
    token: `${process.pid}-live`,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  };
  fs.writeFileSync(path.join(lockDir, "holder.json"), JSON.stringify(holder), "utf8");

  assert.throws(() => withStateLock(workspace, () => "stolen", { waitMs: 200 }), /state lock/i);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(lockDir, "holder.json"), "utf8")),
    holder,
    "a live holder's lock must survive"
  );
});

// A writer whose lock was taken over must not take its successor's lock down with
// it on the way out. The PID is not enough to tell them apart — it is reused, and
// the successor can even be this same process later — so the holder carries a
// one-off token.
test("release only removes a lock this process still owns", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const holderFile = path.join(resolveStateDir(workspace), "state.lock", "holder.json");
  const successor = { pid: process.pid, token: `${process.pid}-successor`, startedAt: new Date().toISOString() };

  withStateLock(workspace, () => {
    fs.writeFileSync(holderFile, JSON.stringify(successor), "utf8");
  });

  assert.equal(fs.existsSync(holderFile), true, "a successor's lock must survive our release");
  assert.deepEqual(JSON.parse(fs.readFileSync(holderFile, "utf8")), successor);
});

// Judging a lock stale and breaking it are two separate steps, and a lot can
// happen in between: another waiter that judged the same lock stale can break it
// and acquire it before this one gets to its own rename. Renaming that live lock
// aside would put two writers in the critical section — and the winner's release
// would then silently do nothing, because the lock it holds is gone.
test("the stale-lock breaker leaves a successor's lock alone", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  const holderFile = path.join(lockDir, "holder.json");
  const dead = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });

  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    holderFile,
    JSON.stringify({ pid: dead.pid, token: `${dead.pid}-gone`, startedAt: new Date().toISOString() }),
    "utf8"
  );
  // What a waiter reads when it decides this lock is stale.
  const judged = JSON.parse(fs.readFileSync(holderFile, "utf8"));

  // Another waiter got there first: it broke the stale lock and is now holding
  // its own, under a live pid and a fresh token.
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir, { recursive: true });
  const successor = { pid: process.pid, token: `${process.pid}-successor`, startedAt: new Date().toISOString() };
  fs.writeFileSync(holderFile, JSON.stringify(successor), "utf8");

  breakStaleLock(lockDir, judged);

  assert.equal(fs.existsSync(holderFile), true, "the successor's lock must survive a late breaker");
  assert.deepEqual(JSON.parse(fs.readFileSync(holderFile, "utf8")), successor);
  assert.throws(() => withStateLock(workspace, () => "stolen", { waitMs: 150 }), /state lock/i);
});

// A `running` legacy job has already consumed its request: the worker reads the
// payload (or the record) BEFORE `runTrackedJob` flips the record to `running`.
// Staging a payload for it would write plaintext `--config` values that nothing
// ever reads and nothing ever deletes — only a `queued` record still has a worker
// coming for them.
test("migrating a running legacy record does not stage a payload nobody consumes", () => {
  const workspace = makeTempDir();
  const legacy = {
    id: "job-running-legacy",
    status: "running",
    request: { prompt: "old", config: { "model_providers.x.http_headers.Cookie": "SESSION_SECRET" } }
  };
  const jobFile = resolveJobFile(workspace, legacy.id);
  fs.writeFileSync(jobFile, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const view = readJobFile(jobFile);

  assert.equal(view.request.config["model_providers.x.http_headers.Cookie"], "[redacted]");
  assert.equal(fs.readFileSync(jobFile, "utf8").includes("SESSION_SECRET"), false, "the record must be redacted on disk");
  assert.equal(
    fs.existsSync(resolveJobRequestFile(workspace, legacy.id)),
    false,
    "a running job's request has already been consumed; staging it again only leaks it"
  );
});

// The re-check alone is only a narrower window. The fence is a tombstone named
// after the generation being broken: exactly one process can create it, so only
// that process may rename the lock aside. A breaker that finds the tombstone
// taken does not break at all — it goes back to waiting on whatever lock is
// there now, which by then may be the winner's live one.
test("only one breaker may take over a given lock generation", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const stateDir = resolveStateDir(workspace);
  const lockDir = path.join(stateDir, "state.lock");
  const holderFile = path.join(lockDir, "holder.json");
  const dead = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
  const holder = { pid: dead.pid, token: `${dead.pid}-gone`, startedAt: new Date().toISOString() };
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(holderFile, JSON.stringify(holder), "utf8");

  // Another breaker owns this generation's takeover.
  const tomb = path.join(stateDir, `state.lock.tomb-${holder.token}`);
  fs.mkdirSync(tomb);

  breakStaleLock(lockDir, holder);
  assert.equal(fs.existsSync(holderFile), true, "a breaker that lost the fence must not touch the lock");

  // The winner finished and dropped its tombstone.
  fs.rmdirSync(tomb);
  breakStaleLock(lockDir, holder);
  assert.equal(fs.existsSync(lockDir), false, "the breaker that wins the fence takes the lock over");
  assert.equal(fs.existsSync(tomb), false, "a finished break must not leave its tombstone behind");

  // And the workspace is usable again.
  upsertJob(workspace, { id: "job-after-takeover", status: "queued" });
  assert.deepEqual(listJobs(workspace).map((job) => job.id), ["job-after-takeover"]);
});

// A breaker that dies mid-break must not fence off its generation forever.
test("a tombstone left behind by a dead breaker is reclaimed", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const stateDir = resolveStateDir(workspace);
  const lockDir = path.join(stateDir, "state.lock");
  const dead = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
  const holder = { pid: dead.pid, token: `${dead.pid}-gone`, startedAt: new Date().toISOString() };
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "holder.json"), JSON.stringify(holder), "utf8");

  const tomb = path.join(stateDir, `state.lock.tomb-${holder.token}`);
  fs.mkdirSync(tomb);
  const longAgo = new Date(Date.now() - 60000);
  fs.utimesSync(tomb, longAgo, longAgo);

  breakStaleLock(lockDir, holder);

  assert.equal(fs.existsSync(lockDir), false, "an abandoned tombstone must not block the takeover");
  assert.equal(fs.existsSync(tomb), false, "the reclaimed tombstone must not be left behind");
});
