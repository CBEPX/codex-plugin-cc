import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  initGitRepo,
  isAlive,
  IS_WIN,
  makeTempDir,
  ROOT,
  run,
  SCRIPT,
  seededRepo,
  SESSION_HOOK,
  STOP_HOOK,
  waitFor
} from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessIdentity } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";


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
