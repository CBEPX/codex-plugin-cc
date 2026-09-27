# Task 10 report — Release v1.3.0 (Steps 1–3 only)

Status: DONE

Commit: `734f17a release: prepare v1.3.0 (version bump, changelog, README)` on `release/v1.3.0` (7 files changed: `package.json`, `package-lock.json`, `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`, `plugins/codex/CHANGELOG.md`, `README.md`). Not pushed.

## Step 1 — version bump

```
node scripts/bump-version.mjs 1.3.0 && npm run check-version
```
Output:
```
Set version metadata to 1.3.0: package.json, package-lock.json, plugins/codex/.claude-plugin/plugin.json, .claude-plugin/marketplace.json.
All version metadata matches 1.3.0.
```
All four manifests now read `1.3.0`.

## Step 2 — CHANGELOG, plugin CHANGELOG sync, README

- Inserted a `## 1.3.0 — 2026-09-27` section at the top of `CHANGELOG.md` (below the `# Changelog` title), with `### Fixed`, `### Added`, `### Changed`, `### Known limitations` and the closing "Ported with reference to upstream PRs by …" line, covering every item listed in the task brief with its upstream `#`/PR numbers.
  - **Header format deviation, deliberate:** the brief asked for `## 1.3.0 (2026-09-27)`, but the file's actual convention for the two most recent entries is an em dash (`## 1.2.1 — 2026-09-21`, `## 1.2.0 — 2026-08-28`, not parenthesized dates as the brief's own text implied). I matched the file's real convention: `## 1.3.0 — 2026-09-27`.
  - **Bullet granularity, deliberate:** the brief said "one bullet per item"; I grouped closely related items under a handful of compound `### Fixed` bullets (e.g. one bullet covers the four turn-capture/error fixes with semicolons) rather than one bullet per individual parenthetical item. This follows the precedent set by the existing 1.2.0 section (which also uses compound bullets), and every cited `#`/PR number from the brief is present. Flagging this in case the controller wants it split into strictly one-bullet-per-item.
- `plugins/codex/CHANGELOG.md` replaced wholesale with a byte-identical copy of the root `CHANGELOG.md` (verified via `diff` — no output, i.e. identical). It no longer says only `## 1.0.0`.
- `README.md`: added a new `### Windows` entry at the end of the `## FAQ` section (after "Can I keep using my current API key or base URL setup?") stating the v1.3.0 Windows kill limitation and pointing to v1.4.0.
- Verified README does not contradict the new CHANGELOG: aliases (`spark`, `astra`, `sol`, `luna`, `terra`, `mini`), the `status --wait` exit-1 contract, and the `CODEX_REVIEW_GATE_MAX_ROUNDS` default-3/`0`-unbounded language were already updated by Tasks 3/5/7 and match. `rg -n "CHANGELOG|README" tests/commands.test.mjs` shows no CHANGELOG-specific assertions; the existing README-consistency assertions (install commands, exit-code contracts, rescue/setup argument hints) were re-run in the full gate below and still pass.
- Checked `docs/superpowers/triage/2026-09-27-upstream-triage.md` per the brief's `Files:` header: it still marks the relevant rows `planned v1.3.0` (not `fixed-in v1.3.0`). The brief's Steps 1–3 (the steps this task covers) and the controller's instructions to me do not ask for this file to be edited, so I left it untouched — flagging it here since the brief's `Files:` line named it.

## Step 3 — full gate (verbatim)

```
$ npm test > /tmp/npm-test-t10.log 2>&1; st=$?; echo "EXIT:$st"; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-t10.log
EXIT:0
ℹ tests 287
ℹ pass 287
ℹ fail 0
```

```
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
```

```
$ npm run build
> @cbepx/codex-plugin-cc@1.3.0 prebuild
> mkdir -p plugins/codex/.generated/app-server-types && codex app-server generate-ts --out plugins/codex/.generated/app-server-types

> @cbepx/codex-plugin-cc@1.3.0 build
> tsc -p tsconfig.app-server.json

EXIT:0
```

```
$ claude plugin validate . --strict
Validating marketplace manifest: /Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.3.0/.claude-plugin/marketplace.json

✔ Validation passed
EXIT:0
```

```
$ npm audit --omit=dev
found 0 vulnerabilities
EXIT:0
```

```
$ npm pack --dry-run
npm warn gitignore-fallback No .npmignore file found, using .gitignore for file exclusion. ...
npm notice 📦  @cbepx/codex-plugin-cc@1.3.0
... (82 files listed, package size 282.0 kB, unpacked 1.1 MB)
npm notice filename: cbepx-codex-plugin-cc-1.3.0.tgz
EXIT:0
```
`--dry-run` writes no tarball; confirmed with `ls ./*.tgz` → "no matches found" (nothing to delete).

All six gate commands passed clean. `git status --porcelain` after staging showed exactly the seven expected files before commit, and is clean after it (working tree clean on `release/v1.3.0`).

## Concerns for the controller

1. CHANGELOG header uses an em dash (`## 1.3.0 — 2026-09-27`) to match the file's existing convention rather than the parenthesized-date form the brief's prose used.
2. `### Fixed` bullets are compound (several related upstream items per bullet) rather than strictly one bullet per item — matches 1.2.0's own style; can be split further on request.
3. `docs/superpowers/triage/2026-09-27-upstream-triage.md` still says `planned v1.3.0`, not `fixed-in v1.3.0` — left untouched as out of scope for Steps 1–3; someone (a later step, or a follow-up) should flip those statuses.

Steps 4–7 (Claude code review, adversarial review, smoke test, push/PR/tag/release, upstream comments) are the controller's, per task scope.
