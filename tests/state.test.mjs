import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  consumeJobRequestFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobRequestFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobRequestFile
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_MODULE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "codex",
  "scripts",
  "lib",
  "state.mjs"
);

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("job request payloads are written owner-only and consumed exactly once", () => {
  const workspace = makeTempDir();
  const payload = { prompt: "go", config: { "http_headers.Authorization": "SECRET" } };

  const requestFile = writeJobRequestFile(workspace, "task-1", payload);
  assert.equal(requestFile, resolveJobRequestFile(workspace, "task-1"));
  assert.equal(fs.statSync(requestFile).mode & 0o777, 0o600);

  assert.deepEqual(consumeJobRequestFile(workspace, "task-1"), payload);
  assert.equal(fs.existsSync(requestFile), false);
  assert.equal(consumeJobRequestFile(workspace, "task-1"), null);
});

test("saveState drops the private request payload of pruned jobs", () => {
  const workspace = makeTempDir();
  const requestFile = writeJobRequestFile(workspace, "task-dropped", { prompt: "go" });

  saveState(workspace, { jobs: [{ id: "task-dropped", updatedAt: "2026-01-01T00:00:00.000Z" }] });
  assert.equal(fs.existsSync(requestFile), true);

  saveState(workspace, { jobs: [] });
  assert.equal(fs.existsSync(requestFile), false);
});

// A reader that catches `state.json` mid-write parses a truncated file, and
// `loadState` turns that into "no jobs" — which is how a SessionEnd with a live
// job decided the workspace was idle and shut the shared broker down. Writers
// must swap the file in atomically so a reader sees the old or the new one.
test("concurrent writers never leave a torn state.json for a reader", async () => {
  const workspace = makeTempDir();
  const jobs = Array.from({ length: 50 }, (_, index) => ({
    id: `job-${index}`,
    status: "running",
    updatedAt: `2026-03-18T15:${String(index % 60).padStart(2, "0")}:00.000Z`,
    summary: "x".repeat(2048)
  }));
  saveState(workspace, { jobs });
  const stateFile = resolveStateFile(workspace);

  const writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { saveState } from ${JSON.stringify(pathToFileURL(STATE_MODULE).href)};
       const jobs = ${JSON.stringify(jobs)};
       const deadline = Date.now() + 2000;
       while (Date.now() < deadline) {
         saveState(${JSON.stringify(workspace)}, { jobs });
       }`
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] }
  );
  let writerStderr = "";
  writer.stderr.on("data", (chunk) => {
    writerStderr += chunk;
  });

  let reads = 0;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const raw = fs.readFileSync(stateFile, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      assert.fail(`torn read after ${reads} reads (${raw.length} bytes): ${error.message}`);
    }
    assert.equal(parsed.jobs.length, 50, `torn read after ${reads} reads: lost jobs`);
    reads += 1;
  }

  await new Promise((resolve) => writer.on("exit", resolve));
  assert.equal(writerStderr, "");
  assert.ok(reads > 100, `expected the reader to race the writer, got ${reads} reads`);
});
