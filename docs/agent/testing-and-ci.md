# Testing and CI

## Gate and commit

`npm run check` (check-version, check:changelog, lint, build, typecheck:tests, tests) → exit 0; then `sleep 10; [ "$(pgrep -f codex-plugin-test- | wc -l)" = 0 ]`. Commit only through an `&&` chain on these exit codes; never through `;` or a log match (v1.4.0 shipped two commits with a red gate that way). `claude plugin validate . --strict` before a release commit.

## Timing tests on slow hosted runners

GitHub Windows runners run 2–3× slower for hours at a time (the same test: 6.6 s vs 33 s on identical code). Rules: no absolute `< N ms` assertion under 10 s; waiting windows are relative to the fixture parameter (`< fakeTurnMs`); `waitFor` defaults to 30 s; the broker idle timeout in tests that pause between commands is ≥ 15 s; every test with an open stdin or a child process sets `{ timeout }` and a `t.after` that SIGKILLs. A single red Windows or macOS job: rerun first (`gh run rerun --failed`) and compare durations; bisect only on a reproduction.

## Evidence in tests

A failing assertion on a job's outcome prints the stored record and the job-log tail (read only on failure, like the broker-log tail in `tests/broker-stale-pid.test.mjs`). The v1.4.1 macOS failure was solved only once the test printed them.

## Watching CI

Concurrency cancels the previous run on every push: look only at the HEAD run. Capture `gh run watch <id> --exit-status; rc=$?` in a variable, never through an `echo` chain. Job logs of a finished job in a still-running run: `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<id>/logs`.

## PowerShell on Windows (v1.4.1 lessons)

The clean child environment must pass `LOCALAPPDATA` and `PSModuleAnalysisCachePath` through (otherwise every start costs 22–33 s: a short-lived process never persists the module-analysis cache). Use `Get-CimInstance -ClassName Win32_Process -Property …` (provider-side projection; `Select-Object` still computes `CommandLine`). Enumerating `Win32_Process` on a hosted runner takes 30–50 s: the leak-step budget is ≥ 180 s. The broker never probes its own identity (it blocks its event loop while the starter waits for the endpoint). `node:readline` splits JSONL on U+2028/U+2029: read frames on `\n` only.
