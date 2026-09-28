# Task 2 report: CI hardening; wider broker busy-retry

Commit: `4f78a80` — "ci: one run per SHA, quality job on node 24, wider broker busy-retry"

## Step 1 — `pull-request-ci.yml`

- Triggers narrowed to `pull_request`, `push: { branches: [main] }`, `workflow_dispatch` (no inputs). Release branches are now checked by manual dispatch instead of an automatic push trigger, so a SHA that becomes both a push and (later) a PR head no longer runs CI twice.
- Added `concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` at the workflow level.
- Matrix `ci` job unchanged in shape (3×3 `{ubuntu, macos, windows} × {18, 22, 24}`, Windows `continue-on-error` kept, test-log artifact, POSIX-only leak check, `npm run build`).
- Fixed the test-summary extraction: `rg -e 'ℹ (tests|pass|fail)' -e '^# (tests|pass|fail)' -e '^not ok' -e '^✖'` (with the existing `grep -E` fallback for shells without `rg`), so both the TAP reporter and the spec reporter Node 24 prints land in `$GITHUB_STEP_SUMMARY`.
- Added a `quality` job (`ubuntu-latest`, node 24): `npm ci`, `Install Codex CLI` (needed because `npm run build`'s `prebuild` shells out to `codex app-server generate-ts`), `npm run build`, `npm run check-version`. Lint/typecheck/changelog/coverage are explicitly left for Task 3 (comment in the job).

## Step 3 — `release-verify.yml`

Restructured from a single `verify` job into the same shape as `pull-request-ci.yml`:
- `ci` job: same 3×3 matrix, same steps (including the fixed summary `rg` patterns), Windows `continue-on-error` kept for now.
- `quality` job: `npm ci`, `Install Codex CLI`, `npm run check-version` (against the release ref/tag), `npm run build`, `npm audit --omit=dev`, and `npm pack --dry-run` followed by `rm -f ./*.tgz` (defensive — `--dry-run` shouldn't write a tarball, but nothing is left behind if it ever does).
- Both jobs check out `${{ github.event.release.tag_name || inputs.ref || github.ref_name }}`, matching the original single-job behavior.
- Triggers (`release: published`, `workflow_dispatch` with `ref` input) and top-level `permissions: contents: read` unchanged; no concurrency group added here (not requested for this trigger set).

## Step 2 — Broker busy-retry widening

- `plugins/codex/scripts/session-lifecycle-hook.mjs`: `BROKER_BUSY_RETRY_MS` 1000 → 3000. The invariant ("teardown only after the broker confirmed idle") is unchanged — this only widens how long a `busy` answer is retried before the hook gives up and leaves the broker running.
- Updated the `SESSION_END_BUDGET_MS` comment to state the current nominal step bounds: state lock 5 s, each broker handshake 5 s, busy retries 3 s, teardown probe ≤2 s — all still clamped by `stepBudget`/`remainingMs()` inside the 12 s ceiling.
- `tests/commands.test.mjs` was checked: its one relevant assertion (`the SessionEnd hook timeout stays above the hook's own budget`) only compares `hooks.json`'s 15 s timeout against `SESSION_END_BUDGET_MS` (still 12000, unchanged) — nothing there pins the retry constant, so no edit was needed.

## Broker log line + flaky test fix

- `plugins/codex/scripts/app-server-broker.mjs`: the broker had no log output on client socket `close`. Added one line in the existing `socket.on("close", ...)` handler: `` `[broker] client disconnected (${sockets.size} remaining)\n` `` written to `process.stderr` (which the broker's spawner already redirects to its `logFile`).
- `tests/broker-stale-pid.test.mjs` — "session end reaps a SIGKILLed background worker instead of keeping its broker alive": after the existing `waitUntil(() => !isAlive(running.pid))`, the test now waits for a **new** `"client disconnected"` line in `broker.logFile` before invoking the SessionEnd hook. Important correction made after an advisor review: a naive `log.includes("client disconnected")` would have been a no-op, since the broker's own readiness probe (`ensureBrokerSession` → `waitForBrokerEndpoint`, which connects and immediately half-closes) already writes that line earlier in the test, before the SIGKILL. Fixed by snapshotting the disconnect *count* before the kill and waiting for the count to increase. No fixed `sleep` is used anywhere in the fix.

## Gate

- `npm test > /tmp/npm-test-t2.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-t2.log; test "$st" -eq 0` → `tests 314`, `pass 314`, `fail 0`, exit 0.
- `sleep 10; pgrep -f codex-plugin-test- | wc -l` → `0`.
- `npm run build` → clean (prebuild codegen + `tsc -p tsconfig.app-server.json`, no errors).
- Focused runs (`--test-name-pattern "SIGKILLed|SessionEnd hook timeout"`), 4× in a row after the count-based fix: all green, no flakiness observed (~1.3 s per SIGKILL test run).
- `npm run check-version` run locally: passes (compares `package.json` version against in-repo metadata, not against a git tag, so it is safe to run on every PR/push, not just releases).
- YAML validated by eye only — `js-yaml` is not installed in this repo and the task forbids adding new deps; relying on the controller's CI run to confirm workflow syntax.

## Self-review checklist (from the brief)

- Workflow triggers dedupe a SHA: yes — push is `main`-only now, release branches go through `workflow_dispatch`, no double-trigger path remains.
- Concurrency group set: yes, on `pull-request-ci.yml` exactly as specified.
- Windows still `continue-on-error`: yes, in both workflows, unchanged.
- Summary extraction covers TAP and spec reporters: yes, `rg` patterns for `ℹ (tests|pass|fail)`, `^# (tests|pass|fail)`, `^not ok`, `^✖`.
- Retry constant change documented in the code comment: yes, `SESSION_END_BUDGET_MS` comment updated with the 3 s / ≤2 s figures.
- The broker test waits on an observable event, not a sleep: yes, and the observable check is a strict "count increased" comparison (not merely "line present"), which is the correct fix — a plain presence check would have been satisfied by an earlier, unrelated disconnect from the broker's own readiness probe.

## Files touched

- `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.0/.github/workflows/pull-request-ci.yml`
- `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.0/.github/workflows/release-verify.yml`
- `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.0/plugins/codex/scripts/session-lifecycle-hook.mjs`
- `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.0/plugins/codex/scripts/app-server-broker.mjs`
- `/Users/g.mehrenin/project/personal/codex-plugin-cc/.worktrees/release-v1.4.0/tests/broker-stale-pid.test.mjs`
- `tests/commands.test.mjs` — checked, no change needed (no test pins the retry constant).

## Concerns / follow-ups for the controller

- The `quality` job's `npm run build` needs the Codex CLI on PATH (its `prebuild` script shells out to `codex app-server generate-ts`); an `Install Codex CLI` step was added to both `quality` jobs even though it wasn't explicitly listed in the ruling's 3-command description — omitting it would have made `quality` fail in CI on a clean runner.
- `release-verify.yml`'s `quality` job orders `check-version` before `build` (mirroring the original single-job ordering) rather than `build` before `check-version` as listed in the ruling; this is a cosmetic ordering difference only, both steps are independent and idempotent.
- `continue-on-error` for Windows remains in both workflows per this task's scope; it is scheduled for removal in Task 9 after Tasks 4–6 land.
