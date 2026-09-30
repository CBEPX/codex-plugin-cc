import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  FAKE_RESOLVED_SETTINGS,
  initGitRepo,
  IS_WIN,
  jobDiagnostics,
  makeTempDir,
  readJobRecord,
  readStateIndex,
  run,
  SCRIPT,
  seededRepo,
  waitFor
} from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  consumeJobRequestFile,
  readJobFile,
  resolveJobFile,
  resolveJobRequestFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";


test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run(process.execPath, [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
  assert.deepEqual(readJobRecord(repo).resolved, FAKE_RESOLVED_SETTINGS);
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task-resume-candidate reaps a crashed running task so it becomes resumable", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  // A pid that has already exited: process.kill(pid, 0) will throw ESRCH.
  const deadPid = run(process.execPath, ["-e", ""]).pid;
  const crashedJob = {
    id: "task-crashed",
    status: "running",
    phase: "delegating",
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-current",
    threadId: "thr_crashed",
    summary: "Investigate the crash",
    pid: deadPid,
    updatedAt: "2026-03-24T20:00:00.000Z"
  };
  fs.writeFileSync(path.join(jobsDir, "task-crashed.json"), `${JSON.stringify(crashedJob, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [crashedJob] }, null, 2)}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Without the reaper the job would still read as "running" and be skipped,
  // leaving the resume probe with no candidate.
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.id, "task-crashed");
  assert.equal(payload.candidate.status, "failed");
  assert.equal(payload.candidate.threadId, "thr_crashed");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run(process.execPath, [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run(process.execPath, [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run(process.execPath, [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.approvalPolicy, "on-request");
  assert.equal(fakeState.lastThreadStart.sandbox, "workspace-write");
});

test("read-only task keeps never approval policy on app-server thread/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "inspect the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.approvalPolicy, "never");
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
});

test("task --resume-last --write forwards write approval policy to app-server thread/resume", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run(process.execPath, [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run(process.execPath, [SCRIPT, "task", "--resume-last", "--write", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadResume.threadId, "thr_1");
  assert.equal(fakeState.lastThreadResume.approvalPolicy, "on-request");
  assert.equal(fakeState.lastThreadResume.sandbox, "workspace-write");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run(process.execPath, [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run(process.execPath, [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "resolved-effort");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
  assert.deepEqual(readJobRecord(repo).resolved, {
    ...FAKE_RESOLVED_SETTINGS,
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "low"
  });
});

test("task preserves resolved settings when turn/start fails", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "--effort", "xhigh", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /turn\/start failed after thread resolution/);
  const storedJob = readJobRecord(repo);
  assert.equal(storedJob.status, "failed");
  // `--effort` is applied via thread/start.config, so the resolved settings echo it back.
  const resolvedWithEffort = { ...FAKE_RESOLVED_SETTINGS, reasoningEffort: "xhigh" };
  assert.deepEqual(storedJob.resolved, resolvedWithEffort);
  const state = readStateIndex(repo);
  assert.deepEqual(state.jobs[0].resolved, resolvedWithEffort);
});

for (const effort of ["max", "ultra"]) {
  test(`task forwards ${effort} reasoning effort to app-server turn/start`, () => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    const statePath = path.join(binDir, "fake-codex-state.json");
    installFakeCodex(binDir);
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    const result = run(process.execPath, [SCRIPT, "task", "--effort", effort, "diagnose the failing test"], {
      cwd: repo,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(fakeState.lastTurnStart.effort, effort);
  });
}

test("task rejects an unknown reasoning effort", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "--effort", "supreme", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported reasoning effort "supreme"/);
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readStateIndex(repo);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readStateIndex(repo);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task keeps the subagent label when thread/started arrives before the turn/start response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir, { FAKE_CODEX_SUBAGENT_EARLY_STARTED: "1" })
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readStateIndex(repo);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger:/);
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const runningJob = await waitFor(() => {
    try {
      const storedJob = readJobRecord(repo, launchPayload.jobId);
      return storedJob.status === "running" && storedJob.resolved ? storedJob : null;
    } catch {
      return null;
    }
  });
  assert.deepEqual(runningJob.resolved, FAKE_RESOLVED_SETTINGS);
  const runningState = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.deepEqual(runningState.jobs.find((job) => job.id === launchPayload.jobId).resolved, FAKE_RESOLVED_SETTINGS);

  const waitedStatus = run(
    process.execPath,
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run(process.execPath, [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.deepEqual(resultPayload.job.resolved, FAKE_RESOLVED_SETTINGS);
  assert.deepEqual(resultPayload.storedJob.resolved, FAKE_RESOLVED_SETTINGS);
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

// A cancel that lands after the spawn but before the worker takes the record
// over writes `cancelled`; the worker that starts afterwards must not run it.
test("a worker started against a cancelled job exits without running the turn", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  const jobId = "task-cancelled-before-start";
  const record = { id: jobId, kind: "task", jobClass: "task", title: "Codex Task", workspaceRoot: repo, status: "cancelled", phase: "cancelled", background: true, pid: null, pidIdentity: null, errorMessage: "Cancelled by user.", completedAt: new Date().toISOString(), request: { prompt: "never run" } };
  writeJobFile(repo, jobId, record);
  upsertJob(repo, record);
  const worker = run(process.execPath, [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(worker.status, 0, worker.stderr);
  const stored = readJobFile(resolveJobFile(repo, jobId));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.startedAt, undefined, "no running record was written");
  assert.equal(stored.result, undefined);
  const appServerStarts = fs.existsSync(fakeStatePath) ? JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts : 0;
  assert.equal(appServerStarts, 0, "no Codex turn may start for a cancelled job");
});

test("task --model sol resolves through the model catalogue and rejects an unsupported effort", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const ok = run(process.execPath, [SCRIPT, "task", "--json", "--model", "sol", "--effort", "max", "hello"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastThreadStart.config.model, "gpt-6-sol");
  const bad = run(process.execPath, [SCRIPT, "task", "--json", "--model", "gpt-5.6-sol", "--effort", "max", "hello"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /gpt-5\.6-sol supports: low, medium, high/);
});

test("task forwards config overrides and keeps option-looking prompt words", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "task", "--effort", "max", "--config", "model_provider=ollama", "investigate", "ls", "-R", "usage"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_provider: "ollama", model_reasoning_effort: "max" });
  assert.match(fakeState.lastTurnStart.prompt, /investigate ls -R usage/);
});

test("task --resume-last never puts model or effort into thread/resume config", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const first = run(process.execPath, [SCRIPT, "task", "--model", "sol", "--effort", "high", "first"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);
  const startsAfterFirst = JSON.parse(fs.readFileSync(statePath, "utf8")).appServerStarts;
  const second = run(process.execPath, [SCRIPT, "task", "--resume-last", "--effort", "max", "--config", "model_provider=ollama", "again"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(second.status, 0, second.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadResume.config, { model_provider: "ollama" });
  assert.equal(fakeState.lastTurnStart.effort, "max");
  // A hot broker rejoin would ignore the config/sandbox overrides, so the resume
  // must have run on a freshly spawned app-server process.
  assert.equal(fakeState.appServerStarts, startsAfterFirst + 1);
});

test("task --resume-last cold-resumes without a thread/resume model override", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const first = run(process.execPath, [SCRIPT, "task", "--model", "sol", "--effort", "high", "first"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);
  const startsAfterFirst = JSON.parse(fs.readFileSync(statePath, "utf8")).appServerStarts;

  const second = run(process.execPath, [SCRIPT, "task", "--resume-last", "--model", "sol", "--effort", "max", "again"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(second.status, 0, second.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // A top-level `model` on thread/resume sets has_model_resume_override and stops
  // Codex restoring the thread's persisted model/provider/effort.
  assert.equal(fakeState.lastThreadResume.model, undefined);
  assert.equal(fakeState.lastThreadResume.config, null);
  assert.equal(fakeState.appServerStarts, startsAfterFirst + 1);
  assert.equal(fakeState.lastTurnStart.model, "gpt-6-sol");
  assert.equal(fakeState.lastTurnStart.effort, "max");
});

test("task --background stores config overrides in the job request", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "task", "--background", "--json", "--config", "model_provider=ollama", "bg"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const jobId = JSON.parse(result.stdout).jobId;
  const done = run(process.execPath, [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(done.status, 0, done.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_provider: "ollama" });
});

test("task --args-stdin keeps shell metacharacters inside the prompt instead of executing them", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  const sentinel = path.join(makeTempDir(), "pwned");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const rawArguments = `--effort max investigate $(touch ${sentinel}) \`id\``;
  const result = run(process.execPath, [SCRIPT, "task", "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: `${rawArguments}\n`
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.effort, "max");
  assert.equal(fakeState.lastTurnStart.prompt, `investigate $(touch ${sentinel}) \`id\``);
  assert.equal(fs.existsSync(sentinel), false);
});

test("task --background persists the job record before spawning the worker", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "investigate the ordering"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  // The launch command has returned, so the record must already be readable by
  // the worker no matter how fast it started.
  const stateDir = resolveStateDir(repo);
  const indexed = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs.find((job) => job.id === jobId);
  assert.ok(indexed, "job must be in the state index as soon as the launch returns");
  assert.ok(["queued", "running"].includes(indexed.status), `unexpected status ${indexed.status}`);
  assert.ok(fs.existsSync(path.join(stateDir, "jobs", `${jobId}.json`)), "job file must exist as soon as the launch returns");

  const waited = run(process.execPath, [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
});

// Classifying secrets by key name always misses one: a session cookie header is
// every bit a credential and matches no denylist. Every `--config` value stays
// out of the public record; only the keys are kept.
test("task --background keeps secret --config values out of every job record", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const launched = run(
    process.execPath,
    [
      SCRIPT,
      "task",
      "--background",
      "--json",
      "--config",
      "model_providers.x.http_headers.Cookie=SECRET_SENTINEL_42",
      "--config",
      "model_provider=ollama",
      "x"
    ],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const waited = run(process.execPath, [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  const resultRun = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(resultRun.status, 0, resultRun.stderr);

  const stateDir = resolveStateDir(repo);
  const exposures = {
    "state index": fs.readFileSync(path.join(stateDir, "state.json"), "utf8"),
    "job file": fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"),
    "result --json stdout": resultRun.stdout
  };
  for (const [label, text] of Object.entries(exposures)) {
    assert.equal(text.includes("SECRET_SENTINEL_42"), false, `${label} leaked the secret --config value`);
    assert.equal(text.includes("[redacted]"), true, `${label} should keep the redacted placeholder`);
    assert.equal(text.includes("model_provider"), true, `${label} should still record which config keys were set`);
    assert.equal(text.includes("ollama"), false, `${label} stored a --config value; keys are recorded, values never are`);
  }

  // `status` is a summary since 1.5.0: it drops `request`, so only the values' absence can be checked there.
  assert.equal(waited.stdout.includes("SECRET_SENTINEL_42"), false, "status --json stdout leaked the secret --config value");
  assert.equal(waited.stdout.includes("ollama"), false, "status --json stdout leaked a --config value");
  assert.ok(JSON.parse(waited.stdout).omissions.fieldNames.includes("request"), "status --json drops the request");

  // The one-shot payload file is deleted by the worker once it has read it.
  assert.equal(fs.existsSync(path.join(stateDir, "jobs", `${jobId}.request.json`)), false);

  // The worker still forwarded the real value to Codex.
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.config["model_providers.x.http_headers.Cookie"], "SECRET_SENTINEL_42");
  assert.equal(fakeState.lastThreadStart.config.model_provider, "ollama");
});

// Redaction was added when the job is created, which does nothing for records
// v1.1.1 already wrote: same `STATE_VERSION`, raw `--config` values, and every
// `status`/`result --json` still echoing them back after the upgrade.
test("a v1.1.1 record's --config values never reach status/result and are redacted on disk", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const seeded = run(process.execPath, [SCRIPT, "task", "seed the state dir"], { cwd: repo, env });
  assert.equal(seeded.status, 0, seeded.stderr);

  const stateDir = resolveStateDir(repo);
  const statePath = path.join(stateDir, "state.json");
  const legacyRequest = {
    cwd: repo,
    prompt: "legacy prompt",
    config: { "model_providers.x.http_headers.Cookie": "SESSION_SECRET_FROM_1_1_1" }
  };
  const legacyJob = {
    id: "task-legacy",
    status: "completed",
    phase: "done",
    jobClass: "task",
    kind: "task",
    title: "Codex Task",
    summary: "Legacy job written by 1.1.1",
    threadId: "thr_legacy",
    updatedAt: "2026-03-24T20:05:00.000Z",
    completedAt: "2026-03-24T20:06:00.000Z",
    request: legacyRequest
  };
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.jobs.push(legacyJob);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const legacyJobFile = path.join(stateDir, "jobs", "task-legacy.json");
  fs.writeFileSync(
    legacyJobFile,
    `${JSON.stringify({ ...legacyJob, result: { status: 0, finalMessage: "legacy output" }, rendered: "legacy output\n" }, null, 2)}\n`,
    "utf8"
  );

  const status = run(process.execPath, [SCRIPT, "status", "task-legacy", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const result = run(process.execPath, [SCRIPT, "result", "task-legacy", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);

  // `status` is a summary since 1.5.0 (no `request`): only the value's absence is checked there.
  assert.equal(status.stdout.includes("SESSION_SECRET_FROM_1_1_1"), false, "status --json stdout leaked a legacy --config value");
  assert.ok(JSON.parse(status.stdout).omissions.fieldNames.includes("request"), "status --json drops the request");
  const exposures = {
    "result --json stdout": result.stdout,
    "state index": fs.readFileSync(statePath, "utf8"),
    "job file": fs.readFileSync(legacyJobFile, "utf8")
  };
  for (const [label, text] of Object.entries(exposures)) {
    assert.equal(text.includes("SESSION_SECRET_FROM_1_1_1"), false, `${label} leaked a legacy --config value`);
    assert.equal(text.includes("[redacted]"), true, `${label} should carry the redacted placeholder`);
    assert.equal(
      text.includes("model_providers.x.http_headers.Cookie"),
      true,
      `${label} should still record which config keys were set`
    );
  }
});

// The record of an ACTIVE 1.1.1 job is the only copy of its request — 1.1.1 wrote
// no private payload file — and `handleTaskWorker` falls back to exactly that
// record when there is none. Redacting it in place would hand the worker
// "[redacted]" as its Codex config (auth headers included), so the raw request is
// moved into a fresh 0600 payload file first and only then dropped from the record.
test("an active v1.1.1 record keeps its real --config for the worker while output stays redacted", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  const seeded = run(process.execPath, [SCRIPT, "task", "seed the state dir"], { cwd: repo, env });
  assert.equal(seeded.status, 0, seeded.stderr);

  const stateDir = resolveStateDir(repo);
  const statePath = path.join(stateDir, "state.json");
  const now = new Date().toISOString();
  const legacyRequest = {
    cwd: repo,
    prompt: "legacy queued prompt",
    config: { "model_providers.x.http_headers.Cookie": "SESSION_SECRET_FROM_1_1_1" }
  };
  const legacyJob = {
    id: "task-legacy-queued",
    status: "queued",
    phase: "queued",
    jobClass: "task",
    kind: "task",
    title: "Codex Task",
    summary: "Legacy queued job written by 1.1.1",
    createdAt: now,
    updatedAt: now,
    request: legacyRequest
  };
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.jobs.push(legacyJob);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const legacyJobFile = resolveJobFile(repo, "task-legacy-queued");
  fs.writeFileSync(legacyJobFile, `${JSON.stringify(legacyJob, null, 2)}\n`, "utf8");

  const status = run(process.execPath, [SCRIPT, "status", "task-legacy-queued", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.includes("SESSION_SECRET_FROM_1_1_1"), false, "status --json leaked a legacy --config value");
  // The summary drops `request` (and `result --json` of an active job is a summary too):
  // the full export is where the redacted request is visible.
  const exportFile = path.join(makeTempDir(), "legacy-queued.json");
  const exported = run(process.execPath, [SCRIPT, "status", "task-legacy-queued", "--output", exportFile], { cwd: repo, env });
  assert.equal(exported.status, 0, exported.stderr);
  const exportedText = fs.readFileSync(exportFile, "utf8");
  assert.equal(exportedText.includes("SESSION_SECRET_FROM_1_1_1"), false, "status --output leaked a legacy --config value");
  assert.equal(JSON.parse(exportedText).job.request.config["model_providers.x.http_headers.Cookie"], "[redacted]");

  // The worker's own read path (`readStoredJob` → `readJobFile`).
  const workerView = readJobFile(legacyJobFile);
  assert.equal(workerView.request.config["model_providers.x.http_headers.Cookie"], "[redacted]");

  const requestFile = resolveJobRequestFile(repo, "task-legacy-queued");
  assert.equal(fs.existsSync(requestFile), true, "the raw request must be moved into the private payload file");
  // Windows has no POSIX mode bits; the owner-only invariant is not modelled there.
  if (!IS_WIN) assert.equal(fs.statSync(requestFile).mode & 0o777, 0o600, "the payload file must be owner-only");
  assert.equal(fs.readFileSync(legacyJobFile, "utf8").includes("SESSION_SECRET_FROM_1_1_1"), false, "the record must be redacted on disk");

  // What the worker actually runs with.
  const consumed = consumeJobRequestFile(repo, "task-legacy-queued");
  assert.equal(consumed.config["model_providers.x.http_headers.Cookie"], "SESSION_SECRET_FROM_1_1_1");
  assert.equal(consumed.prompt, "legacy queued prompt");
});

test("a resume refuses to start a second turn on a thread another job is still using", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };

  const first = run(process.execPath, [SCRIPT, "task", "first"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  // Another Claude session is mid-turn on the very thread this session would
  // resume. Its job is invisible to this session's resume-candidate lookup, so
  // only the thread-level guard can catch it.
  const statePath = path.join(resolveStateDir(repo), "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const busyJob = {
    id: "task-other-running",
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-other",
    threadId: "thr_1",
    summary: "Other session active task",
    updatedAt: "2026-03-24T20:05:00.000Z"
  };
  state.jobs.push(busyJob);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const blocked = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.notEqual(blocked.status, 0);
  assert.match(
    blocked.stderr,
    /Thread thr_1 is busy in job task-other-running; wait for it or run cancel task-other-running first\./
  );

  // Once that job finishes, the same resume goes through.
  busyJob.status = "completed";
  busyJob.phase = "done";
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const resumed = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

// The crash window between a worker's terminal `writeJobFile` and its
// `upsertJob`: the job file is terminal, the index still says running. The
// reaper handed the terminal file back to its caller but left the index alone,
// so the raw `listJobs()` behind `assertThreadIsFree` kept seeing a phantom
// running job and blocked every later resume of that thread. The recorded pid
// here is alive and unrelated (this test runner) — exactly what a zombie or a
// recycled pid looks like — so nothing but the job file itself can settle it.
test("a terminal job file reconciles the state index and unblocks resume", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };

  const first = run(process.execPath, [SCRIPT, "task", "first"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const stateDir = resolveStateDir(repo);
  const statePath = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.jobs.push({
    id: "task-crash-window",
    status: "running",
    phase: "running",
    title: "Codex Task",
    jobClass: "task",
    sessionId: "sess-other",
    threadId: "thr_1",
    pid: process.pid,
    summary: "Other session task that died after writing its result",
    updatedAt: "2026-03-24T20:05:00.000Z"
  });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "jobs", "task-crash-window.json"),
    `${JSON.stringify(
      {
        id: "task-crash-window",
        status: "completed",
        phase: "done",
        pid: null,
        threadId: "thr_1",
        turnId: "turn_9",
        result: { status: 0, finalMessage: "done" },
        rendered: "done\n",
        completedAt: "2026-03-24T20:06:00.000Z"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // Resume first: only a reaped/reconciled job list can tell this thread is free.
  const resumed = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);

  const reconciled = JSON.parse(fs.readFileSync(statePath, "utf8")).jobs.find((job) => job.id === "task-crash-window");
  assert.equal(reconciled.status, "completed", "the terminal job file must be reconciled into the state index");
  assert.equal(reconciled.pid, null);

  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
});

test("task --prompt-file wins over --args-stdin and keeps the prompt byte-exact", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  // Everything splitRawArgumentString would eat: quotes as grouping, backslashes
  // as escapes, newlines as separators.
  const promptText = `line one \\d+ "quoted" 'single' C:\\Users\\x\nsecond line with $(id) and \`backticks\``;
  const promptFile = path.join(makeTempDir(), "request.txt");
  fs.writeFileSync(promptFile, promptText, "utf8");

  const result = run(process.execPath, [SCRIPT, "task", "--prompt-file", promptFile, "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "--effort max\n"
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, promptText);
  assert.equal(fakeState.lastTurnStart.effort, "max");
});

test("task --await launches a tracked job, waits, and prints the result", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const result = run(process.execPath, [SCRIPT, "task", "--await", "--json", "--model", "sol", "--effort", "low", "--prompt-stdin"], {
    cwd: repo, env: buildEnv(binDir), input: "line one \\d+ \"quoted\" 'single'\nline two\n"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.match(out.job.id, /^task-/);
  assert.equal(out.job.status, "completed");
  assert.ok(typeof out.storedJob.result.rawOutput === "string" && out.storedJob.result.rawOutput.length > 0);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "line one \\d+ \"quoted\" 'single'\nline two");
  assert.equal(fakeState.lastTurnStart.effort, "low");
  assert.equal(fakeState.lastTurnStart.model, "gpt-6-sol");
  const status = run(process.execPath, [SCRIPT, "status", out.job.id, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(JSON.parse(status.stdout).job.status, "completed");
});

test("task --await exits 3 with a resumable hint when the await timeout elapses", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "3000" });
  const result = run(process.execPath, [SCRIPT, "task", "--await", "--await-timeout-ms", "500", "--prompt-stdin"], { cwd: repo, env, input: "slow task\n" });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /Still running: job task-[A-Za-z0-9_-]+\. Re-run: node .*result task-[A-Za-z0-9_-]+ --wait --timeout-ms 540000/);
  const jobId = result.stdout.match(/job (task-[A-Za-z0-9_-]+)/)[1];

  const timedOutJson = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "100", "--json"], { cwd: repo, env });
  assert.equal(timedOutJson.status, 3, timedOutJson.stderr);
  const snapshot = JSON.parse(timedOutJson.stdout);
  assert.ok(["queued", "running"].includes(snapshot.job.status), snapshot.job.status);
  assert.match(
    snapshot.resumeCommand,
    new RegExp(`^node ".*codex-companion\\.mjs" result ${jobId} --wait --timeout-ms 540000$`)
  );

  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000"], { cwd: repo, env });
  assert.equal(done.status, 0, done.stderr);
});

test("task rejects --prompt-stdin combined with --args-stdin or --prompt-file", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const r = run(process.execPath, [SCRIPT, "task", "--prompt-stdin", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "x" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--prompt-stdin/);
});

test("task usage errors around --prompt-stdin arrive without waiting for stdin", async () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const cases = [
    [["--prompt-stdin", "--args-stdin"], /--prompt-stdin cannot be combined with --args-stdin/],
    [["--prompt-stdin", "--await", "--background"], /Choose either --await or --background/]
  ];

  for (const [args, pattern] of cases) {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [SCRIPT, "task", ...args], {
      cwd: repo,
      env: buildEnv(binDir),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // stdin stays open and empty: the error must not wait for EOF.
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    child.stdin.destroy();

    assert.notEqual(code, 0, args.join(" "));
    assert.match(stderr, pattern, args.join(" "));
    assert.ok(Date.now() - startedAt < 2000, `${args.join(" ")} took ${Date.now() - startedAt}ms`);
  }
});

test("task --prompt-stdin sends the prompt verbatim minus one trailing newline", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const promptText = "\n   indented first line   \r\nsecond\tline\n\nlast line without a newline";

  const withNewline = run(process.execPath, [SCRIPT, "task", "--prompt-stdin"], {
    cwd: repo, env: buildEnv(binDir), input: `${promptText}\r\n`
  });
  assert.equal(withNewline.status, 0, withNewline.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt, promptText);

  const withoutNewline = run(process.execPath, [SCRIPT, "task", "--prompt-stdin"], {
    cwd: repo, env: buildEnv(binDir), input: promptText
  });
  assert.equal(withoutNewline.status, 0, withoutNewline.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt, promptText);
});

test("task rejects contradictory await and prompt flag combinations", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const cases = [
    [["--prompt-stdin", "inline prompt text"], /--prompt-stdin cannot be combined with --prompt-file or prompt text/],
    [["--prompt-stdin", "--prompt-file", "prompt.txt"], /--prompt-stdin cannot be combined with --prompt-file or prompt text/],
    [["--await", "--background", "do it"], /Choose either --await or --background/],
    [["--await-timeout-ms", "1000", "do it"], /--await-timeout-ms requires --await/],
    [["--await", "--await-timeout-ms", "0", "do it"], /--await-timeout-ms expects a positive integer/],
    [["--await", "--await-timeout-ms", "-5", "do it"], /--await-timeout-ms expects a positive integer/],
    [["--await", "--await-timeout-ms", "1.5", "do it"], /--await-timeout-ms expects a positive integer/],
    [["--await", "--await-timeout-ms", "nope", "do it"], /--await-timeout-ms expects a positive integer/],
    [["--await", "--await-timeout-ms", "1e400", "do it"], /--await-timeout-ms expects a positive integer/]
  ];

  for (const [args, pattern] of cases) {
    const result = run(process.execPath, [SCRIPT, "task", ...args], { cwd: repo, env: buildEnv(binDir), input: "" });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, pattern, args.join(" "));
  }

  const badResultTimeout = run(process.execPath, [SCRIPT, "result", "task-x", "--wait", "--timeout-ms", "0"], {
    cwd: repo, env: buildEnv(binDir)
  });
  assert.notEqual(badResultTimeout.status, 0);
  assert.match(badResultTimeout.stderr, /--timeout-ms expects a positive integer/);

  const missingWaitTimeout = run(process.execPath, [SCRIPT, "result", "task-x", "--timeout-ms", "1000"], {
    cwd: repo, env: buildEnv(binDir)
  });
  assert.notEqual(missingWaitTimeout.status, 0);
  assert.match(missingWaitTimeout.stderr, /--timeout-ms requires --wait/);
});

test("task --await reports a failed job with exit 1 while result stays exit 0", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-fails");

  const awaited = run(process.execPath, [SCRIPT, "task", "--await", "--json", "--prompt-stdin"], {
    cwd: repo, env: buildEnv(binDir), input: "break on purpose\n"
  });
  assert.equal(awaited.status, 1, awaited.stderr);
  const out = JSON.parse(awaited.stdout);
  assert.equal(out.job.status, "failed");
  assert.match(out.storedJob.errorMessage, /turn\/start failed after thread resolution/);

  const stored = run(process.execPath, [SCRIPT, "result", out.job.id], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /turn\/start failed after thread resolution/);
});

// A turn that never completes used to hang the companion until Claude Code's
// Bash tool SIGKILLed it, leaving the job "running" and no output at all.
test("task --turn-timeout-ms interrupts a stalled turn and fails the job with the timeout message", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  // The fake turn is held far longer than the budget: a slow CI VM can spend
  // several seconds just starting the broker, so the margin is generous.
  const fakeTurnMs = 20000;
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: String(fakeTurnMs) });

  const started = Date.now();
  const result = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "500", "--json", "stall please"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 1, result.stderr);
  assert.ok(Date.now() - started < fakeTurnMs, "the turn budget must fire long before the fake turn completes");
  assert.equal(JSON.parse(result.stdout).status, 1);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(fakeState.lastInterrupt, "a timed-out turn must be interrupted, not abandoned");

  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const latest = JSON.parse(status.stdout).latestFinished;
  assert.equal(latest.status, "failed");
  assert.match(latest.errorMessage, /turn timed out after 500 ms/);
});

// `turn/interrupt` returning is not proof the turn stopped: a wedged app-server
// answers the RPC and keeps going. Writing `failed` right there claims a turn
// (possibly a `--write` one) is over while it is still editing files, so the
// timeout waits for the terminal turn notification and says so when it never
// arrives. `--resume-last` is the path that owns a direct app-server, so
// closing the connection is what actually kills the runaway turn.
test("an unacknowledged interrupt is reported and closes a direct app-server", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);

  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "20000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const result = run(process.execPath, [SCRIPT, "task", "--resume-last", "--turn-timeout-ms", "500", "--json", "stall please"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 1, result.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(fakeState.lastInterrupt, "the timed-out turn must still be interrupted");
  assert.equal(fakeState.clientClosed, true, "a direct app-server must be closed so the runaway turn dies with it");

  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  const latest = JSON.parse(status.stdout).latestFinished;
  assert.equal(latest.status, "failed");
  assert.match(latest.errorMessage, /turn timed out after 500 ms; interrupt not acknowledged/);
  assert.match(latest.errorMessage, /may still be running in the shared runtime/);
});

// The other degraded shape: the app-server answers the interrupt and dies before
// any terminal notification. Nothing can arrive after that, and the acknowledgement
// window used to be an unref'd timer with no exit awareness — so the companion
// waited on a promise nothing would settle and could exit before writing the job's
// terminal record, leaving it `running` forever.
test("a transport that exits after the interrupt still writes a terminal record", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);

  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "20000", FAKE_CODEX_EXIT_AFTER_INTERRUPT: "1" });
  const started = Date.now();
  const result = run(process.execPath, [SCRIPT, "task", "--resume-last", "--turn-timeout-ms", "500", "--json", "stall please"], {
    cwd: repo,
    env
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 1, result.stderr);
  assert.ok(elapsed < 9000, `a dead transport must end the acknowledgement wait early, took ${elapsed} ms`);

  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  const latest = JSON.parse(status.stdout).latestFinished;
  assert.equal(latest.status, "failed", "the job must not be left running");
  assert.match(latest.errorMessage, /turn timed out after 500 ms; interrupt not acknowledged/);
});

test("task --turn-timeout-ms survives into the detached background worker", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "5000" });

  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--turn-timeout-ms", "500", "--json", "stall please"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const waited = run(process.execPath, [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  const job = JSON.parse(waited.stdout).job;
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage, /turn timed out after 500 ms/);
});

test("task without a turn budget is unbounded", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "task", "--json", "take your time"], {
    cwd: repo,
    env: buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "700" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 0);
});

test("CODEX_TURN_TIMEOUT_MS bounds a turn when no flag is passed", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "task", "--json", "stall please"], {
    cwd: repo,
    env: buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "5000", CODEX_TURN_TIMEOUT_MS: "500" })
  });

  assert.equal(result.status, 1, result.stderr);
});

test("task rejects a non-positive turn budget", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "0", "hi"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--turn-timeout-ms expects a positive integer/);
});

test("task fails fast when Codex sends a terminal error notification (#698)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "error-notification");
  const result = run(process.execPath, [SCRIPT, "task", "do the thing"], {
    cwd: repo,
    env: buildEnv(binDir),
    timeout: 15000
  });
  assert.equal(result.error, undefined, "companion must not hang until the test timeout");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Selected model is at capacity/);
  assert.match(result.stderr, /Codex error: Selected model is at capacity/);
});

test("task keeps running through an error notification that Codex will retry", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "error-notification-retry");
  const result = run(process.execPath, [SCRIPT, "task", "--json", "do the thing"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).rawOutput, /./);
  const stored = readJobRecord(repo);
  assert.equal(stored.status, "completed");
  assert.equal(stored.errorMessage, null);
});

test("task survives fileChange started items that omit changes (#775)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "file-change-no-changes");
  const result = run(process.execPath, [SCRIPT, "task", "--json", "edit"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot read properties of undefined/);
});

test("a server-side turn failure that terminates normally still records an errorMessage (#757)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-failed-silently");
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "do the thing"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "15000", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(done.status, 0, done.stderr);
  const status = run(process.execPath, [SCRIPT, "status", jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /\| failed \|/);
  assert.doesNotMatch(status.stdout, /Summary: \{$/m);
  assert.match(status.stdout, /Codex turn ended with status "failed"/);
});

// The final answer arriving well before the terminal notification (a slow relay,
// a loaded CI host) must not be mistaken for the turn having completed.
test("a failed turn whose turn/completed arrives late is still recorded as failed", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-failed-silently");
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "800" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "do the thing"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "15000", "--json"], { cwd: repo, env });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).job.status, "failed");
  assert.match(JSON.parse(done.stdout).job.errorMessage ?? "", /Codex turn ended with status "failed"/);
});

// The server dying after the final answer but before turn/completed must still
// end the turn: as failed, with the captured output, on both transports.
test("a transport that exits after the final answer ends a direct turn as failed", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);

  installFakeCodex(binDir, "turn-failed-silently");
  const env = buildEnv(binDir, { FAKE_CODEX_EXIT_AFTER_FINAL_ANSWER: "1" });
  const started = Date.now();
  const result = run(process.execPath, [SCRIPT, "task", "--resume-last", "--turn-timeout-ms", "20000", "--json", "do the thing"], { cwd: repo, env, timeout: 40000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(Date.now() - started < 15000, "the dead transport must end the turn long before the turn timeout");
  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  const latest = JSON.parse(status.stdout).latestFinished;
  assert.equal(latest.status, "failed");
  assert.match(latest.errorMessage ?? "", /exited|closed/i);
});

test("a transport that exits after the final answer ends a brokered background job as failed", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-failed-silently");
  const env = buildEnv(binDir, { FAKE_CODEX_EXIT_AFTER_FINAL_ANSWER: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "do the thing"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const done = run(process.execPath, [SCRIPT, "result", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env, timeout: 40000 });
  assert.equal(done.status, 0, done.stderr);
  const job = JSON.parse(done.stdout).job;
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage ?? "", /exited|closed/i);
});

test("a subagent's terminal error does not fail the main turn", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "subagent-error");
  const result = run(process.execPath, [SCRIPT, "task", "challenge the design"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /subagent at capacity/);
  const stored = readJobRecord(repo);
  assert.equal(stored.status, "completed");
  assert.equal(stored.errorMessage, null);
});

test("task completes when the turn/start response carries no turn id (#781)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-without-id");
  const result = run(process.execPath, [SCRIPT, "task", "--json", "hello"], { cwd: repo, env: buildEnv(binDir), timeout: 15000 });
  assert.equal(result.error, undefined, "must not hang");
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).rawOutput, /./);
});

// Without an id in the turn/start response, turn/started is what names the turn:
// the timeout path needs it to send turn/interrupt at all.
test("a timed-out turn whose turn/start carried no id is still interrupted (#781)", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-start-without-id");
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "5000" });
  const result = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "500", "--json", "stall please"], { cwd: repo, env, timeout: 15000 });
  assert.equal(result.error, undefined, "must not hang");
  assert.equal(result.status, 1, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(fakeState.lastInterrupt?.turnId, "the turn named by turn/started must be interrupted");
  assert.equal(readJobRecord(repo).turnId, fakeState.lastInterrupt.turnId);
});

// Row 6 of the read-view table: the rescue path's awaited result is never bounded.
test("task --await --json of a 20 KB answer prints the full record without read-view fields", { timeout: 60_000 }, (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const answer = "0123456789".repeat(2000);
  const env = buildEnv(binDir, { FAKE_CODEX_ANSWER_TEXT: answer });
  t.after(() => {
    try {
      const { pid } = readJobRecord(repo);
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
  });
  const awaited = run(process.execPath, [SCRIPT, "task", "--await", "--json", "--prompt-stdin"], { cwd: repo, env, input: "a long answer please\n" });
  assert.equal(awaited.status, 0, `${awaited.stderr}\n${jobDiagnostics(repo, readJobRecord(repo).id)}`);
  assert.ok(Buffer.byteLength(awaited.stdout) > 8192);
  const out = JSON.parse(awaited.stdout);
  assert.equal("truncated" in out, false);
  assert.equal("omissions" in out, false);
  assert.equal(out.storedJob.result.rawOutput, answer);
});
