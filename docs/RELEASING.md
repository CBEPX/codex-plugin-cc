# Releasing

Releases follow the same shape as [CBEPX/cc-plugin-codex](https://github.com/CBEPX/cc-plugin-codex/releases):
a git tag, a GitHub Release with hand-written notes, and the `npm pack` tarball (plus its
SHA-256) attached as the release artifact. There is no npm publish (`package.json` is
`private`); users install from this repository through `.claude-plugin/marketplace.json`.

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
