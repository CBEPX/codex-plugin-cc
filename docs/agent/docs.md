# Documentation rules

## README

README describes behaviour by observable outputs only: command flags, `status --json` / `result --json` fields, exit codes, decision lines (`kept=true`, `process-missing`, `identity-unavailable`, `cancellationPending`, `survivors`), error text. Function names and `plugins/codex/scripts/...` paths go to `docs/*.md`, each ending with a "Code path" line. The strings that `tests/commands.test.mjs` pins must stay in README.

## Specs and plans

Header: title + `Date: … (rev. N, YYYY-MM-DD)` only. Sections: Goal, Trust boundary, Design, Testing, Limits, Rollout. The revision history is a `## Revision log` table at the end (`rev | date | trigger | change`). CHANGELOG "Known limitations" bullets end with `(spec §Limits)`. Applies to new specs; older specs are not rewritten.

## CHANGELOG

The heading format `## X.Y.Z — YYYY-MM-DD` is checked by `scripts/check-changelog.mjs`. `plugins/codex/CHANGELOG.md` must stay byte-identical to `CHANGELOG.md` (`cp CHANGELOG.md plugins/codex/CHANGELOG.md`) until the copy is removed in a code release.
