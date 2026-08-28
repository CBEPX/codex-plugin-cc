import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review --args-stdin <<'CODEX_ARGS'/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /\[--turn-timeout-ms <ms>\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review --args-stdin <<'CODEX_ARGS'\n\$ARGUMENTS\nCODEX_ARGS`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review --args-stdin <<'CODEX_ARGS'/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\].*\[focus \.\.\.\]/);
  assert.match(source, /\[--turn-timeout-ms <ms>\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review --args-stdin <<'CODEX_ARGS'\n\$ARGUMENTS\nCODEX_ARGS`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /show the output verbatim, then your assessment/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit `Agent` tool invocation naming `codex:codex-rescue`
  // and the inline (no-fork) execution.
  assert.match(rescue, /invoke the `Agent` tool with `codex:codex-rescue`/);
  assert.match(rescue, /do not call `Skill\(codex:rescue\)`/i);
  // Covers the separate `task-resume-candidate --json` Bash call too: it isn't
  // part of the payload block, so it needs its own non-zero-exit fallback.
  assert.match(rescue, /If any Bash step exits non-zero, show its stderr to the user — never report "no result"/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /\[--background\]/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark\|sol\|luna\|terra\|mini>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);
  assert.match(rescue, /\[--turn-timeout-ms <ms>\]/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion.*Continue current Codex thread/s);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /Default is synchronous/i);
  assert.match(rescue, /Strip `--background`, `--wait`, `--resume`, and `--fresh` out of `<flags>`/i);
  assert.match(rescue, /Pass `--model`, `--effort`, `--config key=value` through/i);
  assert.match(rescue, /Delegate the request to Codex through the shared companion runtime/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /the output ends with a `Re-run:` line/i);
  assert.doesNotMatch(agent, /prefer background execution/i);
  assert.match(runtimeSkill, /Launch exactly one job per rescue handoff with `task --await --prompt-stdin`/i);
  assert.match(agent, /Bash tool's 10-minute cap/i);
  assert.match(agent, /do not inspect the repository, read files, grep, cancel jobs, summarize output, or do any other follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Return the `result` stdout exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return the command's exit status and stderr verbatim/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /launches once with `task --await --prompt-stdin`, and on exit 3 re-runs only its own job's printed `result <id> --wait` hint/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, or `cancel` from `codex:codex-rescue`/i);
  assert.match(runtimeSkill, /Re-running the printed `result <id> --wait` hint for the job you just launched is the only follow-up call allowed/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, cancel jobs, summarize output, or do any other follow-up work of your own beyond launching and polling your own job/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return the command's exit status and stderr verbatim/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark` -> `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("rescue runs synchronously through the companion and uses Agent only for --background", () => {
  const rescue = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", "rescue.md"), "utf8");
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "codex-rescue.md"), "utf8");
  const runtimeSkill = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "codex-cli-runtime", "SKILL.md"), "utf8");
  assert.match(rescue, /task --await --prompt-stdin/);
  assert.match(rescue, /the output ends with a `Re-run:` line/i);
  assert.match(rescue, /`--background`: invoke the `Agent` tool with `codex:codex-rescue`/);
  assert.match(rescue, /--config/);
  assert.doesNotMatch(agent, /^model:/m);
  assert.doesNotMatch(agent, /return nothing/i);
  assert.match(agent, /exit status and stderr/i);
  assert.match(agent, /task --await --prompt-stdin/);
  assert.match(agent, /the output ends with a `Re-run:` line/i);
  assert.doesNotMatch(agent, /task-resume-candidate --json/);
  // Fix round 1: the agent must defer to SKILL.md's "only permitted follow-up
  // is the printed Re-run line" rule instead of granting itself a separate
  // bare-`status` permission.
  assert.doesNotMatch(agent, /own `status`/);
  assert.match(agent, /--config/);
  assert.doesNotMatch(runtimeSkill, /return nothing/i);
  assert.match(runtimeSkill, /Map `sol` to `--model gpt-5\.6-sol`/i);
  assert.match(runtimeSkill, /\$agent-compat:skill-router/);
  assert.doesNotMatch(agent, /adding `--write` unless/i);
  assert.doesNotMatch(runtimeSkill, /adding `--write` unless/i);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer --args-stdin <<'CODEX_ARGS'/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /argument-hint:\s*'\[job-id\] \[--wait\] \[--timeout-ms <ms>\]'/);
  assert.match(result, /codex-companion\.mjs" result --args-stdin <<'CODEX_ARGS'/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel --args-stdin <<'CODEX_ARGS'/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task --await --prompt-stdin/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("session start hook allows enough time to restore session state", () => {
  const hooks = JSON.parse(read("hooks/hooks.json"));
  const sessionStartHook = hooks.hooks.SessionStart[0].hooks[0];

  assert.equal(sessionStartHook.timeout, 60);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json --args-stdin <<'CODEX_ARGS'/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

test("stop gate script timeout is shorter than the Stop hook timeout and its message matches", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const stopTimeoutSeconds = hooks.hooks.Stop[0].hooks[0].timeout;
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs"), "utf8");
  const minutes = source.match(/const STOP_REVIEW_TIMEOUT_MINUTES = (\d+);/);
  assert.ok(minutes, "STOP_REVIEW_TIMEOUT_MINUTES must be a named constant");
  assert.match(source, /const STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_TIMEOUT_MINUTES \* 60 \* 1000;/);
  assert.ok(Number(minutes[1]) * 60 < stopTimeoutSeconds, "script timeout must be below the hook timeout");
  assert.doesNotMatch(source, /15 minutes/);
  assert.match(source, /\$\{STOP_REVIEW_TIMEOUT_MINUTES\} minutes/);
  assert.match(source, /killSignal: "SIGKILL"/);
  assert.match(source, /maxBuffer: 16 \* 1024 \* 1024/);
});

test("marketplace is published under cbepx while the plugin keeps the codex name", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(marketplace.name, "cbepx");
  assert.equal(marketplace.owner.name, "CBEPX");
  assert.equal(plugin.name, "codex");
  assert.equal(marketplace.plugins[0].name, "codex");
  assert.equal(marketplace.plugins[0].version, plugin.version);
});

function assertArgumentsNeverReachTheShell(label, body) {
  body.split("\n").forEach((line, index) => {
    if (!line.includes("$ARGUMENTS")) {
      return;
    }
    const trimmed = line.trim();
    assert.ok(
      trimmed === "$ARGUMENTS" || trimmed === "`$ARGUMENTS`",
      `${label}:${index + 1} exposes $ARGUMENTS to the shell: ${line}`
    );
  });
}

test("command bodies hand arguments to the companion via a quoted heredoc, never inside a shell string", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  for (const file of commandFiles) {
    const body = read(path.join("commands", file));
    assert.doesNotMatch(body, /"\$ARGUMENTS"/, `${file} still interpolates $ARGUMENTS inside a shell string`);
    // $ARGUMENTS may only appear as inline-code prose (`$ARGUMENTS`) or as the
    // whole body line of a quoted heredoc. Anywhere else the shell expands what
    // Claude Code substituted before bash ever ran.
    assertArgumentsNeverReachTheShell(file, body);
    // rescue.md sends only the request prose through a randomized --prompt-stdin
    // heredoc (flags travel on the command line); the other seven command bodies
    // keep the fixed `--args-stdin <<'CODEX_ARGS'` delimiter for their flag-only payload.
    const expectedDelimiter = file === "rescue.md" ? /--prompt-stdin <flags> <<'CODEX_PROMPT_/ : /--args-stdin <<'CODEX_ARGS'/;
    assert.match(body, expectedDelimiter, `${file} must pass arguments through a quoted heredoc`);
  }

  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  for (const [label, body] of [["rescue.md", rescue], ["codex-rescue.md", agent]]) {
    assert.doesNotMatch(body, /"<request text>"/, `${label} still interpolates the request text inside a shell string`);
    assert.match(
      body,
      /task --await --prompt-stdin <flags> <<'CODEX_PROMPT_/,
      `${label} must launch through a quoted heredoc`
    );
  }
});

test("rescue sends the request prose through --prompt-stdin, never through the argument tokenizer", () => {
  for (const [label, body] of [
    ["rescue.md", read("commands/rescue.md")],
    ["codex-rescue.md", read("agents/codex-rescue.md")]
  ]) {
    assert.match(body, /--prompt-stdin <flags> <<'CODEX_PROMPT_/, `${label} must pass the request prose via --prompt-stdin`);
    assert.doesNotMatch(body, /--prompt-file/, `${label} must not use the old --prompt-file channel`);
    assert.doesNotMatch(body, /--args-stdin/, `${label} must not use the old --args-stdin channel`);
    assert.doesNotMatch(body, /\$PROMPT\b/, `${label} must not carry the prompt through a shell variable`);

    // A payload line equal to a fixed delimiter would close the heredoc early and
    // run the rest on the host shell.
    assert.match(body, /8 fresh random hex/i, `${label} must require a fresh random heredoc delimiter`);
    assert.match(body, /CODEX_PROMPT_<random>/, `${label} must name the randomized delimiter placeholder`);
    assert.match(
      body,
      /a payload line equal to it would end the heredoc early and run the rest on the host shell/i,
      `${label} must explain why the delimiter must not collide with request text`
    );
  }
});

function extractFirstBashBlock(body, label) {
  const match = body.match(/```bash\n([\s\S]*?)```/);
  assert.ok(match, `${label} must contain a fenced bash block`);
  return match[1];
}

test("rescue and agent payload blocks are a single node call with no leftover shell scaffolding", () => {
  for (const [label, body] of [
    ["rescue.md", read("commands/rescue.md")],
    ["codex-rescue.md", read("agents/codex-rescue.md")]
  ]) {
    const block = extractFirstBashBlock(body, label);
    const invocations = block.match(/codex-companion\.mjs/g) || [];
    assert.equal(invocations.length, 1, `${label} payload block must invoke codex-companion.mjs exactly once`);
    assert.match(block, /task --await --prompt-stdin/, `${label} payload block must call task --await --prompt-stdin`);
    for (const banned of [/mktemp/, /cat >/, /\bwhile\b/, /sleep/, /\$JOB=/]) {
      assert.doesNotMatch(block, banned, `${label} payload block must not contain ${banned}`);
    }
    // <flags> sit on the host command line unconstrained; the payload block
    // itself must never carry command substitution or a literal backtick.
    assert.doesNotMatch(block, /\$\(|`/, `${label} payload block must not contain $() or backticks`);
    assert.match(
      body,
      /may contain only bare tokens/i,
      `${label} must document the <flags> hygiene rule`
    );
    assert.match(
      body,
      /never place it on the command line/i,
      `${label} hygiene rule must tell the caller to drop unsafe flag values instead of using them`
    );
  }
});

test("rescue resolves the resume decision before the --background branch", () => {
  const rescue = read("commands/rescue.md");
  const resumeDecisionIndex = rescue.indexOf("ask ONCE with `AskUserQuestion`");
  const backgroundBranchIndex = rescue.indexOf("`--background`: invoke the `Agent` tool with `codex:codex-rescue`");
  assert.notEqual(resumeDecisionIndex, -1, "resume-decision AskUserQuestion step must be present");
  assert.notEqual(backgroundBranchIndex, -1, "--background branch must be present");
  assert.ok(resumeDecisionIndex < backgroundBranchIndex, "resume decision must precede the --background branch");
});

test("agent never decides the resume choice itself", () => {
  const agent = read("agents/codex-rescue.md");
  assert.doesNotMatch(agent, /task-resume-candidate --json/);
  assert.doesNotMatch(agent, /clearly asking to continue/i);
  assert.match(agent, /You have no `AskUserQuestion` tool to ask with/i);
  assert.match(agent, /never call `task-resume-candidate`/i);
  assert.match(agent, /if neither flag is present, run fresh/i);
});

test("SKILL.md execution rules describe the single-call flow, not the old two-step poll loop", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  assert.doesNotMatch(runtimeSkill, /task --background --json/);
  assert.doesNotMatch(runtimeSkill, /polls only that job's own `status`/);
  assert.match(runtimeSkill, /task --await --prompt-stdin/);
  assert.match(runtimeSkill, /result <id> --wait --timeout-ms 540000/);
  assert.doesNotMatch(runtimeSkill, /task "<raw arguments>"/);
});

// `task --await` reports the job's outcome; `result` reports whether a record
// could be retrieved. Automation cannot act on a published contract that claims
// both return 0 for a failed job one line after saying `--await` returns 1.
test("README keeps the task --await and result exit-code contracts apart", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(
    readme,
    /Exit code is 0 when the job completed, 1 when it failed or was cancelled, and 3 when the wait times out/,
    "the task --await contract (0/1/3) must stay stated"
  );
  assert.match(
    readme,
    /`result` exits 0 for any terminal record \(completed, failed or cancelled\) and 3 while the job is still active/,
    "the result contract must be stated separately"
  );
  assert.doesNotMatch(
    readme,
    /`result` and `task --await` exit 0 for \*\*any\*\* terminal record/,
    "the two contracts must not be merged back into one claim"
  );
});

test("README documents the fork's own install commands", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(readme, /plugin marketplace add CBEPX\/codex-plugin-cc/);
  assert.match(readme, /plugin install codex@cbepx/);

  // No install line may point at the upstream marketplace or plugin id. The one
  // line allowed to name upstream is the "Upstream:" attribution.
  readme.split("\n").forEach((line, index) => {
    if (!/plugin (marketplace add|install)/.test(line) || !line.includes("openai")) {
      return;
    }
    assert.ok(line.includes("Upstream:"), `README.md:${index + 1} still documents an upstream install: ${line}`);
  });
  assert.doesNotMatch(readme, /openai-codex/);
});

test("bump-version --check pins the lockfile identity to package.json", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
});
