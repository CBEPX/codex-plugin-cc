import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
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

const noCodex = () => ({ status: 1, stdout: "", stderr: "", error: null });

function writeCatalog(dir, name, json) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(json));
  return file;
}

test("loadModelCatalog normalizes entries from a bare array and applies defaults", () => {
  const dir = makeTempDir();
  const file = writeCatalog(dir, "catalog.json", [
    { slug: "gpt-9-x" },
    { slug: 42 },
    null,
    { slug: "gpt-9-y", visibility: "hide", priority: 3, supported_reasoning_levels: [{ effort: "low" }, null, {}] }
  ]);
  assert.deepEqual(loadModelCatalog({ env: { CODEX_COMPANION_MODEL_CATALOG: file, CODEX_HOME: dir }, runCommandImpl: noCodex }), [
    { slug: "gpt-9-x", visibility: "list", priority: Number.MAX_SAFE_INTEGER, efforts: [] },
    { slug: "gpt-9-y", visibility: "hide", priority: 3, efforts: ["low"] }
  ]);
});

test("loadModelCatalog falls back from the env catalogue to models_cache.json, then to codex --bundled", () => {
  const dir = makeTempDir();
  writeCatalog(dir, "models_cache.json", { models: [{ slug: "gpt-cache" }] });
  const empty = writeCatalog(dir, "empty.json", { models: [] });
  const calls = [];
  const bundled = (cmd, args, opts) => {
    calls.push([cmd, args, opts.timeoutMs]);
    return { status: 0, stdout: JSON.stringify({ models: [{ slug: "gpt-bundled" }] }), error: null };
  };
  const fromCache = loadModelCatalog({ env: { CODEX_COMPANION_MODEL_CATALOG: empty, CODEX_HOME: dir }, runCommandImpl: bundled });
  assert.deepEqual(fromCache.map((m) => m.slug), ["gpt-cache"]);
  assert.deepEqual(calls, []);

  const fromBundled = loadModelCatalog({ env: { CODEX_HOME: path.join(dir, "missing") }, runCommandImpl: bundled });
  assert.deepEqual(fromBundled.map((m) => m.slug), ["gpt-bundled"]);
  assert.deepEqual(calls, [["codex", ["debug", "models", "--bundled"], 10000]]);
});

test("loadModelCatalog ignores failed, erroring or non-JSON codex output", () => {
  const env = { CODEX_HOME: path.join(makeTempDir(), "missing") };
  for (const result of [
    { status: 0, stdout: "not json", error: null },
    { status: 0, stdout: "[]", error: new Error("spawn") },
    { status: 2, stdout: JSON.stringify([{ slug: "gpt-x" }]), error: null }
  ]) {
    assert.deepEqual(loadModelCatalog({ env, runCommandImpl: () => result }), []);
  }
  assert.deepEqual(loadModelCatalog({ env, runCommandImpl: () => { throw new Error("boom"); } }), []);
});

test("loadModelCatalog caches only when asked", () => {
  const dir = makeTempDir();
  const file = writeCatalog(dir, "catalog.json", [{ slug: "gpt-first" }]);
  const env = { CODEX_COMPANION_MODEL_CATALOG: file, CODEX_HOME: dir };
  assert.deepEqual(loadModelCatalog({ env, cache: true, runCommandImpl: noCodex }).map((m) => m.slug), ["gpt-first"]);
  writeCatalog(dir, "catalog.json", [{ slug: "gpt-second" }]);
  assert.deepEqual(loadModelCatalog({ env, cache: true, runCommandImpl: noCodex }).map((m) => m.slug), ["gpt-first"]);
  assert.deepEqual(loadModelCatalog({ env, runCommandImpl: noCodex }).map((m) => m.slug), ["gpt-second"]);
});

test("resolveModelAlias trims input, rejects blanks and orders by priority then newest family", () => {
  const entries = [
    { slug: "gpt-5-nova", visibility: "list", priority: 1, efforts: [] },
    { slug: "gpt-6-nova", visibility: "list", priority: 1, efforts: [] },
    { slug: "gpt-5.5-nova", visibility: "list", priority: 1, efforts: [] },
    { slug: "gpt-7-nova", visibility: "list", priority: 2, efforts: [] },
    { slug: "nova", visibility: "hide", priority: 0, efforts: [] },
    { slug: "supernova", visibility: "list", priority: 0, efforts: [] }
  ];
  assert.equal(resolveModelAlias("  nova ", entries), "nova");
  assert.equal(resolveModelAlias("NOVA", entries), "gpt-6-nova");
  assert.equal(resolveModelAlias("", entries), null);
  assert.equal(resolveModelAlias("   ", entries), null);
  assert.equal(resolveModelAlias(undefined, entries), null);
  assert.equal(resolveModelAlias("Unknown", entries), "Unknown");
  assert.equal(resolveModelAlias("spark", []), "gpt-5.3-codex-spark");
  assert.equal(resolveModelAlias("astra", []), "gpt-6-astra");
  assert.equal(resolveModelAlias("luna", []), "gpt-6-luna");
  assert.equal(resolveModelAlias("terra", []), "gpt-5.6-terra");
});

test("supportedEfforts returns null for a model with no listed efforts", () => {
  assert.equal(supportedEfforts("gpt-x", [{ slug: "gpt-x", visibility: "list", priority: 1, efforts: [] }]), null);
});
