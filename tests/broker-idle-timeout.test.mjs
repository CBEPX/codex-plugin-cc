import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

function spawnBroker({ cwd, endpoint, env, idleTimeoutMs }) {
  const args = [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", cwd];
  if (idleTimeoutMs !== undefined) {
    args.push("--idle-timeout", String(idleTimeoutMs));
  }
  return spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function waitForExit(child, { timeoutMs = 5000 } = {}) {
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

function connectClient(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.path });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Connect and try one `initialize`, reporting whether the broker served it.
function connectAndInitialize(endpoint, { timeoutMs = 1000 } = {}) {
  const target = parseBrokerEndpoint(endpoint);
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: target.path });
    let settled = false;
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ initialized: false, reason: "timeout" }), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    });
    socket.on("data", (chunk) => finish({ initialized: chunk.includes("result"), reason: chunk.trim() }));
    socket.on("error", (error) => finish({ initialized: false, reason: error.code ?? error.message }));
    socket.on("close", () => finish({ initialized: false, reason: "closed" }));
  });
}

test("broker self-terminates after the idle timeout when no client is connected", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({ cwd: sessionDir, endpoint, env: buildEnv(binDir), idleTimeoutMs: 300 });

  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true, "broker should accept connections before it times out");

    const start = Date.now();
    const result = await waitForExit(child, { timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    assert.equal(result.code, 0, "broker should exit cleanly on idle timeout");
    assert.ok(elapsed >= 200, `broker exited too early (${elapsed}ms)`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});

test("broker stays alive while a client is connected and exits after it disconnects", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({ cwd: sessionDir, endpoint, env: buildEnv(binDir), idleTimeoutMs: 300 });

  let socket = null;
  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true);

    socket = await connectClient(endpoint);

    // Hold the connection open well past the idle timeout; the broker must not
    // self-terminate while a client is still connected.
    await delay(900);
    assert.equal(child.exitCode, null, "broker must stay alive while a client is connected");

    socket.end();
    socket = null;

    const result = await waitForExit(child, { timeoutMs: 5000 });
    assert.equal(result.code, 0, "broker should exit once the client disconnects and it goes idle");
  } finally {
    if (socket) {
      socket.destroy();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});

test("broker with the idle timeout disabled keeps running while idle", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({ cwd: sessionDir, endpoint, env: buildEnv(binDir), idleTimeoutMs: 0 });

  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true);

    await delay(700);
    assert.equal(child.exitCode, null, "broker must not self-terminate when the idle timeout is disabled");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
});

// Shutting down takes as long as the app-server child needs to exit. A client
// that connects during that window used to be accepted and answered locally by
// the broker's own `initialize`, then failed its first real RPC with
// "codex app-server client is closed" — an error the caller does not retry.
test("broker refuses clients that connect after the idle shutdown starts", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({
    cwd: sessionDir,
    endpoint,
    env: buildEnv(binDir, { FAKE_CODEX_CLOSE_DELAY_MS: "2000" }),
    idleTimeoutMs: 300
  });

  try {
    const ready = await waitForBrokerEndpoint(endpoint, 3000);
    assert.equal(ready, true);

    // No endpoint probing between here and the late connect: every probe
    // connection re-arms the idle timer, so the window would never open.
    await delay(700);

    const outcome = await connectAndInitialize(endpoint);
    assert.equal(outcome.initialized, false, `late client must not be served: ${JSON.stringify(outcome)}`);

    const result = await waitForExit(child, { timeoutMs: 10000 });
    assert.equal(result.code, 0, "broker must still exit after refusing the late client");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

// A JSON-RPC client that keeps every message the broker sent, so a test can wait
// for one instead of guessing at timings.
async function openClient(endpoint) {
  const socket = await connectClient(endpoint);
  socket.setEncoding("utf8");
  const messages = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (line.trim()) {
        messages.push(JSON.parse(line));
      }
    }
  });

  const client = {
    socket,
    messages,
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    async waitFor(predicate, { timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) {
          return found;
        }
        await delay(25);
      }
      throw new Error(`Timed out waiting for a broker message. Got: ${JSON.stringify(messages)}`);
    },
    async request(id, method, params = {}) {
      client.send({ id, method, params });
      return client.waitFor((message) => message.id === id);
    },
    close() {
      socket.end();
      return new Promise((resolve) => socket.once("close", resolve));
    }
  };
  return client;
}

// `hasActiveWorkspaceJobs()` in the SessionEnd hook is only a snapshot: another
// session can enqueue a job and connect between that check and the shutdown RPC.
// The broker is the only place that knows whether it is actually idle, so it
// refuses a shutdown while any other client is connected — the requester's own
// connection is the one that does not count.
test("broker refuses shutdown while another client is using it", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionDir = makeTempDir("cxc-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = spawnBroker({
    cwd: sessionDir,
    endpoint,
    env: buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "1500" }),
    idleTimeoutMs: 20000
  });

  let holder = null;
  let requester = null;
  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 3000), true);

    holder = await openClient(endpoint);
    await holder.request(1, "initialize", {});
    const started = await holder.request(2, "thread/start", { cwd: sessionDir });
    const threadId = started.result.thread.id;
    await holder.request(3, "turn/start", { threadId, input: [{ type: "text", text: "hold the runtime" }] });

    requester = await openClient(endpoint);
    const refused = await requester.request(1, "broker/shutdown", {});
    assert.equal(refused.result?.busy, true, `shutdown must be refused: ${JSON.stringify(refused)}`);
    assert.equal(child.exitCode, null, "the broker must keep serving after refusing a shutdown");

    // The refused shutdown must not have cost the holder its turn.
    const completed = await holder.waitFor((message) => message.method === "turn/completed", { timeoutMs: 8000 });
    assert.equal(completed.params.threadId, threadId);

    await holder.close();
    holder = null;
    await requester.close();
    requester = null;

    const closer = await openClient(endpoint);
    const accepted = await closer.request(1, "broker/shutdown", {});
    assert.notEqual(accepted.result?.busy, true, "an idle broker must accept the shutdown");
    const exited = await waitForExit(child, { timeoutMs: 5000 });
    assert.equal(exited.code, 0, "the broker must exit once nothing else is connected");
  } finally {
    holder?.socket.destroy();
    requester?.socket.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
