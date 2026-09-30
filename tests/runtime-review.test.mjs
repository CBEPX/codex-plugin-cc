import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  FAKE_RESOLVED_SETTINGS,
  initGitRepo,
  makeTempDir,
  readJobRecord,
  readStateIndex,
  run,
  SCRIPT,
  seededRepo
} from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";


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
  assert.deepEqual(readJobRecord(repo).resolved, FAKE_RESOLVED_SETTINGS);
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
  assert.deepEqual(readJobRecord(repo).resolved, FAKE_RESOLVED_SETTINGS);
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
  const state = readStateIndex(repo);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
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

// A repo on `feature` one commit ahead of `main`, clean, for `--base main`.
function featureBranchRepo() {
  const repo = seededRepo();
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello feature\n");
  run("git", ["commit", "-am", "feature"], { cwd: repo });
  return repo;
}

function focusLine(prompt) {
  return prompt.slice(prompt.indexOf("User focus:"), prompt.indexOf("</task>"));
}

test("adversarial-review --args-stdin passes the focus text verbatim (#714)", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "--base main don't mangle \"this\"\nline 2\n"
  });

  assert.equal(result.status, 0, result.stderr);
  const prompt = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt;
  assert.ok(prompt.includes("Target: branch diff against main\n"), "the flags before the focus still apply");
  assert.ok(prompt.includes("User focus: don't mangle \"this\"\nline 2\n</task>"), focusLine(prompt));
});

test("adversarial-review --args-stdin keeps a focus-only heredoc in one piece and takes -- as the end of flags", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  // One token after splitting: normalizeArgv must not re-split it.
  const only = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "don't stop\n" });
  assert.equal(only.status, 0, only.stderr);
  let turn = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart;
  assert.ok(turn.prompt.includes("User focus: don't stop\n</task>"), focusLine(turn.prompt));

  const dashed = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "-- --model is wrong\n" });
  assert.equal(dashed.status, 0, dashed.stderr);
  turn = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart;
  assert.ok(turn.prompt.includes("User focus: --model is wrong\n</task>"), focusLine(turn.prompt));
  assert.equal(turn.model, null, "--model after -- is focus text, not a flag");
});

test("adversarial-review --args-stdin accepts a bullet-led focus", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "- check auth\n- check races\n"
  });

  assert.equal(result.status, 0, result.stderr);
  const prompt = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTurnStart.prompt;
  assert.ok(prompt.includes("User focus: - check auth\n- check races\n</task>"), focusLine(prompt));
});

test("review --args-stdin with flags only still runs the built-in reviewer", () => {
  const repo = featureBranchRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run(process.execPath, [SCRIPT, "review", "--args-stdin"], { cwd: repo, env: buildEnv(binDir), input: "--base main\n" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed changes against main/);
});

test("review and adversarial-review refuse an unresolvable --base before any job or Codex start (#653)", () => {
  for (const command of ["review", "adversarial-review"]) {
    for (const ref of ["nope", "-x", "^main"]) {
      const repo = seededRepo();
      const binDir = makeTempDir();
      installFakeCodex(binDir);
      fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
      const label = `${command} --base ${ref}`;

      const result = run(process.execPath, [SCRIPT, command, "--base", ref], { cwd: repo, env: buildEnv(binDir) });

      assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
      assert.ok(
        result.stderr.includes(`Base ref "${ref}" not found in this repository; pass a branch, tag or commit that resolves locally (git fetch it first for a remote ref).`),
        `${label}: ${result.stderr}`
      );
      // Failing before the job means no state was written at all.
      const indexPath = path.join(resolveStateDir(repo), "state.json");
      assert.deepEqual(fs.existsSync(indexPath) ? readStateIndex(repo).jobs : [], [], `${label}: no job record`);
      // The fake bumps appServerStarts on every `codex app-server` launch (fake-codex-fixture.mjs:288).
      const fakeStatePath = path.join(binDir, "fake-codex-state.json");
      const starts = fs.existsSync(fakeStatePath) ? JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts : 0;
      assert.equal(starts, 0, `${label}: no app-server start`);
    }
  }
});
