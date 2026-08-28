import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
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

const LOCK_DIR = "state.lock.d";

function lockDirFor(workspace) {
  const lockDir = path.join(resolveStateDir(workspace), LOCK_DIR);
  fs.mkdirSync(lockDir, { recursive: true });
  return lockDir;
}

function seedLockEntry(lockDir, name, pid, startedAt = new Date().toISOString()) {
  const entry = path.join(lockDir, name);
  fs.writeFileSync(entry, `${JSON.stringify({ pid, startedAt })}\n`, "utf8");
  return entry;
}

function deadPid() {
  const finished = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
  assert.equal(finished.status, 0);
  return finished.pid;
}

// The property the whole lock exists for, checked the only way that means
// anything: a counter that is read, incremented and written back — non-atomic by
// construction, so any overlap loses increments.
test("two processes acquiring concurrently never overlap", async () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const counter = path.join(workspace, "counter.json");
  fs.writeFileSync(counter, "0", "utf8");

  const rounds = 100;
  const worker = `
    import fs from "node:fs";
    import { withStateLock } from ${STATE_MODULE_URL};
    const workspace = ${JSON.stringify(workspace)};
    const counter = ${JSON.stringify(counter)};
    for (let round = 0; round < ${rounds}; round += 1) {
      withStateLock(workspace, () => {
        const value = Number.parseInt(fs.readFileSync(counter, "utf8"), 10);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        fs.writeFileSync(counter, String(value + 1), "utf8");
      });
    }
  `;

  const [first, second] = await Promise.all([collectExit(runModule(worker)), collectExit(runModule(worker))]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(Number.parseInt(fs.readFileSync(counter, "utf8"), 10), rounds * 2, "an overlap lost increments");
});

// A holder that died with its ticket in the directory releases it to the next
// acquirer immediately — its PID proves it is gone.
test("a ticket whose holder is gone is removed and the waiter acquires at once", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  const gone = deadPid();
  const ticket = seedLockEntry(lockDir, `1.${gone}-gone.ticket`, gone);

  const started = Date.now();
  assert.equal(withStateLock(workspace, () => "ok"), "ok");

  assert.ok(Date.now() - started < 1000, `a dead holder must not cost a grace period, took ${Date.now() - started} ms`);
  assert.equal(fs.existsSync(ticket), false, "the dead holder's ticket must be cleared");
});

// The opposite rule, and the one that keeps two writers apart: a holder that is
// still running keeps its ticket however long it has been working — a slow holder
// and a stuck one are indistinguishable from out here. The waiter gives up and
// says exactly which process to look at.
test("a ticket held by a live process is never removed and the waiter times out naming it", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  const ticket = seedLockEntry(lockDir, `1.${process.pid}-live.ticket`, process.pid, new Date(Date.now() - 600000).toISOString());

  assert.throws(
    () => withStateLock(workspace, () => "stolen", { waitMs: 200 }),
    (error) =>
      /state lock/i.test(error.message) &&
      error.message.includes(`pid ${process.pid}`) &&
      error.message.includes(ticket) &&
      /pid reuse/.test(error.message)
  );
  assert.equal(fs.existsSync(ticket), true, "a live holder's ticket must survive");
});

// A process killed between announcing its choice and taking a number leaves a
// `choosing` file behind. Every acquirer waits for those, so one that nobody will
// ever come back for would wedge the workspace.
test("a choosing file left by a dead process does not block the next acquirer", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  const gone = deadPid();
  const chooser = seedLockEntry(lockDir, `choosing.${gone}-crashed`, gone);

  const started = Date.now();
  assert.equal(withStateLock(workspace, () => "ok"), "ok");

  assert.ok(Date.now() - started < 1000, `a dead chooser must not cost a grace period, took ${Date.now() - started} ms`);
  assert.equal(fs.existsSync(chooser), false, "the crashed chooser's file must be cleared");
});

// Bakery order: a waiter that arrived while the lock was held is served before one
// that arrives later, and a latecomer can never take a lower number than a waiter
// already in line.
test("a latecomer queues behind the waiter that was already in line", async () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const trace = path.join(workspace, "trace.log");

  const participant = (name, holdMs) => `
    import fs from "node:fs";
    import { withStateLock } from ${STATE_MODULE_URL};
    withStateLock(${JSON.stringify(workspace)}, () => {
      fs.appendFileSync(${JSON.stringify(trace)}, "enter ${name}" + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      fs.appendFileSync(${JSON.stringify(trace)}, "leave ${name}" + "\\n");
    });
  `;

  const holder = collectExit(runModule(participant("holder", 900)));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const early = collectExit(runModule(participant("early", 50)));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const late = collectExit(runModule(participant("late", 50)));

  for (const finished of await Promise.all([holder, early, late])) {
    assert.equal(finished.code, 0, finished.stderr);
  }

  const steps = fs.readFileSync(trace, "utf8").trim().split("\n");
  assert.deepEqual(
    steps,
    ["enter holder", "leave holder", "enter early", "leave early", "enter late", "leave late"],
    `the queue was not served in order: ${steps.join(" | ")}`
  );
});

// Two acquirers can take the same number — they read the tickets at the same
// moment — so the number alone cannot decide. The token breaks the tie, and both
// tickets are judged the same way: the dead one goes, the live one holds the line.
test("tickets that tie on a number are ordered and judged individually", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  const gone = deadPid();
  const abandoned = seedLockEntry(lockDir, `3.${gone}-aaa.ticket`, gone);
  const live = seedLockEntry(lockDir, `3.${process.pid}-zzz.ticket`, process.pid);

  assert.throws(
    () => withStateLock(workspace, () => "stolen", { waitMs: 300 }),
    (error) => error.message.includes(`pid ${process.pid}`) && error.message.includes(live)
  );
  assert.equal(fs.existsSync(abandoned), false, "the dead ticket in the tie must be cleared");
  assert.equal(fs.existsSync(live), true, "the live ticket in the tie must survive");
});

// A queue that cannot be read is not an empty queue. Answering a listing failure
// with "nobody is ahead of me" is fail-open: a directory that allows creating
// files but not listing them (or a transient I/O error) would put two processes in
// the critical section at once.
test(
  "a lock directory that cannot be listed fails the acquisition, not the queue",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  () => {
    const workspace = makeTempDir();
    saveState(workspace, { jobs: [] });
    const lockDir = lockDirFor(workspace);
    const foreign = seedLockEntry(lockDir, `1.${process.pid}-live.ticket`, process.pid);

    let ran = false;
    // Write and search allowed, read denied: files can still be created and
    // unlinked, but the directory cannot be listed.
    fs.chmodSync(lockDir, 0o300);
    try {
      assert.throws(() => withStateLock(workspace, () => {
        ran = true;
      }, { waitMs: 200 }), /EACCES/);
    } finally {
      fs.chmodSync(lockDir, 0o700);
    }

    assert.equal(ran, false, "the callback must not run when the queue cannot be read");
    assert.equal(fs.existsSync(foreign), true, "a foreign ticket must not be touched");
    assert.deepEqual(
      fs.readdirSync(lockDir),
      [path.basename(foreign)],
      "a failed acquisition must take its own entries back out of the queue"
    );
  }
);

// A blocker that is judged abandoned but cannot actually be unlinked used to be a
// hot loop with no exit: clearing an entry skipped the deadline check, so the
// waiter span the CPU forever instead of giving up. (Unlink can only ever fail on
// a foreign entry — a permission or filesystem problem, modelled here by a
// directory, which `unlink` refuses on every POSIX platform.)
test("a blocker that cannot be removed still ends at the deadline", { timeout: 10000 }, () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  const stuck = path.join(lockDir, `1.${deadPid()}-unremovable.ticket`);
  fs.mkdirSync(stuck);
  const longAgo = new Date(Date.now() - 600000);
  fs.utimesSync(stuck, longAgo, longAgo);

  const started = Date.now();
  assert.throws(() => withStateLock(workspace, () => "never", { waitMs: 300 }), /state lock/i);

  assert.ok(Date.now() - started < 5000, `the wait must end at its own deadline, took ${Date.now() - started} ms`);
  assert.deepEqual(fs.readdirSync(lockDir), [path.basename(stuck)], "the waiter must take its own entries back out");
});

// `statSync` failing is not "the entry is infinitely old". When the entry's own
// content cannot be read either, a swallowed stat error left the age comparison
// with NaN, which read as "abandoned" — so the waiter unlinked a live holder's
// ticket and walked into the critical section behind it.
function withStatFailure(targetPath, error, run) {
  const real = fs.statSync;
  fs.statSync = (candidate, ...rest) => {
    if (String(candidate) === targetPath) {
      throw Object.assign(new Error(`${error}: injected, stat '${candidate}'`), { code: error });
    }
    return real.call(fs, candidate, ...rest);
  };
  try {
    return run();
  } finally {
    fs.statSync = real;
  }
}

test("a stat failure on a foreign entry fails the acquisition instead of evicting it", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  // Present but unreadable, so the decision falls to the entry's age.
  const foreign = path.join(lockDir, `1.${process.pid}-live.ticket`);
  fs.writeFileSync(foreign, "{ not json", "utf8");

  let ran = false;
  assert.throws(
    () =>
      withStatFailure(foreign, "EIO", () =>
        withStateLock(workspace, () => {
          ran = true;
        }, { waitMs: 200 })
      ),
    /EIO/
  );

  assert.equal(ran, false, "the callback must not run when an entry cannot be judged");
  assert.equal(fs.existsSync(foreign), true, "a foreign entry must not be evicted on a stat failure");
  assert.deepEqual(fs.readdirSync(lockDir), [path.basename(foreign)], "the waiter must take its own entries back out");
});

// The one stat error that is an answer: the entry was released between the listing
// and the look, so it is simply not in the queue any more. Modelled truthfully —
// the file really is removed as the waiter reaches for it.
test("an entry that vanishes between listing and stat is not a blocker", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  const lockDir = lockDirFor(workspace);
  const foreign = path.join(lockDir, `1.${process.pid}-live.ticket`);
  fs.writeFileSync(foreign, "{ not json", "utf8");

  const realStat = fs.statSync;
  fs.statSync = (candidate, ...rest) => {
    if (String(candidate) === foreign) {
      fs.rmSync(foreign, { force: true });
    }
    return realStat.call(fs, candidate, ...rest);
  };

  let ran = false;
  try {
    withStateLock(workspace, () => {
      ran = true;
    }, { waitMs: 1000 });
  } finally {
    fs.statSync = realStat;
  }

  assert.equal(ran, true, "a vanished entry must not hold up the queue");
  assert.deepEqual(fs.readdirSync(lockDir), [], "the lock must be released and nothing left behind");
});

// A budget of zero is not a reason to fail an acquisition nobody is contending:
// the wait is a bound on queueing, not on trying. It still must not queue.
test("a zero budget takes a free lock but does not queue", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });

  assert.equal(withStateLock(workspace, () => "ok", { waitMs: 0 }), "ok");

  const lockDir = lockDirFor(workspace);
  const held = seedLockEntry(lockDir, `1.${process.pid}-live.ticket`, process.pid);
  assert.throws(() => withStateLock(workspace, () => "queued", { waitMs: 0 }), /state lock/i);
  assert.equal(fs.existsSync(held), true, "the live holder keeps its ticket");
});
