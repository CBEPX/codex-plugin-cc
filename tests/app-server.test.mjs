import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { AppServerClientBase, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

/** Minimal client that records the JSON-RPC messages it would send. */
class CapturingClient extends AppServerClientBase {
  constructor() {
    super(process.cwd());
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

test("handleServerRequest answers MCP elicitation requests instead of rejecting them", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 7,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1" }
  });
  assert.deepEqual(client.sent, [{ id: 7, result: { action: "decline" } }]);
});

test("handleServerRequest still rejects unknown server requests with -32601", () => {
  const client = new CapturingClient();
  client.handleServerRequest({ id: 8, method: "some/unknown/request", params: {} });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].id, 8);
  assert.equal(client.sent[0].result, undefined);
  assert.equal(client.sent[0].error.code, -32601);
});

test("every elicitation mode is declined, so consent is never fabricated", () => {
  // Accepting a url-mode elicitation tells the MCP server that an out-of-band
  // authorization succeeded when nobody completed it. There is no operator here,
  // so no mode may be accepted.
  for (const mode of ["form", "openai/form", "url", undefined, "something-new"]) {
    const client = new CapturingClient();
    client.handleServerRequest({
      id: 9,
      method: "mcpServer/elicitation/request",
      params: { threadId: "t1", ...(mode === undefined ? {} : { mode }) }
    });
    assert.deepEqual(client.sent, [{ id: 9, result: { action: "decline" } }], `mode ${mode} must be declined`);
  }
});

// The non-interactive runner has no operator, so every approval request must be
// answered with that request type's own refusal variant. The generated types
// disagree on shape: the v1 approvals take a `ReviewDecision` whose refusal is
// `{ denied: { rejection } }`, the v2 item approvals take a plain `"decline"`
// enum with no room for a reason, and `PermissionsRequestApprovalResponse` has
// no refusal variant at all — granting nothing is its fail-closed answer.
const DENIAL_REASON = "Non-interactive Codex runner: no operator to approve.";

test("v1 approval requests are answered with the ReviewDecision denied variant", () => {
  for (const [id, method] of [
    [21, "execCommandApproval"],
    [22, "applyPatchApproval"]
  ]) {
    const client = new CapturingClient();
    client.handleServerRequest({ id, method, params: { threadId: "t1" } });
    assert.deepEqual(client.sent, [
      { id, result: { decision: { denied: { rejection: DENIAL_REASON } } } }
    ]);
  }
});

test("v2 item approval requests are answered with the decline decision", () => {
  for (const [id, method] of [
    [23, "item/commandExecution/requestApproval"],
    [24, "item/fileChange/requestApproval"]
  ]) {
    const client = new CapturingClient();
    client.handleServerRequest({ id, method, params: { threadId: "t1" } });
    assert.deepEqual(client.sent, [{ id, result: { decision: "decline" } }]);
  }
});

test("permission approval requests grant nothing for the turn", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 25,
    method: "item/permissions/requestApproval",
    params: { threadId: "t1", permissions: { network: { enabled: true } } }
  });
  assert.deepEqual(client.sent, [{ id: 25, result: { permissions: {}, scope: "turn" } }]);
});

// `close()` is what the turn timeout uses to kill a runaway turn on a transport
// it owns, so it must never become the second hang: an app-server that ignores
// SIGTERM (or is wedged in a tool call) used to leave it awaiting process exit
// forever. TERM, then KILL, then give up on the process rather than the caller.
test("close() bounds an app-server that ignores SIGTERM", { timeout: 8000 }, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: buildEnv(binDir, { FAKE_CODEX_IGNORE_SIGTERM: "1" })
  });
  t.after(() => {
    try {
      client.proc.kill("SIGKILL");
    } catch {
      // Already gone, which is the point of the test.
    }
  });

  const started = Date.now();
  await client.close();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 6000, `close() must be bounded, took ${elapsed} ms`);
  assert.equal(client.proc.signalCode, "SIGKILL", "a SIGTERM-immune app-server must be killed outright");
});

// The bound only ever applied to the first call: a second one took the "already
// closed" branch and awaited the raw process-exit promise with no deadline at
// all. The turn timeout always closes twice — `failTurnOnTimeout` closes the
// runaway app-server, then `withAppServer` closes it again on the way out — so
// the one case the deadline exists for is exactly the case that hung.
test("close() stays bounded when it is called twice", { timeout: 15000 }, async (t) => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const client = await CodexAppServerClient.connect(binDir, {
    disableBroker: true,
    env: buildEnv(binDir, { FAKE_CODEX_IGNORE_SIGTERM: "1" })
  });
  const childPid = client.proc.pid;
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  // A child nothing can kill: the fixture ignores SIGTERM and stdin EOF, and
  // swallowing the signals means even the SIGKILL escalation never lands.
  client.proc.kill = () => true;

  await client.close();
  const started = Date.now();
  await client.close();

  assert.ok(Date.now() - started < 1000, `a repeated close must not wait again, took ${Date.now() - started} ms`);
  assert.equal(client.proc.exitCode, null, "the test needs a child that never exits");
});
