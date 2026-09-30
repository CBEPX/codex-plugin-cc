import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseArgs, splitArgsWithVerbatimTail, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { makeTempDir, run, initGitRepo } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

test("parseArgs rejects unknown long options when configured", () => {
  const helped = parseArgs(["--help", "--cwd", "/tmp"], {
    booleanOptions: ["help"],
    valueOptions: ["cwd"],
    rejectUnknownOptions: true
  });
  assert.equal(helped.options.help, true);
  assert.equal(helped.options.cwd, "/tmp");
  assert.deepEqual(helped.positionals, []);

  assert.throws(
    () =>
      parseArgs(["--not-a-flag"], {
        booleanOptions: ["json"],
        rejectUnknownOptions: true
      }),
    /Unknown option: --not-a-flag/
  );
});

test("parseArgs keeps unknown options as positionals by default", () => {
  const { options, positionals } = parseArgs(["--not-a-flag", "hello"], {
    booleanOptions: ["json"]
  });
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--not-a-flag", "hello"]);
});

test("task --help prints usage and does not dispatch a Codex thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");

  const result = run(process.execPath, [SCRIPT, "task", "--help", "--cwd", repo, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /codex-companion\.mjs task/);
  assert.equal(result.stderr.trim(), "");

  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  if (fs.existsSync(fakeStatePath)) {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal((state.threads ?? []).length, 0);
  }
});

test("task unknown --flag errors without dispatching a Codex thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");

  const result = run(process.execPath, [SCRIPT, "task", "--not-a-real-flag", "--cwd", repo], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option: --not-a-real-flag/);

  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  if (fs.existsSync(fakeStatePath)) {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal((state.threads ?? []).length, 0);
  }
});

test("parseArgs collects repeatable options and honours -- and --opt=value", () => {
  const { options, positionals } = parseArgs(
    ["--config", "a=1", "--config=b=x=y", "--model", "sol", "--", "--not-an-option", "tail"],
    { valueOptions: ["model"], repeatableOptions: ["config"] }
  );
  assert.deepEqual(options.config, ["a=1", "b=x=y"]);
  assert.equal(options.model, "sol");
  assert.deepEqual(positionals, ["--not-an-option", "tail"]);
});

test("parseArgs with stopAtFirstPositional keeps option-looking prompt words", () => {
  const { options, positionals } = parseArgs(
    ["--effort", "max", "investigate", "ls", "-R", "usage", "--model", "x"],
    { valueOptions: ["effort", "model"], stopAtFirstPositional: true }
  );
  assert.equal(options.effort, "max");
  assert.equal(options.model, undefined);
  assert.deepEqual(positionals, ["investigate", "ls", "-R", "usage", "--model", "x"]);
});

test("parseArgs rejects a repeatable option without a value", () => {
  assert.throws(() => parseArgs(["--config"], { repeatableOptions: ["config"] }), /--config/);
});

test("splitRawArgumentString keeps shell metacharacters as literal token content", () => {
  assert.deepEqual(splitRawArgumentString("investigate $(id) `whoami` ${HOME} a|b;c&d"), [
    "investigate",
    "$(id)",
    "`whoami`",
    "${HOME}",
    "a|b;c&d"
  ]);
});

test("splitRawArgumentString groups quoted runs and keeps quoted newlines inside one token", () => {
  assert.deepEqual(splitRawArgumentString("--config 'a b=c d' \"e f\""), ["--config", "a b=c d", "e f"]);
  assert.deepEqual(splitRawArgumentString("'line one\nline two'"), ["line one\nline two"]);
  assert.deepEqual(splitRawArgumentString("--all\n--json"), ["--all", "--json"]);
});

test("splitRawArgumentString keeps a backslash that escapes nothing (Windows paths)", () => {
  assert.deepEqual(splitRawArgumentString("investigate C:\\Users\\me\\proj\\file.mjs"), ["investigate", "C:\\Users\\me\\proj\\file.mjs"]);
  assert.deepEqual(splitRawArgumentString("'C:\\dir\\x' \"D:\\y\""), ["C:\\dir\\x", "D:\\y"]);
});

test("splitRawArgumentString keeps the old escape semantics for quotes, backslash and whitespace", () => {
  assert.deepEqual(splitRawArgumentString("say \\\"q\\\" a\\ b back\\\\slash it\\'s"), ["say", "\"q\"", "a b", "back\\slash", "it's"]);
  assert.deepEqual(splitRawArgumentString("'it\\'s'"), ["it's"]); // old behaviour, kept
  assert.deepEqual(splitRawArgumentString("\\\\server\\share"), ["\\server\\share"]); // documented limitation
});

// The review commands' option table as applyArgsStdin hands it over:
// REVIEW_ARG_SPEC plus the shared help flag and -C/-h aliases.
const REVIEW_SPLIT_SPEC = {
  valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"],
  booleanOptions: ["help", "json", "background", "wait"],
  repeatableOptions: ["config"],
  aliasMap: { C: "cwd", h: "help", m: "model" }
};

test("splitArgsWithVerbatimTail keeps everything from the first positional as one verbatim token (#714)", () => {
  const cases = [
    ["don't mangle this", ["don't mangle this"]],
    ["--base main don't mangle \"this\"\nline 2\n", ["--base", "main", "don't mangle \"this\"\nline 2"]],
    ["focus \"quoted\" and 'single' C:\\dir\\x \\n", ["focus \"quoted\" and 'single' C:\\dir\\x \\n"]],
    ["--json\n  line 1\n\n  line 2  \n", ["--json", "line 1\n\n  line 2"]],
    ["--model sol check --model x please", ["--model", "sol", "check --model x please"]],
    ["-m sol focus", ["-m", "sol", "focus"]],
    ["-C /tmp/x focus", ["-C", "/tmp/x", "focus"]],
    ["--config k=v --config=a=b focus", ["--config", "k=v", "--config=a=b", "focus"]],
    ["--model=sol focus", ["--model=sol", "focus"]],
    ["--config 'a b=c d' focus", ["--config", "a b=c d", "focus"]],
    ["-- -x y", ["--", "-x y"]],
    ["--base main -- --model is wrong\n", ["--base", "main", "--", "--model is wrong"]],
    ["--", ["--"]],
    ["--base main --json", ["--base", "main", "--json"]],
    ["--bogus focus", ["--bogus", "focus"]],
    ["--base", ["--base"]],
    ["--base -x focus", ["--base", "-x", "focus"]],
    ["", []],
    ["  \n\t", []]
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(splitArgsWithVerbatimTail(raw, REVIEW_SPLIT_SPEC), expected, JSON.stringify(raw));
  }
});

test("splitArgsWithVerbatimTail output parses to the same options and one focus string", () => {
  const parse = (raw) =>
    parseArgs(splitArgsWithVerbatimTail(raw, REVIEW_SPLIT_SPEC), { ...REVIEW_SPLIT_SPEC, rejectUnknownOptions: true, stopAtFirstPositional: true });
  const { options, positionals } = parse("--model sol -C /tmp/x --config a=1 check --model x, don't \"stop\"\n");
  assert.equal(options.model, "sol");
  assert.equal(options.cwd, "/tmp/x");
  assert.deepEqual(options.config, ["a=1"]);
  assert.deepEqual(positionals, ["check --model x, don't \"stop\""]);
  assert.deepEqual(parse("-- --model is wrong").positionals, ["--model is wrong"]);
  assert.throws(() => parse("--base"), /Missing value for --base/);
  assert.throws(() => parse("--bogus focus"), /Unknown option: --bogus/);
});
