import test from "node:test";
import assert from "node:assert/strict";

import { isActiveJobStatus, isTerminalRecord, JOB_STATUS } from "../plugins/codex/scripts/lib/job-status.mjs";

test("isActiveJobStatus: only queued and running are active", () => {
  assert.deepEqual(Object.values(JOB_STATUS).map(isActiveJobStatus), [true, true, false, false, false]);
  assert.equal(isActiveJobStatus(undefined), false);
  assert.equal(isActiveJobStatus("done"), false);
});

test("isTerminalRecord: a finished record is terminal, a missing or active one is not", () => {
  assert.equal(isTerminalRecord({ status: "completed" }), true);
  assert.equal(isTerminalRecord({ status: "running" }), false);
  assert.equal(isTerminalRecord(null), false);
  assert.equal(isTerminalRecord(undefined), false);
});

test("JOB_STATUS is frozen", () => {
  assert.ok(Object.isFrozen(JOB_STATUS));
});
