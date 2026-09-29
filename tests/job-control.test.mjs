import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { BROKER_ENDPOINT_ENV } from "../plugins/codex/scripts/lib/app-server.mjs";
import { saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import assert from "node:assert/strict";

import { brokerExclusion, brokerPresence, cancelDecision, emitCancelPending, renderCancelPending } from "../plugins/codex/scripts/lib/job-control.mjs";

const SURVIVORS = [{ pid: 4301, identity: "win32:7" }];

test("cancelDecision: what each kill outcome means for the job", () => {
  const cases = [
    [{ pid: 1, kill: { attempted: true, delivered: true }, alive: false, platform: "win32" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false, survivors: SURVIVORS }, alive: false, platform: "win32" }, { pending: true, reason: "kill-failed", survivors: SURVIVORS, rootAlive: false }],
    [{ pid: 1, kill: { attempted: true, delivered: false, survivors: SURVIVORS }, alive: false, platform: "linux" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: true, platform: "win32" }, { pending: true, reason: "identity-unavailable", survivors: [], rootAlive: true }],
    [{ pid: 1, kill: { attempted: true, delivered: false, unverified: true }, alive: false, platform: "win32" }, { pending: true, reason: "kill-failed", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "win32" }, { pending: true, reason: "process-missing", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "linux" }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "win32", workerFinished: true }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, alive: false, platform: "win32", workerFinished: false }, { pending: true, reason: "process-missing", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: false, platform: "win32", workerFinished: true }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: false, platform: "win32", workerFinished: false }, { pending: true, reason: "identity-unavailable", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-mismatch" }, alive: false, platform: "win32", workerFinished: false }, { pending: true, reason: "identity-mismatch", survivors: [], rootAlive: false }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-mismatch" }, alive: false, platform: "win32", workerFinished: true }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: false, reason: "process-missing" }, alive: true, platform: "win32", workerFinished: true }, { pending: true, reason: "process-missing", survivors: [], rootAlive: true }],
    [{ pid: 1, kill: { attempted: false, reason: "identity-unavailable" }, alive: false, platform: "linux", workerFinished: false }, { pending: false, reason: null, survivors: [] }],
    [{ pid: 1, kill: { attempted: true, delivered: false }, alive: true, platform: "linux" }, { pending: true, reason: "not-delivered", survivors: [], rootAlive: true }],
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
  assert.equal(brokerExclusion("unknown"), null);
});

test("brokerPresence: a record, unknown while an endpoint is advertised, or null", () => {
  const workspace = makeTempDir();
  assert.equal(brokerPresence(workspace, {}), null);
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "" }), null);
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "unix:/tmp/x.sock" }), "unknown");
  // A pre-loaded record is used as is: no second read.
  assert.deepEqual(brokerPresence(workspace, {}, { record: { endpoint: "e" } }), { endpoint: "e" });
  assert.equal(brokerPresence(workspace, {}, { record: null }), null);
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "x" }, { record: null }), "unknown");
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/x.sock", pid: null, pidFile: null, logFile: null, sessionDir: null });
  assert.equal(brokerPresence(workspace, { [BROKER_ENDPOINT_ENV]: "unix:/tmp/x.sock" }).endpoint, "unix:/tmp/x.sock");
  assert.equal(brokerPresence(workspace, {}).endpoint, "unix:/tmp/x.sock");
});

test("brokerPresence: an existing but unreadable broker.json presumes a broker", () => {
  const workspace = makeTempDir();
  const dir = resolveStateDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "broker.json"), "{not json");
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(brokerPresence(workspace, {}), "unknown");
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("renderCancelPending renders process-missing plainly", () => {
  const rendered = renderCancelPending({ pending: true, reason: "process-missing", survivors: [], rootAlive: false }, 4300, "job-1");
  assert.equal(rendered.logLine, "cancellation not confirmed: worker pid 4300 left running (process-missing)");
  assert.match(rendered.text, /worker pid 4300 exited before it could be signalled; the job stays running until the reaper judges it/);
  assert.equal(rendered.json.reason, "process-missing");
  assert.equal(rendered.diagnostic, null);
});

test("renderCancelPending says an unverifiable dead worker waits for the reaper", () => {
  for (const reason of ["identity-unavailable", "identity-mismatch"]) {
    const rendered = renderCancelPending({ pending: true, reason, survivors: [], rootAlive: false }, 4300, "job-1");
    assert.match(rendered.text, /worker pid 4300 exited before it could be verified; the job stays running until the reaper judges it\./);
  }
});

test("renderCancelPending reports survivors on win32", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS }, 4300, "job-1");
  assert.deepEqual(rendered.json.survivors, SURVIVORS);
  assert.ok(rendered.logLine.endsWith(" worker tree survivors: 4301:win32:7"));
  assert.equal(rendered.diagnostic, "[codex] worker tree survivors: 4301:win32:7\n");
});

test("renderCancelPending says the root exited when only its tree survives", () => {
  const rendered = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS, rootAlive: false }, 4300, "job-1");
  assert.ok(rendered.text.includes("worker pid 4300 exited but part of its tree is still running (survivors: 4301:win32:7); the job stays running until the reaper judges it."));
  assert.ok(!rendered.text.includes("until the worker exits"));
  const alive = renderCancelPending({ pending: true, reason: "kill-failed", survivors: SURVIVORS, rootAlive: true }, 4300, "job-1");
  assert.ok(alive.text.includes("until the worker exits"));
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
