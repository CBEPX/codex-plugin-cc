import test from "node:test";
import assert from "node:assert/strict";

import { isActiveJobStatus, isTerminalRecord } from "../plugins/codex/scripts/lib/job-status.mjs";

test("isActiveJobStatus: only queued and running are active", () => {
  assert.equal(isActiveJobStatus("queued"), true);
  assert.equal(isActiveJobStatus("running"), true);
  for (const status of ["completed", "failed", "cancelled", undefined, null, "done"]) {
    assert.equal(isActiveJobStatus(status), false, String(status));
  }
});

test("isTerminalRecord: a finished record is terminal, a missing or active one is not", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.equal(isTerminalRecord({ status }), true, status);
  }
  for (const status of ["queued", "running"]) {
    assert.equal(isTerminalRecord({ status }), false, status);
  }
  assert.equal(isTerminalRecord(null), false);
  assert.equal(isTerminalRecord(undefined), false);
  // A status-less record counts as terminal (the pre-existing inline semantics).
  assert.equal(isTerminalRecord({}), true);
});
