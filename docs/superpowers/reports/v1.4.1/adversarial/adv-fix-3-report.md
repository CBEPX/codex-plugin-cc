# adv-fix-3 report
Commit 93cae54 (pushed). B1 provisional record after spawn (cleared on the not-ready path); B2 memo reused only on identity match (null memo never reused; existing "nulls included" test updated); S1 SessionEnd clears only when a record was loaded; S2 workerFinished replaces interrupted (+ README/CHANGELOG); polish: no "left running" log when worker finished, identity-* dead-root text, identity-mismatch table rows.
Gate: 414 tests, 404 pass, 0 fail, 10 skipped. Concern: the S1 test passes without the fix (the old code already kept a corrupt file); it is a regression guard.
