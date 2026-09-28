# Task 9 report — README updates and 1.4.0 CHANGELOG

Commit: `a8bf858` `docs: Windows support notes and 1.4.0 changelog` on `release/v1.4.0` (base 451a33a). Not pushed.

## What changed

### README.md
- Removed `<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>` (no wrapper existed; collapsed the surrounding blank line so a single blank line remains before `## What You Get`). The referenced file `docs/plugin-demo.webm` was left in place (not asked to delete it).
- Rewrote `### Windows` (previously two paragraphs from v1.3.0/Task 5/Task 7) into four paragraphs, merging rather than duplicating what Tasks 4–8 already added:
  1. Spawn: no longer through `$SHELL` on Windows; `where.exe` resolution, `.exe` direct, `.cmd`/`.bat` via `cmd.exe` — this is the spawn path behind the commands, `/codex:review`, `/codex:adversarial-review` and background `task`/`--await` jobs. Separately, the `Stop`/`SessionStart`/`SessionEnd` hooks now read stdin with a bounded deadline instead of a blocking read. `/codex:transfer`'s own Windows-specific issues are called out as unrelated to this change and not fixed in v1.4.0 (see "could not confirm" below).
  2. "Still limited until v1.4.1": kills from stored records refuse with `identity-unavailable`; corrected the stale v1.3.0 claim that identity was landing "in v1.4.0" to v1.4.1.
  3. Requirements: `where.exe`/`cmd.exe` are in-box, PowerShell not required in v1.4.0, `codex`/`npm` must be on `PATH` as `.cmd`/`.exe`, Git Bash aliases no longer found.
  4. Kept Task 7's `%LOCALAPPDATA%\codex-companion` fallback-root paragraph verbatim (not duplicated), and folded the bounded-EPERM-retry detail (20 attempts, ~300 ms worst case) into its existing closing sentence rather than adding a new paragraph.
- Verified against `tests/commands.test.mjs`: no assertion pins any Windows-section wording (only hooks.json/setup.md/rescue.md/install-command/exit-code assertions), so the rewrite was unconstrained there. Ran the full `rg -n 'README.md'` sweep across `tests/*.test.mjs` first — all other hits are unrelated fixture writes in temp repos.
- Left the `### Development` section (Task 3) untouched — not stale.

### CHANGELOG.md (+ `plugins/codex/CHANGELOG.md`, byte-identical copy)
Added `## 1.4.0 — 2026-09-28` at the top, same heading/subsection style as `## 1.3.0`. Verbatim:

```
## 1.4.0 — 2026-09-28

### Fixed
- Windows: commands are no longer spawned through `$SHELL` (usually Git Bash under Claude Code, which mangled `taskkill /PID /T /F` and other arguments); executables are resolved with `where.exe`, `.exe`/`.com` files run directly, and `.cmd`/`.bat` shims (including a global `npm install -g @openai/codex`) run through `cmd.exe` with every argument escaped for both `cmd /c` and the shim's own `%*` re-parse (#525, #647, #656, #669, #708, #287, #409, #735).
- Windows: the broker and app-server child processes no longer flash a visible console window on spawn (`windowsHide: true`) (#440, #451).
- The `Stop`, `SessionStart` and `SessionEnd` hooks read stdin with a bounded deadline (2 s / 5 s / 1 s respectively) and a 1 MiB limit instead of a blocking `readFileSync(0)`; a disabled Stop review gate no longer hangs until the 900 s hook timeout when stdin never arrives, and the companion no longer crashes with `EAGAIN` reading a non-blocking stdin under concurrent sessions (#530, #544, #120, #247, #123, #150, #165).
- `--args-stdin` (and `$ARGUMENTS`) no longer eats a backslash that does not escape a quote, another backslash or whitespace, so Windows paths such as `C:\Users\me\project\file.mjs` survive; `\\server\share` is a documented limitation, and `--prompt-stdin` remains available for byte-exact text.
- Windows: reads and writes of `state.json` and lock tickets retry briefly (bounded, roughly 300 ms worst case) on `EPERM`/`EBUSY`/`EACCES` instead of failing outright when another process holds the file open.

### Added
- `SECURITY.md` (supported versions, GitHub Security Advisories reporting) (#326).
- Node 24 development tooling: ESLint, a `typecheck:tests` script over `tests/**` and `scripts/**` (`checkJs` is off for now — turning it on surfaced 54 pre-existing findings, deferred), `c8` coverage (`npm run test:coverage`, thresholds in `.c8rc.json`), Stryker mutation testing over the critical `args.mjs`/`model-catalog.mjs` pair (`npm run test:mutation:critical`), a `check:changelog` gate that keeps `CHANGELOG.md` and `plugins/codex/CHANGELOG.md` byte-identical, Dependabot, and `npm run setup:git-hooks` (pre-commit lint + typecheck).
- CI: one workflow run per SHA (push limited to `main`, release branches checked via manual `workflow_dispatch`, with a `concurrency` group cancelling superseded runs) and a new `quality` job on Node 24 alongside the existing OS × Node matrix.

### Changed
- The per-user fallback state root used when `CLAUDE_PLUGIN_DATA` is unset is now `%LOCALAPPDATA%\codex-companion` on Windows. A pre-1.4.0 root under `%TEMP%\codex-companion-user` keeps being used, with a one-line stderr notice, until it is removed by hand — nothing is migrated automatically. This transitional notice only applies to an unversioned/dev checkout: a marketplace install's state-root hash is derived from `CLAUDE_PLUGIN_ROOT`, which already includes the plugin version in the marketplace cache, so a normal upgrade never sees the legacy root.
- `BROKER_BUSY_RETRY_MS` widened from 1000 to 3000 ms; the "teardown only after the broker confirmed idle" invariant is unchanged.
- Deferred v1.3.0 review minors folded in: `CODEX_REVIEW_GATE_MAX_ROUNDS` rejects a non-integer, negative or otherwise malformed value (falls back to 3 with a warning) instead of misreading it; `setup --review-gate-model ""` / `--review-gate-effort ""` now fails with `--<flag> needs a value; use inherit to clear it.` instead of writing anything; a job id used to build the `workerCommandLine` match is now regex-escaped; the `kill-failed` broker-teardown reason is documented in the README's reason table. Also added (test coverage only, no behavior change): a catalogue-only model alias resolving correctly on a priority tie, and the fallback-root refusal covering a non-standard directory mode.

### Known limitations
- Kills issued from stored process records (`/codex:cancel`, `SessionEnd` cleanup, stale-broker replacement, broker teardown) are still refused on Windows (`identity-unavailable`); process identity verification is now targeted for v1.4.1, not v1.4.0 as previously stated. This bounds any leak by the broker idle timeout, and the turn interrupt is still sent regardless.

Ported with reference to upstream PRs by mohammad-malik, mittalpk, stantheman0128, tmchow, D2758695161, ikbear, e345ee, tanakauo.
```

The 1.3.0 section (including its own now-stale "until process identity lands in v1.4.0" bullet) was left untouched — history isn't rewritten; the 1.4.0 "Known limitations" entry states the corrected fact instead.

`cp CHANGELOG.md plugins/codex/CHANGELOG.md` run; `diff` confirms byte-identical.

## Gate (verbatim; full log at `task-9-gate.log` next to this report)

```
> @cbepx/codex-plugin-cc@1.3.0 check-version
> node scripts/bump-version.mjs --check
All version metadata matches 1.3.0.

> @cbepx/codex-plugin-cc@1.3.0 check:changelog
> node scripts/check-changelog.mjs
Changelog OK: CHANGELOG.md has a non-empty section for 1.3.0 and matches plugins/codex/CHANGELOG.md.

[... lint / build / typecheck:tests / test ...]

ℹ tests 356
ℹ suites 0
ℹ pass 355
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 188438.894459
exit=0
```
`sleep 10; pgrep -f codex-plugin-test- | wc -l` → `0`.

First gate run (before the advisor-flagged corrections below) was also exit 0 with the same test counts — the corrections were wording-only, no code touched, so the numbers didn't move.

## Commit

`git add README.md CHANGELOG.md plugins/codex/CHANGELOG.md` (exactly these three; `git status --short` showed nothing else). Message:
```
docs: Windows support notes and 1.4.0 changelog

README: drop the demo video element; rewrite the Windows section to
reflect v1.4.0 as shipped (spawn no longer goes through $SHELL, bounded
hook stdin, %LOCALAPPDATA% fallback root and its transitional notice,
bounded EPERM/EBUSY/EACCES retries) and correct the stale "identity
lands in v1.4.0" claim to v1.4.1.

CHANGELOG: add the 1.4.0 section (Added/Changed/Fixed/Known
limitations) and copy it to plugins/codex/CHANGELOG.md.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
Used the brief's `Claude Fable 5.1` trailer rather than the harness's suggested `Claude Sonnet 5`, matching Tasks 4–8 (Task 3 is the one deviation, noted in its own report). SHA `a8bf858`. Not pushed.

## Self-caught corrections (advisor review, before commit)

A first draft overclaimed and mis-cited some things; fixed before the gate/commit above:
- README Windows §1 originally said "`/codex:transfer` … all of them work on Windows now" and implied hooks spawn through `where.exe`. Rewrote to separate the spawn fix (review/adversarial-review/task) from the hook-stdin fix (Stop/SessionStart/SessionEnd), and to flag transfer's own Windows issues as unrelated/unfixed rather than claiming they work.
- CHANGELOG's "deferred v1.3.0 minors" bullet originally claimed the `gpt-7-nova` priority-tie alias and the 0o755/foreign-uid refusal were "fixed" — Task 8's own RED-evidence table shows both were test-coverage additions with no failing baseline (no source hunk). Reworded to state only the real product changes (MAX_ROUNDS validation, empty `--review-gate-model`/`--review-gate-effort` rejection, `workerCommandLine` escaping, `kill-failed` documented) and labelled the two coverage-only items as such.
- "TypeScript typecheck pass over `tests/**`" corrected to name the actual script (`typecheck:tests`) and note `checkJs` is off (54 pre-existing findings deferred, per Task 3).
- Expanded the "Ported with reference to" line beyond the two commits' `Co-authored-by` trailers (mohammad-malik, mittalpk, stantheman0128, tmchow) to include the triage doc's credited PR authors for the other cited numbers that are PRs, not bare issues (D2758695161 #150, ikbear #165, e345ee #451, tanakauo #326).

## Could not confirm from the reports (flagging for the controller / Task 10)

- **`/codex:transfer`**: the brief's Russian line lists "transfer" among what works in v1.4.0. No Task 1–8 report touches transfer, and `docs/superpowers/triage/2026-09-27-upstream-triage.md` marks transfer's own Windows bugs (#514, #618, #701 — verbatim `\\?\` paths, ledger lookup) as "planned v1.5.0". I sided with the triage doc and wrote that transfer's Windows issues are untouched by this release rather than claiming transfer "works" on Windows — please confirm this is the intended framing, or tell me to drop the transfer sentence entirely.
- **#326 (SECURITY.md) and its credited author (tanakauo)**: no Task 1–8 report cites the issue number directly; Task 3's report just says "SECURITY.md" was added. I included #326 because the brief lists it unconditionally (not "if the reports mention it," which only qualified #326 explicitly) and the triage doc confirms #326 is exactly "Create SECURITY.md for security policy."
- No task report documents an actual green Windows CI run for the Task 4–7 fixes (Task 5/7 both say "only CI can verify"); the CHANGELOG states these as shipped per the brief's own framing ("what shipped"), consistent with Tasks 4–7's own reports treating their local (macOS/POSIX) gates as sufficient to commit.
- Deliberately omitted from the CHANGELOG: the "leak step" (Task 2's report says the leak check was pre-existing and POSIX-only, unchanged) and Task 1's Windows test-harness work (test-only, no product-facing behavior).
