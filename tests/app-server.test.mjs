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

test("handleServerRequest accepts MCP elicitation requests instead of rejecting them", () => {
  const client = new CapturingClient();
  client.handleServerRequest({
    id: 7,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1" }
  });
  assert.deepEqual(client.sent, [
    { id: 7, result: { action: "accept", content: null, _meta: null } }
  ]);
});

test("handleServerRequest still rejects unknown server requests with -32601", () => {
  const client = new CapturingClient();
  client.handleServerRequest({ id: 8, method: "some/unknown/request", params: {} });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].id, 8);
  assert.equal(client.sent[0].result, undefined);
  assert.equal(client.sent[0].error.code, -32601);
});

test("form-mode elicitation requests are declined instead of accepted with empty content", () => {
  for (const mode of ["form", "openai/form"]) {
    const client = new CapturingClient();
    client.handleServerRequest({
      id: 9,
      method: "mcpServer/elicitation/request",
      params: { threadId: "t1", mode }
    });
    assert.deepEqual(client.sent, [{ id: 9, result: { action: "decline" } }]);
  }

  const urlClient = new CapturingClient();
  urlClient.handleServerRequest({
    id: 10,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1", mode: "url" }
  });
  assert.deepEqual(urlClient.sent, [{ id: 10, result: { action: "accept", content: null, _meta: null } }]);
});
