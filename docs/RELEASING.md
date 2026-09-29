# Releasing

Releases follow the same shape as [CBEPX/cc-plugin-codex](https://github.com/CBEPX/cc-plugin-codex/releases):
a git tag, a GitHub Release with hand-written notes, and the `npm pack` tarball (plus its
SHA-256) attached as the release artifact. There is no npm publish (`package.json` is
`private`); users install from this repository through `.claude-plugin/marketplace.json`.

## 0. Before the release branch is bumped

- Draft PR against `main` is the work item (issues are disabled); claim it with `agent-work claim --target <PR url>`.
- The adversarial gate is closed per `docs/agent/process.md` (stop rule): every parked finding is listed in the spec `## Limits` section and in the CHANGELOG "Known limitations" bullets.
- Spec and plan revision tables are current; the CHANGELOG section for the new version exists.
- `npm audit --omit=dev` reports 0 vulnerabilities. (The CI matrix must be green on the final release commit — the SHA that step 3 tags — which only exists after steps 1–2; record that run id and `rc` in the ledger.)

## 1. Prepare the release branch

```bash
git checkout -b release/vX.Y.Z main
npm run bump-version -- X.Y.Z      # package.json, plugin.json, marketplace.json
npm run check-version              # all version metadata matches
```

Add a `## X.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md`.

## 2. Gate (local, then CI)

```bash
npm run build && npm run check-version && claude plugin validate . --strict
npm test; sleep 10; pgrep -f codex-plugin-test- | wc -l   # must print 0
npm audit --omit=dev
```

Open a pull request against `main`; `Pull Request CI` must be green. Merge with a merge
commit (`gh pr merge N --merge`).

## 3. Tag and build the artifact

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
npm pack                                             # cbepx-codex-plugin-cc-X.Y.Z.tgz
shasum -a 256 cbepx-codex-plugin-cc-X.Y.Z.tgz > cbepx-codex-plugin-cc-X.Y.Z.tgz.sha256
```

## 4. Publish the GitHub Release

```bash
gh release create vX.Y.Z \
  --title "codex-plugin-cc vX.Y.Z" \
  --notes-file notes.md \
  cbepx-codex-plugin-cc-X.Y.Z.tgz cbepx-codex-plugin-cc-X.Y.Z.tgz.sha256
```

`notes.md` template:

```markdown
One-line summary of the release.

### Highlights
- …

### Compatibility
- CLI / hook / state-format changes callers must know about (omit if none).

### Validation
- Exact tag target: `<full sha>`
- Local gate: N/N tests, 0 leaked test processes, `npm run build`, `npm run check-version`, `claude plugin validate . --strict`
- GitHub CI: <run link>
- Review: Codex adversarial review (verdict), Claude review (verdict)
- Runtime dependency audit: `npm audit --omit=dev` reports 0 vulnerabilities

### Artifact
`<sha256>  cbepx-codex-plugin-cc-X.Y.Z.tgz`
```

Publishing the release triggers `.github/workflows/release-verify.yml`, which re-runs the
gate on the tag (tests, leak check, build, version check, audit, pack dry run).

## 5. Update local installs

```bash
claude plugin marketplace update cbepx && claude plugin update codex@cbepx
```

## 6. After the release

- Update the local installs (step 5) in every Claude config directory (`CLAUDE_CONFIG_DIR=~/.claude …` for the primary one), restart the session, then smoke the installed plugin: `/codex:status`, `/codex:rescue --effort low Strictly read-only: reply PONG` (sync and `--background`), `/codex:review --background` → `/codex:result`. Record smoke-review findings in the ledger as inputs for the next release.
- Archive the SDD directory: everything under `.superpowers/sdd/<plan>/` except `*.diff` and `*.log` goes to `docs/superpowers/reports/vX.Y.Z/` (`progress.md` becomes `sdd-ledger.md`; adversarial passes under `adversarial/`); replace private paths (`/Users/<name>/…` → `<repo>/`) before committing.
- Upstream comments: draft into `docs/superpowers/triage/upstream-comments-vX.Y.Z.md`, post only after the user's approval (one comment per issue), then mark the file as posted.
- `agent-work release --stopped --gate "<release summary>"`; remove the release worktree.
