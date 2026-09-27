import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadModelCatalog, resolveModelAlias, supportedEfforts } from "../plugins/codex/scripts/lib/model-catalog.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "models-catalog.json");
const catalog = loadModelCatalog({ env: { CODEX_COMPANION_MODEL_CATALOG: FIXTURE } });

test("family alias resolves to the listed model with the lowest priority, newest family on ties", () => {
  assert.equal(resolveModelAlias("sol", catalog), "gpt-6-sol");
  assert.equal(resolveModelAlias("terra", catalog), "gpt-5.6-terra");
  assert.equal(resolveModelAlias("astra", catalog), "gpt-6-astra");
  assert.equal(resolveModelAlias("SOL", catalog), "gpt-6-sol");
});

test("hidden models never resolve from an alias and exact slugs pass through", () => {
  assert.equal(resolveModelAlias("reserve", catalog), "reserve");
  assert.equal(resolveModelAlias("gpt-reserve", catalog), "gpt-reserve");
  assert.equal(resolveModelAlias("gpt-5.6-sol", catalog), "gpt-5.6-sol");
});

test("hardcoded fallback applies only without a catalogue", () => {
  assert.equal(resolveModelAlias("sol", []), "gpt-6-sol");
  assert.equal(resolveModelAlias("mini", catalog), "gpt-5.4-mini");
});

test("supportedEfforts reports the catalogue list or null for unknown models", () => {
  assert.deepEqual(supportedEfforts("gpt-5.6-sol", catalog), ["low", "medium", "high"]);
  assert.equal(supportedEfforts("o3", catalog), null);
});

test("loadModelCatalog never throws on a missing or malformed source", () => {
  assert.deepEqual(loadModelCatalog({ env: { CODEX_COMPANION_MODEL_CATALOG: "/nonexistent.json", CODEX_HOME: "/nonexistent" }, runCommandImpl: () => ({ status: 1, stdout: "", stderr: "", error: null }) }), []);
});
