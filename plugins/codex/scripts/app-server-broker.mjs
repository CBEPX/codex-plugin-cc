#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { clearBrokerSession, loadBrokerSession } from "./lib/broker-lifecycle.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

// Broker-side idle timeout. When no client has been connected for this long the
// broker self-terminates. This is the correctness backstop for stale ownership
// records in broker.json: a co-owning session that exits without running its
// SessionEnd hook (SIGKILL, OOM, crash, host reboot) or whose teardown skips the
// entry on lock contention leaves its sessionId behind forever, so no future hook
// will ever tear the broker down. Self-termination on idle is platform-independent
// and needs no PID/liveness signal, so it covers the abnormal-exit orphan, the
// dead-co-owner orphan, and the lock-contention skip in one mechanism. See #108,
// #380, and #450.
// How long a client is given to close its side once the broker has said goodbye.
// `socket.end()` is a graceful half-close, so a peer that never answers the FIN —
// one that is wedged, or one whose process is gone but whose close event has not
// been processed yet — leaves the connection open. Anything still open after this
// is closed outright.
const SHUTDOWN_SOCKET_GRACE_MS = 1000;

const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Resolve the idle timeout from the CLI flag, then the environment, then the
// default. Exactly `0` disables the timeout so the broker never self-terminates,
// which keeps the old behavior available for callers that manage lifecycle
// themselves; a negative or non-finite override is treated as garbage and falls
// back to the default.
function resolveIdleTimeoutMs(optionValue, env = process.env) {
  const raw = optionValue ?? env[IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--idle-timeout <ms>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "idle-timeout"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const idleTimeoutMs = resolveIdleTimeoutMs(options["idle-timeout"]);
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  let idleTimer = null;
  let shuttingDown = false;

  function disarmIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Arm the idle timer whenever the broker has no connected clients. A live
  // client connection means the broker is still in use, so we only count down
  // while idle and cancel the moment a client connects. When the timer fires we
  // shut the broker down gracefully and exit.
  function armIdleTimer() {
    disarmIdleTimer();
    if (idleTimeoutMs <= 0 || sockets.size > 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      shutdown(server)
        .catch(() => {})
        .finally(() => process.exit(0));
    }, idleTimeoutMs);
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  // The ownership record in broker.json outlives the process unless we drop it:
  // after an idle self-terminate a later SessionEnd hook would load it and
  // signal a PID the OS may have recycled, and `status`/`reuseExistingBroker`
  // would advertise or dial an endpoint nothing is listening on. Only clear a
  // record that still points at this broker — a newer broker may have replaced
  // us in it. The state dir derives from --cwd plus the inherited environment,
  // exactly as it did in the process that spawned us.
  function clearOwnSessionRecord() {
    try {
      if (loadBrokerSession(cwd)?.endpoint === endpoint) {
        clearBrokerSession(cwd);
      }
    } catch {
      // Best-effort: never block shutdown on state-file cleanup.
    }
  }

  // Closing the app-server child can take a while. Stop listening before the
  // first await instead of after it: a client accepted in that window would be
  // served the broker-local `initialize` and then fail its first real RPC with
  // "codex app-server client is closed", which callers do not retry.
  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    disarmIdleTimer();
    clearOwnSessionRecord();
    const serverClosed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    // Never wait on a client indefinitely. SIGTERM is handled here, so a shutdown
    // that does not return is a broker that ignores SIGTERM — a SessionEnd could
    // signal it, get on with its teardown, and leave the process running forever.
    let graceTimer = null;
    await Promise.race([
      serverClosed,
      new Promise((resolve) => {
        graceTimer = setTimeout(resolve, SHUTDOWN_SOCKET_GRACE_MS);
      })
    ]);
    clearTimeout(graceTimer);
    for (const socket of sockets) {
      socket.destroy();
    }
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    if (shuttingDown) {
      // Already accepted before the listener finished closing: reset it so the
      // client retries or reports a connection error instead of half-working.
      socket.destroy();
      return;
    }
    sockets.add(socket);
    disarmIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          // The caller (a SessionEnd hook) decides to shut the broker down from a
          // snapshot of the job index, and another session can enqueue a job and
          // connect in the gap between that snapshot and this request. Only the
          // broker knows whether it is actually idle, so it refuses while anyone
          // else is connected at all: a client is a client from the moment it is
          // accepted, and `CodexAppServerClient` connects before it writes its
          // first line. The requester's own connection is the one that does not
          // count. Refusing is fail-safe and costs nothing that the idle timer
          // does not already cost — that timer is likewise held off by any open
          // socket, so a client that hangs up lets both mechanisms proceed.
          const busy =
            (activeRequestSocket && activeRequestSocket !== socket) ||
            (activeStreamSocket && activeStreamSocket !== socket) ||
            [...sockets].some((other) => other !== socket);
          if (busy) {
            send(socket, { id: message.id, result: { busy: true } });
            continue;
          }
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      armIdleTimer();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      armIdleTimer();
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path, () => {
    // Start counting down immediately: a broker that is spawned but never
    // receives a client (or whose only client connects briefly during the
    // readiness probe) must still self-terminate instead of lingering.
    armIdleTimer();
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
