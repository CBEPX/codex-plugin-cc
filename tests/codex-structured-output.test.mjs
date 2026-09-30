import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutput } from "../plugins/codex/scripts/lib/codex.mjs";

const REVIEW = { verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] };
const BODY = JSON.stringify(REVIEW);
const TICKS = { ...REVIEW, summary: "use ``` fences" };

// Recovery chain ported from cc-plugin-codex (#583): whole message, first fenced
// block, first balanced object that parses. rawOutput is always the raw message.
test("parseStructuredOutput recovers JSON from the whole message, a fenced block or embedded prose (#583)", () => {
  const rows = [
    ["bare", BODY, REVIEW],
    ["json fence", "```json\n" + BODY + "\n```", REVIEW],
    ["untagged fence", "```\n" + BODY + "\n```", REVIEW],
    ["CRLF fence with surrounding whitespace", "\r\n```json\r\n" + BODY + "\r\n```\r\n", REVIEW],
    ["backticks inside a string", "```json\n" + JSON.stringify(TICKS) + "\n```", TICKS],
    ["fenced block after a prose preface", "Here is my review:\n\n```json\n" + BODY + "\n```\nThanks.", REVIEW],
    ["a fenced block wins over an earlier prose object", "Format: {\"verdict\":\"x\"}.\n```json\n" + BODY + "\n```", REVIEW],
    ["prose with one embedded object", "Now I have all the evidence.\n\n" + BODY + "\n", REVIEW],
    ["broken first object, valid later one", 'prefix {"bad": } middle {"ok":true}', { ok: true }],
    ["braces inside a JSON string", 'noise {"message":"brace: \\"{\\"","nested":{"ok":true}} tail', { message: 'brace: "{"', nested: { ok: true } }],
    ["nested objects", 'Intro\n\n{"ok":true,"nested":{"a":1}}\n', { ok: true, nested: { a: 1 } }]
  ];
  for (const [label, raw, expected] of rows) {
    const result = parseStructuredOutput(raw, { status: 0 });
    assert.deepEqual(result.parsed, expected, label);
    assert.equal(result.parseError, null, label);
    assert.equal(result.rawOutput, raw, `${label}: rawOutput stays the raw message`);
    assert.equal(result.status, 0, `${label}: fallback fields still spread`);
  }
});

test("parseStructuredOutput still fails on malformed JSON, prose without an object and empty output", () => {
  const rows = [
    ["malformed inside a fence", "```json\n{not json}\n```"],
    ["truncated object", '{"verdict":"approve","summary":'],
    ["prose without an object", "Looks good to me."]
  ];
  for (const [label, raw] of rows) {
    const result = parseStructuredOutput(raw);
    assert.equal(result.parsed, null, label);
    assert.ok(result.parseError, label);
    assert.equal(result.rawOutput, raw, label);
  }
  const empty = parseStructuredOutput("", {});
  assert.deepEqual([empty.parsed, empty.parseError, empty.rawOutput], [null, "Codex did not return a final structured message.", ""]);
});

// Accepted risk (spec §Limits): a reply that only quotes an object is read as
// that object. A quoted review-shaped object therefore renders as a review.
test("parseStructuredOutput takes an object quoted in prose as the answer", () => {
  const raw = `The expected format is ${BODY}, but I could not finish the review.`;
  const result = parseStructuredOutput(raw);
  assert.deepEqual(result.parsed, REVIEW);
  assert.equal(result.parseError, null);
  assert.equal(result.rawOutput, raw);
});
