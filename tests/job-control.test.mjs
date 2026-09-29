import test from "node:test";
import assert from "node:assert/strict";

import { brokerExclusion, cancelDecision, emitCancelPending, renderCancelPending } from "../plugins/codex/scripts/lib/job-control.mjs";

const SURVIVORS = [{ pid: 4301, identity: "win32:7" }];

test("cancelDecision: what each kill outcome means for the job", () => {
  const cases = [
    [{ pid: 1, kill: { attempted: true, delivered: true }, alive: false, platform: "win32" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false, survivors: SURVIVORS }, alive: false, platform: "win32" }, { pending: true, reason: "kill-failed", survivors: SURVIVORS }],
    [{ pid: 1, kill: { attempted: true, delivered: false, survivors: SURVIVORS }, alive: false, platform: "linux" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: true, platform: "win32" }, { pending: true, reason: "identity-unavailable", survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false, unverified: true }, alive: false, platform: "win32" }, { pending: true, reason: "kill-failed", survivors: [] }],
    [{ pid: 1, kill: { attempted: false, reason: "process-missing" }, alive: false, platform: "win32" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false }, alive: true, platform: "linux" }, { pending: true, reason: "not-delivered", survivors: [] }],
    [{ pid: null, kill: { attempted: false, reason: "no-pid" }, alive: null, platform: "win32" }, { pending: false, reason: null, survivors: [] }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(cancelDecision(input), expected, JSON.stringify(input));
  }
});

test("brokerExclusion: none, a verified pair, or null when the broker cannot be excluded", () => {
  assert.deepEqual(brokerExclusion(null), []);
  assert.deepEqual(brokerExclusion({ pid: 555, pidIdentity: "win32:12" }), [{ pid: 555, identity: "win32:12" }]);
  assert.equal(brokerExclusion({ pid: 555, pidIdentity: null }), null);
  assert.equal(brokerExclusion({ pid: 555, pidIdentity: "linux:12" }), null);
});

test("renderCancelPending reports survivors on win32", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS }, 4300, "job-1");
  assert.deepEqual(rendered.json.survivors, SURVIVORS);
  assert.ok(rendered.logLine.endsWith(" worker tree survivors: 4301:win32:7"));
  assert.equal(rendered.diagnostic, "[codex] worker tree survivors: 4301:win32:7\n");
});

test("renderCancelPending marks an unverified kill without survivors", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: [] }, 4300, "job-1");
  assert.equal("survivors" in rendered.json, false);
  assert.ok(rendered.logLine.endsWith(" (unverified)"));
  assert.equal(rendered.diagnostic, null);
});

test("renderCancelPending is byte-identical to v1.4.0 on posix", () => {
  const rendered = renderCancelPending({ pending: true, reason: "not-delivered", survivors: [] }, 4300, "job-1");
  assert.deepEqual(rendered.json, { jobId: "job-1", status: "running", cancellationPending: true, reason: "not-delivered" });
  assert.equal(rendered.logLine, "cancellation not confirmed: worker pid 4300 left running (not-delivered)");
  assert.equal(rendered.diagnostic, null);
});

test("emitCancelPending never puts the diagnostic on stdout", () => {
  for (const json of [true, false]) {
    const out = [];
    const err = [];
    const log = [];
    const rendered = emitCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS }, 4300, "job-1", {
      json,
      appendLog: (line) => log.push(line),
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) }
    });
    assert.equal(out.length, 1);
    if (json) {
      assert.deepEqual(JSON.parse(out[0]).survivors, SURVIVORS);
    } else {
      assert.equal(out[0], rendered.text);
    }
    assert.deepEqual(err, ["[codex] worker tree survivors: 4301:win32:7\n"]);
    assert.equal(log.length, 1);
    assert.ok(log[0].endsWith("worker tree survivors: 4301:win32:7"));
  }
});
