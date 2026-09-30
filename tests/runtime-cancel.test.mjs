import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  cimTree,
  initGitRepo,
  isAlive,
  IS_WIN,
  jobDiagnostics,
  makeTempDir,
  readJobRecord,
  readStateIndex,
  ROOT,
  run,
  SCRIPT,
  seededRepo,
  SESSION_HOOK,
  waitFor
} from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessIdentity } from "../plugins/codex/scripts/lib/process.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobPidFile,
  resolveStateDir,
  upsertJob,
  writeJobFile,
  writeJobPidFile
} from "../plugins/codex/scripts/lib/state.mjs";


test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  // A record without an identity (written by v1.2.x) is only signalled when the
  // pid's command line is still this job's worker (#743).
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "codex-companion.mjs", "task-worker", "--job-id", "task-live"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run(process.execPath, [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  if (IS_WIN) {
    // Documented v1.3.0 refusal: win32 cannot prove the pid is this job's worker
    // (identity-unavailable until v1.4.1), so the job stays running, exit 1.
    assert.equal(cancelResult.status, 1, cancelResult.stderr);
    assert.deepEqual(JSON.parse(cancelResult.stdout), { jobId: "task-live", status: "running", cancellationPending: true, reason: "identity-unavailable" });
    return;
  }
  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

// The #743 scenario through the no-identity command-line fallback: a record from
// before identities existed names a pid the OS has since handed to another
// companion process. The reaper cannot rule a companion out by command line, so
// it keeps the job; cancel must refuse to signal a process that is not this
// job's worker, say so, and not claim the job was cancelled — it stays running
// (sidecar kept) until the pid goes away. (A pid now running something that is
// not a companion at all is reaped instead; see tests/tracked-jobs.test.mjs.)
test("cancel through the no-identity command-line fallback refuses a foreign pid and keeps the job running", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  // Still a companion process (the reaper cannot rule it out by command line),
  // just not this job's worker.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "codex-companion.mjs", "task-worker", "--job-id", "task-other"], { detached: true, stdio: "ignore" });
  stranger.unref();
  t.after(() => {
    try { process.kill(stranger.pid, "SIGKILL"); } catch {}
  });
  const job = {
    id: "task-recycled",
    status: "running",
    phase: "delegating",
    title: "Codex Task",
    jobClass: "task",
    pid: stranger.pid,
    logFile: null,
    createdAt: new Date().toISOString()
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);
  writeJobPidFile(repo, job.id, stranger.pid);

  const cancel = run(process.execPath, [SCRIPT, "cancel", job.id], { cwd: repo });

  assert.equal(cancel.status, 1, cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`cancellation not confirmed: worker pid ${stranger.pid} left running \\(identity-mismatch\\)`));
  assert.match(cancel.stdout, /the job stays running until the worker exits/);
  const cancelJson = run(process.execPath, [SCRIPT, "cancel", job.id, "--json"], { cwd: repo });
  assert.equal(cancelJson.status, 1, cancelJson.stderr);
  assert.deepEqual(JSON.parse(cancelJson.stdout), { jobId: job.id, status: "running", cancellationPending: true, reason: "identity-mismatch" });
  const json = run(process.execPath, [SCRIPT, "status", job.id, "--json"], { cwd: repo });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).job.status, "running");
  assert.equal(fs.existsSync(resolveJobPidFile(repo, job.id)), true, "the pid sidecar must survive a refused cancel");
  process.kill(stranger.pid, 0); // still alive: throws ESRCH if cancel signalled it

  // Once the pid is gone the job reaches a terminal state the normal way.
  process.kill(stranger.pid, "SIGKILL");
  await waitFor(() => {
    try { process.kill(stranger.pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
  });
  const after = run(process.execPath, [SCRIPT, "status", job.id, "--json"], { cwd: repo });
  assert.equal(after.status, 0, after.stderr);
  assert.notEqual(JSON.parse(after.stdout).job.status, "running");
});

// The parent records the worker's identity next to its pid, so cancel can prove
// the pid is still that worker before signalling it.
test("a background worker's pid sidecar carries its identity and cancel signals it", async () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "8000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "slow"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const sidecar = JSON.parse(fs.readFileSync(resolveJobPidFile(repo, jobId), "utf8"));
  try {
    assert.ok(Number.isInteger(sidecar.pid));
    assert.equal(sidecar.identity, getProcessIdentity(sidecar.pid));
    assert.match(sidecar.identity, /^(linux|darwin|win32):/);
    // v1.4.1 refuses kills while the broker record has no identity (Windows start window).
    if (IS_WIN) {
      await waitFor(() => (/^win32:\d+$/.test(loadBrokerSession(repo)?.pidIdentity ?? "") ? "ready" : null));
    }
    const cancel = run(process.execPath, [SCRIPT, "cancel", jobId], { cwd: repo, env });
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.doesNotMatch(cancel.stdout, /left running/);
    await waitFor(() => {
      try { process.kill(sidecar.pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
    });
  } finally {
    try { process.kill(-sidecar.pid, "SIGKILL"); } catch { try { process.kill(sidecar.pid, "SIGKILL"); } catch {} }
  }
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run(process.execPath, [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run(process.execPath, [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run(process.execPath, [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel interrupts a brokered task and records cancelled only after the worker's own terminal record", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const runningJob = await waitFor(() => {
    const state = readStateIndex(repo);
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId && job.transport) {
      return job;
    }
    return null;
  }, { timeoutMs: 30000 });
  assert.equal(runningJob.transport, "broker");

  const cancelResult = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);
  const stored = readJobRecord(repo, jobId);
  assert.equal(stored.status, "cancelled", jobDiagnostics(repo, jobId));
  assert.deepEqual([stored.workerClosed, stored.appServerExited], [true, true], jobDiagnostics(repo, jobId));
  const log = fs.readFileSync(stored.logFile, "utf8");
  assert.ok(log.includes("Turn interrupted.") && log.indexOf("Turn interrupted.") < log.indexOf("Cancelled by user."), `the turn ended before the cancel wrote:\n${log}`);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

// The turn lives in the shared runtime, not in the worker: a cancel whose
// interrupt the runtime ignores must not claim success and must not kill the
// worker (the turn would keep running and the reaper would fail the job).
test("a brokered cancel whose interrupt is ignored stays pending and kills nothing; the next cancel ends the turn", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const running = await waitFor(() => { const job = readJobRecord(repo, jobId); return job.status === "running" && job.pid && job.turnId ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));
  assert.equal(running.transport, "broker", jobDiagnostics(repo, jobId));

  const first = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(first.status, 1, `cancel said: ${first.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.deepEqual(JSON.parse(first.stdout), { jobId, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(running.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readJobRecord(repo, jobId).status, "running", jobDiagnostics(repo, jobId));
  assert.match(fs.readFileSync(running.logFile, "utf8"), /left running \(turn-not-interrupted\)/);

  const second = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, `${second.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${second.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterrupted, true);
  assert.equal(readJobRecord(repo, jobId).status, "cancelled", jobDiagnostics(repo, jobId));
  await waitFor(() => !isAlive(running.pid));
});

// The direct path is trusted only when the job file and the index agree: the
// updater patches the index (locked) and then the file, so a file that says
// direct while the index says broker is forged or torn, and the kill (no turn
// end) would strand the turn.
test("a job file forged to transport direct does not take the direct kill path while the index says broker", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const running = await waitFor(() => { const job = readJobRecord(repo, jobId); return job.status === "running" && job.pid && job.turnId && job.transport === "broker" ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));

  // Only the job file is rewritten; the index keeps `broker`.
  writeJobFile(repo, jobId, { ...readJobFile(resolveJobFile(repo, jobId)), transport: "direct" });
  assert.equal(readJobRecord(repo, jobId).transport, "direct", jobDiagnostics(repo, jobId));

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 1, `cancel said: ${cancel.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.deepEqual(JSON.parse(cancel.stdout), { jobId, status: "running", cancellationPending: true, reason: "turn-not-interrupted" }, jobDiagnostics(repo, jobId));
  assert.equal(isAlive(running.pid), true, `no kill on a disagreeing transport\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(readJobRecord(repo, jobId).status, "running", jobDiagnostics(repo, jobId));
  assert.equal(listJobs(repo).find((entry) => entry.id === jobId)?.transport, "broker", "the index was never forged");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.ok(fakeState.lastInterrupt, `the interrupt was sent (brokered path)\n${jobDiagnostics(repo, jobId)}`);
});

test("cancelling an awaited job ends the await with exit 1 and leaves a readable result", async () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "6000" });

  const child = spawn(process.execPath, [SCRIPT, "task", "--await", "--await-timeout-ms", "30000", "--prompt-stdin"], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end("cancel me\n");
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });

  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const jobId = await waitFor(() => {
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs?.[0];
    // Wait for the worker to own the record: the turn has to be under way for
    // the cancel to have a running turn to interrupt.
    return job && job.status === "running" && job.pid ? job.id : null;
  }, { timeoutMs: 15000 });

  // v1.4.1 refuses kills while the broker record has no identity (Windows start window).
  if (IS_WIN) {
    await waitFor(() => (/^win32:\d+$/.test(loadBrokerSession(repo)?.pidIdentity ?? "") ? "ready" : null));
  }
  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled/i);
  assert.equal(await exited, 1);

  const stored = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).job.status, "cancelled");
});

// Direct transport (a cold --resume-last owns its app-server): cancel sends no
// turn/interrupt — no second client can reach that app-server, and the old
// attempt could start a codex of its own — and kills the worker's group. The
// worker ignores SIGTERM and outlives the kill as its app-server dies; its late
// write must not replace the acknowledged `cancelled` record.
test("a direct cancel skips the interrupt, and the cancellation survives a worker that finishes after it", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // Only the task worker ignores SIGTERM; the broker and fake codex keep the default.
  const preload = path.join(binDir, "worker-ignores-sigterm.mjs");
  fs.writeFileSync(preload, 'if (process.argv.includes("task-worker")) process.on("SIGTERM", () => {});\n');
  const env = buildEnv(binDir, {
    FAKE_CODEX_TURN_DELAY_MS: "20000",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim()
  });
  const launch = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "--prompt-stdin"], { cwd: repo, env, input: "cancel me late\n" });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const running = await waitFor(() => { const job = readJobRecord(repo, jobId); return job.status === "running" && job.pid && job.turnId ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  assert.equal(running.transport, "direct", jobDiagnostics(repo, jobId));
  const startsBefore = JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts;

  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, `${cancelled.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${cancelled.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterruptAttempted, false, "a direct job's app-server is the worker's own");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastInterrupt ?? null, null, "no turn/interrupt was sent");
  assert.equal(fakeState.appServerStarts, startsBefore, "cancel started no codex of its own");

  await waitFor(() => !isAlive(running.pid));
  const stored = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).job.status, "cancelled", jobDiagnostics(repo, jobId));
});

// Recording the worker pid on the queued record (so a queued job can be
// cancelled at all) means cancel can now kill a worker *before* it consumed its
// private one-shot payload. A cancelled job is terminal, so the reaper will
// never look at it again — cancel has to release the file itself. The worker's
// identity is recorded, so the kill is provable.
test("cancel removes the private request payload of a job killed in the queued window", async (t) => {
  const repo = seededRepo();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const secret = "sk-cancel-secret-value";
  const requestFile = path.join(jobsDir, "task-queued.request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ prompt: "hi", config: { auth_header: secret } }), {
    encoding: "utf8",
    mode: 0o600
  });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      // No process groups on Windows, or already gone.
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  const job = {
    id: "task-queued",
    status: "queued",
    phase: "queued",
    jobClass: "task",
    title: "Codex Task",
    background: true,
    pid: sleeper.pid,
    pidIdentity: getProcessIdentity(sleeper.pid),
    logFile: null,
    requestFile,
    request: { prompt: "hi", config: { auth_header: "[redacted]" } },
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:30:00.000Z"
  };
  fs.writeFileSync(path.join(jobsDir, "task-queued.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );

  const cancelled = run(process.execPath, [SCRIPT, "cancel", "task-queued", "--json"], { cwd: repo, env: process.env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

  assert.equal(fs.existsSync(requestFile), false, "the private payload must not outlive the cancelled job");
  const stored = readJobRecord(repo, "task-queued");
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.requestFile, null);
  assert.equal(fs.readFileSync(path.join(stateDir, "state.json"), "utf8").includes(secret), false);
});

test("cancel on Windows kills a direct worker and the codex.cmd tree under it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // A cold resume owns its own app-server, so the tree hangs under the worker, not the broker.
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readJobRecord(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  const running = await waitFor(() => { const j = readJobRecord(repo, jobId); return j.status === "running" && j.pidIdentity && j.threadId && j.turnId ? j : null; });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  assert.equal(running.transport, "direct");
  const tree = cimTree(running.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(tree.some((n) => /^cmd\.exe$/i.test(n.name)) && tree.filter((n) => /^node\.exe$/i.test(n.name)).length >= 2, `expected worker → cmd.exe → node.exe, got ${JSON.stringify(tree)}`);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).turnInterruptAttempted, false, "a direct job's app-server is the worker's own");
  await waitFor(() => (tree.every((n) => !isAlive(n.pid)) ? "gone" : null));
  assert.equal(readJobRecord(repo, jobId).status, "cancelled");
});

test("a brokered cancel on Windows kills nothing until the turn ends, leaves the shared broker and its subtree alive, and the same app-server serves the next job", { skip: !IS_WIN, timeout: 180_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  // The broker's app-server ignores only the first interrupt: the first cancel must stay pending, the second ends the turn; the "quick C" timeout interrupt is the third and is honoured.
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold A"], { cwd: repo, env });
  const jobA = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readJobRecord(repo, jobA); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  const running = await waitFor(() => { const j = readJobRecord(repo, jobA); return j.status === "running" && j.turnId ? j : null; });
  assert.equal(running.transport, "broker", jobDiagnostics(repo, jobA));
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, "worker A started the shared broker");
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  const brokerTree = cimTree(broker.pid);
  t.after(() => { for (const { pid } of brokerTree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(brokerTree.some((n) => /^cmd\.exe$/i.test(n.name)), `expected the app-server tree under the broker, got ${JSON.stringify(brokerTree)}`);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  // The broker is A's child by ParentProcessId on Windows; the kill must skip its whole subtree.
  const pending = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(pending.status, 1, `cancel said: ${pending.stdout.trim()}\n${jobDiagnostics(repo, jobA)}`);
  assert.deepEqual(JSON.parse(pending.stdout), { jobId: jobA, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(withPid.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readJobRecord(repo, jobA).status, "running", jobDiagnostics(repo, jobA));
  assert.equal(isAlive(broker.pid), true, "the shared broker is untouched by a pending cancel");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "and so is its subtree");
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobA)}`);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled", jobDiagnostics(repo, jobA));
  await waitFor(() => (!isAlive(withPid.pid) ? "gone" : null));
  assert.equal(isAlive(broker.pid), true, "the shared broker survives a worker kill");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "the broker's subtree survives");
  // The same app-server still serves: the fake holds every turn 60 s, so bound the next job by the turn timeout
  // and prove it went through the existing app-server (no second start) rather than a direct fallback.
  const next = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "3000", "--json", "quick C"], { cwd: repo, env, timeout: 60000 });
  assert.equal(next.error, undefined);
  assert.equal(next.status, 1, next.stderr);
  // The foreground JSON carries only the payload; the stored job carries the outcome.
  const jobC = readJobRecord(repo);
  assert.notEqual(jobC.id, jobA);
  assert.match(jobC.errorMessage ?? "", /turn timed out after 3000 ms/, "the next job really ran a turn (and hit its budget)");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1, "no second app-server was started for the next job");
  assert.equal(fakeState.lastTurnStart?.prompt, "quick C", "the turn went through the existing app-server");
  assert.equal(loadBrokerSession(repo)?.pid, broker.pid, "no replacement broker was started");
});

test("a root that died before cancel is failed by the reaper on Windows; nothing is signalled by number", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readJobRecord(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readJobRecord(repo, jobId); return j.status === "running" && j.turnId ? j : null; });
  const tree = cimTree(withPid.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  process.kill(withPid.pid, "SIGKILL");
  await waitFor(() => (!isAlive(withPid.pid) ? "dead" : null));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0, "the reaper already failed the job; cancel has nothing active to signal");
  assert.equal(readJobRecord(repo, jobId).status, "failed");
  // The orphaned children are the documented limitation here: nothing is touched by number.
  assert.ok(tree.filter((n) => n.pid !== withPid.pid).some((n) => isAlive(n.pid)));
});

test("a reused-looking identity is never signalled on Windows: the reaper fails the job and cancel reports it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readJobRecord(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readJobRecord(repo, jobId); return j.status === "running" && j.pidIdentity ? j : null; });
  upsertJob(repo, { id: jobId, pidIdentity: "win32:1" });
  const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0);
  assert.equal(isAlive(withPid.pid), true, "the process holding the pid is a stranger to this record and must stay");
  const stored = readJobRecord(repo, jobId);
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage ?? "", /pid reused/);
});

test("a planted PowerShell in the workspace or a relative PATH entry is never what the identity probe runs", { skip: !IS_WIN, timeout: 90_000 }, () => {
  const repo = makeTempDir(); fs.mkdirSync(path.join(repo, "tools"));
  const marker = path.join(repo, "HIJACKED");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(repo, "powershell.exe"));
  for (const planted of ["powershell.cmd", path.join("tools", "powershell.cmd"), path.join("tools", "powershell.exe.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), `@echo off\r\necho x> "${marker}"\r\n`);
  }
  const testEnvUrl = pathToFileURL(path.join(ROOT, "tests", "test-env.mjs")).href;
  const processUrl = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "process.mjs")).href;
  const probe = run(process.execPath, ["--import", testEnvUrl, "-e", `import(${JSON.stringify(processUrl)}).then(m => console.log(m.getProcessIdentity(process.pid) ?? 'null'))`], {
    cwd: repo, env: { ...process.env, PATH: `.;tools;${process.env.PATH}`, PSModulePath: path.join(repo, "tools") }
  });
  assert.match(probe.stdout.trim(), /^win32:\d+$/, probe.stderr);
  assert.equal(fs.existsSync(marker), false);
});
