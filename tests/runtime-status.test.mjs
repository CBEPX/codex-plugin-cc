import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  initGitRepo,
  jobDiagnostics,
  makeTempDir,
  readJobRecord,
  run,
  SCRIPT,
  seededRepo
} from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const READ_LIMIT = 8192;
const STATUS_NEXT = "Use --output <new-path> for the complete JSON payload.";
const bytes = (text) => Buffer.byteLength(text);

// A `running` task whose index entry carries a 60 KB prompt, as a background
// task's does. No pid: nothing runs, and the reaper leaves the record alone
// (the pattern of "status --wait times out cleanly" below).
function seedLiveTask(workspace, prompt) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  const job = {
    id: "task-live",
    kind: "task",
    jobClass: "task",
    status: "running",
    phase: "running",
    title: "Codex Task",
    summary: "Investigate flaky test",
    background: true,
    logFile,
    request: { prompt, config: {} },
    createdAt: "2026-03-18T15:30:00.000Z",
    startedAt: "2026-03-18T15:30:01.000Z",
    updatedAt: "2026-03-18T15:30:02.000Z"
  };
  fs.writeFileSync(path.join(jobsDir, "task-live.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );
}

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  // A timed-out wait exits 1 in JSON mode too (#774); the snapshot itself is unchanged.
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run(process.execPath, [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run(process.execPath, [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run(process.execPath, [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("status --args-stdin tokenizes the raw argument string from stdin", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const viaStdin = run(process.execPath, [SCRIPT, "status", "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "--all --json\n"
  });
  const viaArgv = run(process.execPath, [SCRIPT, "status", "--all", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(viaArgv.status, 0, viaArgv.stderr);
  assert.deepEqual(JSON.parse(viaStdin.stdout), JSON.parse(viaArgv.stdout));
});

test("result on a still-running job exits 3 with the wait hint instead of \"No job found\"", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "3000" });
  const launch = run(process.execPath, [SCRIPT, "task", "--background", "--json", "--prompt-stdin"], {
    cwd: repo, env, input: "slow background task\n"
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  const active = run(process.execPath, [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(active.status, 3, active.stderr);
  assert.match(
    active.stdout,
    new RegExp(`Job ${jobId} is still (queued|running)\\. Re-run: node .*result ${jobId} --wait --timeout-ms 540000`)
  );

  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: repo, env });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(done.stdout.trim().length > 0);
});

test("status --wait reports a timeout in text output and exits 1 while the job is still active (#774)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "4000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "slow"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const status = run(process.execPath, [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "500"], { cwd: repo, env });
  assert.equal(status.status, 1);
  assert.match(status.stdout, /Timed out after 1s while the job was still running\./);
  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: repo, env });
  assert.equal(done.status, 0, done.stderr);
});

test("status of a finished task with a 60 KB prompt stays bounded; --output exports it once", { timeout: 90_000 }, (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const prompt = `investigate ${"p".repeat(60_000)}`;
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "--prompt-stdin"], { cwd: repo, env, input: prompt });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  t.after(() => {
    try {
      const { pid } = readJobRecord(repo, jobId);
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
  });
  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "30000"], { cwd: repo, env });
  assert.equal(done.status, 0, `${done.stderr}\n${jobDiagnostics(repo, jobId)}`);

  for (const args of [["status", "--json"], ["status", jobId, "--json"]]) {
    const status = run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
    assert.equal(status.status, 0, status.stderr);
    assert.ok(bytes(status.stdout) <= READ_LIMIT, `${args.join(" ")}: ${bytes(status.stdout)} bytes`);
    assert.equal(status.stdout.includes("p".repeat(100)), false, `${args.join(" ")} printed the prompt`);
    const view = JSON.parse(status.stdout);
    assert.equal(view.truncated, true);
    assert.ok(view.omissions.fieldNames.includes("request"));
    assert.equal(view.nextStep, STATUS_NEXT);
  }
  const listed = JSON.parse(run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env }).stdout);
  assert.equal(listed.latestFinished.id, jobId);
  assert.equal("request" in listed.latestFinished, false);
  assert.deepEqual([listed.totalJobs, listed.omittedJobs], [1, 0]);

  for (const args of [["status"], ["status", jobId]]) {
    const text = run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(bytes(text.stdout) <= READ_LIMIT, `${args.join(" ")}: ${bytes(text.stdout)} bytes`);
    // The text never shows the prompt, so dropping it is no truncation there
    // (the --json runs above still report it: truncated, fieldNames ["request"]).
    assert.doesNotMatch(text.stdout, /Truncated:|--output <new-path>/);
  }

  // A relative --output resolves against --cwd, not the process cwd.
  const elsewhere = makeTempDir();
  const exported = run(process.execPath, [SCRIPT, "status", "--output", "status-full.json", "--cwd", repo], { cwd: elsewhere, env });
  assert.equal(exported.status, 0, exported.stderr);
  const outputFile = path.join(repo, "status-full.json");
  const written = fs.readFileSync(outputFile);
  assert.deepEqual(JSON.parse(exported.stdout), {
    outputFile,
    bytes: written.length,
    sha256: createHash("sha256").update(written).digest("hex")
  });
  const full = JSON.parse(written.toString("utf8"));
  assert.equal(full.latestFinished.request.prompt, prompt);
  assert.equal("truncated" in full, false, "the file holds the pre-1.5.0 payload");

  const again = run(process.execPath, [SCRIPT, "status", "--output", outputFile], { cwd: repo, env });
  assert.equal(again.status, 1);
  assert.equal(again.stdout, "");
  assert.match(again.stderr, /--output .*status-full\.json already exists; pass a new path\./);
  assert.equal(fs.readFileSync(outputFile).equals(written), true, "an existing file is never overwritten");
});

test("status <id> --wait on a job with a 60 KB prompt times out bounded with exit 1, also with --output", () => {
  const workspace = makeTempDir();
  const prompt = "q".repeat(60_000);
  seedLiveTask(workspace, prompt);

  const json = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], { cwd: workspace });
  assert.equal(json.status, 1, json.stderr);
  assert.ok(bytes(json.stdout) <= READ_LIMIT, `${bytes(json.stdout)} bytes`);
  const view = JSON.parse(json.stdout);
  assert.deepEqual([view.job.id, view.job.status, view.waitTimedOut, view.truncated], ["task-live", "running", true, true]);
  assert.equal("request" in view.job, false);
  assert.equal(view.nextStep, STATUS_NEXT);

  const text = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25"], { cwd: workspace });
  assert.equal(text.status, 1, text.stderr);
  assert.ok(bytes(text.stdout) <= READ_LIMIT);
  assert.ok(text.stdout.endsWith("\nTimed out after 1s while the job was still running.\n"), text.stdout);
  assert.doesNotMatch(text.stdout, /Truncated:/);

  const outputFile = path.join(makeTempDir(), "status-wait.json");
  const exported = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--output", outputFile], { cwd: workspace });
  assert.equal(exported.status, 1, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).outputFile, outputFile);
  const full = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(full.waitTimedOut, true);
  assert.equal(full.job.request.prompt, prompt);
});

test("status <id> --wait --output <existing> fails before waiting and leaves the job running", { timeout: 90_000 }, () => {
  const workspace = makeTempDir();
  seedLiveTask(workspace, "q".repeat(60_000));
  const existing = path.join(makeTempDir(), "taken.json");
  fs.writeFileSync(existing, "keep");
  // A wait that is not skipped lasts 120 s; spawnSync kills it at 60 s and `status` is then null.
  const refused = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "120000", "--output", existing], { cwd: workspace, timeout: 60_000 });
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stderr.includes(`--output ${existing} already exists; pass a new path.`), true, refused.stderr);
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  const after = run(process.execPath, [SCRIPT, "status", "task-live", "--json"], { cwd: workspace });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).job.status, "running");
});

test("status lists 8 jobs, counts the finished ones past the cut and points at --all", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const jobs = Array.from({ length: 12 }, (_, index) => {
    const at = `2026-03-18T15:${String(59 - index).padStart(2, "0")}:00.000Z`;
    return { id: `task-${String(index).padStart(2, "0")}`, kind: "task", jobClass: "task", status: "completed", phase: "done", title: "Codex Task", summary: `job ${index}`, createdAt: at, completedAt: at, updatedAt: at };
  });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`, "utf8");

  const listed = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: workspace });
  assert.equal(listed.status, 0, listed.stderr);
  const view = JSON.parse(listed.stdout);
  assert.deepEqual([view.totalJobs, view.omittedJobs, view.omissions.records, view.truncated], [12, 4, 4, true]);
  assert.equal(view.nextStep, "Use --all to include omitted records, with --output <new-path> for the complete JSON payload.");

  const text = run(process.execPath, [SCRIPT, "status"], { cwd: workspace });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\nUse --all to include omitted records, with --output <new-path> for the complete JSON payload\.\n$/);

  const all = run(process.execPath, [SCRIPT, "status", "--all", "--json"], { cwd: workspace });
  assert.equal(all.status, 0, all.stderr);
  const allView = JSON.parse(all.stdout);
  assert.equal(allView.omittedJobs, 0);
  assert.equal(allView.omissions.records, 0);
  assert.ok(bytes(all.stdout) <= READ_LIMIT);
});

// Port of the cc-plugin-codex "bounds --all lists" regression, with active records:
// the text renderer prints those twice, in the table and in the details.
test("an oversized status list shrinks its arrays and counts every omitted record", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const at = (minute) => `2026-03-18T15:${String(minute).padStart(2, "0")}:00.000Z`;
  const active = Array.from({ length: 4 }, (_, index) => {
    const logFile = path.join(jobsDir, `task-active-${index}.log`);
    fs.writeFileSync(logFile, "[2026-03-18T15:59:00.000Z] Starting Codex Task.\n", "utf8");
    return { id: `task-active-${index}`, kind: "task", jobClass: "task", status: "running", phase: "running", title: "Codex Task", summary: "長".repeat(2000), logFile, createdAt: at(59 - index), updatedAt: at(59 - index) };
  });
  const finished = Array.from({ length: 30 }, (_, index) => ({
    id: `task-done-${String(index).padStart(2, "0")}`, kind: "task", jobClass: "task", status: "completed", phase: "done", title: "Codex Task", summary: "済".repeat(2000), createdAt: at(50 - index), completedAt: at(50 - index), updatedAt: at(50 - index)
  }));
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [...active, ...finished] }, null, 2)}\n`, "utf8");

  for (const [args, omittedJobs, recentTotal] of [[["--all"], 0, 29], [[], 26, 3]]) {
    const listed = run(process.execPath, [SCRIPT, "status", ...args, "--json"], { cwd: workspace });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(bytes(listed.stdout) <= READ_LIMIT, `${bytes(listed.stdout)} bytes`);
    const view = JSON.parse(listed.stdout);
    assert.deepEqual([view.totalJobs, view.omittedJobs, view.truncated], [34, omittedJobs, true]);
    if (args.length) {
      assert.ok(view.recent.length < recentTotal, "--all: the recent array was shrunk");
    }
    assert.equal(view.omissions.records, omittedJobs + (4 - view.running.length) + (recentTotal - view.recent.length));
    const text = run(process.execPath, [SCRIPT, "status", ...args], { cwd: workspace });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(bytes(text.stdout) <= READ_LIMIT, `text: ${bytes(text.stdout)} bytes`);
    assert.match(text.stdout, /\n\nTruncated: \{.*\}\n/);
    assert.ok(text.stdout.endsWith(`\n${omittedJobs > 0 ? "Use --all to include omitted records, with --output <new-path> for the complete JSON payload." : STATUS_NEXT}\n`));
  }
});

// Port of the cc-plugin-codex "large historical Unicode reads" regression.
test("a large historical record with CJK and astral text reads bounded through status and result, untouched on disk", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  // Astral characters straddle every cut point (512, 4096 and the halvings).
  const body = `漢字${"😀漢".repeat(20_000)}`;
  const job = {
    id: "task-unicode",
    kind: "task",
    jobClass: "task",
    status: "completed",
    phase: "done",
    title: "Codex Task",
    summary: `概要😀${"長".repeat(3000)}`,
    threadId: "thr_unicode",
    request: { prompt: body, config: {} },
    createdAt: "2026-03-18T15:00:00.000Z",
    completedAt: "2026-03-18T15:01:00.000Z",
    updatedAt: "2026-03-18T15:01:00.000Z"
  };
  const jobFile = path.join(jobsDir, "task-unicode.json");
  const statePath = path.join(stateDir, "state.json");
  fs.writeFileSync(jobFile, `${JSON.stringify({ ...job, result: { rawOutput: body }, rendered: `${body}\n` }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`, "utf8");
  const before = [fs.readFileSync(jobFile), fs.readFileSync(statePath)];

  for (const args of [["status", "task-unicode"], ["result", "task-unicode"]]) {
    for (const format of [[], ["--json"]]) {
      const read = run(process.execPath, [SCRIPT, ...args, ...format], { cwd: workspace });
      const label = [...args, ...format].join(" ");
      assert.equal(read.status, 0, `${label}: ${read.stderr}`);
      assert.ok(bytes(read.stdout) <= READ_LIMIT, `${label}: ${bytes(read.stdout)} bytes`);
      assert.equal(read.stdout.includes("�"), false, `${label} printed a broken surrogate`);
      assert.match(read.stdout, /Truncated|"truncated": true/, label);
      if (format.length) {
        assert.equal(JSON.parse(read.stdout).truncated, true, label);
      }
    }
  }
  assert.ok(fs.readFileSync(jobFile).equals(before[0]), "the job file is never rewritten by a read");
  assert.ok(fs.readFileSync(statePath).equals(before[1]), "the state index is never rewritten by a read");
});

test("result on an active job with a 3000-character id stays bounded with exit 3", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const id = `task-${"x".repeat(3000)}`;
  // Index only: a job file name that long is over NAME_MAX, and nothing reads one for an active job without a pid.
  const job = { id, kind: "task", jobClass: "task", status: "running", phase: "running", title: "Codex Task", summary: "long id", createdAt: "2026-03-18T15:30:00.000Z", updatedAt: "2026-03-18T15:30:02.000Z" };
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`, "utf8");
  for (const format of [[], ["--json"]]) {
    const read = run(process.execPath, [SCRIPT, "result", id, ...format], { cwd: workspace });
    assert.equal(read.status, 3, read.stderr);
    assert.ok(bytes(read.stdout) <= READ_LIMIT, `${format.join(" ") || "text"}: ${bytes(read.stdout)} bytes`);
    if (format.length) {
      assert.ok("resumeCommand" in JSON.parse(read.stdout));
    } else {
      assert.ok(read.stdout.startsWith(`Job ${id.slice(0, 100)}`), read.stdout.slice(0, 200));
    }
  }
});

test("result of a 20 KB answer prints a bounded preview; --wait prints it in full; --wait --output is refused", { timeout: 60_000 }, () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const answer = "0123456789".repeat(2000);
  const env = buildEnv(binDir, { FAKE_CODEX_ANSWER_TEXT: answer });
  const task = run(process.execPath, [SCRIPT, "task", "--json", "a long answer please"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  const stored = readJobRecord(repo);
  const jobId = stored.id;
  const nextStep = `Full output: \`result ${jobId} --wait\` (text) or \`result ${jobId} --output <new-path>\` (JSON).`;

  const preview = run(process.execPath, [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(bytes(preview.stdout) <= READ_LIMIT, `${bytes(preview.stdout)} bytes`);
  assert.ok(preview.stdout.startsWith(`${answer.slice(0, 4096)}…\n`), preview.stdout.slice(0, 4200));
  assert.match(preview.stdout, new RegExp(`\\nCodex session ID: ${stored.threadId}\\n`));
  assert.match(preview.stdout, /\n\nTruncated: \{"fields":0,"fieldNames":\[\],"records":0,"strings":\d+\}\n/);
  assert.ok(preview.stdout.endsWith(`\n${nextStep}\n`), preview.stdout.slice(-300));

  const json = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
  assert.equal(json.status, 0, json.stderr);
  assert.ok(bytes(json.stdout) <= READ_LIMIT, `${bytes(json.stdout)} bytes`);
  const view = JSON.parse(json.stdout);
  assert.deepEqual([view.job.id, view.job.status, view.truncated, view.nextStep], [jobId, "completed", true, nextStep]);
  assert.ok(view.omissions.strings >= 1);
  assert.equal(view.omissions.fields, 0, "result is not a summary: nothing is dropped");
  assert.ok(view.storedJob.result.rawOutput.endsWith("…"));

  const full = run(process.execPath, [SCRIPT, "result", jobId, "--wait"], { cwd: repo, env });
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.stdout, `${stored.rendered}\nCodex session ID: ${stored.threadId}\nResume in Codex: codex resume ${stored.threadId}\n`);

  const outputFile = path.join(makeTempDir(), "result.json");
  const refused = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--output", outputFile], { cwd: repo, env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--output cannot be combined with --wait; result --wait already prints the full record\./);
  assert.equal(fs.existsSync(outputFile), false);

  const exported = run(process.execPath, [SCRIPT, "result", jobId, "--output", outputFile], { cwd: repo, env });
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).outputFile, outputFile);
  assert.equal(JSON.parse(fs.readFileSync(outputFile, "utf8")).storedJob.result.rawOutput, answer);
});

test("result on an active job with a 60 KB prompt: bounded hint with exit 3; --wait's timeout hint stays full", () => {
  const workspace = makeTempDir();
  const prompt = "q".repeat(60_000);
  seedLiveTask(workspace, prompt);
  const nextStep = "Full output: `result task-live --wait` (text) or `result task-live --output <new-path>` (JSON).";

  const json = run(process.execPath, [SCRIPT, "result", "task-live", "--json"], { cwd: workspace });
  assert.equal(json.status, 3, json.stderr);
  assert.ok(bytes(json.stdout) <= READ_LIMIT, `${bytes(json.stdout)} bytes`);
  const view = JSON.parse(json.stdout);
  assert.match(view.resumeCommand, /^node ".*codex-companion\.mjs" result task-live --wait --timeout-ms 540000$/);
  assert.deepEqual([view.job.status, view.truncated, view.nextStep], ["running", true, nextStep]);
  assert.equal("request" in view.job, false);

  const text = run(process.execPath, [SCRIPT, "result", "task-live"], { cwd: workspace });
  assert.equal(text.status, 3, text.stderr);
  // Only the summary drop happened: the text hint is the 1.4.3 line, nothing appended.
  assert.match(text.stdout, /^Job task-live is still running\. Re-run: node .*result task-live --wait --timeout-ms 540000\n$/);

  const outputFile = path.join(makeTempDir(), "active.json");
  const exported = run(process.execPath, [SCRIPT, "result", "task-live", "--output", outputFile], { cwd: workspace });
  assert.equal(exported.status, 3, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).outputFile, outputFile);
  const full = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(full.job.request.prompt, prompt);
  assert.equal(full.resumeCommand, view.resumeCommand);

  // Row 5: the `--wait` timeout hint is the rescue path's, printed in full as in 1.4.3.
  const waited = run(process.execPath, [SCRIPT, "result", "task-live", "--wait", "--timeout-ms", "100", "--json"], { cwd: workspace });
  assert.equal(waited.status, 3, waited.stderr);
  const hint = JSON.parse(waited.stdout);
  assert.equal(hint.job.request.prompt, prompt);
  assert.equal("truncated" in hint, false);
});
