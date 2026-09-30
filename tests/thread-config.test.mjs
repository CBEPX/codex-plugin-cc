import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewThreadName, buildThreadConfig, TASK_THREAD_PREFIX } from "../plugins/codex/scripts/lib/codex.mjs";

test("buildThreadConfig returns null when nothing is set", () => {
  assert.equal(buildThreadConfig({}), null);
  assert.equal(buildThreadConfig({ config: {} }), null);
});

test("buildThreadConfig maps model, review model and effort to Codex config keys", () => {
  assert.deepEqual(buildThreadConfig({ model: "gpt-5.6-sol", effort: "max", reviewModel: "gpt-5.6-sol" }), {
    model: "gpt-5.6-sol",
    review_model: "gpt-5.6-sol",
    model_reasoning_effort: "max"
  });
});

test("buildThreadConfig lets dedicated flags win over generic overrides and parses JSON-ish values", () => {
  assert.deepEqual(
    buildThreadConfig({
      effort: "max",
      config: { model_reasoning_effort: "low", "sandbox_workspace_write.network_access": "true", model_provider: "ollama", n: "3" }
    }),
    { "sandbox_workspace_write.network_access": true, model_provider: "ollama", n: 3, model_reasoning_effort: "max" }
  );
});

test("buildReviewThreadName names review threads outside the task prefix (#529)", () => {
  assert.equal(buildReviewThreadName("Review", "working tree diff"), "Codex Companion Review: working tree diff");
  const long = buildReviewThreadName("Adversarial Review", `check ${"the auth flow ".repeat(10)}`);
  assert.equal(long.length, "Codex Companion Adversarial Review: ".length + 56);
  assert.ok(long.endsWith("..."), long);
  for (const name of [long, buildReviewThreadName("Review", "branch diff against main")]) {
    assert.equal(name.startsWith(TASK_THREAD_PREFIX), false, name);
  }
});
