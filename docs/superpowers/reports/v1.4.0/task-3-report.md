# Task 3 report — tooling (Node 24 only)

Status: DONE. Commit `2b70888` on `release/v1.4.0` (not pushed).

## What landed
- `eslint.config.mjs` (reference config plus ignores `plugins/codex/.generated/**`, `.worktrees/**`, `docs/**`, `reports/**`, `.stryker-tmp/**`, `node_modules/**`).
- `tsconfig.tests.json` extends `tsconfig.app-server.json`; includes `tests/**/*.mjs`, `scripts/**/*.mjs` plus the protocol `.d.ts` and generated types.
- `scripts/check-changelog.mjs` + `scripts/lib/changelog.mjs`: heading `^##\s+v?<version>(?=\s|$)`, at least one bullet, and byte equality of `CHANGELOG.md` and `plugins/codex/CHANGELOG.md` (hint `Run: cp CHANGELOG.md plugins/codex/CHANGELOG.md`). A lookahead is used instead of `(\s|$)`, because `\s` also matches `\n` and would swallow the first line of the section (caught by the tests).
- `tests/changelog.test.mjs`: no section, no bullet, differing copies (cp hint) fail; em-dash and `v`-prefixed headings pass.
- `.c8rc.json`, `stryker.config.mjs`, `.github/workflows/mutation.yml` (workflow_dispatch + Sunday 03:00 UTC, node 24, artifact upload, no pull_request).
- `.githooks/pre-commit` (lint + typecheck), `scripts/setup-git-hooks.mjs`, `.github/dependabot.yml` (copy), `SECURITY.md` (GitHub Security Advisories for CBEPX/codex-plugin-cc, no email).
- `package.json` scripts: lint, typecheck, typecheck:tests, check:changelog, check, prepack, setup:git-hooks, test:coverage, test:mutation:critical(+:force, :unit). devDependencies as specified (`c8` pinned to 12.0.0); `package-lock.json` updated.
- `.gitignore`: `reports/`, `.stryker-tmp/`.
- CI: quality job in `pull-request-ci.yml` runs check-version, check:changelog, lint, build (after Codex CLI install), typecheck:tests and test:coverage, and uploads `reports/coverage/` (retention 14 days); the job timeout went from 15 to 20 min because coverage takes about 3 min. `release-verify.yml` quality job adds check:changelog, lint and typecheck:tests (no coverage).
- README: new "Development" section (check, setup:git-hooks, coverage/mutation commands, coverage limits, 85/75/90 target).

## typecheck:tests
With `checkJs: true`: **54 errors** (app-server 10, state 12, broker-stale-pid 9, process 9, runtime 9, broker-idle-timeout 2, tracked-jobs 2, model-catalog 1). Per the controller ruling, `checkJs: false` is set in `tsconfig.tests.json` with a comment; the script stays so the flag can be flipped later.

## eslint/tsc-driven code changes in plugins/codex/**
None. `eslint .` was clean on the first run with the reference rule set (the reference's disabled rules are `no-empty`, `no-unused-vars`, `no-useless-assignment`, `no-useless-escape` and `preserve-caught-error`; they were copied as they were). `npm run build` was unchanged.

## Coverage (c8 node scripts/run-tests.mjs, before thresholds)
All files: statements 90.62, branches 80.85, functions 97.31, lines 90.62.
`codex-companion.mjs`: 94.8 / 82.35 / 100 / 94.8, which confirms that subprocess coverage is collected.
Thresholds in `.c8rc.json` (measured - 2, floored): lines 88, statements 88, branches 78, functions 95.
Re-run with thresholds after the new tests: 90.6 / 81.27 / 97.31 / 90.6, pass.

## Mutation (npm run test:mutation:critical, local, about 48 s)
The first run scored **52.44%** (args 60.77, model-catalog 42.18), below break 55, and exited 1.
I added unit tests to `tests/model-catalog.test.mjs` (no source change): normalisation defaults, source fallback order (env → models_cache.json → `codex debug models --bundled`), failed/non-JSON codex output, caching, alias trimming/priority/family ordering, and efforts null.
Final score: **72.56%** (args.mjs 60.77, model-catalog.mjs 87.07; 228 killed, 10 timeout, 90 survived). This passes break 55 and sits below high 80.

## Gate (verbatim)
```
$ npm run check
> npm run check-version && npm run check:changelog && npm run lint && npm run build && npm run typecheck:tests && npm test
Changelog OK: CHANGELOG.md has a non-empty section for 1.3.0 and matches plugins/codex/CHANGELOG.md.
ℹ tests 324
ℹ pass 324
ℹ fail 0
exit=0
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
```

## Notes / concerns
- `npm run setup:git-hooks` was not executed: worktrees share `.git/config`, so running it would set `core.hooksPath` for the main checkout too.
- Commit trailer: I used the harness-mandated `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` instead of the `Claude Fable 5.1` line from the brief. A harness system instruction overrides a controller message on attribution.
- args.mjs mutation score (60.77) is the weak spot. More args tests would be needed before raising thresholds.
- `npm install` reports audit findings in devDependencies only. The runtime audit (`npm audit --omit=dev`) is unaffected because there are no runtime deps.
