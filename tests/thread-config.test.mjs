import test from "node:test";
import assert from "node:assert/strict";
import { buildThreadConfig } from "../plugins/codex/scripts/lib/codex.mjs";

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
