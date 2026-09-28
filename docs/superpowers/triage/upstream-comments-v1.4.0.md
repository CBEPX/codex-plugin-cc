# Upstream comment drafts — CBEPX fork v1.4.0

Drafts only — nothing here has been posted. For the maintainer: post each section's body with

    gh issue comment <n> -R openai/codex-plugin-cc --body-file <file-with-that-section's-body>

Scope: the 9 upstream **issues** (no PRs) closed by v1.4.0, taken from the `### fixed-in 1.4.0`
bucket of the "Upstream comment queue" section of
`docs/superpowers/triage/2026-09-27-upstream-triage.md`.

Note on attribution: each "thanks" line cites the specific upstream PR the v1.4.0 CHANGELOG entry
groups with that issue's fix area, matched to its author via the CHANGELOG's closing credit line
("Ported with reference to upstream PRs by mohammad-malik, mittalpk, stantheman0128, tmchow,
D2758695161, ikbear, e345ee, tanakauo.") and the triage doc's "Authors to credit" list. Where one
PR is the clear fix for two related issues (the Windows spawn/taskkill cluster), both issues cite
it and each other, as "same root cause" where the two reports genuinely describe the same
underlying bug (#409/#708, both MSYS argument mangling under `$SHELL`) or as "fixed by the same
change" where the fix is shared but the reports describe distinct mechanisms (#287's PATHEXT
lookup vs #525's `$SHELL` wrapping) — please double-check the pairing before posting if that
matters to you.

Caveat carried into #525, #647 and #708: all three originally reported `cancel`/`SessionEnd`
failing to kill a Windows process. v1.4.0 fixes the argument-mangling bug each one named, but a
kill issued from a *stored* pid/broker record (`terminateRecordedProcess`) still refuses on
Windows — `getProcessIdentity` returns null there — so `cancel` can still leave a job showing
`running`, now because of the identity check rather than mangled `taskkill` flags. The CHANGELOG's
"Known limitations" section confirms this slipped from v1.4.0 to v1.4.1; each of those three
drafts says so explicitly rather than claiming the kill now works end to end.

## #120 — EAGAIN crash in hook scripts: readFileSync(0) fails when stdin is non-blocking

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): the `Stop`, `SessionStart` and `SessionEnd` hooks now read stdin through a new bounded reader with a per-hook deadline (2 s / 5 s / 1 s respectively) and a 1 MiB cap, instead of a blocking `readFileSync(0)`, so a non-blocking stdin file descriptor can no longer crash a hook with `EAGAIN`; upstream PR #150 used as reference, thanks @D2758695161.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #247 — codex-companion crashes with EAGAIN on concurrent sessions (readStdinIfPiped sync read)

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): `readStdinIfPiped` now retries on `EAGAIN` (a short `Atomics.wait` pause, up to 50 consecutive attempts, the counter resetting on each successful read) instead of throwing immediately, so codex-companion no longer crashes when stdin is briefly non-blocking under concurrent sessions; upstream PR #165 used as reference, thanks @ikbear.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #287 — Windows: spawn("codex") in app-server.mjs throws ENOENT (Node does not try PATHEXT for .cmd shims)

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): on Windows, a bare command name such as `codex` is now resolved with `where.exe` against `PATHEXT`, and a resolved `.cmd`/`.bat` shim (including a global `npm install -g @openai/codex`) is launched through `cmd.exe /d /s /v:off /c` with cross-spawn-style double caret escaping, instead of relying on Node's own spawn to try `PATHEXT` and throwing `ENOENT`; fixed by the same change as #525, upstream PR #669 used as reference, thanks @mittalpk.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #409 — [Windows] POSIX path conversion mangles slash-prefixed CLI args under Git Bash

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): commands are no longer spawned through `$SHELL` (Git Bash) on Windows — executables are resolved directly with `where.exe` and launched with `shell:false` — so Git Bash's MSYS path/argument conversion can no longer rewrite a slash-prefixed CLI argument before it reaches the target process; same root cause as #708, upstream PR #735 used as reference, thanks @mohammad-malik.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #440 — spawnBrokerProcess() missing windowsHide: true — leftover spawn site from #67

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): `spawnBrokerProcess()` now passes `windowsHide: true`, so the broker (and the app-server child it spawns) no longer flashes a visible console window on Windows; upstream PR #451 used as reference, thanks @e345ee.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #525 — Windows: taskkill /PID is mangled by MSYS path conversion when SHELL is set (Git Bash under Claude Code) — cancel and SessionEnd cleanup never kill the process tree

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): the argument mangling this issue reported is fixed — process spawning on Windows no longer shells out through `$SHELL`, and `taskkill.exe` is invoked directly with `shell:false`, so Git Bash's `SHELL` variable can no longer garble the `/PID`, `/T` and `/F` flags. That said, a Windows kill issued from a stored job/broker record — which is what `cancel` and `SessionEnd` cleanup do — is still refused pending process-identity verification, now targeted for v1.4.1 rather than v1.4.0; the turn interrupt is still sent regardless, and a leaked broker is bounded by its own idle timeout in the meantime. Fixed by the same change as #287, upstream PR #669 used as reference, thanks @mittalpk.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #530 — Stop hook hangs until 900s timeout on Windows even when review gate is disabled (stdin EOF never arrives)

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): the Stop hook now reads stdin with a bounded 2-second deadline and a 1 MiB cap instead of a blocking `readFileSync(0)`; when the review gate is disabled, a timed-out read with no data allows the turn immediately instead of waiting for the host's 900-second hook timeout; upstream PR #544 used as reference, thanks @stantheman0128.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #647 — Windows: SHELL env var (Git Bash) breaks taskkill; handleCancel swallows terminateProcessTree exceptions, leaving jobs stuck in running/finalizing

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): `taskkill /PID /T /F` (and every other command) is now spawned directly with `shell:false` instead of through `$SHELL` (Git Bash), so the `SHELL` variable can no longer garble its flags. That said, a Windows kill issued from a stored job/broker record — which is what `handleCancel` does — is still refused pending process-identity verification, now targeted for v1.4.1 rather than v1.4.0; the turn interrupt is still sent regardless, so a job left running this way is not silently abandoned. Upstream PR #656 used as reference, thanks @mittalpk.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #708 — Windows: `cancel` silently fails — Git Bash mangles `taskkill /PID /T /F` flags, leaving jobs stuck as `running`

Fixed in CBEPX/codex-plugin-cc v1.4.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.4.0): `taskkill.exe` is now invoked directly with `shell:false` instead of through the `SHELL` environment variable, so Git Bash can no longer mangle the `/PID /T /F` flags this issue reported. That said, `cancel` kills a job's worker from its stored pid record, and that path is still refused on Windows pending process-identity verification, now targeted for v1.4.1 rather than v1.4.0 — so a job can still be left showing `running` after `cancel`, for a different reason than before; the turn interrupt is still sent regardless. Same root cause as #409, upstream PR #735 used as reference, thanks @mohammad-malik.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

---

## Fixed earlier (v1.3.0), not announced yet

### #626 — teardownBrokerSession: unguarded pid/log unlinkSync throws EPERM on Windows

Fixed in CBEPX/codex-plugin-cc v1.3.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0): broker teardown now treats the pid-file and log-file unlink as best-effort, the same as the other cleanup steps in that function, so an EPERM on Windows no longer fails the whole job; a broker that already cleared its own record during teardown is tolerated too. Upstream PRs #650 and #666 used as reference, thanks @SomSamantray and @Hughhhhcoder.

### #633 — duplicate of #626

Same fix as #626: shipped in CBEPX/codex-plugin-cc v1.3.0 (https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0) — best-effort pid/log unlink during broker teardown. Thanks @SomSamantray (#650) and @Hughhhhcoder (#666) for the reference PRs.

