import test from "node:test";
import assert from "node:assert/strict";

import { buildAdversarialReviewPrompt, MAX_REVIEW_PROMPT_CHARS } from "../plugins/codex/scripts/commands/review.mjs";

const inlineContext = (content) => ({
  target: { label: "working tree diff" },
  collectionGuidance: "Use the repository context below as primary evidence.",
  content
});

test("buildAdversarialReviewPrompt leaves a prompt under the ceiling untouched", () => {
  const logs = [];
  const prompt = buildAdversarialReviewPrompt(inlineContext("## Git Status\n\nM app.js\n"), "auth", (message) => logs.push(message));
  assert.match(prompt, /primary evidence/);
  assert.match(prompt, /M app\.js/);
  assert.doesNotMatch(prompt, /Repository context truncated/);
  assert.deepEqual(logs, []);
});

test("buildAdversarialReviewPrompt cuts a 1 MB context at a line and switches to self-collect guidance (#405)", () => {
  const line = `${"y".repeat(63)}\n`;
  const content = line.repeat(16384); // 1,048,576 characters
  const logs = [];
  const prompt = buildAdversarialReviewPrompt(inlineContext(content), "auth", (message) => logs.push(message));

  assert.equal(MAX_REVIEW_PROMPT_CHARS, 786432);
  assert.ok(prompt.length <= MAX_REVIEW_PROMPT_CHARS, `prompt is ${prompt.length} characters`);
  const marker = /\n\[Repository context truncated at (\d+) characters: inspect the target yourself with read-only git commands before finalizing findings\.\]\n/.exec(prompt);
  assert.ok(marker, "truncation marker missing");
  const kept = Number(marker[1]);
  assert.equal(kept % line.length, 0, "cut after a whole line");
  assert.ok(prompt.includes(`${content.slice(0, kept)}[Repository context truncated at ${kept} characters`), "the kept part is the context's prefix");
  assert.match(prompt, /Inspect the target diff yourself with read-only git commands before finalizing findings\./);
  assert.doesNotMatch(prompt, /primary evidence/);
  assert.deepEqual(logs, [`Review context truncated to fit the prompt ceiling (${kept} of ${content.length} characters).`]);
});
