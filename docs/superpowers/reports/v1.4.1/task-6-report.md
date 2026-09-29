# Task 6 report
- README.md: Windows section rewritten (v1.4.1 kill path, limits, requirements, file-based lookup instead of where.exe, CR/LF and %VAR:a=b% ceilings); identity-unavailable row mentions CLM/AppLocker; kill-failed row/table indent kept.
- CHANGELOG.md + plugins/codex/CHANGELOG.md: new 1.4.1 section (Fixed/Changed/Internal), byte-identical.
- Triage: #336, #416, #423, #487, #577, #718, #743 (win32) -> fixed-in v1.4.1; #70 left planned/verify.
- tests/commands.test.mjs: no assertion pinned old wording; unchanged.
- check-changelog: "Changelog OK: CHANGELOG.md has a non-empty section for 1.4.0 and matches plugins/codex/CHANGELOG.md."
- Gate: npm run check exit 0 (399 tests, 391 pass, 0 fail, 8 skipped), then leak check and commit.
- Self-review: facts taken from the brief; #743 row status now fixed-in v1.4.1 with note that posix half was v1.3.0.

## Fix round 1
F1 #70 -> verify (row + group); F2 record kept/re-judged vs survivor process never retried; F3 CLM: SessionEnd keeps records, cancel interrupts and leaves job running; F4 #743 note "posix half in 1.3.0, win32 half in 1.4.1". commands.test 23 pass; check-changelog OK.
