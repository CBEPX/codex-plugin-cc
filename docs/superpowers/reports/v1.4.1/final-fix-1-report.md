# final-fix-1 report (commit 7e68046)
Gate: npm run check + 10 s + leak pgrep = 0, exit 0; 398 pass / 0 fail / 10 skipped (win32-only).
- I1: kill script, cimTree, check-leaks use `Get-CimInstance -ClassName Win32_Process -Property ...`; check-leaks adds CommandLine, cimTree uses Name (it classifies on Name, not CreationDate). Script-text test asserts projection and no CommandLine. Spec 3.4 step 3 reworded.
- I2: win32 batch probe memo (2 s TTL, null included, failed batch not stored, injectable `now`, exported resetWin32ProbeMemo used in tests). Tests: TTL hit/miss for identity and null. README sentence added (in the Requirements/PATH area of "### Windows"). Evidence: the cold-start test broke until it reset the memo (indirect RED).
- M3: option 2. check-leaks isDirectRun uses realpathSync with try/catch like the hook; workflows untouched (both steps use `shell: bash`, so pipefail applies).
- M4: refused presumed from broker/exclude before the try, ANDed with pid after resolve (throw path still keeps the job; pid-less job drops as no-pid). RED: new hook test failed, then pass 6.
- M6: spec 4 and plan (lines 662, 1632, not ~54) now 245 / verified exclude pairs; process.test message 245; spec 6 fourth posix difference (kept=).
- M7: two live win32 tests (241 process-missing, 242 identity-mismatch), skip on non-win.
- M8: cancelDecision adds rootAlive on pending results; renderCancelPending root-exited text; tests extended.
- M9: runCommand comment.
Concerns: plan lines 606/634 still show `$code = 244` (historical block, not edited); CHANGELOG 1.4.1 not updated for the memo; RED-first only for M4.
