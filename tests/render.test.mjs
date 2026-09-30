import test from "node:test";
import assert from "node:assert/strict";

import { looksLikeVerificationCommand, renderJobStatusReport, renderReviewResult, renderStoredJobResult, shorten } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderJobStatusReport prints Error only for failed jobs whose error adds to the summary", () => {
  const base = { id: "task-1", status: "failed", kindLabel: "rescue", title: "Codex Task" };
  const duplicate = renderJobStatusReport({ ...base, summary: "Quota exhausted", errorMessage: " Quota exhausted\n" });
  assert.doesNotMatch(duplicate, /Error:/);
  const distinct = renderJobStatusReport({ ...base, summary: "Codex Task failed.", errorMessage: "Quota exhausted" });
  assert.match(distinct, /^ {2}Error: Quota exhausted$/m);
  const completed = renderJobStatusReport({ ...base, status: "completed", summary: "Done", errorMessage: "stale" });
  assert.doesNotMatch(completed, /Error:/);
});

test("shorten: collapses whitespace, truncates with an ellipsis, tolerates null", () => {
  const long = shorten("a".repeat(100), 96);
  assert.equal(long.length, 96);
  assert.ok(long.endsWith("..."));
  assert.equal(shorten(" a \n b ", 96), "a b");
  assert.equal(shorten(null, 96), "");
});

test("looksLikeVerificationCommand: test runners yes, plain shell no", () => {
  for (const command of ["npm test", "pytest -q", "tsc"]) assert.equal(looksLikeVerificationCommand(command), true, command);
  for (const command of ["git status", "ls -la"]) assert.equal(looksLikeVerificationCommand(command), false, command);
});
