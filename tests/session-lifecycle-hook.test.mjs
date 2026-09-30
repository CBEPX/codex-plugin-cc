import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { deadPid as deadPidOf, makeTempDir } from "./helpers.mjs";
import { loadState, resolveStateDir, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { cleanupSessionJobs, killStepMs } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

test("killStepMs gives a Windows kill one PowerShell run's worth of budget", () => {
  assert.equal(killStepMs("win32"), 4000);
  assert.equal(killStepMs("linux"), 2000);
});

test("SessionEnd keeps a job whose tree left survivors and drops one whose kill settled", () => {
  const cases = [
    ["win32", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [{ pid: 4301, identity: "win32:7" }] }, true, /tree survivors: 4301:win32:7/],
    ["win32", { attempted: true, delivered: false, method: "handle", reason: "kill-failed", survivors: [], unverified: true }, true, /tree survivors: unverified/],
    ["linux", { attempted: true, delivered: false, reason: "not-delivered" }, false, null],
    ["win32", { attempted: true, delivered: true, method: "handle", reason: "identity-match" }, false, null],
    ["win32", { attempted: false, delivered: false, reason: "no-pid" }, false, null],
    // Never examined the tree (refused, or the kill threw): a dead root proves nothing — the broker teardown's rule.
    ["win32", { attempted: false, delivered: false, reason: "identity-unavailable" }, true, /job-1 tree survivors: unknown\n[\s\S]*left job-1 running: identity-unavailable/],
    ["win32", () => { throw new Error("powershell crashed"); }, true, /job-1 tree survivors: unknown\n[\s\S]*left job-1 running: kill-failed/],
    // Proven not ours, or gone without orphans: a stale record, the reaper's domain.
    ["win32", { attempted: false, delivered: false, method: "handle", reason: "identity-mismatch" }, false, null],
    ["win32", { attempted: false, delivered: false, method: "handle", reason: "process-missing" }, false, null]
  ];
  // A pid that is provably dead: a child that has already exited and that the
  // plugin's liveness probe reports gone (helpers' deadPid waits for that on
  // Windows), so no table row depends on which pids the host happens to use.
  const deadPid = deadPidOf();
  for (const [platform, outcome, keptExpected, stderrPattern] of cases) {
    const repo = makeTempDir();
    const sessionId = "session-1";
    upsertJob(repo, { id: "job-1", status: "running", sessionId, background: false, pid: deadPid, pidIdentity: platform === "win32" ? "win32:1" : "linux:1" });
    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      cleanupSessionJobs(repo, sessionId, 1000, () => 8000, { platform, terminateRecordedProcessImpl: typeof outcome === "function" ? outcome : () => outcome, broker: { pid: 555, pidIdentity: "win32:1" } });
    } finally {
      process.stderr.write = original;
    }
    const remaining = loadState(repo).jobs.map((job) => job.id);
    assert.deepEqual(remaining, keptExpected ? ["job-1"] : [], `${platform} ${typeof outcome === "function" ? "throws" : JSON.stringify(outcome)}`);
    if (stderrPattern) {
      assert.match(written.join(""), stderrPattern);
    }
  }
});

test("SessionEnd passes the verified broker as the excluded subtree and refuses without its identity", () => {
  const repo = makeTempDir();
  const deadPid = deadPidOf();
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  let seen = null;
  cleanupSessionJobs(repo, "s", 1000, () => 8000, { platform: "win32", broker: { pid: 555, pidIdentity: "win32:1" }, terminateRecordedProcessImpl: (pid, options) => { seen = options; return { attempted: true, delivered: true, method: "handle", reason: "identity-match" }; } });
  assert.deepEqual(seen.exclude, [{ pid: 555, identity: "win32:1" }]);
  assert.ok(seen.timeoutMs <= 4000 && seen.timeoutMs >= 100);
  // A recorded broker without identity: the kill is not even attempted; the job is kept.
  const repo2 = makeTempDir();
  upsertJob(repo2, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    cleanupSessionJobs(repo2, "s", 1000, () => 8000, { platform: "win32", broker: { pid: 555, pidIdentity: null }, terminateRecordedProcessImpl: () => assert.fail("must not kill") });
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(loadState(repo2).jobs.map((job) => job.id), ["job-1"]);
  assert.match(written.join(""), /left job-1 running: identity-unavailable/);
  assert.match(written.join(""), /left job-1 tree: refused \(broker record unreadable or without identity\)/);
});

test("SessionEnd keeps the job untouched when the broker presence is unknown", () => {
  const repo = makeTempDir();
  const deadPid = deadPidOf();
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    cleanupSessionJobs(repo, "s", 1000, () => 8000, { platform: "win32", broker: "unknown", terminateRecordedProcessImpl: () => assert.fail("must not kill") });
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(loadState(repo).jobs.map((job) => job.id), ["job-1"]);
  assert.match(written.join(""), /left job-1 tree: refused \(broker record unreadable or without identity\)/);
});

test("SessionEnd without a recorded broker still kills the worker, excluding nothing", () => {
  const repo = makeTempDir();
  const deadPid = deadPidOf();
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  let seen = null;
  cleanupSessionJobs(repo, "s", 1000, () => 8000, { platform: "win32", broker: null, terminateRecordedProcessImpl: (pid, options) => { seen = options; return { attempted: true, delivered: true, method: "handle", reason: "identity-match" }; } });
  assert.deepEqual(seen.exclude, []);
});

test("SessionEnd drops a pid-less job even when the broker presence is unknown", () => {
  const repo = makeTempDir();
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false });
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    cleanupSessionJobs(repo, "s", 1000, () => 8000, {
      platform: "win32",
      broker: "unknown",
      terminateRecordedProcessImpl: () => ({ attempted: false, delivered: false, reason: "no-pid" })
    });
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(loadState(repo).jobs, []);
  assert.doesNotMatch(written.join(""), /refused/);
});

test("SessionEnd reads the broker presence for worker kills under the cleanup lock", () => {
  const repo = makeTempDir();
  const deadPid = deadPidOf();
  upsertJob(repo, { id: "job-1", status: "running", sessionId: "s", background: false, pid: deadPid, pidIdentity: "win32:1" });
  let tickets = null;
  let seen = null;
  cleanupSessionJobs(repo, "s", 1000, () => 8000, {
    platform: "win32",
    loadBroker: () => {
      tickets = fs.readdirSync(path.join(resolveStateDir(repo), "state.lock.d")).filter((name) => name.endsWith(".ticket"));
      return { pid: 555, pidIdentity: "win32:1" };
    },
    terminateRecordedProcessImpl: (pid, options) => { seen = options; return { attempted: true, delivered: true, method: "handle", reason: "identity-match" }; }
  });
  assert.equal(tickets?.length, 1, "the broker record is read while the state lock is held");
  assert.deepEqual(seen.exclude, [{ pid: 555, identity: "win32:1" }]);
});
