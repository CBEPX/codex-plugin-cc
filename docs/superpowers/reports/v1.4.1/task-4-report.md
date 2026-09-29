# Task 4 report

Commit: ba4cbc0 feat(process): Windows kill from a stored record pins the process, verifies its start time and terminates the verified tree (pushed to origin/release/v1.4.1).

Implemented (process.mjs): win32 branch in terminateRecordedProcess -> terminateWindowsRecordedProcess; exports fileTimeAt, terminateScript (brief script verbatim, digit-only substitutions); mapping per brief precedence table. posix and terminateProcessTree untouched. broker-lifecycle.mjs comments/enum (+process-missing) and README reasons table updated. tests/runtime.test.mjs untouched.

TDD: RED - new test failed at first case (AssertionError "exit 0 / KILL\r\nOK\r\n") before implementation; GREEN - passes after. Lint fix: regex `\n  foreach` -> `\n {2}foreach` (no-regex-spaces), same match.
Gate: `npm run check && sleep 10 && pgrep... && git add && commit && push` exit 0; 377 tests, 375 pass, 0 fail, 2 skipped.

Concerns: none. process.mjs grew ~147 lines (mostly the script literal). Windows CI is not run locally; expected runtime failures until Task 5.

## Fix round 1 (commit d106b42)

- F1: `excludePids` replaced by `exclude: [{pid, identity}]` (win32 identities only); script `$exclude = @{ pid = 'filetime' }` (empty `@{}`); CommandLine/marker line and CommandLine projection removed; exclusion checked after pin and `$live`, by exact FILETIME.
- F2: 241/242 with any stdout -> identity-unavailable (no method).
- F3: SURVIVOR pids must be valid and unique, else unverified.
- F4: `WINDOWS_KILL_ABORTED_EXIT = 245` (budget shortfall, child pin errors; `$code` initialised 245; 244 only for CLM guard), never trips breaker; `runPowerShell` option `tripOnTimeout` (kill passes false).
- F5: README kill-failed row re-indented. F6: unreachable win32 branch in `refusal` removed.
- Tests: extended mapping test plus new "empty exclusion / breaker" test; `node --import ./tests/test-env.mjs --test tests/process.test.mjs` 40 pass 0 fail. Gate exit 0, pushed.
