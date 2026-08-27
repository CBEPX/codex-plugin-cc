import { test } from "node:test";
import assert from "node:assert/strict";

import { AppServerClientBase } from "../plugins/codex/scripts/lib/app-server.mjs";

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
