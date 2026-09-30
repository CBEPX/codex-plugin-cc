import fs from "node:fs";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { deadPid, IS_WIN, makeTempDir, ROOT, run, SCRIPT, SESSION_HOOK, waitFor, waitForExit, waitUntil } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  clearBrokerSession,
  clearBrokerSessionIfEndpoint,
  ensureBrokerSession,
  loadBrokerSession,
  registerBrokerProcess,
  resolveBrokerStateFile,
  saveBrokerSession,
  sendBrokerShutdown,
  spawnBrokerProcess,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessIdentity, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { brokerExclusion } from "../plugins/codex/scripts/lib/job-control.mjs";
import { resolveStateDir, STATE_LOCK_TIMEOUT_CODE } from "../plugins/codex/scripts/lib/state.mjs";

const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A broker that self-terminates on idle must not leave its ownership record
// behind: a later SessionEnd hook would load it and signal a PID the OS may have
// recycled, and `status` would advertise an endpoint nothing is listening on.
test("broker clears its session record when it self-terminates on idle", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);

  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", workspace, "--idle-timeout", "300"],
    { cwd: workspace, env: buildEnv(binDir), stdio: ["ignore", "pipe", "pipe"] }
  );

  saveBrokerSession(workspace, {
    endpoint,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: child.pid
  });

  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 3000), true);
    const result = await waitForExit(child);
    assert.equal(result.code, 0);

    assert.equal(loadBrokerSession(workspace), null, "idle exit must clear the persisted broker record");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    clearBrokerSession(workspace);
  }
});

// The recorded PID may belong to an unrelated process by the time SessionEnd
// runs (the broker exited on idle and the OS recycled its PID). Teardown must
// prove the PID is this session's broker before it signals the process group.
test("session end teardown does not signal a recycled pid that is not this broker", async (t) => {
  if (process.platform === "win32") {
    t.skip("PID ownership is not verified on Windows");
    return;
  }

  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  // Detached so the impostor leads its own process group: that is what
  // terminateProcessTree's `kill(-pid)` actually reaches.
  const impostor = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  impostor.unref();

  saveBrokerSession(workspace, {
    endpoint,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: impostor.pid
  });

  try {
    const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
      cwd: workspace,
      env: process.env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: workspace })
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(isAlive(impostor.pid), true, "teardown must not signal a PID that is not the broker");
    assert.equal(loadBrokerSession(workspace), null, "stale broker record must be cleared");
  } finally {
    try {
      process.kill(-impostor.pid, "SIGKILL");
    } catch {
      try {
        process.kill(impostor.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    clearBrokerSession(workspace);
  }
});

function spawnOwnedBroker(workspace, { binDir, sessionDir, endpoint, env }) {
  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", workspace, "--pid-file", path.join(sessionDir, "broker.pid")],
    { cwd: workspace, env: env ?? buildEnv(binDir), stdio: ["ignore", "pipe", "pipe"] }
  );
  saveBrokerSession(workspace, {
    endpoint,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: child.pid
  });
  return child;
}

function runSessionEndHook(workspace, { env = process.env, sessionId = null } = {}) {
  return run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace,
    env: sessionId ? { ...env, CODEX_COMPANION_SESSION_ID: sessionId } : env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: workspace,
      ...(sessionId ? { session_id: sessionId } : {})
    })
  });
}

// `run` is spawnSync, which blocks this process's event loop — an in-process stub
// server could never accept the hook's connection. Anything that answers the hook
// from within the test has to run it asynchronously.
function runSessionEndHookAsync(workspace, { env = process.env, sessionId = null } = {}) {
  const child = spawn(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: workspace,
    env: sessionId ? { ...env, CODEX_COMPANION_SESSION_ID: sessionId } : env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(
    JSON.stringify({ hook_event_name: "SessionEnd", cwd: workspace, ...(sessionId ? { session_id: sessionId } : {}) })
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // `close`, not `exit`: the process can exit before its stdio is drained, and
  // callers assert on what it logged.
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

// Regression cover for the graceful path: the session that owns the broker ends,
// nothing else depends on it, so the process must be gone and the record must
// not survive to be signalled by a later hook.
test("session end shuts down the live broker it owns and clears its record", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnOwnedBroker(workspace, { binDir, sessionDir, endpoint });

  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 3000), true);

    const cleanup = runSessionEndHook(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);

    const exited = await waitForExit(child, { timeoutMs: 3000 });
    assert.equal(exited.code, 0, "the owned broker must exit on SessionEnd");
    assert.equal(loadBrokerSession(workspace), null, "the broker record must be cleared");
    assert.equal(fs.existsSync(parseBrokerEndpoint(endpoint).path), false, "the endpoint socket must be removed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    clearBrokerSession(workspace);
  }
});

// The broker is per-workspace, so a foreground job of ANOTHER Claude session is
// talking to it too. That job survives this session's cleanup (own jobs only)
// but used to be invisible to the active-job check, which only counted
// `background: true` — so this hook tore the shared runtime out from under a
// live foreign turn.
test("session end keeps the broker while another session's foreground job is running", async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnOwnedBroker(workspace, { binDir, sessionDir, endpoint });

  // Stands in for the other session's live foreground worker.
  const foreignWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "codex-companion.mjs", "task"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  foreignWorker.unref();

  t.after(() => {
    for (const pid of [foreignWorker.pid, child.pid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    clearBrokerSession(workspace);
  });

  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-foreign-foreground",
            status: "running",
            phase: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            pid: foreignWorker.pid,
            logFile: null,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          // The ending session's own finished job: makes the cleanup rewrite run.
          {
            id: "task-own-done",
            status: "completed",
            phase: "done",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            pid: null,
            logFile: null,
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  assert.equal(await waitForBrokerEndpoint(endpoint, 3000), true);

  const cleanup = runSessionEndHook(workspace, { env: buildEnv(binDir), sessionId: "sess-current" });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  assert.equal(
    loadBrokerSession(workspace)?.endpoint,
    endpoint,
    "SessionEnd must not tear down a broker another session's job is using"
  );
  assert.equal(isAlive(child.pid), true, "the shared broker process must survive a foreign active job");
  assert.equal(isAlive(foreignWorker.pid), true, "the foreign session's worker must not be signalled");

  const jobs = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs;
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["task-foreign-foreground"],
    "the foreign job record must survive while the ending session's own job is pruned"
  );
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].pid, foreignWorker.pid);
});

// A background job is dispatched to outlive its session, and it talks to Codex
// through the broker: SessionEnd must leave both alone, and the broker's own
// idle timer — not the hook — is what finally reclaims it.
test("session end keeps the broker while an owned background job runs, and the broker idle-exits after it finishes", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const env = buildEnv(binDir, {
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "2000",
    CODEX_COMPANION_SESSION_ID: "sess-current",
    FAKE_CODEX_TURN_DELAY_MS: "3000"
  });

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "keep me running"], { cwd: workspace, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const stateFile = path.join(resolveStateDir(workspace), "state.json");
  // A starting record (no pid yet) comes first; wait for the spawned broker.
  const broker = await waitUntil(() => (loadBrokerSession(workspace)?.pid ? loadBrokerSession(workspace) : null));
  assert.ok(broker, "the background worker must have started a broker");

  const cleanup = runSessionEndHook(workspace, { env, sessionId: "sess-current" });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  // The worker's broker is still there, and so is the job it belongs to.
  assert.equal(loadBrokerSession(workspace)?.endpoint, broker.endpoint, "SessionEnd must not tear down a broker a background job needs");
  assert.equal(isAlive(broker.pid), true, "the broker process must survive SessionEnd");
  const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.ok(jobs.some((job) => job.id === jobId), "the background job record must survive SessionEnd");

  const finished = await waitUntil(() => {
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((entry) => entry.id === jobId);
    return job && job.status !== "queued" && job.status !== "running" ? job : null;
  }, { timeoutMs: 20000 });
  assert.equal(finished?.status, "completed", `background job did not complete: ${JSON.stringify(finished)}`);

  // Nothing is connected any more, so the broker reclaims itself and takes its
  // own record with it.
  const cleared = await waitUntil(() => (loadBrokerSession(workspace) === null ? "cleared" : null), { timeoutMs: 10000 });
  assert.equal(cleared, "cleared", "the idle broker must clear its own record once the job is done");
  // The record is dropped first and the app-server child is closed after, so the
  // process disappears a moment later.
  const exited = await waitUntil(() => (isAlive(broker.pid) ? null : "exited"), { timeoutMs: 10000 });
  assert.equal(exited, "exited", "the idle broker must exit once the job is done");
});

// The broker's own `clearOwnSessionRecord` compares endpoints before deleting
// the record; the hook has to be just as careful, or a replacement broker that
// started while the old one was shutting down loses its ownership record and
// becomes unreachable.
test("session end does not clear the record of a replacement broker started during shutdown", async () => {
  const workspace = makeTempDir();
  const oldSessionDir = makeTempDir("cxc-");
  const newSessionDir = makeTempDir("cxc-");
  const oldEndpoint = createBrokerEndpoint(oldSessionDir);
  const newEndpoint = createBrokerEndpoint(newSessionDir);
  const replacement = {
    endpoint: newEndpoint,
    pidFile: path.join(newSessionDir, "broker.pid"),
    logFile: path.join(newSessionDir, "broker.log"),
    sessionDir: newSessionDir,
    pid: null
  };

  saveBrokerSession(workspace, {
    endpoint: oldEndpoint,
    pidFile: path.join(oldSessionDir, "broker.pid"),
    logFile: path.join(oldSessionDir, "broker.log"),
    sessionDir: oldSessionDir,
    pid: null
  });

  // Stands in for the broker that is shutting down: it accepts the graceful
  // `broker/shutdown`, and the replacement records itself inside that window.
  let replaced = false;
  const stub = net.createServer((socket) => {
    socket.once("data", () => {
      saveBrokerSession(workspace, replacement);
      replaced = true;
      setTimeout(() => socket.end(`${JSON.stringify({ id: 1, result: {} })}\n`), 100);
    });
  });
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(parseBrokerEndpoint(oldEndpoint).path, resolve);
  });

  try {
    const hook = spawn(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", cwd: workspace }));
    const code = await new Promise((resolve) => hook.on("exit", resolve));

    assert.equal(code, 0);
    assert.equal(replaced, true, "the replacement must have been recorded during the shutdown window");
    assert.equal(loadBrokerSession(workspace)?.endpoint, newEndpoint, "the replacement broker must keep its record");
  } finally {
    stub.close();
    clearBrokerSession(workspace);
  }
});

// A worker killed outright (SIGKILL/OOM) never writes a terminal status. If the
// active-background check trusts that stale `running` record, every later
// SessionEnd in the workspace takes the early return and the broker — plus its
// app-server child — lingers forever.
// Windows: the scenario kills the worker's process group with kill(-pid), which is POSIX-only.
test("session end reaps a SIGKILLed background worker instead of keeping its broker alive", { skip: IS_WIN }, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const env = buildEnv(binDir, {
    // Long enough that only the hook can be the reason the broker goes away.
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "20000",
    CODEX_COMPANION_SESSION_ID: "sess-current",
    FAKE_CODEX_TURN_DELAY_MS: "20000"
  });

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "die mid-turn"], { cwd: workspace, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const stateFile = path.join(resolveStateDir(workspace), "state.json");
  const running = await waitUntil(() => {
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((entry) => entry.id === jobId);
    return job && job.status === "running" && job.pid ? job : null;
  }, { timeoutMs: 20000 });
  assert.ok(running, "the background worker must have taken over its record");
  // A starting record (no pid yet) comes first; wait for the spawned broker.
  const broker = await waitUntil(() => (loadBrokerSession(workspace)?.pid ? loadBrokerSession(workspace) : null));
  assert.ok(broker, "the background worker must have started a broker");

  t.after(() => {
    for (const pid of [running.pid, broker.pid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    clearBrokerSession(workspace);
  });

  // The broker's log already has at least one "client disconnected" line from
  // its own readiness probe (`ensureBrokerSession` connects and immediately
  // closes). Count before the kill so the wait below is for a *new*
  // disconnect, not one already on record.
  const countDisconnects = () =>
    (fs.readFileSync(broker.logFile, "utf8").match(/client disconnected/g) ?? []).length;
  const disconnectsBeforeKill = countDisconnects();

  process.kill(-running.pid, "SIGKILL");
  await waitUntil(() => (isAlive(running.pid) ? null : "dead"));

  // The killed worker's socket close is async on the broker's side: `sockets`
  // (and therefore its busy check) is only accurate once the broker's own
  // "close" handler has run for THIS socket. Wait for that observable log
  // line rather than a fixed sleep, so this isn't racing the broker's event
  // loop.
  await waitUntil(() => (countDisconnects() > disconnectsBeforeKill ? "disconnected" : null));

  const cleanup = runSessionEndHook(workspace, { env, sessionId: "sess-current" });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  const exited = await waitUntil(() => (isAlive(broker.pid) ? null : "exited"), { timeoutMs: 5000 });
  // Read only on failure: a broker that did exit has already removed its log.
  const brokerLogTail = () => {
    try {
      return fs.readFileSync(broker.logFile, "utf8").split("\n").slice(-20).join("\n");
    } catch {
      return "(broker log gone)";
    }
  };
  assert.equal(
    exited,
    "exited",
    `a dead worker must not keep the broker alive; hook said: ${cleanup.stderr.trim()}\nbroker log tail:\n${exited === "exited" ? "" : brokerLogTail()}`
  );
  assert.equal(loadBrokerSession(workspace), null, "the broker record must be cleared");

  const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((entry) => entry.id === jobId);
  assert.equal(job.status, "failed", "the dead worker's job must be reaped");
  assert.equal(job.requestFile, null, "the reaped job must not keep its private payload path");
});

// The failure this reproduces: a background worker SIGKILLed while it was taking
// the workspace state lock left the lock directory behind with nothing inside to
// identify its holder. The dead-PID takeover had no PID to check, so the bounded
// wait expired and the SessionEnd hook died with "Timed out … waiting for the
// Codex state lock" — leaving the broker and its app-server child running.
test("session end recovers the lock a killed worker left behind", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnOwnedBroker(workspace, { binDir, sessionDir, endpoint });

  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 3000), true);

    const stateDir = resolveStateDir(workspace);
    fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify(
        {
          version: 1,
          config: { stopReviewGate: false },
          jobs: [
            {
              id: "task-finished",
              status: "completed",
              phase: "done",
              sessionId: "sess-current",
              updatedAt: "2026-03-24T20:05:00.000Z"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    // A worker SIGKILLed while it held the lock leaves its ticket behind; the
    // pre-1.2.0 lock directory alongside it must simply be ignored.
    const deadWorker = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
    const lockDir = path.join(stateDir, "state.lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, `1.${deadWorker.pid}-killed.ticket`),
      `${JSON.stringify({ pid: deadWorker.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    fs.mkdirSync(path.join(stateDir, "state.lock"), { recursive: true });

    const cleanup = runSessionEndHook(workspace, { env: buildEnv(binDir), sessionId: "sess-current" });
    assert.equal(cleanup.status, 0, cleanup.stderr);

    const exited = await waitForExit(child, { timeoutMs: 5000 });
    assert.equal(exited.code, 0, "an abandoned lock must not keep the broker alive");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    clearBrokerSession(workspace);
  }
});

function listenStub(endpoint, onConnection) {
  const stub = net.createServer(onConnection);
  return new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(parseBrokerEndpoint(endpoint).path, () => resolve(stub));
  });
}

// A starting record (no pid yet) belongs to a broker being spawned: SessionEnd
// keeps it and its files, whatever the handshake said.
test("session end keeps a starting broker record and its files", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "", "utf8");
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, state: "starting", pid: null, pidIdentity: null });
  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => socket.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
  });
  try {
    const cleanup = await runSessionEndHookAsync(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stderr, /pid=none signalled=false reason=starting kept=true/);
    assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "the starting record is kept");
    assert.equal(fs.existsSync(pidFile), true, "its files are kept");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// The record read at the top of SessionEnd can be a starting one that gains its
// pid and identity while the hook runs: teardown uses the record as it is now.
test("session end re-reads the broker record right before teardown", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const record = { endpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir };
  const idler = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const identity = getProcessIdentity(idler.pid);
  assert.ok(identity);
  saveBrokerSession(workspace, { ...record, state: "starting", pid: null, pidIdentity: null });
  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      // The start completes while the hook is shutting the broker down.
      saveBrokerSession(workspace, { ...record, state: "ready", pid: idler.pid, pidIdentity: identity });
      socket.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    });
  });
  try {
    const cleanup = await runSessionEndHookAsync(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stderr, new RegExp(`pid=${idler.pid} signalled=true`), cleanup.stderr);
    await waitForExit(idler, { timeoutMs: 10000 });
    assert.equal(loadBrokerSession(workspace), null, "the stopped broker's record is cleared");
  } finally {
    try { idler.kill("SIGKILL"); } catch {}
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// A socket is a byte stream, not a message stream: the reply can arrive in as
// many chunks as the kernel feels like. Parsing each chunk on its own turned a
// split `{"busy":true}` into a parse error — read as "not busy", which is how a
// SessionEnd would tear down a broker in the middle of another session's turn.
test("sendBrokerShutdown reads a busy reply that arrives in fragments", async () => {
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      socket.write('{"id":1,"result":{"bu');
      setTimeout(() => socket.write('sy":true}}\n'), 50);
    });
  });

  try {
    assert.deepEqual(await sendBrokerShutdown(endpoint), { busy: true });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
  }
});

// A peer that accepts the connection and never answers used to block the hook
// forever. It is also not proof of anything: an unanswered handshake must not be
// read as "idle, safe to destroy".
test("a broker that never answers is bounded and never assumed idle", { timeout: 20000 }, async () => {
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => sockets.push(socket));

  try {
    const started = Date.now();
    const outcome = await sendBrokerShutdown(endpoint);
    const elapsed = Date.now() - started;

    assert.equal(outcome.busy, null, "an unanswered handshake must report unknown, not idle");
    assert.ok(elapsed < 9000, `the handshake must be bounded, took ${elapsed} ms`);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
  }
});

test("session end leaves everything alone when the broker never answers", { timeout: 20000 }, async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "999999\n", "utf8");
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: null });

  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => sockets.push(socket));

  try {
    const cleanup = await runSessionEndHookAsync(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "an unconfirmed broker must keep its record");
    assert.equal(fs.existsSync(pidFile), true, "an unconfirmed broker must not be torn down");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// The broker counts every connected socket as a client, and a worker that was
// just SIGKILLed still has one until its close event is processed. A SessionEnd
// that reaped that very worker and then believed the resulting `busy` answer left
// the broker running for nothing — the phantom clears milliseconds later.
test("session end retries a busy answer that is about to clear", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "999999\n", "utf8");
  // A dead pid (a pid-less record is a starting broker, which SessionEnd keeps); win32 settles it by identity (241).
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: deadPid(), pidIdentity: IS_WIN ? "win32:1" : null });

  // Count the answers rather than the clock: under load the first handshake can
  // land after any wall-clock window, and then the retry path is never exercised.
  let answered = 0;
  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      const stillBusy = answered++ < 2;
      socket.write(`${JSON.stringify({ id: 1, result: stillBusy ? { busy: true } : {} })}\n`);
    });
  });

  try {
    const cleanup = await runSessionEndHookAsync(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(loadBrokerSession(workspace), null, `a busy answer that clears must not stop the teardown: ${cleanup.stderr.trim()}`);
    assert.equal(fs.existsSync(pidFile), false, "the pid file must be removed");
    assert.match(cleanup.stderr, /busyRetries=[1-9]/, "the decision line must report the retries");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// The other side of the same rule: a broker that is genuinely busy stays busy, and
// the retry window changes nothing about leaving it alone.
test("session end still leaves a persistently busy broker alone", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "999999\n", "utf8");
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: null });

  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => socket.write(`${JSON.stringify({ id: 1, result: { busy: true } })}\n`));
  });

  try {
    const cleanup = await runSessionEndHookAsync(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "a busy broker keeps its record");
    assert.equal(fs.existsSync(pidFile), true, "a busy broker keeps its pid file");
    assert.match(cleanup.stderr, /still serving another session/);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// Every step of this hook has a bound of its own — the state lock, each broker
// handshake, the busy retries — and they add up past any single one of them. Claude
// Code kills the hook at the timeout in hooks.json, so a `busy` answer followed by
// a broker that stops answering used to get the hook killed before it could decide
// anything. One absolute budget, clamped into every step, keeps the decision inside
// the host's timeout.
test("session end stays inside its budget when a busy broker then goes silent", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "999999\n", "utf8");
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: null });

  const sockets = [];
  let answered = 0;
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      answered += 1;
      // Busy once, then nothing at all.
      if (answered === 1) {
        socket.write(`${JSON.stringify({ id: 1, result: { busy: true } })}\n`);
      }
    });
  });

  const budgetMs = 3000;
  try {
    const started = Date.now();
    const cleanup = await runSessionEndHookAsync(workspace, {
      env: { ...process.env, CODEX_COMPANION_SESSION_END_BUDGET_MS: String(budgetMs) }
    });
    const elapsed = Date.now() - started;

    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.ok(elapsed < budgetMs + 2000, `the hook must stay inside its budget, took ${elapsed} ms: ${cleanup.stderr.trim()}`);
    assert.match(cleanup.stderr, /busyRetries=\d+/, "the decision line must report the retries");
    assert.match(cleanup.stderr, /leaving it running/, "the hook must log the decision it made");
    assert.doesNotMatch(cleanup.stderr, /ignored/, "an override below the ceiling must be honoured, not clamped");
    assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "an unconfirmed broker keeps its record");
    assert.equal(fs.existsSync(pidFile), true, "an unconfirmed broker keeps its pid file");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// The budget's ceiling is not negotiable from the environment: `hooks.json`'s
// timeout is a fixed number, so an override above the ceiling would push the
// deadline past the point where Claude Code kills the hook — reintroducing exactly
// the failure the budget prevents.
test("a SessionEnd budget override above the ceiling is ignored", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "999999\n", "utf8");
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: null });

  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => sockets.push(socket));

  try {
    const started = Date.now();
    const cleanup = await runSessionEndHookAsync(workspace, {
      env: { ...process.env, CODEX_COMPANION_SESSION_END_BUDGET_MS: "20000" }
    });
    const elapsed = Date.now() - started;

    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(
      cleanup.stderr,
      /budget override 20000 ignored: above the 12000 ms ceiling/,
      "an override above the ceiling must be refused, with a reason"
    );
    assert.ok(elapsed < 14000, `the effective budget must stay at the ceiling, took ${elapsed} ms`);
    assert.match(cleanup.stderr, /leaving it running/, "the hook must still log its decision");
    assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "an unconfirmed broker keeps its record");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    clearBrokerSession(workspace);
  }
});

// Reaping costs one lock acquisition per dead job, so a wedged lock holder used to
// cost the hook that bound N times over — and a wait that expires throws, which
// escaped as a crash with no decision at all. The waits are clamped to what is left
// of the budget, and a lock this hook cannot take is reported, not fatal.
test("session end reports a wedged state lock instead of dying on it", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  const deadJobs = [1, 2, 3].map((index) => {
    const finished = run(process.execPath, ["-e", "process.exit(0)"], { env: process.env });
    return {
      id: `task-dead-${index}`,
      status: "running",
      phase: "running",
      pid: finished.pid,
      background: true,
      updatedAt: "2026-03-24T20:05:00.000Z"
    };
  });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: deadJobs }, null, 2)}\n`,
    "utf8"
  );

  // A live holder: never evictable, so every acquisition can only time out.
  const lockDir = path.join(stateDir, "state.lock.d");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, `1.${process.pid}-wedged.ticket`),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    "utf8"
  );

  const budgetMs = 3000;
  const started = Date.now();
  const cleanup = await runSessionEndHookAsync(workspace, {
    env: { ...process.env, CODEX_COMPANION_SESSION_END_BUDGET_MS: String(budgetMs) }
  });
  const elapsed = Date.now() - started;

  assert.equal(cleanup.status, 0, `a lock this hook cannot take must not fail it: ${cleanup.stderr.trim()}`);
  assert.ok(elapsed < budgetMs + 2000, `the hook must stay inside its budget, took ${elapsed} ms`);
  assert.match(cleanup.stderr, /budgetExhausted=true/, "the decision line must say the budget decided it");
  assert.match(cleanup.stderr, /state lock/i, "the decision line must name the lock");
});

// Matching the message would swallow more than the timeout: the lock's own
// integrity error names the same lock, and any filesystem error whose path happens
// to contain the phrase reads the same way. Only the typed timeout may be absorbed;
// everything else has to fail the hook loudly.
test(
  "session end fails on a lock error that is not the timeout",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const workspace = makeTempDir();
    const pluginData = path.join(makeTempDir(), "state lock data");
    fs.mkdirSync(pluginData, { recursive: true });

    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    let stateDir;
    try {
      stateDir = resolveStateDir(workspace);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
    }
    // The lock's path now contains the phrase a message match would key on.
    assert.match(stateDir, /state lock/);

    fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify(
        {
          version: 1,
          config: { stopReviewGate: false },
          jobs: [{ id: "task-done", status: "completed", sessionId: "sess-current", updatedAt: "2026-03-24T20:05:00.000Z" }]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const lockDir = path.join(stateDir, "state.lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.chmodSync(lockDir, 0o000);

    try {
      const cleanup = await runSessionEndHookAsync(workspace, {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
        sessionId: "sess-current"
      });

      assert.equal(cleanup.status, 1, `a real lock failure must fail the hook: ${cleanup.stderr.trim()}`);
      assert.match(cleanup.stderr, /EACCES/, "the real error must reach the operator");
      assert.doesNotMatch(cleanup.stderr, /budgetExhausted/, "a real failure must not be reported as a spent budget");
    } finally {
      fs.chmodSync(lockDir, 0o700);
    }
  }
);

test("waitForBrokerEndpoint gives up on a socket that never connects or errors (#773)", async () => {
  let destroyed = 0;
  const connectImpl = () => {
    const socket = new EventEmitter();
    socket.destroy = () => { destroyed += 1; socket.emit("close"); };
    socket.end = () => {};
    return socket;
  };
  const started = Date.now();
  const ready = await waitForBrokerEndpoint("unix:/nonexistent/broker.sock", 600, { connectImpl });
  assert.equal(ready, false);
  assert.ok(Date.now() - started < 1500, "must respect the overall timeout");
  assert.ok(destroyed >= 1, "hung probe sockets must be destroyed");
});

test("waitForBrokerEndpoint reads a connected probe whose close is slow as ready", async () => {
  const connectImpl = () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.end = () => {};
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
  const started = Date.now();
  const ready = await waitForBrokerEndpoint("unix:/nonexistent/broker.sock", 600, { connectImpl });
  assert.equal(ready, true);
  assert.ok(Date.now() - started < 1500, "must resolve within the attempt window");
});

// Records every kill; a pid other than the test runner's own (a fresh broker that
// missed its readiness window on a slow machine) is really terminated, or it is
// orphaned.
function recordingKill(killed) {
  return (pid) => {
    killed.push(pid);
    if (pid !== process.pid) {
      terminateProcessTree(pid);
    }
  };
}

test("ensureBrokerSession kills a live unreachable broker before replacing it (#753/#762)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const staleEndpoint = createBrokerEndpoint(sessionDir); // nothing listens here
  saveBrokerSession(workspace, { endpoint: staleEndpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: process.pid });
  const killed = [];
  let probes = 0;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    isAliveImpl: () => true,
    ownsProcessImpl: () => { probes += 1; return true; },
    killProcess: recordingKill(killed),
    retryTimeoutMs: 300
  });
  try {
    // win32 (v1.3.0 documented refusal): a record without an identity is never
    // signalled (identity-unavailable until v1.4.1), so nothing is killed there.
    assert.deepEqual(killed, IS_WIN ? [] : [process.pid], "the unreachable but live broker must be signalled");
    assert.ok(probes >= 1);
    if (IS_WIN) {
      // The kill is refused (no identity): the record is kept and the request falls back to the direct transport.
      assert.equal(session, null);
      assert.equal(loadBrokerSession(workspace)?.endpoint, staleEndpoint, "the record is kept");
    } else {
      assert.ok(session && session.endpoint !== staleEndpoint, "a fresh broker must be spawned");
      assert.equal(loadBrokerSession(workspace)?.endpoint, session.endpoint);
    }
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

test("ensureBrokerSession never signals a dead or foreign pid from a stale record (#749)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  saveBrokerSession(workspace, { endpoint: createBrokerEndpoint(sessionDir), pidFile: null, logFile: null, sessionDir, pid: deadPid() });
  const killed = [];
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir), killProcess: recordingKill(killed) });
  try {
    assert.deepEqual(killed, []);
    assert.ok(session);
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }

  // Alive but not ours: the pid now belongs to something else.
  const foreignWorkspace = makeTempDir();
  const foreignDir = makeTempDir("cxc-");
  saveBrokerSession(foreignWorkspace, { endpoint: createBrokerEndpoint(foreignDir), pidFile: null, logFile: null, sessionDir: foreignDir, pid: process.pid });
  const foreignKilled = [];
  const replacement = await ensureBrokerSession(foreignWorkspace, {
    env: buildEnv(binDir),
    isAliveImpl: () => true,
    ownsProcessImpl: () => false,
    killProcess: recordingKill(foreignKilled)
  });
  try {
    assert.deepEqual(foreignKilled, []);
    assert.ok(replacement);
  } finally {
    if (replacement?.pid) { try { process.kill(replacement.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(foreignWorkspace);
  }
});

test("ensureBrokerSession retries the readiness probe before giving up on a slow broker (#768)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const server = net.createServer((socket) => socket.end());
  saveBrokerSession(workspace, { endpoint, pidFile: null, logFile: null, sessionDir, pid: process.pid });
  const killed = [];
  const sessionPromise = ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    isAliveImpl: () => true,
    ownsProcessImpl: () => true,
    killProcess: recordingKill(killed),
    retryTimeoutMs: 2000
  });
  let session = null;
  try {
    // Not listening yet during the first 150 ms probe; the 2 s retry must catch it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(parseBrokerEndpoint(endpoint).path, resolve);
    });
    session = await sessionPromise;
    assert.deepEqual(killed, [], "a broker that answers within the retry window must not be killed");
    assert.equal(session.endpoint, endpoint);
  } finally {
    session ??= await sessionPromise.catch(() => null);
    if (session?.pid && session.pid !== process.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    server.close();
    clearBrokerSession(workspace);
  }
});

test("saveBrokerSession writes atomically: no temp file is left and the record loads", () => {
  const workspace = makeTempDir();
  const renames = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([from, to]); return realRename(from, to); };
  try {
    saveBrokerSession(workspace, { endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(renames.length, 1, "the record is swapped in by one rename");
  assert.equal(renames[0][0], `${renames[0][1]}.${process.pid}.tmp`);
  assert.deepEqual(fs.readdirSync(resolveStateDir(workspace)).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(loadBrokerSession(workspace)?.endpoint, "unix:/tmp/x.sock");
});

test("saveBrokerSession rides out a transient EPERM on the rename on win32", () => {
  const workspace = makeTempDir();
  let calls = 0;
  const renameImpl = (from, to) => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    }
    fs.renameSync(from, to);
  };
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null }, { renameImpl, platform: "win32" });
  assert.equal(calls, 2);
  assert.equal(loadBrokerSession(workspace)?.endpoint, "unix:/tmp/x.sock");
  assert.throws(() => saveBrokerSession(workspace, { endpoint: "unix:/tmp/y.sock" }, { renameImpl: () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); }, platform: "linux" }), /locked/);
});

test("loadBrokerSession ignores a malformed record instead of trusting it", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "broker.json");
  const notes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => (notes.push(String(chunk)), true);
  try {
    for (const bad of [
      "[]",
      JSON.stringify({ endpoint: "ftp://x", pid: 1 }),
      JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: -5 }),
      JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: 1, pidFile: "relative/broker.pid" }),
      JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: 1, pidIdentity: 42 })
    ]) {
      fs.writeFileSync(file, bad);
      assert.equal(loadBrokerSession(workspace), null, bad);
    }
    fs.writeFileSync(file, JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null }));
    assert.ok(loadBrokerSession(workspace));
    fs.writeFileSync(file, JSON.stringify({ endpoint: "unix:/tmp/x.sock", pid: 1, pidIdentity: "linux:1" }));
    assert.ok(loadBrokerSession(workspace));
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(notes.length, 5);
  assert.ok(notes.every((note) => note.startsWith(`[codex] Ignoring malformed broker.json at ${file}: `)));
});

// The recorded pid is alive (it is this test runner) but its start identity is
// not the one the broker recorded: the pid was recycled, so it must not be
// signalled (#743).
test("SessionEnd leaves a recorded broker pid alone when its identity no longer matches (#743)", { skip: process.platform === "win32" }, async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  saveBrokerSession(workspace, { endpoint, pidFile: null, logFile: null, sessionDir, pid: process.pid, pidIdentity: "darwin:definitely-not-this|nope" });
  const hook = run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: workspace, env: buildEnv(binDir), input: JSON.stringify({ cwd: workspace, session_id: "sess-identity" }) });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /signalled=false/);
  assert.match(hook.stderr, /identity-mismatch/);
  clearBrokerSession(workspace);
});

// A broker this call just spawned that never becomes ready is killed as a process
// group: its pid cannot have been recycled while the child handle says it has not
// exited, so no identity is consulted. The handle's own kill is only the fallback.
test("ensureBrokerSession kills a fresh broker that never becomes ready as a process group", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const scriptDir = makeTempDir();
  const scriptPath = path.join(scriptDir, "never-listens.mjs");
  const descendantPidFile = path.join(scriptDir, "descendant.pid");
  // Like a broker stuck in connect: it has an app-server child and no cleanup
  // handlers yet, so only a process-group kill takes the descendant down.
  fs.writeFileSync(
    scriptPath,
    `import { spawn } from "node:child_process";\n` +
      `import fs from "node:fs";\n` +
      `const d = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
      `fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(d.pid));\n` +
      `setInterval(() => {}, 1000);\n`
  );
  const killed = [];
  const spawned = [];
  let descendant = null;
  try {
    const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir), scriptPath, timeoutMs: 500, killProcess: recordingKill(killed),
      // posix: the live child handle proves ownership, no identity needed. win32:
      // the verified tree kill runs on the real identity (no posix terminator).
      getProcessIdentityImpl: (pid) => (spawned.push(pid), IS_WIN ? getProcessIdentity(pid) : null)
    });
    assert.equal(session, null);
    assert.equal(spawned.length, 1);
    assert.deepEqual(killed, IS_WIN ? [] : [spawned[0]], "the live fresh child is killed as a process group (posix)");
    assert.equal(loadBrokerSession(workspace), null);
    descendant = Number(fs.readFileSync(descendantPidFile, "utf8"));
    const deadline = Date.now() + 5000;
    while ((isAlive(spawned[0]) || isAlive(descendant)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isAlive(spawned[0]), false, "the fresh child must be gone");
    assert.equal(isAlive(descendant), false, "its app-server descendant must be gone too");
  } finally {
    for (const pid of [...spawned, descendant].filter(Boolean)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

// A failed start is torn down through the verified kill with the identity it
// captured; the record and the files go only with a child that exited within the
// bounded wait. A live one keeps both (with an identity, re-probed once when the
// first probe had none), so SessionEnd or the next start can kill it verifiably.
test("ensureBrokerSession clears a failed start only once its child exited", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const scriptPath = path.join(makeTempDir(), "never-listens.mjs");
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
  for (const exits of [true, false]) {
    const workspace = makeTempDir();
    const spawned = [];
    const calls = [];
    let probes = 0;
    let files = null;
    try {
      const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir), scriptPath, timeoutMs: 300,
        spawnBrokerProcessImpl: (args) => ((files = args), spawnBrokerProcess(args)),
        // The alive case's first probe fails: the kept record gets the retried identity.
        getProcessIdentityImpl: (pid) => (spawned.push(pid), (probes += 1) === 1 && !exits ? null : `win32:${pid}`),
        terminateRecordedProcessImpl: (pid, options) => {
          calls.push({ pid, identity: options.identity, timeoutMs: options.timeoutMs });
          if (exits) process.kill(pid, "SIGKILL");
          // "delivered" either way: only the child's exit settles it.
          return { attempted: true, delivered: true, reason: "identity-match" };
        }
      });
      assert.equal(session, null);
      assert.deepEqual(calls, [{ pid: spawned[0], identity: exits ? `win32:${spawned[0]}` : null, timeoutMs: 4000 }], "one verified kill with the captured identity");
      const record = loadBrokerSession(workspace);
      if (exits) {
        assert.equal(record, null, "an exited child's record is cleared");
        assert.equal(fs.existsSync(files.logFile), false, "and its files removed");
      } else {
        assert.equal(record?.pid, spawned[0], "a live child's record is kept");
        assert.equal(record.pidIdentity, `win32:${spawned[0]}`, "kept with the identity of the retried probe");
        assert.equal(fs.existsSync(files.logFile), true, "a live child's files are kept");
        assert.equal(probes, 2, "one identity retry while the child lives");
      }
    } finally {
      for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
      clearBrokerSession(workspace);
    }
  }
});

// Two starts: the second finds the first's record inside the state lock (it
// appeared between its own read and the lock) and waits for that broker instead
// of spawning a second one.
test("ensureBrokerSession claims inside the lock: a start that finds a record there does not spawn", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const spawned = [];
  let second = null;
  let started = false;
  const options = {
    env: buildEnv(binDir),
    spawnBrokerProcessImpl: (args) => {
      const child = spawnBrokerProcess(args);
      spawned.push(child.pid);
      return child;
    },
    createBrokerEndpoint: (dir, platform) => {
      if (!started) {
        started = true;
        // Runs to its first await: its starting record, spawn and pid are on disk before this call's lock.
        second = ensureBrokerSession(workspace, options);
      }
      return createBrokerEndpoint(dir, platform);
    }
  };
  const first = await ensureBrokerSession(workspace, options);
  const other = await second;
  try {
    assert.equal(spawned.length, 1, "one broker");
    assert.ok(other);
    assert.equal(first?.endpoint, other.endpoint, "the first call waited for the second's broker");
    assert.equal(loadBrokerSession(workspace)?.pid, spawned[0]);
  } finally {
    for (const pid of spawned) { try { process.kill(pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

// A fresh child that exited during the readiness wait has a pid the OS may
// already have handed on: nothing may be signalled by number.
test("ensureBrokerSession never signals the pid of a fresh broker that already exited", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const scriptPath = path.join(makeTempDir(), "exits-at-once.mjs");
  fs.writeFileSync(scriptPath, "process.exit(0);\n");
  const killed = [];
  const spawned = [];
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir), scriptPath, timeoutMs: 500, killProcess: recordingKill(killed),
    getProcessIdentityImpl: (pid) => (spawned.push(pid), null)
  });
  assert.equal(session, null);
  assert.equal(spawned.length, 1);
  assert.deepEqual(killed, [], "an exited child's pid must not be signalled");
  assert.equal(loadBrokerSession(workspace), null);
});

// A legacy record (no identity) is re-checked by command line when the kill
// happens, not only before the 2 s readiness retry: the pid may be recycled
// during that wait.
test("ensureBrokerSession re-verifies a legacy broker's ownership after the readiness retry", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  saveBrokerSession(workspace, { endpoint: createBrokerEndpoint(sessionDir), pidFile: null, logFile: null, sessionDir, pid: process.pid });
  const killed = [];
  let probes = 0;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    isAliveImpl: () => true,
    // Ours before the retry; the command line changed during it.
    ownsProcessImpl: () => (probes += 1) === 1,
    killProcess: recordingKill(killed),
    retryTimeoutMs: 300
  });
  try {
    // win32 (v1.3.0 documented refusal): teardown refuses an identity-less record
    // before any kill-time recheck, so only the first probe happens there.
    if (!IS_WIN) assert.ok(probes >= 2, "ownership must be checked again at kill time");
    assert.deepEqual(killed, []);
    if (IS_WIN) {
      assert.equal(session, null, "the refused kill falls back to the direct transport");
      assert.equal(loadBrokerSession(workspace)?.pid, process.pid, "the record is kept");
    } else {
      assert.ok(session);
    }
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

// SessionEnd may only drop a foreground job's record once its worker is stopped
// (or provably gone). A kill it refused or never reached leaves the worker
// running, and dropping the record would orphan it along with its files.
function spawnWorkerStandIn(t, commandLineTail) {
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...commandLineTail], { detached: true, stdio: "ignore" });
  worker.unref();
  t.after(() => {
    try {
      process.kill(worker.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  return worker;
}

function seedForegroundJobs(workspace, jobs) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  for (const job of jobs) {
    fs.writeFileSync(path.join(jobsDir, `${job.id}.request.json`), "{}\n");
    fs.writeFileSync(path.join(jobsDir, `${job.id}.pid`), `${JSON.stringify({ pid: job.pid, identity: job.pidIdentity ?? null })}\n`);
  }
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: jobs.map((job) => ({
        status: "running",
        phase: "running",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-current",
        logFile: null,
        createdAt: "2026-09-27T10:00:00.000Z",
        updatedAt: "2026-09-27T10:01:00.000Z",
        ...job
      }))
    }, null, 2)}\n`
  );
  return { stateDir, jobsDir };
}

test("session end keeps the record of a foreground worker it refused to signal", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  // A companion, but not this job's worker: the legacy command-line check refuses it.
  const foreign = spawnWorkerStandIn(t, ["codex-companion.mjs", "task-worker", "--job-id", "task-someone-else"]);
  // A stored identity that is not the live pid's.
  const mismatched = spawnWorkerStandIn(t, ["codex-companion.mjs", "task-worker", "--job-id", "task-own-mismatch"]);
  const { stateDir, jobsDir } = seedForegroundJobs(workspace, [
    { id: "task-own-legacy", pid: foreign.pid },
    { id: "task-own-mismatch", pid: mismatched.pid, pidIdentity: "darwin:definitely-not-this|nope" }
  ]);

  const hook = runSessionEndHook(workspace, { sessionId: "sess-current" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /\[codex\] SessionEnd left task-own-legacy running: identity-mismatch/);
  assert.match(hook.stderr, /\[codex\] SessionEnd left task-own-mismatch running: identity-mismatch/);
  assert.equal(isAlive(foreign.pid), true);
  assert.equal(isAlive(mismatched.pid), true);

  const jobs = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs;
  assert.deepEqual(jobs.map((job) => job.id).sort(), ["task-own-legacy", "task-own-mismatch"]);
  const legacy = jobs.find((job) => job.id === "task-own-legacy");
  assert.equal(legacy.status, "running");
  assert.equal(fs.existsSync(path.join(jobsDir, "task-own-legacy.request.json")), true);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-own-legacy.pid")), true);
  // The identity mismatch is the reaper's call afterwards (the recorded worker is
  // gone from that pid); the record itself is never silently dropped.
  assert.ok(jobs.find((job) => job.id === "task-own-mismatch"));
});

test("session end keeps the records of foreground jobs its budget never reached", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  // Would be signalled if reached: the command line is this job's worker.
  const worker = spawnWorkerStandIn(t, ["codex-companion.mjs", "task-worker", "--job-id", "task-own-unreached"]);
  const { stateDir, jobsDir } = seedForegroundJobs(workspace, [{ id: "task-own-unreached", pid: worker.pid }]);

  const hook = runSessionEndHook(workspace, { sessionId: "sess-current", env: { ...process.env, CODEX_COMPANION_SESSION_END_BUDGET_MS: "1" } });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /\[codex\] SessionEnd left task-own-unreached running: /);
  assert.equal(isAlive(worker.pid), true);
  const jobs = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs;
  assert.deepEqual(jobs.map((job) => [job.id, job.status]), [["task-own-unreached", "running"]]);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-own-unreached.request.json")), true);
});

// Probe timeouts are halves of what is left of the budget; an odd remainder gave
// spawnSync a fractional timeout, it threw, and the kill was logged `kill-failed`
// with the worker kept. Several workers make an odd remainder all but certain.
test("session end stops foreground workers on an odd budget", { skip: process.platform === "win32" }, async (t) => {
  const workspace = makeTempDir();
  const ids = ["a", "b", "c", "d", "e", "f"].map((suffix) => `task-own-odd-${suffix}`);
  const workers = ids.map((id) => spawnWorkerStandIn(t, ["codex-companion.mjs", "task-worker", "--job-id", id]));
  const { stateDir } = seedForegroundJobs(workspace, ids.map((id, index) => ({ id, pid: workers[index].pid })));

  const hook = runSessionEndHook(workspace, { sessionId: "sess-current", env: { ...process.env, CODEX_COMPANION_SESSION_END_BUDGET_MS: "1001" } });
  assert.equal(hook.status, 0, hook.stderr);
  assert.doesNotMatch(hook.stderr, /kill-failed/);
  assert.doesNotMatch(hook.stderr, /SessionEnd left/);
  const jobs = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs;
  assert.deepEqual(jobs, []);
});

// The broker's own SIGTERM handler (`clearOwnSessionRecord`) deletes the same
// broker.json concurrently with the SessionEnd hook. A pre-check with
// `existsSync` still loses that race: the file can vanish between the check and
// the unlink. `clearBrokerSession` must tolerate a record that is simply not there.
test("clearBrokerSession on a workspace with no broker.json returns without throwing", () => {
  const workspace = makeTempDir();
  assert.doesNotThrow(() => clearBrokerSession(workspace));
});

test("clearBrokerSession tolerates a broker that already cleared its own record", () => {
  const workspace = makeTempDir();
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null });
  clearBrokerSession(workspace);
  // The second call hits exactly the file-already-gone race the broker's own
  // cleanup can win against the hook.
  assert.doesNotThrow(() => clearBrokerSession(workspace));
  assert.equal(loadBrokerSession(workspace), null);
});

test("teardownBrokerSession tolerates a pidFile, logFile, and sessionDir the broker already removed", () => {
  const sessionDir = makeTempDir("cxc-");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.rmdirSync(sessionDir);

  const result = teardownBrokerSession({ pidFile, logFile, sessionDir });
  assert.deepEqual(result, { signalled: false, reason: "no-pid", kept: false });
});

// The pidFile/logFile unlinks are best-effort cleanup, not a contract the hook can
// fail on: a locked file (EPERM, notably on Windows per upstream #633/#626) or any
// other unlink failure must not escape teardown.
test("teardownBrokerSession swallows unlink failures on pidFile and logFile as best-effort cleanup", () => {
  const workspace = makeTempDir();
  // pidFile's directory does not exist at all (ENOENT on the unlink).
  const pidFile = path.join(workspace, "missing-dir", "broker.pid");
  // logFile's parent path component is a regular file, not a directory (ENOTDIR).
  const regularFile = path.join(workspace, "not-a-directory");
  fs.writeFileSync(regularFile, "");
  const logFile = path.join(regularFile, "broker.log");

  const result = teardownBrokerSession({ pidFile, logFile, sessionDir: null });
  assert.deepEqual(result, { signalled: false, reason: "no-pid", kept: false });
});

test("teardownBrokerSession keeps the records on Windows when the outcome is unknown and asked to", () => {
  const cases = [
    ["win32", true, { attempted: false, delivered: false, reason: "identity-unavailable" }, true],
    ["win32", true, { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 7, identity: "win32:9" }] }, true],
    ["win32", true, { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }, true],
    ["win32", true, { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, false],
    ["win32", true, { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }, false],
    ["win32", false, { attempted: false, delivered: false, reason: "identity-unavailable" }, false],
    ["linux", true, { attempted: false, delivered: false, reason: "identity-unavailable" }, false]
  ];
  for (const [platform, keepOnUnknown, outcome, keptExpected] of cases) {
    const sessionDir = makeTempDir();
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    fs.writeFileSync(pidFile, "999999");
    fs.writeFileSync(logFile, "");
    const result = teardownBrokerSession({ pidFile, logFile, sessionDir, pid: 999999, pidIdentity: "win32:1", killProcess: () => {}, timeoutMs: 1000, platform, keepOnUnknown, terminateRecordedProcessImpl: () => outcome });
    assert.equal(result.kept, keptExpected, `${platform} keepOnUnknown=${keepOnUnknown} ${JSON.stringify(outcome)}`);
    assert.equal(result.reason, outcome.reason);
    assert.equal(fs.existsSync(pidFile), keptExpected, "records survive exactly when kept");
    assert.equal(fs.existsSync(logFile), keptExpected);
  }
  // A starting record (pid or not: its broker is being started) is kept on every platform, files included.
  for (const platform of ["win32", "linux"]) {
    const dir = makeTempDir();
    const pidFile = path.join(dir, "broker.pid");
    const logFile = path.join(dir, "broker.log");
    fs.writeFileSync(pidFile, "");
    fs.writeFileSync(logFile, "");
    assert.deepEqual(teardownBrokerSession({ pidFile, logFile, sessionDir: dir, pid: null, state: "starting", killProcess: () => assert.fail("nothing to kill"), platform, keepOnUnknown: true }), { signalled: false, reason: "starting", kept: true });
    assert.equal(fs.existsSync(pidFile) && fs.existsSync(logFile), true, `${platform}: nothing unlinked`);
  }
  // No pid at all is settled: nothing to keep.
  const sessionDir = makeTempDir();
  assert.deepEqual(teardownBrokerSession({ pidFile: null, logFile: null, sessionDir, pid: null, killProcess: () => {}, platform: "win32", keepOnUnknown: true }), { signalled: false, reason: "no-pid", kept: false });
});

test("ensureBrokerSession records the broker's pid before it captures the identity (start window)", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  let inWindow = null;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    getProcessIdentityImpl: (pid) => {
      inWindow = loadBrokerSession(workspace);
      return `win32:${pid}`;
    }
  });
  try {
    assert.ok(session);
    assert.equal(inWindow?.pid, session.pid, "the provisional record carries the pid");
    assert.equal(inWindow.pidIdentity, null);
    assert.equal(inWindow.endpoint, session.endpoint);
    assert.equal(brokerExclusion(inWindow), null, "a record without identity refuses kills");
    const final = loadBrokerSession(workspace);
    assert.equal(final.pidIdentity, `win32:${session.pid}`);
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

test("ensureBrokerSession writes a starting record under the state lock before it spawns", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  let atSpawn = null;
  let lockEntries = null;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    spawnBrokerProcessImpl: (args) => {
      atSpawn = loadBrokerSession(workspace);
      lockEntries = fs.readdirSync(path.join(resolveStateDir(workspace), "state.lock.d")).filter((name) => name.endsWith(".ticket"));
      return spawnBrokerProcess(args);
    }
  });
  try {
    assert.ok(session);
    assert.equal(typeof atSpawn?.startedAt, "number", "the starting record carries its start time");
    assert.deepEqual(atSpawn, { endpoint: session.endpoint, pidFile: session.pidFile, logFile: session.logFile, sessionDir: session.sessionDir, state: "starting", startedAt: atSpawn.startedAt, pid: null, pidIdentity: null });
    assert.equal(brokerExclusion(atSpawn), null, "a starting record refuses kills");
    assert.equal(lockEntries.length, 1, "the spawn happens under the state lock");
  } finally {
    if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

test("ensureBrokerSession waits for a starting record's broker instead of replacing it", async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  saveBrokerSession(workspace, { endpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, state: "starting", pid: null, pidIdentity: null });
  const server = net.createServer((socket) => socket.end());
  t.after(() => server.close());
  setTimeout(() => server.listen(parseBrokerEndpoint(endpoint).path), 300);
  const killed = [];
  const session = await ensureBrokerSession(workspace, { env: buildEnv(binDir), killProcess: recordingKill(killed), retryTimeoutMs: 3000 });
  // win32: a pid-less starting broker has no identity to exclude it by: kept, direct transport.
  assert.equal(session?.endpoint ?? null, IS_WIN ? null : endpoint, "the starting broker is kept once it listens");
  assert.deepEqual(killed, []);
  assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint);
  clearBrokerSession(workspace);
});

// Wave 7 (B1): a stale path acts on the current claim, not on its snapshot.
test("ensureBrokerSession waits on a claim that gained a pid during its wait instead of tearing it down", async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const base = { endpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir };
  saveBrokerSession(workspace, { ...base, state: "starting", pid: null, pidIdentity: null });
  const server = net.createServer((socket) => socket.end());
  t.after(() => server.close());
  setTimeout(() => saveBrokerSession(workspace, { ...base, pid: process.pid, pidIdentity: `x:${process.pid}` }), 100);
  setTimeout(() => server.listen(parseBrokerEndpoint(endpoint).path), 450);
  const killed = [];
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    killProcess: recordingKill(killed),
    terminateRecordedProcessImpl: () => assert.fail("no teardown of a claim that changed"),
    isAliveImpl: () => true,
    ownsProcessImpl: () => true,
    retryTimeoutMs: 300
  });
  assert.equal(session?.endpoint, endpoint, "the updated claim's broker is returned");
  assert.deepEqual(killed, []);
  assert.equal(loadBrokerSession(workspace)?.pid, process.pid, "the record survives");
  clearBrokerSession(workspace);
});

function failingSaves(failures) {
  let calls = 0;
  return {
    get calls() { return calls; },
    impl: (cwd, record) => {
      calls += 1;
      if (failures.includes(calls)) {
        throw Object.assign(new Error("lock timeout"), { code: STATE_LOCK_TIMEOUT_CODE });
      }
      return saveBrokerSession(cwd, record);
    }
  };
}

test("ensureBrokerSession retries a failed ready-record save once, then tears the start down", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  for (const failures of [[3], [3, 4]]) {
    const workspace = makeTempDir();
    const saves = failingSaves(failures);
    const spawned = [];
    const terminated = [];
    try {
      const session = await ensureBrokerSession(workspace, {
        env: buildEnv(binDir),
        // Counted saves: 1 pid, 2 identity, 3 ready, 4 ready retry.
        saveBrokerSessionImpl: (cwd, record) => saves.impl(cwd, record),
        // The real probe: the broker registers only its pid and the starter saves
        // the identity, so the failed start's reservation finds its own claim unchanged.
        spawnBrokerProcessImpl: (args) => { const child = spawnBrokerProcess(args); spawned.push(child.pid); return child; },
        terminateRecordedProcessImpl: (pid) => { terminated.push(pid); process.kill(pid, "SIGKILL"); return { attempted: true, delivered: true, reason: "identity-match" }; }
      });
      if (failures.length === 1) {
        assert.equal(session?.pid, spawned[0], "the retry saved the record");
        assert.equal(loadBrokerSession(workspace)?.pidIdentity, getProcessIdentity(spawned[0]));
        assert.deepEqual(terminated, []);
      } else {
        assert.equal(session, null, "never a session the record does not name");
        assert.deepEqual(terminated, [spawned[0]], "the verified failed-start teardown ran");
        assert.equal(loadBrokerSession(workspace), null);
      }
    } finally {
      for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
      clearBrokerSession(workspace);
    }
  }
});

test("saveClaimed under a lock timeout returns false instead of throwing", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const saves = failingSaves([2]); // the identity save (1 is the pid save)
  let child = null;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    saveBrokerSessionImpl: (cwd, record) => saves.impl(cwd, record),
    getProcessIdentityImpl: (pid) => `x:${pid}`,
    spawnBrokerProcessImpl: (args) => (child = spawnBrokerProcess(args))
  });
  try {
    assert.ok(session, "the start succeeds although one save timed out");
    assert.equal(saves.calls >= 2, true);
  } finally {
    if (child?.pid) { try { process.kill(child.pid, "SIGTERM"); } catch {} }
    clearBrokerSession(workspace);
  }
});

// Wave 7 (S1): an unverified stale kill keeps the record and files.
test("ensureBrokerSession keeps a stale record whose kill is unverified and uses no replacement", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  for (const reason of ["identity-unavailable", "identity-mismatch"]) {
    const workspace = makeTempDir();
    const sessionDir = makeTempDir("cxc-");
    const staleEndpoint = createBrokerEndpoint(sessionDir);
    const pidFile = path.join(sessionDir, "broker.pid");
    fs.writeFileSync(pidFile, "");
    saveBrokerSession(workspace, { endpoint: staleEndpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: process.pid });
    let spawns = 0;
    let session = null;
    try {
      session = await ensureBrokerSession(workspace, {
        env: buildEnv(binDir),
        isAliveImpl: () => true,
        ownsProcessImpl: () => true,
        killProcess: () => {},
        terminateRecordedProcessImpl: () => ({ attempted: false, delivered: false, reason }),
        spawnBrokerProcessImpl: (args) => { spawns += 1; return spawnBrokerProcess(args); },
        retryTimeoutMs: 200
      });
      if (reason === "identity-unavailable") {
        assert.equal(session, null);
        assert.equal(spawns, 0, "no replacement");
        assert.equal(loadBrokerSession(workspace)?.endpoint, staleEndpoint, "the record is kept");
        assert.equal(fs.existsSync(pidFile), true, "and its files");
      } else {
        assert.ok(session && session.endpoint !== staleEndpoint, "a settled answer is replaced");
        assert.equal(fs.existsSync(pidFile), false);
      }
    } finally {
      if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
      clearBrokerSession(workspace);
    }
  }
});

test("SessionEnd leaves an unreadable broker.json in place", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const stateFile = resolveBrokerStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{ not json", "utf8");
  const result = runSessionEndHook(workspace, { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(stateFile), true, "an unreadable record is not erased");
});

// Wave 8 (B1): the endpoint compare and the clear are one locked section.
test("clearBrokerSessionIfEndpoint does not delete a replacement written after the caller decided", () => {
  const workspace = makeTempDir();
  const stale = { endpoint: "unix:/tmp/old.sock", pid: null, pidFile: null, logFile: null, sessionDir: null };
  const replacement = { ...stale, endpoint: "unix:/tmp/new.sock" };
  saveBrokerSession(workspace, stale);
  let lockHeld = null;
  const cleared = clearBrokerSessionIfEndpoint(workspace, stale.endpoint, {
    // The replacement lands between the caller's decision and the delete.
    loadBrokerSessionImpl: (cwd) => {
      lockHeld = fs.readdirSync(path.join(resolveStateDir(cwd), "state.lock.d")).some((name) => name.endsWith(".ticket"));
      saveBrokerSession(cwd, replacement);
      return loadBrokerSession(cwd);
    }
  });
  assert.equal(cleared, false);
  assert.equal(lockHeld, true, "the re-load runs under the state lock");
  assert.equal(loadBrokerSession(workspace)?.endpoint, replacement.endpoint, "the replacement survives");
  assert.equal(clearBrokerSessionIfEndpoint(workspace, replacement.endpoint), true);
  assert.equal(loadBrokerSession(workspace), null);
});

// Wave 8 (B2): a child running behind a pid-null record is torn down, not stranded.
test("ensureBrokerSession tears the child down when the pid save fails", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const scriptPath = path.join(makeTempDir(), "never-listens.mjs");
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
  const workspace = makeTempDir();
  const spawned = [];
  const killed = [];
  try {
    const session = await ensureBrokerSession(workspace, {
      env: buildEnv(binDir),
      scriptPath,
      timeoutMs: 300,
      spawnBrokerProcessImpl: (args) => {
        const child = spawnBrokerProcess(args);
        spawned.push(child.pid);
        return child;
      },
      saveBrokerSessionImpl: () => {
        throw new Error("disk full");
      },
      terminateRecordedProcessImpl: (pid) => {
        killed.push(pid);
        process.kill(pid, "SIGKILL");
        return { attempted: true, delivered: true, reason: "identity-match" };
      }
    });
    assert.equal(session, null, "direct fallback");
    assert.deepEqual(killed, spawned, "the child is killed through the verified kill");
    assert.equal(loadBrokerSession(workspace), null, "no pid-null record is left behind");
  } finally {
    for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
    clearBrokerSession(workspace);
  }
});

// Wave 8 (B3): the starting state, not a missing pid, is what SessionEnd keeps.
test("session end keeps a starting record that already has a pid and identity", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "", "utf8");
  const idler = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const identity = getProcessIdentity(idler.pid);
  assert.ok(identity);
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, state: "starting", pid: idler.pid, pidIdentity: identity });
  const sockets = [];
  const stub = await listenStub(endpoint, (socket) => {
    sockets.push(socket);
    socket.once("data", () => socket.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
  });
  try {
    const cleanup = await runSessionEndHookAsync(workspace);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stderr, new RegExp(`pid=${idler.pid} signalled=false reason=starting kept=true`), cleanup.stderr);
    assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "the starting record is kept");
    assert.equal(fs.existsSync(pidFile), true, "its files are kept");
    assert.equal(idler.exitCode, null, "the broker is not signalled");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close();
    idler.kill("SIGKILL");
    clearBrokerSession(workspace);
  }
});

test("ensureBrokerSession waits on a starting record that has a pid", async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  saveBrokerSession(workspace, { endpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, state: "starting", pid: process.pid, pidIdentity: null });
  const server = net.createServer((socket) => socket.end());
  t.after(() => server.close());
  setTimeout(() => server.listen(parseBrokerEndpoint(endpoint).path), 300);
  const killed = [];
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    killProcess: recordingKill(killed),
    terminateRecordedProcessImpl: () => assert.fail("a starting broker that answers is not torn down"),
    isAliveImpl: () => false,
    retryTimeoutMs: 3000
  });
  assert.equal(session?.endpoint, endpoint);
  assert.deepEqual(killed, []);
  clearBrokerSession(workspace);
});

// Wave 9 (R1): a pid-less starting record is settled only after the grace period.
test("ensureBrokerSession keeps a young pid-less starting record and settles an old one", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  for (const age of [0, 120_000]) {
    const workspace = makeTempDir();
    const sessionDir = makeTempDir("cxc-");
    const endpoint = createBrokerEndpoint(sessionDir); // nothing listens here
    saveBrokerSession(workspace, { endpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, state: "starting", startedAt: Date.now() - age, pid: null, pidIdentity: null });
    let spawns = 0;
    let session = null;
    try {
      session = await ensureBrokerSession(workspace, {
        env: buildEnv(binDir),
        spawnBrokerProcessImpl: (args) => { spawns += 1; return spawnBrokerProcess(args); },
        retryTimeoutMs: 200
      });
      if (age === 0) {
        assert.equal(session, null, "direct transport while the start may still be running");
        assert.equal(spawns, 0);
        assert.equal(loadBrokerSession(workspace)?.endpoint, endpoint, "the record is kept");
      } else {
        assert.ok(session && session.endpoint !== endpoint, "an old pid-less start is settled and replaced");
        assert.equal(loadBrokerSession(workspace)?.endpoint, session.endpoint);
      }
    } finally {
      if (session?.pid) { try { process.kill(session.pid, "SIGTERM"); } catch {} }
      clearBrokerSession(workspace);
    }
  }
});

// Wave 9 (R1): a failed pid save whose child survives leaves a record naming it.
test("ensureBrokerSession records the pid of a live child it could not stop after a failed pid save", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const scriptPath = path.join(makeTempDir(), "never-listens.mjs");
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
  const workspace = makeTempDir();
  const spawned = [];
  let saves = 0;
  try {
    const session = await ensureBrokerSession(workspace, {
      env: buildEnv(binDir),
      scriptPath,
      timeoutMs: 300,
      spawnBrokerProcessImpl: (args) => { const child = spawnBrokerProcess(args); spawned.push(child.pid); return child; },
      saveBrokerSessionImpl: (cwd, record) => {
        saves += 1;
        if (saves === 1) {
          throw new Error("disk full");
        }
        return saveBrokerSession(cwd, record);
      },
      getProcessIdentityImpl: (pid) => `x:${pid}`,
      terminateRecordedProcessImpl: () => ({ attempted: false, delivered: false, reason: "identity-unavailable" })
    });
    assert.equal(session, null);
    const record = loadBrokerSession(workspace);
    assert.equal(record?.pid, spawned[0], "the kept record names the live child");
    assert.equal(record.pidIdentity, `x:${spawned[0]}`);
    assert.equal(record.state, "starting");
    assert.equal(typeof record.startedAt, "number");
  } finally {
    for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
    clearBrokerSession(workspace);
  }
});

// Wave 9 (R2): the teardown is reserved under the lock; a starter cannot promote past it.
// Wave 10 (W2): nor kill it — the reservation is the other caller's teardown.
test("ensureBrokerSession refuses a ready save after a replacer reserved the record", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const spawned = [];
  const terminated = [];
  try {
    const session = await ensureBrokerSession(workspace, {
      env: buildEnv(binDir),
      spawnBrokerProcessImpl: (args) => { const child = spawnBrokerProcess(args); spawned.push(child.pid); return child; },
      getProcessIdentityImpl: (pid) => {
        // A stale caller reserves this claim for teardown right here.
        saveBrokerSession(workspace, { ...loadBrokerSession(workspace), state: "replacing", replacer: "other", replacingAt: Date.now() });
        return `x:${pid}`;
      },
      terminateRecordedProcessImpl: (pid) => { terminated.push(pid); process.kill(pid, "SIGKILL"); return { attempted: true, delivered: true, reason: "identity-match" }; }
    });
    assert.equal(session, null, "the refused starter abandons its start");
    assert.deepEqual(terminated, [], "the reserved claim is not the starter's to kill");
    assert.equal(loadBrokerSession(workspace)?.replacer, "other", "the other reservation is intact");
    assert.notEqual(loadBrokerSession(workspace)?.state, "ready", "never promoted past the reservation");
  } finally {
    for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
    clearBrokerSession(workspace);
  }
});

test("registerBrokerProcess writes only into its own endpoint's record and keeps its state", () => {
  const workspace = makeTempDir();
  const record = { endpoint: "unix:/tmp/r.sock", pid: null, pidIdentity: null, pidFile: null, logFile: null, sessionDir: null, state: "replacing", replacer: "a", replacingAt: 1 };
  saveBrokerSession(workspace, record);
  assert.equal(registerBrokerProcess(workspace, "unix:/tmp/other.sock", 42), false);
  assert.deepEqual(loadBrokerSession(workspace), record);
  assert.equal(registerBrokerProcess(workspace, record.endpoint, 42), true);
  assert.deepEqual(loadBrokerSession(workspace), { ...record, pid: 42, pidIdentity: null });
  saveBrokerSession(workspace, { ...record, pid: 42, pidIdentity: "x:42" });
  assert.equal(registerBrokerProcess(workspace, record.endpoint, 42), true);
  assert.equal(loadBrokerSession(workspace)?.pidIdentity, "x:42", "the starter's identity for the same pid is kept");
  clearBrokerSession(workspace);
});

test("ensureBrokerSession does not clear a record another claim wrote during its stale kill", async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const staleDir = makeTempDir("cxc-");
  const staleEndpoint = createBrokerEndpoint(staleDir);
  saveBrokerSession(workspace, { endpoint: staleEndpoint, pidFile: null, logFile: null, sessionDir: staleDir, state: "ready", pid: process.pid, pidIdentity: `x:${process.pid}` });
  const nextDir = makeTempDir("cxc-");
  const nextEndpoint = createBrokerEndpoint(nextDir);
  const server = await listenStub(nextEndpoint, (socket) => socket.end());
  t.after(() => server.close());
  let during = null;
  const session = await ensureBrokerSession(workspace, {
    env: buildEnv(binDir),
    isAliveImpl: () => true,
    ownsProcessImpl: () => true,
    killProcess: () => {},
    retryTimeoutMs: 200,
    terminateRecordedProcessImpl: () => {
      during = loadBrokerSession(workspace);
      saveBrokerSession(workspace, { endpoint: nextEndpoint, pidFile: null, logFile: null, sessionDir: nextDir, state: "ready", pid: null, pidIdentity: null });
      return { attempted: true, delivered: true, reason: "identity-match" };
    }
  });
  assert.equal(during?.state, "replacing", "the kill runs behind a reservation");
  assert.equal(typeof during.replacer, "string");
  assert.equal(loadBrokerSession(workspace)?.endpoint, nextEndpoint, "the other claim survives");
  assert.equal(session?.endpoint, nextEndpoint);
  clearBrokerSession(workspace);
});

test("teardownBrokerSession keeps a replacing record like a starting one", () => {
  assert.deepEqual(teardownBrokerSession({ pidFile: null, logFile: null, pid: 1, state: "replacing", killProcess: () => assert.fail("nothing to kill") }), { signalled: false, reason: "replacing", kept: true });
});

// Wave 9 (R3): an adopted starting broker is promoted to ready with its identity.
test("ensureBrokerSession promotes an answering starting broker, and keeps it on win32 without an identity", async (t) => {
  for (const platform of [process.platform, "win32"]) {
    const workspace = makeTempDir();
    const sessionDir = makeTempDir("cxc-");
    const endpoint = createBrokerEndpoint(sessionDir);
    const record = { endpoint, pidFile: null, logFile: null, sessionDir, state: "starting", startedAt: Date.now(), pid: process.pid, pidIdentity: null };
    saveBrokerSession(workspace, record);
    const server = await listenStub(endpoint, (socket) => socket.end());
    t.after(() => server.close());
    const session = await ensureBrokerSession(workspace, {
      platform,
      spawnBrokerProcessImpl: () => assert.fail("no spawn"),
      getProcessIdentityImpl: () => (platform === "win32" ? null : "x:adopted")
    });
    if (platform === "win32") {
      assert.equal(session, null, "direct transport");
      assert.deepEqual(loadBrokerSession(workspace), record, "the record is kept as is");
    } else {
      assert.equal(session?.state, "ready");
      assert.equal(session.pidIdentity, "x:adopted");
      assert.deepEqual(loadBrokerSession(workspace), session, "the promotion is saved");
    }
    clearBrokerSession(workspace);
  }
});

// Wave 10 (W1): a bound broker writes its own pid (no identity probe) into its record.
test("broker registers its pid in its own record once it listens", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const startedAt = Date.now();
  saveBrokerSession(workspace, { endpoint, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, state: "starting", startedAt, pid: null, pidIdentity: null });
  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", workspace, "--idle-timeout", "60000"],
    { cwd: workspace, env: buildEnv(binDir), stdio: "ignore" }
  );
  try {
    const record = await waitFor(() => {
      const current = loadBrokerSession(workspace);
      return current?.pid === child.pid ? current : null;
    });
    assert.equal(record.pidIdentity, null, "the broker probes no identity");
    assert.equal(record.state, "starting", "the state is left to the starter");
    assert.equal(record.startedAt, startedAt);
  } finally {
    child.kill("SIGKILL");
    clearBrokerSession(workspace);
  }
});

// Wave 10 (W1): time alone never settles a record whose endpoint answers.
test("ensureBrokerSession adopts an answering pid-less starting record past its grace instead of settling it", async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const record = { endpoint, pidFile: null, logFile: null, sessionDir, state: "starting", startedAt: Date.now() - 120_000, pid: null, pidIdentity: null };
  saveBrokerSession(workspace, record);
  const server = await listenStub(endpoint, (socket) => socket.end());
  t.after(() => server.close());
  await ensureBrokerSession(workspace, {
    spawnBrokerProcessImpl: () => assert.fail("no spawn"),
    terminateRecordedProcessImpl: () => assert.fail("no kill")
  });
  assert.deepEqual(loadBrokerSession(workspace), record, "the record is not settled");
  clearBrokerSession(workspace);
});

// Wave 10 (W2): abandonStart reserves; a claim promoted meanwhile is not killed.
test("ensureBrokerSession does not kill a failed start whose record was promoted meanwhile", async () => {
  const workspace = makeTempDir();
  const spawned = [];
  const terminated = [];
  let promoted = null;
  try {
    const session = await ensureBrokerSession(workspace, {
      timeoutMs: 300,
      spawnBrokerProcessImpl: () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        spawned.push(child.pid);
        return child;
      },
      saveBrokerSessionImpl: (cwd, record) => {
        saveBrokerSession(cwd, record);
        if (!promoted) {
          // Another caller adopts the broker during the readiness wait.
          promoted = setTimeout(() => saveBrokerSession(cwd, { ...loadBrokerSession(cwd), state: "ready" }), 50);
        }
      },
      getProcessIdentityImpl: (pid) => `x:${pid}`,
      terminateRecordedProcessImpl: (pid) => { terminated.push(pid); return { attempted: true, delivered: true, reason: "identity-match" }; }
    });
    assert.equal(session, null);
    assert.deepEqual(terminated, [], "the promoted broker is not killed");
    assert.equal(loadBrokerSession(workspace)?.state, "ready", "the promoted record is intact");
    assert.equal(loadBrokerSession(workspace).pid, spawned[0]);
  } finally {
    for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
    clearBrokerSession(workspace);
  }
});

// Wave 10 (W3): a reservation past its grace is not the replacer's any more.
test("ensureBrokerSession does not kill once its own reservation is older than the grace", async () => {
  const workspace = makeTempDir();
  const staleDir = makeTempDir("cxc-");
  const staleEndpoint = createBrokerEndpoint(staleDir);
  saveBrokerSession(workspace, { endpoint: staleEndpoint, pidFile: null, logFile: null, sessionDir: staleDir, state: "ready", pid: process.pid, pidIdentity: `x:${process.pid}` });
  const terminated = [];
  const session = await ensureBrokerSession(workspace, {
    isAliveImpl: () => true,
    ownsProcessImpl: () => true,
    killProcess: () => {},
    retryTimeoutMs: 200,
    // The replacer is suspended past the grace right after it reserved.
    nowImpl: () => Date.now() + (loadBrokerSession(workspace)?.state === "replacing" ? 120_000 : 0),
    spawnBrokerProcessImpl: () => assert.fail("no spawn"),
    terminateRecordedProcessImpl: (pid) => { terminated.push(pid); return { attempted: true, delivered: true, reason: "identity-match" }; }
  });
  assert.equal(session, null);
  assert.deepEqual(terminated, [], "the kill is never launched");
  assert.equal(loadBrokerSession(workspace)?.state, "replacing", "nothing is restored");
  clearBrokerSession(workspace);
});

// Wave 10 (W4): a fresh win32 broker without an identity stays starting until one is read.
test("ensureBrokerSession keeps a fresh win32 broker starting until its identity is read", async () => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  let server = null;
  let identity = null;
  const options = {
    platform: "win32",
    createBrokerEndpoint: () => endpoint,
    spawnBrokerProcessImpl: () => {
      // Stands in for the broker: it answers, and never registers itself.
      server = net.createServer((socket) => socket.end()).listen(parseBrokerEndpoint(endpoint).path);
      return { pid: process.pid, exitCode: null, signalCode: null };
    },
    getProcessIdentityImpl: () => identity
  };
  try {
    assert.equal(await ensureBrokerSession(workspace, options), null, "direct transport without an identity");
    const kept = loadBrokerSession(workspace);
    assert.equal(kept?.state, "starting");
    assert.equal(kept.pid, process.pid);
    assert.equal(kept.pidIdentity, null);
    assert.equal(await ensureBrokerSession(workspace, options), null, "a later probe that fails keeps it");
    assert.equal(loadBrokerSession(workspace)?.state, "starting");
    identity = "win32:later";
    const session = await ensureBrokerSession(workspace, options);
    assert.equal(session?.state, "ready", "promoted once the probe succeeds");
    assert.equal(session.pidIdentity, "win32:later");
    assert.deepEqual(loadBrokerSession(workspace), session);
  } finally {
    server?.close();
    clearBrokerSession(workspace);
  }
});

// Wave 10 (W5): the adopt probe runs outside the state lock.
test("ensureBrokerSession probes an adopted broker's identity outside the state lock", async (t) => {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  saveBrokerSession(workspace, { endpoint, pidFile: null, logFile: null, sessionDir, state: "starting", startedAt: Date.now(), pid: process.pid, pidIdentity: null });
  const server = await listenStub(endpoint, (socket) => socket.end());
  t.after(() => server.close());
  const lockDir = path.join(resolveStateDir(workspace), "state.lock.d");
  let ticketsDuringProbe = null;
  const session = await ensureBrokerSession(workspace, {
    spawnBrokerProcessImpl: () => assert.fail("no spawn"),
    getProcessIdentityImpl: () => {
      ticketsDuringProbe = fs.existsSync(lockDir) ? fs.readdirSync(lockDir).filter((name) => name.endsWith(".ticket")).length : 0;
      return "x:adopted";
    }
  });
  assert.equal(ticketsDuringProbe, 0, "no lock is held during the probe");
  assert.equal(session?.state, "ready");
  assert.equal(loadBrokerSession(workspace)?.pidIdentity, "x:adopted");
  clearBrokerSession(workspace);
});

// Wave 11 (B1): adoption binds the identity to the answering instance (two probes around the readiness check).
async function adoptWithProbes(t, probes) {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const starting = { endpoint, pidFile: null, logFile: null, sessionDir, state: "starting", startedAt: Date.now(), pid: process.pid, pidIdentity: null };
  saveBrokerSession(workspace, starting);
  const server = await listenStub(endpoint, (socket) => socket.end());
  t.after(() => { server.close(); clearBrokerSession(workspace); });
  const calls = [];
  const session = await ensureBrokerSession(workspace, {
    spawnBrokerProcessImpl: () => assert.fail("no spawn"),
    getProcessIdentityImpl: (pid) => { calls.push(pid); return probes[Math.min(calls.length, probes.length) - 1]; }
  });
  return { session, calls, workspace, starting };
}

test("adoption promotes a starting broker when both identity probes agree", async (t) => {
  const { session, calls, workspace } = await adoptWithProbes(t, ["x:same", "x:same"]);
  assert.equal(session?.state, "ready");
  assert.equal(session.pidIdentity, "x:same");
  assert.equal(loadBrokerSession(workspace)?.pidIdentity, "x:same");
  assert.deepEqual(calls, [process.pid, process.pid], "one probe before and one after the readiness check");
});

test("adoption does not promote when the pid was recycled across the answering window", async (t) => {
  const { session, workspace, starting } = await adoptWithProbes(t, ["x:one", "x:two"]);
  assert.equal(session, null, "direct transport");
  assert.deepEqual(loadBrokerSession(workspace), starting, "the record is unchanged");
});

test("adoption does not promote when the first probe returns null", async (t) => {
  // The second probe still runs (it is cheap to reason about); the result is null either way.
  const { session, workspace, starting } = await adoptWithProbes(t, [null, "x:late"]);
  assert.equal(session, null);
  assert.deepEqual(loadBrokerSession(workspace), starting);
});
