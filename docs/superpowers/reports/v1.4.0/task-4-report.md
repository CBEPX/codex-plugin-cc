# Task 4 report — `--args-stdin` keeps Windows backslashes

Commit: `7145254` fix(args): keep backslashes that escape nothing in --args-stdin text (branch release/v1.4.0, not pushed)

## What changed
- `plugins/codex/scripts/lib/args.mjs` `splitRawArgumentString`: loop is now index-based; `\` sets `escaping` only when the next char is `"`, `'`, `\` or `/\s/`; otherwise the backslash is appended literally. Quote model unchanged. Trailing `\` stays literal (the old post-loop `if (escaping)` branch is now unreachable but left untouched per "nothing more").
- `tests/args.test.mjs`: the two tests from the brief, verbatim. Before the fix both failed (2 fail / 9 pass); after, 11/11 pass.
- `README.md` line 168 (the only `--args-stdin` mention): one sentence with the escape rule, the `\\server\share` limitation and a pointer to `--prompt-stdin` for byte-exact text.
- CHANGELOG and other tests untouched.

## Gate (Node v24.14.0)
`npm run check` → exit=0
```
ℹ tests 326
ℹ suites 0
ℹ pass 326
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 170077.548833
```
`sleep 10; pgrep -f codex-plugin-test- | wc -l` → `0`

## Deviations
None.
