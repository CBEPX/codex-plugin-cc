import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  initGitRepo,
  IS_WIN,
  makeTempDir,
  ROOT,
  run,
  SCRIPT,
  SESSION_HOOK
} from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";


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
