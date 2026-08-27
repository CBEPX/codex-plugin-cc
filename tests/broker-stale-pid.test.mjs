import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

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
