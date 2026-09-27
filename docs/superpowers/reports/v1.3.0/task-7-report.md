# Task 7 report: Data-driven model catalogue

Status: DONE_WITH_CONCERNS (minor; see below). Commit: a9d7b2a.

## Implemented
- `plugins/codex/scripts/lib/model-catalog.mjs`: `loadModelCatalog`, `resolveModelAlias`, `supportedEfforts`, `FALLBACK_ALIASES`, `CATALOG_ENV`. The code follows the brief verbatim, with two deviations:
  1. `cache` defaults to `env === process.env`. With the brief's `cache = true`, the brief's own test "loadModelCatalog never throws" would get the cached fixture from the module-level call and fail. The companion always uses the default env, so it stays cached per process.
  2. Each source call is wrapped in try/catch, so an unexpected shape or a throwing `runCommandImpl` still yields `[]` and the function never throws.
- `codex-companion.mjs`: removed `MODEL_ALIASES`. `normalizeRequestedModel` now calls `resolveModelAlias(..., loadModelCatalog())`. `normalizeReasoningEffort(effort, model = null)` checks the effort against the catalogue when `model` is given. The review/adversarial-review path and the task path (2 call sites, since review and adversarial review share one handler) pass the normalised model. `printUsage` now shows `astra`.
- `handleSetup` gate calls are left with one argument, so the gate effort is checked only against VALID_REASONING_EFFORTS. The gate model and effort can be set in separate `setup` invocations, so cross-checking them there would be inconsistent.
- The catalogue is loaded only when `--model` is given; there is no subprocess and no file read otherwise.
- `tests/test-env.mjs` points `CODEX_COMPANION_MODEL_CATALOG` at `tests/fixtures/models-catalog.json`, so no test reads the host `~/.codex`.
- Docs: README (example `gpt-6-astra`, alias list, effort note, alias list in the gate section, config.toml example), SKILL.md, codex-rescue.md, and the `argument-hint` of rescue/review/adversarial-review (added `astra`).

## Tests
- New: `tests/model-catalog.test.mjs` (5 tests) and the runtime test "task --model sol resolves through the model catalogue and rejects an unsupported effort".
- Updated: runtime expectations `gpt-5.6-sol` -> `gpt-6-sol` (review config test, two `lastTurnStart.model` asserts) and 4 `tests/commands.test.mjs` doc assertions.
- RED: `node --import ./tests/test-env.mjs --test tests/model-catalog.test.mjs` -> `ERR_MODULE_NOT_FOUND ... model-catalog.mjs`, fail 1. Runtime test `--test-name-pattern catalogue` -> fail 1 (`actual: 'gpt-5.6-sol', expected: 'gpt-6-sol'`).
- GREEN: model-catalog pass 5/fail 0; runtime `catalogue|spark|sol|alias` pass 5/fail 0; commands pass 22/fail 0.
- Gate: `npm test` -> `ℹ tests 263, ℹ pass 263, ℹ fail 0` (257 + 6); `pgrep -f codex-plugin-test- | wc -l` -> 0; `npm run build` exit 0.
- Real-machine sanity check (read-only): 9 models, sol=gpt-6-sol, astra=gpt-6-astra, luna=gpt-6-luna, terra=gpt-5.6-terra, spark=gpt-5.3-codex-spark, mini=gpt-5.4-mini.

## Self-review
- Exact slug passthrough: a slug in the catalogue is returned as is, and an unknown string falls through to `wanted` unchanged.
- Hidden models: the `visibility === "list"` filter applies. `reserve` -> `reserve`; the exact `gpt-reserve` passes through.
- `--effort` without `--model`: `model` is null, so the catalogue check is skipped.
- The fallback subprocess is `codex debug models --bundled` with `timeoutMs: 10000` and a 64 MiB `maxBuffer`. A non-zero status, an error or bad JSON gives null and then `[]`.

## Concerns
- An alias typed in mixed case that exactly matches no slug is lowercased for family matching. A mixed-case exact slug not in the catalogue passes through with its original case, as before.
- The fixture has no `luna`, so `luna` resolves through FALLBACK_ALIASES (`gpt-6-luna`) in tests. This is intended.
