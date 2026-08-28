import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function waitForExit(child, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Timed out waiting for broker process to exit."));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

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
    const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
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
      // Already gone.
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
  return run("node", [SESSION_HOOK, "SessionEnd"], {
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
  const child = spawn("node", [SESSION_HOOK, "SessionEnd"], {
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

async function waitUntil(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
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
  const foreignWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
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

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "keep me running"], { cwd: workspace, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const stateFile = path.join(resolveStateDir(workspace), "state.json");
  const broker = await waitUntil(() => loadBrokerSession(workspace));
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
    const hook = spawn("node", [SESSION_HOOK, "SessionEnd"], { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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
test("session end reaps a SIGKILLed background worker instead of keeping its broker alive", async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const workspace = makeTempDir();
  const env = buildEnv(binDir, {
    // Long enough that only the hook can be the reason the broker goes away.
    CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "20000",
    CODEX_COMPANION_SESSION_ID: "sess-current",
    FAKE_CODEX_TURN_DELAY_MS: "20000"
  });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "die mid-turn"], { cwd: workspace, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const stateFile = path.join(resolveStateDir(workspace), "state.json");
  const running = await waitUntil(() => {
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((entry) => entry.id === jobId);
    return job && job.status === "running" && job.pid ? job : null;
  }, { timeoutMs: 20000 });
  assert.ok(running, "the background worker must have taken over its record");
  const broker = await waitUntil(() => loadBrokerSession(workspace));
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

  process.kill(-running.pid, "SIGKILL");
  await waitUntil(() => (isAlive(running.pid) ? null : "dead"));

  const cleanup = runSessionEndHook(workspace, { env, sessionId: "sess-current" });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  const exited = await waitUntil(() => (isAlive(broker.pid) ? null : "exited"), { timeoutMs: 5000 });
  assert.equal(exited, "exited", `a dead worker must not keep the broker alive; hook said: ${cleanup.stderr.trim()}`);
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
  saveBrokerSession(workspace, { endpoint, pidFile, logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: null });

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
