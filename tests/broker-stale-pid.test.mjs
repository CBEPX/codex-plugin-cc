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
