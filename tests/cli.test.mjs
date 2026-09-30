import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPANION_SCRIPT,
  normalizeArgv,
  normalizeReasoningEffort,
  parseConfigOverrides,
  parseTimeoutOption,
  REVIEW_SCHEMA
} from "../plugins/codex/scripts/lib/cli.mjs";
import { SCRIPT } from "./helpers.mjs";

// lib/cli.mjs sits one directory deeper than the entry it names; every matcher
// (reaper, worker command line, stop gate) depends on this path staying the entry's.
test("cli path constants resolve from lib/ to the plugin root", () => {
  assert.equal(COMPANION_SCRIPT, SCRIPT);
  assert.ok(fs.statSync(REVIEW_SCHEMA).isFile(), REVIEW_SCHEMA);
});

test("parseTimeoutOption accepts positive integers only and names the flag", () => {
  assert.equal(parseTimeoutOption(undefined, "--timeout-ms"), null);
  assert.equal(parseTimeoutOption(null, "--timeout-ms"), null);
  assert.equal(parseTimeoutOption("250", "--timeout-ms"), 250);
  for (const bad of ["0", "-5", "1.5", "nope", "1e400"]) {
    assert.throws(() => parseTimeoutOption(bad, "--await-timeout-ms"), {
      message: `--await-timeout-ms expects a positive integer number of milliseconds, got "${bad}".`
    });
  }
});

test("parseConfigOverrides splits at the first = and rejects a missing key", () => {
  assert.deepEqual(parseConfigOverrides(), {});
  assert.deepEqual(parseConfigOverrides(["a=b=c", "empty="]), { a: "b=c", empty: "" });
  for (const bad of ["novalue", "=x"]) {
    assert.throws(() => parseConfigOverrides([bad]), { message: `--config expects key=value, got "${bad}".` });
  }
});

test("normalizeReasoningEffort lowercases, rejects unknown efforts and checks the model", () => {
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort("  "), null);
  assert.equal(normalizeReasoningEffort(" HIGH "), "high");
  assert.throws(() => normalizeReasoningEffort("supreme"), {
    message: 'Unsupported reasoning effort "supreme". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.'
  });
  // tests/fixtures/models-catalog.json: gpt-5.6-sol supports low, medium, high.
  assert.throws(() => normalizeReasoningEffort("max", "gpt-5.6-sol"), {
    message: 'Reasoning effort "max" is not supported by gpt-5.6-sol. gpt-5.6-sol supports: low, medium, high.'
  });
});

test("normalizeArgv splits a single argument string and leaves real argv alone", () => {
  assert.deepEqual(normalizeArgv(["--model sol 'two words' \"x y\""]), ["--model", "sol", "two words", "x y"]);
  assert.deepEqual(normalizeArgv(["   "]), []);
  assert.deepEqual(normalizeArgv([""]), []);
  assert.deepEqual(normalizeArgv(["--model sol", "rest"]), ["--model sol", "rest"]);
});
