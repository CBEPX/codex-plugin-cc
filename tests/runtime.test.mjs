import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { cimTree, homeEnv, initGitRepo, IS_WIN, makeTempDir, run, waitFor } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessIdentity, isPidAlive } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveClaudeSessionPath, resolveClaudeProjectsDir } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";
import {
  consumeJobRequestFile,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobPidFile,
  resolveJobRequestFile,
  resolveStateDir,
  upsertJob,
  writeJobFile,
  writeJobPidFile
} from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const FAKE_RESOLVED_SETTINGS = {
  model: "gpt-5.4",
  modelProvider: "openai",
  reasoningEffort: null,
  sandbox: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false
  }
};

const isAlive = (pid) => isPidAlive(pid) === true;

function readPersistedJob(workspaceRoot, jobId = null) {
  const stateDir = resolveStateDir(workspaceRoot);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const resolvedJobId = jobId ?? state.jobs[0].id;
  return JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${resolvedJobId}.json`), "utf8"));
}

// Read only on failure: which record a cancel found, who wrote it, and the job-log tail.
function jobDiagnostics(repo, jobId) {
  try {
    const record = readPersistedJob(repo, jobId);
    const log = fs.readFileSync(record.logFile, "utf8").split("\n").slice(-20).join("\n");
    return `record: ${JSON.stringify({ status: record.status, phase: record.phase, transport: record.transport, workerClosed: record.workerClosed, appServerExited: record.appServerExited, errorMessage: record.errorMessage })}\njob log tail:\n${log}`;
  } catch (error) {
    return `(job record unreadable: ${error.message})`;
  }
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

// Windows: node.exe cannot be isolated from npm portably; adding the Node dir to PATH
// would bring npm back and void the "npm unavailable" invariant this test models.
test("setup is ready without npm when Codex is already installed and authenticated", { skip: IS_WIN }, () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
  assert.deepEqual(readPersistedJob(repo).resolved, FAKE_RESOLVED_SETTINGS);
});

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

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run(process.execPath, [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      ...homeEnv(home),
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      ...homeEnv(home),
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      ...homeEnv(home),
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), ...homeEnv(home) }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("transfer resolves transcripts under CLAUDE_CONFIG_DIR when it is set (#721)", () => {
  const configDir = makeTempDir();
  const projectDir = path.join(configDir, "projects", "-tmp-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "sess.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const env = { CLAUDE_CONFIG_DIR: configDir };
  assert.equal(resolveClaudeProjectsDir(env), path.join(configDir, "projects"));
  assert.equal(resolveClaudeSessionPath(process.cwd(), { source: transcript, env }), fs.realpathSync(transcript));

  const otherConfigDir = makeTempDir();
  fs.mkdirSync(path.join(otherConfigDir, "projects"), { recursive: true });
  assert.throws(
    () => resolveClaudeSessionPath(process.cwd(), { source: transcript, env: { CLAUDE_CONFIG_DIR: otherConfigDir } }),
    /can import Claude sessions only from/
  );
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

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run(process.execPath, [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run(process.execPath, [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
  assert.deepEqual(readPersistedJob(repo).resolved, FAKE_RESOLVED_SETTINGS);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run(process.execPath, [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
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
  assert.deepEqual(readPersistedJob(repo).resolved, FAKE_RESOLVED_SETTINGS);
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

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
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
  assert.deepEqual(readPersistedJob(repo).resolved, {
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
  const storedJob = readPersistedJob(repo);
  assert.equal(storedJob.status, "failed");
  // `--effort` is applied via thread/start.config, so the resolved settings echo it back.
  const resolvedWithEffort = { ...FAKE_RESOLVED_SETTINGS, reasoningEffort: "xhigh" };
  assert.deepEqual(storedJob.resolved, resolvedWithEffort);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
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

test("review resolves model aliases the same way task does", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run(process.execPath, [SCRIPT, "review", "--model", "spark"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.model, "gpt-5.3-codex-spark");
});

test("adversarial review resolves model aliases the same way task does", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--model", "spark"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.model, "gpt-5.3-codex-spark");
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
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
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
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
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
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
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
      const storedJob = readPersistedJob(repo, launchPayload.jobId);
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

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run(process.execPath, [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run(process.execPath, [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run(process.execPath, [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

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

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  // A record without an identity (written by v1.2.x) is only signalled when the
  // pid's command line is still this job's worker (#743).
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "codex-companion.mjs", "task-worker", "--job-id", "task-live"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
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
            pid: sleeper.pid,
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

  const cancelResult = run(process.execPath, [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  if (IS_WIN) {
    // Documented v1.3.0 refusal: win32 cannot prove the pid is this job's worker
    // (identity-unavailable until v1.4.1), so the job stays running, exit 1.
    assert.equal(cancelResult.status, 1, cancelResult.stderr);
    assert.deepEqual(JSON.parse(cancelResult.stdout), { jobId: "task-live", status: "running", cancellationPending: true, reason: "identity-unavailable" });
    return;
  }
  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

// The #743 scenario through the no-identity command-line fallback: a record from
// before identities existed names a pid the OS has since handed to another
// companion process. The reaper cannot rule a companion out by command line, so
// it keeps the job; cancel must refuse to signal a process that is not this
// job's worker, say so, and not claim the job was cancelled — it stays running
// (sidecar kept) until the pid goes away. (A pid now running something that is
// not a companion at all is reaped instead; see tests/tracked-jobs.test.mjs.)
test("cancel through the no-identity command-line fallback refuses a foreign pid and keeps the job running", { skip: process.platform === "win32" }, async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  // Still a companion process (the reaper cannot rule it out by command line),
  // just not this job's worker.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "codex-companion.mjs", "task-worker", "--job-id", "task-other"], { detached: true, stdio: "ignore" });
  stranger.unref();
  t.after(() => {
    try { process.kill(stranger.pid, "SIGKILL"); } catch {}
  });
  const job = {
    id: "task-recycled",
    status: "running",
    phase: "delegating",
    title: "Codex Task",
    jobClass: "task",
    pid: stranger.pid,
    logFile: null,
    createdAt: new Date().toISOString()
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);
  writeJobPidFile(repo, job.id, stranger.pid);

  const cancel = run(process.execPath, [SCRIPT, "cancel", job.id], { cwd: repo });

  assert.equal(cancel.status, 1, cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`cancellation not confirmed: worker pid ${stranger.pid} left running \\(identity-mismatch\\)`));
  assert.match(cancel.stdout, /the job stays running until the worker exits/);
  const cancelJson = run(process.execPath, [SCRIPT, "cancel", job.id, "--json"], { cwd: repo });
  assert.equal(cancelJson.status, 1, cancelJson.stderr);
  assert.deepEqual(JSON.parse(cancelJson.stdout), { jobId: job.id, status: "running", cancellationPending: true, reason: "identity-mismatch" });
  const json = run(process.execPath, [SCRIPT, "status", job.id, "--json"], { cwd: repo });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).job.status, "running");
  assert.equal(fs.existsSync(resolveJobPidFile(repo, job.id)), true, "the pid sidecar must survive a refused cancel");
  process.kill(stranger.pid, 0); // still alive: throws ESRCH if cancel signalled it

  // Once the pid is gone the job reaches a terminal state the normal way.
  process.kill(stranger.pid, "SIGKILL");
  await waitFor(() => {
    try { process.kill(stranger.pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
  });
  const after = run(process.execPath, [SCRIPT, "status", job.id, "--json"], { cwd: repo });
  assert.equal(after.status, 0, after.stderr);
  assert.notEqual(JSON.parse(after.stdout).job.status, "running");
});

// The parent records the worker's identity next to its pid, so cancel can prove
// the pid is still that worker before signalling it.
test("a background worker's pid sidecar carries its identity and cancel signals it", async () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "8000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "slow"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const sidecar = JSON.parse(fs.readFileSync(resolveJobPidFile(repo, jobId), "utf8"));
  try {
    assert.ok(Number.isInteger(sidecar.pid));
    assert.equal(sidecar.identity, getProcessIdentity(sidecar.pid));
    assert.match(sidecar.identity, /^(linux|darwin|win32):/);
    // v1.4.1 refuses kills while the broker record has no identity (Windows start window).
    if (IS_WIN) {
      await waitFor(() => (/^win32:\d+$/.test(loadBrokerSession(repo)?.pidIdentity ?? "") ? "ready" : null));
    }
    const cancel = run(process.execPath, [SCRIPT, "cancel", jobId], { cwd: repo, env });
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.doesNotMatch(cancel.stdout, /left running/);
    await waitFor(() => {
      try { process.kill(sidecar.pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
    });
  } finally {
    try { process.kill(-sidecar.pid, "SIGKILL"); } catch { try { process.kill(sidecar.pid, "SIGKILL"); } catch {} }
  }
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run(process.execPath, [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run(process.execPath, [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run(process.execPath, [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel interrupts a brokered task and records cancelled only after the worker's own terminal record", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId && job.transport) {
      return job;
    }
    return null;
  }, { timeoutMs: 30000 });
  assert.equal(runningJob.transport, "broker");

  const cancelResult = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);
  const stored = readPersistedJob(repo, jobId);
  assert.equal(stored.status, "cancelled", jobDiagnostics(repo, jobId));
  assert.deepEqual([stored.workerClosed, stored.appServerExited], [true, true], jobDiagnostics(repo, jobId));
  const log = fs.readFileSync(stored.logFile, "utf8");
  assert.ok(log.includes("Turn interrupted.") && log.indexOf("Turn interrupted.") < log.indexOf("Cancelled by user."), `the turn ended before the cancel wrote:\n${log}`);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

// The turn lives in the shared runtime, not in the worker: a cancel whose
// interrupt the runtime ignores must not claim success and must not kill the
// worker (the turn would keep running and the reaper would fail the job).
test("a brokered cancel whose interrupt is ignored stays pending and kills nothing; the next cancel ends the turn", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const running = await waitFor(() => { const job = readPersistedJob(repo, jobId); return job.status === "running" && job.pid && job.turnId ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));
  assert.equal(running.transport, "broker", jobDiagnostics(repo, jobId));

  const first = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(first.status, 1, `cancel said: ${first.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.deepEqual(JSON.parse(first.stdout), { jobId, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(running.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readPersistedJob(repo, jobId).status, "running", jobDiagnostics(repo, jobId));
  assert.match(fs.readFileSync(running.logFile, "utf8"), /left running \(turn-not-interrupted\)/);

  const second = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, `${second.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${second.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterrupted, true);
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled", jobDiagnostics(repo, jobId));
  await waitFor(() => !isAlive(running.pid));
});

// The direct path is trusted only when the job file and the index agree: both
// are written in one patch, so a file that says direct while the index says
// broker is forged or torn, and the kill (no turn end) would strand the turn.
test("a job file forged to transport direct does not take the direct kill path while the index says broker", { skip: IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const running = await waitFor(() => { const job = readPersistedJob(repo, jobId); return job.status === "running" && job.pid && job.turnId && job.transport === "broker" ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  t.after(() => run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo }) }));

  // Only the job file is rewritten; the index keeps `broker`.
  writeJobFile(repo, jobId, { ...readJobFile(resolveJobFile(repo, jobId)), transport: "direct" });
  assert.equal(readPersistedJob(repo, jobId).transport, "direct", jobDiagnostics(repo, jobId));

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 1, `cancel said: ${cancel.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.deepEqual(JSON.parse(cancel.stdout), { jobId, status: "running", cancellationPending: true, reason: "turn-not-interrupted" }, jobDiagnostics(repo, jobId));
  assert.equal(isAlive(running.pid), true, `no kill on a disagreeing transport\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(readPersistedJob(repo, jobId).status, "running", jobDiagnostics(repo, jobId));
  assert.equal(listJobs(repo).find((entry) => entry.id === jobId)?.transport, "broker", "the index was never forged");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.ok(fakeState.lastInterrupt, `the interrupt was sent (brokered path)\n${jobDiagnostics(repo, jobId)}`);
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

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  // A live worker's own file says `running`; a status-less file reads as terminal
  // on disk and the reaper would reconcile that into the kept index entry.
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running", status: "running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            // Records since v1.3.0 carry the worker's identity (#743).
            pidIdentity: getProcessIdentity(sleeper.pid),
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("session end preserves background jobs and their broker so workers survive their dispatching session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const backgroundLog = path.join(jobsDir, "background.log");
  const foregroundLog = path.join(jobsDir, "foreground.log");
  const backgroundJobFile = path.join(jobsDir, "task-background.json");
  const foregroundJobFile = path.join(jobsDir, "review-foreground.json");
  fs.writeFileSync(backgroundLog, "background\n", "utf8");
  fs.writeFileSync(foregroundLog, "foreground\n", "utf8");
  fs.writeFileSync(backgroundJobFile, JSON.stringify({ id: "task-background" }, null, 2), "utf8");
  fs.writeFileSync(foregroundJobFile, JSON.stringify({ id: "review-foreground" }, null, 2), "utf8");

  const backgroundSleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  backgroundSleeper.unref();
  const foregroundSleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  foregroundSleeper.unref();

  t.after(() => {
    for (const proc of [backgroundSleeper, foregroundSleeper]) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          process.kill(proc.pid, "SIGTERM");
        } catch {
          // Ignore missing process.
        }
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-background",
            status: "running",
            title: "Codex Task",
            sessionId: "sess-current",
            background: true,
            pid: backgroundSleeper.pid,
            logFile: backgroundLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-foreground",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: foregroundSleeper.pid,
            pidIdentity: getProcessIdentity(foregroundSleeper.pid),
            logFile: foregroundLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);

  // Foreground job killed + pruned from state.
  await waitFor(() => {
    try {
      process.kill(foregroundSleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  // Background job still alive — its worker outlives the session that started it.
  assert.equal(
    (() => {
      try {
        process.kill(backgroundSleeper.pid, 0);
        return true;
      } catch {
        return false;
      }
    })(),
    true,
    "background job worker should not be terminated by SessionEnd"
  );

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(
    state.jobs.map((job) => job.id).sort(),
    ["task-background"],
    "background job stays in state so later sessions can poll it"
  );
  assert.equal(fs.existsSync(backgroundJobFile), true, "background job file preserved");
  assert.equal(fs.existsSync(backgroundLog), true, "background log preserved");
});

// `--background` on a review means what it means on a task: the job is
// dispatched to outlive the session that started it. The flag was parsed and
// then dropped, so SessionEnd pruned the review's record — and with it the
// only way to read the review back with `/codex:result`.
test("an adversarial review dispatched with --background survives its own session's SessionEnd", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "sess-current" };

  const review = run(process.execPath, [SCRIPT, "adversarial-review", "--background"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);

  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const recorded = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs[0];
  assert.equal(recorded.background, true, "a --background review must be recorded as a background job");

  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.map((job) => job.id),
    [recorded.id],
    "the background review record must survive the dispatching session's SessionEnd"
  );
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run(process.execPath, [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run(process.execPath, [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop gate forwards the configured model and effort to the review task (#769)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--review-gate-model", "spark", "--review-gate-effort", "low", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.reviewGateModel, "gpt-5.3-codex-spark");
  assert.equal(payload.reviewGateEffort, "low");
  const hook = run(process.execPath, [STOP_HOOK], { cwd: repo, env: buildEnv(binDir), input: JSON.stringify({ cwd: repo, session_id: "sess-gate-model", last_assistant_message: "done" }) });
  assert.equal(hook.status, 0, hook.stderr);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastThreadStart.config.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastThreadStart.config.model_reasoning_effort, "low");
  const cleared = run(process.execPath, [SCRIPT, "setup", "--review-gate-model", "inherit", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(JSON.parse(cleared.stdout).reviewGateModel, null);
});

test("setup rejects a gate effort the gate model does not support and writes nothing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const setup = run(process.execPath, [SCRIPT, "setup", "--review-gate-model", "spark", "--review-gate-effort", "ultra", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(setup.status, 0);
  assert.match(setup.stderr, /not supported by gpt-5\.3-codex-spark\. gpt-5\.3-codex-spark supports: /);
  const after = run(process.execPath, [SCRIPT, "setup", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).reviewGateModel, null, "a rejected setup must not write the model");
  assert.equal(JSON.parse(after.stdout).reviewGateEffort, null);
});

test("setup rejects a gate model that cannot run the stored gate effort and writes nothing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const first = run(process.execPath, [SCRIPT, "setup", "--review-gate-model", "astra", "--review-gate-effort", "ultra", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);
  const switched = run(process.execPath, [SCRIPT, "setup", "--review-gate-model", "spark", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(switched.status, 0);
  assert.match(switched.stderr, /not supported by gpt-5\.3-codex-spark\. gpt-5\.3-codex-spark supports: /);
  const after = run(process.execPath, [SCRIPT, "setup", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).reviewGateModel, "gpt-6-astra", "a rejected setup must not write the model");
  assert.equal(JSON.parse(after.stdout).reviewGateEffort, "ultra");
});

test("stop gate stops blocking after three gate-induced rounds by default (#548)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run(process.execPath, [SCRIPT, "setup", "--enable-review-gate"], { cwd: repo, env: buildEnv(binDir) });
  const env = { ...buildEnv(binDir) };
  delete env.CODEX_REVIEW_GATE_MAX_ROUNDS;
  const input = (active) => JSON.stringify({ cwd: repo, session_id: "sess-rounds", stop_hook_active: active, last_assistant_message: "I completed the refactor." });
  const decisions = [];
  for (const active of [false, true, true, true]) {
    const r = run(process.execPath, [STOP_HOOK], { cwd: repo, env, input: input(active) });
    assert.equal(r.status, 0, r.stderr);
    decisions.push(r.stdout.trim() ? JSON.parse(r.stdout).decision : "allow");
  }
  assert.deepEqual(decisions, ["block", "block", "block", "allow"]);
});

function gateDecisions(env, repo, session, rounds) {
  const decisions = [];
  let stderr = "";
  for (let i = 0; i < rounds; i += 1) {
    const input = JSON.stringify({ cwd: repo, session_id: session, stop_hook_active: i > 0, last_assistant_message: "I completed the refactor." });
    const r = run(process.execPath, [STOP_HOOK], { cwd: repo, env, input });
    assert.equal(r.status, 0, r.stderr);
    stderr += r.stderr;
    decisions.push(r.stdout.trim() ? JSON.parse(r.stdout).decision : "allow");
  }
  return { decisions, stderr };
}

test("CODEX_REVIEW_GATE_MAX_ROUNDS=0 never stops blocking and =5 allows the sixth stop", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run(process.execPath, [SCRIPT, "setup", "--enable-review-gate"], { cwd: repo, env: buildEnv(binDir) });
  const unlimited = gateDecisions(buildEnv(binDir, { CODEX_REVIEW_GATE_MAX_ROUNDS: "0" }), repo, "sess-rounds-0", 4);
  assert.deepEqual(unlimited.decisions, ["block", "block", "block", "block"]);
  const five = gateDecisions(buildEnv(binDir, { CODEX_REVIEW_GATE_MAX_ROUNDS: "5" }), repo, "sess-rounds-5", 6);
  assert.deepEqual(five.decisions, ["block", "block", "block", "block", "block", "allow"]);
});

test("an invalid CODEX_REVIEW_GATE_MAX_ROUNDS falls back to 3 with a warning", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run(process.execPath, [SCRIPT, "setup", "--enable-review-gate"], { cwd: repo, env: buildEnv(binDir) });
  const { decisions, stderr } = gateDecisions(buildEnv(binDir, { CODEX_REVIEW_GATE_MAX_ROUNDS: "0.5" }), repo, "sess-rounds-bad", 4);
  assert.deepEqual(decisions, ["block", "block", "block", "allow"]);
  assert.match(stderr, /Ignoring CODEX_REVIEW_GATE_MAX_ROUNDS="0\.5"/);
});

test("setup rejects an empty gate model or effort and writes nothing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const first = run(process.execPath, [SCRIPT, "setup", "--review-gate-model", "astra", "--review-gate-effort", "high", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);
  for (const flag of ["--review-gate-model", "--review-gate-effort"]) {
    const empty = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", flag, "", "--json"], { cwd: repo, env: buildEnv(binDir) });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /use inherit to clear/);
  }
  const after = JSON.parse(run(process.execPath, [SCRIPT, "setup", "--json"], { cwd: repo, env: buildEnv(binDir) }).stdout);
  assert.equal(after.reviewGateModel, "gpt-6-astra");
  assert.equal(after.reviewGateEffort, "high");
  assert.equal(after.reviewGateEnabled, false, "the gate flag must not be written either");
});

test("stop gate names the signal when the review task is killed and always names the escape hatch (#589/#483)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run(process.execPath, [SCRIPT, "setup", "--enable-review-gate"], { cwd: repo, env: buildEnv(binDir) });
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", CODEX_STOP_REVIEW_TIMEOUT_MS: "800" });
  const r = run(process.execPath, [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo, session_id: "sess-signal", last_assistant_message: "x" }) });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /timed out after 0\.8 minutes|terminated by signal SIGKILL/);
  assert.match(payload.reason, /Disable with \/codex:setup --disable-review-gate\./);
});

test("stop hook blocks when hook input is malformed JSON", () => {
  const blocked = run(process.execPath, [STOP_HOOK], {
    cwd: ROOT,
    input: "{not-json"
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual(JSON.parse(blocked.stdout), {
    decision: "block",
    reason: "The stop review gate could not read or parse hook input; refusing to fail open."
  });
});

// Claude Code can leave the hook's stdin open (#530): spawn without ending it and
// time how long the hook takes to decide.
async function runHookWithOpenStdin(t, args, { cwd, env, input = "" }) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };
  t.after(kill);
  // A hook that never exits must fail the test, not hang the run.
  setTimeout(kill, 20_000).unref();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  const started = Date.now();
  if (input) {
    child.stdin.write(input);
  }
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, stdout, stderr, elapsedMs: Date.now() - started };
}

test("stop hook with the gate disabled allows promptly when stdin stays open (#530)", { timeout: 30_000 }, async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, CODEX_HOOK_STDIN_TIMEOUT_MS: "200" };
  for (const input of ["", JSON.stringify({ cwd: repo, session_id: "sess-open" })]) {
    const result = await runHookWithOpenStdin(t, [STOP_HOOK], { cwd: repo, env, input });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "", `no decision expected for input ${JSON.stringify(input)}`);
    assert.ok(result.elapsedMs < 10000, `hook took ${result.elapsedMs} ms`);
  }
});

test("stop hook with the gate enabled blocks when hook input never arrives", { timeout: 30_000 }, async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo });
  assert.equal(setup.status, 0, setup.stderr);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, CODEX_HOOK_STDIN_TIMEOUT_MS: "200" };
  const result = await runHookWithOpenStdin(t, [STOP_HOOK], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /hook input did not arrive/);
  assert.ok(result.elapsedMs < 10000, `hook took ${result.elapsedMs} ms`);
});

test("stop hook with an unreadable state file keeps the gate closed when hook input never arrives", { timeout: 30_000 }, async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), "{not-json");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, CODEX_HOOK_STDIN_TIMEOUT_MS: "200" };
  const result = await runHookWithOpenStdin(t, [STOP_HOOK], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /hook input did not arrive/);
});

// existsSync answers false for a path under an unreadable directory, which must
// not read as "gate never configured".
test("stop hook with an unreadable state directory keeps the gate closed when hook input never arrives", { timeout: 30_000, skip: IS_WIN || process.getuid?.() === 0 }, async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ config: { stopReviewGate: true } }));
  fs.chmodSync(stateDir, 0o000);
  t.after(() => fs.chmodSync(stateDir, 0o700));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo, CODEX_HOOK_STDIN_TIMEOUT_MS: "200" };
  const result = await runHookWithOpenStdin(t, [STOP_HOOK], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /hook input did not arrive/);
});

test("stop hook input above 1 MiB allows with the gate off and blocks with it on", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  const input = JSON.stringify({ cwd: repo, session_id: "sess-huge", last_assistant_message: "x".repeat(1.1 * 1024 * 1024) });
  const off = run(process.execPath, [STOP_HOOK], { cwd: repo, env, input });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout.trim(), "");
  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo });
  assert.equal(setup.status, 0, setup.stderr);
  const on = run(process.execPath, [STOP_HOOK], { cwd: repo, env, input });
  assert.equal(on.status, 0, on.stderr);
  const payload = JSON.parse(on.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /exceeded/);
});

test("stop gate hands a 300 KB last_assistant_message to Codex whole", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);
  const message = `start-${"x".repeat(300 * 1024)}-end`;
  const hook = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-big", last_assistant_message: message })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(hook.stdout).decision, "block", hook.stdout);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.ok(fakeState.lastTurnStart.prompt.includes(message), "the whole message must reach Codex");
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  // The broker must outlive the gap between the two CLI runs: on a slow runner
  // spawning the second command alone can take several seconds.
  const idleMs = 15000;
  const env = buildEnv(binDir, { CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: String(idleMs) });

  const review = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run(process.execPath, [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const brokerPid = brokerSession.pid;
  assert.ok(brokerPid > 0);
  const deadline = Date.now() + idleMs + 10000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(brokerPid, 0);
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `broker ${brokerPid} should exit within the ${idleMs} ms test idle timeout`);

  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
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

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
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

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run(process.execPath, [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run(process.execPath, [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});

function seededRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("review forwards model, review_model, effort and config overrides into thread/start config", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run(
    process.execPath,
    [SCRIPT, "review", "--wait", "--model", "sol", "--effort", "max", "--config", "model_provider=ollama", "--config", "foo.bar=3"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, {
    model_provider: "ollama",
    "foo.bar": 3,
    model: "gpt-6-sol",
    review_model: "gpt-6-sol",
    model_reasoning_effort: "max"
  });
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

test("review accepts slash-command style single-string arguments", () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run(process.execPath, [SCRIPT, "review", "--wait --effort xhigh --config model_provider=ollama"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart.config, { model_provider: "ollama", model_reasoning_effort: "xhigh" });
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
    "status --json stdout": waited.stdout,
    "result --json stdout": resultRun.stdout
  };
  for (const [label, text] of Object.entries(exposures)) {
    assert.equal(text.includes("SECRET_SENTINEL_42"), false, `${label} leaked the secret --config value`);
    assert.equal(text.includes("[redacted]"), true, `${label} should keep the redacted placeholder`);
    assert.equal(text.includes("model_provider"), true, `${label} should still record which config keys were set`);
    assert.equal(text.includes("ollama"), false, `${label} stored a --config value; keys are recorded, values never are`);
  }

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

  const exposures = {
    "status --json stdout": status.stdout,
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
  assert.equal(status.stdout.includes("[redacted]"), true);

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

test("cancelling an awaited job ends the await with exit 1 and leaves a readable result", async () => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "6000" });

  const child = spawn(process.execPath, [SCRIPT, "task", "--await", "--await-timeout-ms", "30000", "--prompt-stdin"], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end("cancel me\n");
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });

  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const jobId = await waitFor(() => {
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs?.[0];
    // Wait for the worker to own the record: the turn has to be under way for
    // the cancel to have a running turn to interrupt.
    return job && job.status === "running" && job.pid ? job.id : null;
  }, { timeoutMs: 15000 });

  // v1.4.1 refuses kills while the broker record has no identity (Windows start window).
  if (IS_WIN) {
    await waitFor(() => (/^win32:\d+$/.test(loadBrokerSession(repo)?.pidIdentity ?? "") ? "ready" : null));
  }
  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled/i);
  assert.equal(await exited, 1);

  const stored = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).job.status, "cancelled");
});

// Direct transport (a cold --resume-last owns its app-server): cancel sends no
// turn/interrupt — no second client can reach that app-server, and the old
// attempt could start a codex of its own — and kills the worker's group. The
// worker ignores SIGTERM and outlives the kill as its app-server dies; its late
// write must not replace the acknowledged `cancelled` record.
test("a direct cancel skips the interrupt, and the cancellation survives a worker that finishes after it", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const repo = seededRepo();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // Only the task worker ignores SIGTERM; the broker and fake codex keep the default.
  const preload = path.join(binDir, "worker-ignores-sigterm.mjs");
  fs.writeFileSync(preload, 'if (process.argv.includes("task-worker")) process.on("SIGTERM", () => {});\n');
  const env = buildEnv(binDir, {
    FAKE_CODEX_TURN_DELAY_MS: "20000",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim()
  });
  const launch = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "--prompt-stdin"], { cwd: repo, env, input: "cancel me late\n" });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const running = await waitFor(() => { const job = readPersistedJob(repo, jobId); return job.status === "running" && job.pid && job.turnId ? job : null; });
  t.after(() => { try { process.kill(-running.pid, "SIGKILL"); } catch {} });
  assert.equal(running.transport, "direct", jobDiagnostics(repo, jobId));
  const startsBefore = JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts;

  const cancelled = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, `${cancelled.stderr}\n${jobDiagnostics(repo, jobId)}`);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled", `cancel said: ${cancelled.stdout.trim()}\n${jobDiagnostics(repo, jobId)}`);
  assert.equal(payload.turnInterruptAttempted, false, "a direct job's app-server is the worker's own");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastInterrupt ?? null, null, "no turn/interrupt was sent");
  assert.equal(fakeState.appServerStarts, startsBefore, "cancel started no codex of its own");

  await waitFor(() => !isAlive(running.pid));
  const stored = run(process.execPath, [SCRIPT, "result", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).job.status, "cancelled", jobDiagnostics(repo, jobId));
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

// Recording the worker pid on the queued record (so a queued job can be
// cancelled at all) means cancel can now kill a worker *before* it consumed its
// private one-shot payload. A cancelled job is terminal, so the reaper will
// never look at it again — cancel has to release the file itself. The worker's
// identity is recorded, so the kill is provable.
test("cancel removes the private request payload of a job killed in the queued window", async (t) => {
  const repo = seededRepo();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const secret = "sk-cancel-secret-value";
  const requestFile = path.join(jobsDir, "task-queued.request.json");
  fs.writeFileSync(requestFile, JSON.stringify({ prompt: "hi", config: { auth_header: secret } }), {
    encoding: "utf8",
    mode: 0o600
  });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      // No process groups on Windows, or already gone.
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  const job = {
    id: "task-queued",
    status: "queued",
    phase: "queued",
    jobClass: "task",
    title: "Codex Task",
    background: true,
    pid: sleeper.pid,
    pidIdentity: getProcessIdentity(sleeper.pid),
    logFile: null,
    requestFile,
    request: { prompt: "hi", config: { auth_header: "[redacted]" } },
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:30:00.000Z"
  };
  fs.writeFileSync(path.join(jobsDir, "task-queued.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );

  const cancelled = run(process.execPath, [SCRIPT, "cancel", "task-queued", "--json"], { cwd: repo, env: process.env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

  assert.equal(fs.existsSync(requestFile), false, "the private payload must not outlive the cancelled job");
  const stored = readPersistedJob(repo, "task-queued");
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.requestFile, null);
  assert.equal(fs.readFileSync(path.join(stateDir, "state.json"), "utf8").includes(secret), false);
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
  const stored = readPersistedJob(repo);
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
  const stored = readPersistedJob(repo);
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
  assert.equal(readPersistedJob(repo).turnId, fakeState.lastInterrupt.turnId);
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

test("cancel on Windows kills a direct worker and the codex.cmd tree under it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  // A cold resume owns its own app-server, so the tree hangs under the worker, not the broker.
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pidIdentity && j.threadId && j.turnId ? j : null; });
  assert.match(running.pidIdentity, /^win32:\d+$/);
  assert.equal(running.transport, "direct");
  const tree = cimTree(running.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(tree.some((n) => /^cmd\.exe$/i.test(n.name)) && tree.filter((n) => /^node\.exe$/i.test(n.name)).length >= 2, `expected worker → cmd.exe → node.exe, got ${JSON.stringify(tree)}`);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).turnInterruptAttempted, false, "a direct job's app-server is the worker's own");
  await waitFor(() => (tree.every((n) => !isAlive(n.pid)) ? "gone" : null));
  assert.equal(readPersistedJob(repo, jobId).status, "cancelled");
});

test("a brokered cancel on Windows kills nothing until the turn ends, leaves the shared broker and its subtree alive, and the same app-server serves the next job", { skip: !IS_WIN, timeout: 180_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  // The broker's app-server ignores only the first interrupt: the first cancel must stay pending, the second ends the turn; the "quick C" timeout interrupt is the third and is honoured.
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_FIRST_INTERRUPTS: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold A"], { cwd: repo, env });
  const jobA = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  const running = await waitFor(() => { const j = readPersistedJob(repo, jobA); return j.status === "running" && j.turnId ? j : null; });
  assert.equal(running.transport, "broker", jobDiagnostics(repo, jobA));
  const broker = loadBrokerSession(repo);
  assert.ok(broker?.pid, "worker A started the shared broker");
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  const brokerTree = cimTree(broker.pid);
  t.after(() => { for (const { pid } of brokerTree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.ok(brokerTree.some((n) => /^cmd\.exe$/i.test(n.name)), `expected the app-server tree under the broker, got ${JSON.stringify(brokerTree)}`);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  // The broker is A's child by ParentProcessId on Windows; the kill must skip its whole subtree.
  const pending = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(pending.status, 1, `cancel said: ${pending.stdout.trim()}\n${jobDiagnostics(repo, jobA)}`);
  assert.deepEqual(JSON.parse(pending.stdout), { jobId: jobA, status: "running", cancellationPending: true, reason: "turn-not-interrupted" });
  assert.equal(isAlive(withPid.pid), true, "no kill while the turn still runs in the broker");
  assert.equal(readPersistedJob(repo, jobA).status, "running", jobDiagnostics(repo, jobA));
  assert.equal(isAlive(broker.pid), true, "the shared broker is untouched by a pending cancel");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "and so is its subtree");
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobA, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, `${cancel.stderr}\n${jobDiagnostics(repo, jobA)}`);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled", jobDiagnostics(repo, jobA));
  await waitFor(() => (!isAlive(withPid.pid) ? "gone" : null));
  assert.equal(isAlive(broker.pid), true, "the shared broker survives a worker kill");
  assert.ok(brokerTree.every((n) => isAlive(n.pid)), "the broker's subtree survives");
  // The same app-server still serves: the fake holds every turn 60 s, so bound the next job by the turn timeout
  // and prove it went through the existing app-server (no second start) rather than a direct fallback.
  const next = run(process.execPath, [SCRIPT, "task", "--turn-timeout-ms", "3000", "--json", "quick C"], { cwd: repo, env, timeout: 60000 });
  assert.equal(next.error, undefined);
  assert.equal(next.status, 1, next.stderr);
  // The foreground JSON carries only the payload; the stored job carries the outcome.
  const jobC = readPersistedJob(repo);
  assert.notEqual(jobC.id, jobA);
  assert.match(jobC.errorMessage ?? "", /turn timed out after 3000 ms/, "the next job really ran a turn (and hit its budget)");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1, "no second app-server was started for the next job");
  assert.equal(fakeState.lastTurnStart?.prompt, "quick C", "the turn went through the existing app-server");
  assert.equal(loadBrokerSession(repo)?.pid, broker.pid, "no replacement broker was started");
});

test("a root that died before cancel is failed by the reaper on Windows; nothing is signalled by number", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(seeded.status, 0, seeded.stderr);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--resume-last", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.turnId ? j : null; });
  const tree = cimTree(withPid.pid);
  t.after(() => { for (const { pid } of tree) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  process.kill(withPid.pid, "SIGKILL");
  await waitFor(() => (!isAlive(withPid.pid) ? "dead" : null));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0, "the reaper already failed the job; cancel has nothing active to signal");
  assert.equal(readPersistedJob(repo, jobId).status, "failed");
  // The orphaned children are the documented limitation here: nothing is touched by number.
  assert.ok(tree.filter((n) => n.pid !== withPid.pid).some((n) => isAlive(n.pid)));
});

test("a reused-looking identity is never signalled on Windows: the reaper fails the job and cancel reports it", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { FAKE_CODEX_TURN_DELAY_MS: "60000", FAKE_CODEX_IGNORE_INTERRUPT: "1" });
  const launched = run(process.execPath, [SCRIPT, "task", "--background", "--json", "hold"], { cwd: repo, env });
  const jobId = JSON.parse(launched.stdout).jobId;
  const withPid = await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.pid ? j : null; });
  t.after(() => { try { process.kill(withPid.pid, "SIGKILL"); } catch {} });
  await waitFor(() => { const j = readPersistedJob(repo, jobId); return j.status === "running" && j.pidIdentity ? j : null; });
  upsertJob(repo, { id: jobId, pidIdentity: "win32:1" });
  const jobFile = path.join(resolveStateDir(repo), "jobs", `${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, "utf8")), pidIdentity: "win32:1" }));
  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.notEqual(cancel.status, 0);
  assert.equal(isAlive(withPid.pid), true, "the process holding the pid is a stranger to this record and must stay");
  const stored = readPersistedJob(repo, jobId);
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage ?? "", /pid reused/);
});

test("SessionEnd tears down a broker that acknowledged shutdown but stayed up, by its recorded identity", { skip: !IS_WIN, timeout: 90_000 }, async (t) => {
  const repo = seededRepo(); const binDir = makeTempDir(); installFakeCodex(binDir);
  const env = buildEnv(binDir, { CODEX_COMPANION_SESSION_ID: "sess-win", CODEX_COMPANION_BROKER_HANG_ON_SHUTDOWN: "1", CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "60000" });
  const seeded = run(process.execPath, [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const broker = await waitFor(() => loadBrokerSession(repo));
  t.after(() => { try { process.kill(broker.pid, "SIGKILL"); } catch {} });
  assert.match(broker.pidIdentity ?? "", /^win32:\d+$/);
  const cleanup = run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "sess-win" }) });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stderr, /Broker teardown: .*signalled=true reason=identity-match/);
  await waitFor(() => (!isAlive(broker.pid) ? "gone" : null));
  assert.equal(loadBrokerSession(repo), null);
});

test("a planted PowerShell in the workspace or a relative PATH entry is never what the identity probe runs", { skip: !IS_WIN, timeout: 90_000 }, () => {
  const repo = makeTempDir(); fs.mkdirSync(path.join(repo, "tools"));
  const marker = path.join(repo, "HIJACKED");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(repo, "powershell.exe"));
  for (const planted of ["powershell.cmd", path.join("tools", "powershell.cmd"), path.join("tools", "powershell.exe.cmd")]) {
    fs.writeFileSync(path.join(repo, planted), `@echo off\r\necho x> "${marker}"\r\n`);
  }
  const testEnvUrl = pathToFileURL(path.join(ROOT, "tests", "test-env.mjs")).href;
  const processUrl = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "process.mjs")).href;
  const probe = run(process.execPath, ["--import", testEnvUrl, "-e", `import(${JSON.stringify(processUrl)}).then(m => console.log(m.getProcessIdentity(process.pid) ?? 'null'))`], {
    cwd: repo, env: { ...process.env, PATH: `.;tools;${process.env.PATH}`, PSModulePath: path.join(repo, "tools") }
  });
  assert.match(probe.stdout.trim(), /^win32:\d+$/, probe.stderr);
  assert.equal(fs.existsSync(marker), false);
});
