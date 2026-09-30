import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readJsonOrNull } from "./fs.mjs";
import { runCommand } from "./process.mjs";

export const CATALOG_ENV = "CODEX_COMPANION_MODEL_CATALOG";
// Used only when no catalogue is readable (no models_cache.json and no codex binary).
export const FALLBACK_ALIASES = new Map([
  ["spark", "gpt-5.3-codex-spark"],
  ["astra", "gpt-6-astra"],
  ["sol", "gpt-6-sol"],
  ["luna", "gpt-6-luna"],
  ["terra", "gpt-5.6-terra"],
  ["mini", "gpt-5.4-mini"]
]);

let cached = null;

function normalizeEntries(raw) {
  const models = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
  return models
    .filter((m) => m && typeof m.slug === "string")
    .map((m) => ({
      slug: m.slug,
      visibility: m.visibility ?? "list",
      priority: Number.isFinite(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l?.effort).filter(Boolean) : []
    }));
}

// Cached per process for the default environment only; an explicit env (tests)
// always reads fresh.
export function loadModelCatalog({ env = process.env, runCommandImpl = runCommand, cache = env === process.env } = {}) {
  if (cache && cached) return cached;
  const sources = [];
  if (env[CATALOG_ENV]) sources.push(() => readJsonOrNull(env[CATALOG_ENV]));
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  sources.push(() => readJsonOrNull(path.join(codexHome, "models_cache.json")));
  // Last resort: the bundled catalogue, never the network-refreshing form — its
  // output is ~500 KB and this runs on every companion invocation.
  sources.push(() => {
    const result = runCommandImpl("codex", ["debug", "models", "--bundled"], { env, timeoutMs: 10000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  });
  let entries = [];
  for (const source of sources) {
    try { entries = normalizeEntries(source()); } catch { entries = []; }
    if (entries.length > 0) break;
  }
  if (cache) cached = entries;
  return entries;
}

function familyNumber(slug) {
  const match = /^gpt-(\d+(?:\.\d+)?)/.exec(slug);
  return match ? Number(match[1]) : -1;
}

export function resolveModelAlias(alias, catalog) {
  const wanted = String(alias ?? "").trim();
  if (!wanted) return null;
  if (catalog.some((m) => m.slug === wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const candidates = catalog
    .filter((m) => m.visibility === "list" && (m.slug === lower || m.slug.endsWith(`-${lower}`)))
    .sort((a, b) => a.priority - b.priority || familyNumber(b.slug) - familyNumber(a.slug));
  if (candidates.length > 0) return candidates[0].slug;
  return FALLBACK_ALIASES.get(lower) ?? wanted;
}

export function supportedEfforts(slug, catalog) {
  const entry = catalog.find((m) => m.slug === slug);
  return entry && entry.efforts.length > 0 ? entry.efforts : null;
}
