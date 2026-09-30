# codex-plugin-cc v1.5.0 — companion split, bounded read views, review surface

Date: 2026-09-30 (rev. 4, 2026-09-30)

## Goal

v1.5.0 ships four scopes on `main` 0fa5e8d (v1.4.3):

- **S0** two housekeeping fixes (AGENTS.md install rule, a Windows fixture race).
- **S1** stage B split of `plugins/codex/scripts/codex-companion.mjs` (1496 lines at HEAD) with no runtime change.
- **S2** bounded `status`/`result` output (port of cc-plugin-codex v1.7.5 `read-views`, adapted).
- **S3** the review surface: #615 `--background`, #522 focus on `/codex:review`, #714 verbatim focus, #653 base validation, #529 persisted threads, #405 prompt caps, #583 fenced JSON, #679 built-in `--json` shape.

Success means all of the following:
- `status --json` of a workspace whose index holds a 53.7 KB prompt prints ≤ 8192 bytes of valid JSON (controller's measurement: 53.7 KB of a 99 KB `state.json`).
- `review --background` returns `queued` in under a second of work and finishes in a detached worker that `/codex:cancel` handles by the v1.4.2 rules.
- `/codex:review focus on auth` runs the adversarial reviewer.
- `--base nope` exits 1 before any job record or `codex` start.
- posix and windows-latest CI green, leak check 0.

## Trust boundary

- **`--output <new-path>` (new, user-supplied).**
  - Relative paths resolve against the command cwd (`--cwd`, else the process cwd), like `--prompt-file` (`codex-companion.mjs:852`).
  - Created with `openSync(path, "wx", 0o600)`. `O_CREAT|O_EXCL` never overwrites and never follows a symlink: an existing file, directory or symlink (dangling too) gives `EEXIST`.
  - On a write failure the file is removed only if `lstat` still shows the `dev`/`ino` the create returned.
  - The file holds exactly what the command's `--json` printed before 1.5.0. That is no new exposure: the same user already reads it on stdout. It includes `request` with its config values redacted.
  - Win32: the mode is ignored (the file inherits the directory ACL); `wx` stays exclusive.
- **Review request file.** A background review uses the existing 0600 `jobs/<id>.request.json`, written by `writeJobRequestFile` and deleted by `consumeJobRequestFile` (both defined at `state.mjs:879-900`), and removed on cancel (`job-control.mjs:342`) and by the reaper and the terminal write (`tracked-jobs.mjs:274/306/351`). `--config` values live only there. The record carries `request` with `redactConfigValues` applied, exactly as task does (`codex-companion.mjs:909`).
- **No new spawn path.** The review worker is the existing `spawnDetachedTaskWorker` (`codex-companion.mjs:878-888`): `process.execPath` with the absolute companion path, `task-worker --cwd <cwd> --job-id <id>`, `detached`, `windowsHide`. The `--base` check uses the existing `git()` helper (`lib/git.mjs:12`, `shell: false`). One spawn option changes: the detached worker's stdout and stderr are appended to the job's existing log file instead of being discarded (see Worker diagnostics); the executable, argv, `shell`, `detached`, `windowsHide` and the log's path and mode are unchanged. `docs/agent/windows-threat-model.md` is walked point by point in that task.
- **Refs starting with `-` are refused.** `parseArgs` accepts `--base -x` as a value (`lib/args.mjs:44-58`), and today that reaches `git merge-base HEAD -x` (pre-existing option injection). #653 refuses it with the same "not found" error.
- **Focus text** is user prompt text as before. It arrives through the quoted heredoc on stdin (never a shell) and is now passed on verbatim.
- **Heredoc delimiter.** Every command file passes `$ARGUMENTS` through a quoted heredoc whose delimiter is `CODEX_ARGS_` + 8 fresh random hex characters that do not appear as an exact line in the arguments (rescue already uses `CODEX_PROMPT_<random>`). An argument line equal to a fixed delimiter would end the heredoc early and run the rest on the host shell; the fixed `CODEX_ARGS` has been there since `--args-stdin` was added, and verbatim multi-line focus makes it reachable. The rule covers all seven command files, not only the review ones.
- **Untracked symlinks are never followed.** The review context names an untracked symlink as `(skipped: symlink)` and reads nothing through it, so a link to a file outside the repository cannot put that file into the prompt (the sister's rule).

## Design

### 3.0 S0 housekeeping

**(a) AGENTS.md.** The install rule is rewritten. It says:
- the `cbepx` marketplace is a directory source, so `/codex:*` runs the main checkout's `plugins/codex/`;
- plugin code is never edited on `main`, only in worktrees;
- after a release, run `claude plugin marketplace update cbepx && claude plugin update codex@cbepx` in every config dir (this refreshes the recorded cache copy), then restart.

AGENTS.md stays at 29 lines (`docs-contracts.test.mjs` caps it at 50).

**(b) Windows fixture race.** `deadPid()` already waits until `isPidAlive` says the pid is gone (`tests/helpers.mjs:107-122`). The v1.4.3 failure (`reports/v1.4.3/sdd-ledger.md:28`) is pid reuse across the nine rows of `tests/session-lifecycle-hook.test.mjs` that share one pid.
- `cleanupSessionJobs` gets `isPidAliveImpl = isPidAlive` in its `deps` (destructure at `session-lifecycle-hook.mjs:106`, used at `:192`).
- The table test passes `isPidAliveImpl: () => false`.
- Other tests' outcomes do not depend on liveness.

**(c) Broker idle-timeout test.** CI 36700963516 (a3d9015, windows-latest/node 18) failed `broker stays alive while a client is connected…` with the broker exited 0 inside the 900 ms hold. The readiness probe's close re-arms the 300 ms idle timer, so the broker must register the test's client within 300 ms of it; the cause is inferred from the code, the run captured no broker log. The test now uses a 2000 ms idle timeout, holds for 1.5× of it, and prints the broker's stderr when the assertion fails.

### 3.1 S1 split (no runtime change)

**`lib/cli.mjs`**
- Path constants, computed once: `ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))` (one level deeper than today's `".."`), `COMPANION_SCRIPT`, `REVIEW_SCHEMA`.
- `VALID_REASONING_EFFORTS`, `ARGS_STDIN_FLAG`, `PROMPT_STDIN_FLAG`.
- The mutable `argvTokenizedFromStdin`, together with `applyArgsStdin` and `normalizeArgv`.
- `parseCommandInput`, `printUsage`, `maybePrintCommandHelp`, `resolveCommandCwd`, `resolveCommandWorkspace`, `outputResult`, `outputCommandResult`, `parseTimeoutOption`, `parseConfigOverrides`, `normalizeRequestedModel`, `normalizeReasoningEffort`.

**`commands/shared.mjs`** (used by ≥ 2 families)
- The four `DEFAULT_*_MS` constants, `sleep`, `firstMeaningfulLine`, `ensureCodexAvailable`.
- `waitForSingleJobSnapshot`, `buildResumeWaitCommand`, `outputActiveJobHint`, `waitForTerminalJobOrHint`, `outputJobResult`.
- `getJobKindLabel`, `createCompanionJob`, `createTrackedProgress`, `runForegroundCommand`.
- `spawnDetachedTaskWorker`, `enqueueBackgroundTask` → renamed `enqueueBackgroundJob`, `renderQueuedTaskLaunch` → renamed `renderQueuedLaunch`.
- `handleTaskWorker(argv, runners)`. In S1 `main` passes `{ task: executeTaskRun }`.

**The command modules**
- `commands/setup.mjs`: `buildSetupReport`, `handleSetup`.
- `commands/review.mjs`: `buildAdversarialReviewPrompt`, `buildNativeReviewTarget`, `validateNativeReviewRequest`, `executeReviewRun`, `buildReviewJobMetadata`, `handleReviewCommand`, `handleReview`.
- `commands/task.mjs` (exports `executeTaskRun` for the entry's `runners`): `STOP_REVIEW_TASK_MARKER`, `findLatestResumableTaskJob`, `resolveLatestTrackedTaskThread`, `executeTaskRun`, `buildTaskRunMetadata`, `buildTaskJob`, `buildTaskRequest`, `readTaskPrompt`, `requireTaskRequest`, `handleTask`, `handleTaskResumeCandidate`.
- `commands/status.mjs`: `handleStatus`, `handleResult` (the one-line `renderStatusPayload` is inlined).
- `commands/cancel.mjs`: `handleCancel`, `waitForTerminalRecord`, `WIN32_CANCEL_KILL_MS`, `finishCancel`.
- `commands/transfer.mjs`: `renderTransferResult`, `executeTransfer`, `handleTransfer`.

**`codex-companion.mjs`** keeps only the shebang, the imports, `main` (the dispatch switch, including `help`, `task-worker` and `task-resume-candidate`) and the catch (message to stderr, exit 1). About 70 lines.

**Invariants**
- The entry path and name are unchanged. Three things match on them: the reaper (`tracked-jobs.mjs:557`), the worker command line (`process.mjs:449`) and the stop gate (`stop-review-gate-hook.mjs:138`), plus the commands/*.md files, skills and `tests/helpers.mjs` `SCRIPT`.
- Worker argv is unchanged.
- The rename of `enqueueBackgroundTask` also reaches the comment at `lib/tracked-jobs.mjs:385`.
- `--help` output is byte-identical.
- Module rules: `commands/*` imports only `../lib/**` and `./shared.mjs`; `shared.mjs` imports only `../lib/**`; the entry imports only `./lib/cli.mjs` and `./commands/*` (`shared.mjs` included: `handleTaskWorker` lives there).
- "`lib/**` never imports `commands/**`" is already enforced: the existing "lib modules import only siblings, never ../" test covers it.

### 3.2 S2 bounded read views

**`lib/read-views.mjs`** (a new leaf: node builtins only).

`PUBLIC_READ_BYTES = 8192`.

`boundedReadView(payload, { summary, render, asJson, nextStep })` returns `{ view, text, complete }`. The loop:
1. Start with limits `{string: ∞, items: ∞}`. The first shrinking round depends on the view: `{512, 8}` for a summary view (`status`, the active-job hint), as in the reference, and `{4096, 8}` for the `result` preview. Later rounds halve both until both reach 0. (A 512-byte preview of a large result would waste most of the budget now that `/codex:result` shows the preview as it is; for lists, 4096 would drop records the reference keeps — eight records with 5000-byte strings stay eight at 512 and become two at 4096.)
2. `project` works as follows:
   - strings over the limit (in bytes) are cut at a surrogate-safe boundary and end with `…`;
   - arrays are sliced to the item limit;
   - depth over 12 becomes `null`;
   - in summary mode the keys `request`, `result` and `rendered` are dropped at any depth when their value is not null; a dropped array also adds its length to `omissions.records`, as in the reference;
   - every key of the payload stays an own property of the projection (`__proto__` included).
3. `view = { ...projected, truncated, omissions: { fields, fieldNames, records, strings }, nextStep? }`. `records` starts at `payload.omittedJobs`; `nextStep` is present only when truncated.
4. The printed form is `JSON.stringify(view, null, 2) + "\n"` in JSON mode. In text mode it is `render(projected)`, plus, when the text itself was shortened, a line `Truncated: <omissions as JSON>` and then `<nextStep>`. Shortened means a cut string, a sliced array, a depth-limit `null` or omitted job records. A deliberate summary drop alone does not count in text mode: the text renderers of `status` never print `request`, `result` or `rendered`, so nothing the text showed is missing. In JSON mode a summary drop does set `truncated: true`, `omissions.fields`/`fieldNames` and `nextStep`.
5. If the printed bytes are ≤ 8192, stop. Otherwise try the next limits.
6. If the limits bottom out, print `{ truncated: true, omissions, nextStep }` (JSON mode) or `Truncated: output exceeds 8192 bytes.` followed by `<nextStep>` (text mode). This form is measured as well: when it does not fit with the caller's `nextStep` (a very long job id or path), the fixed `Use --output <new-path> for the complete JSON payload.` replaces it. No path prints more than 8192 bytes.
7. A text renderer of a bounded view reads the projection, never the original payload (the active-job hint is built from the projected job id and resume command).

Deviation from the reference: the size check is on the bytes printed. The reference checks the JSON view and falls back to JSON for text. That is wrong here because a `result` JSON view repeats the output three times (`rendered`, `result.rawOutput`, `codex.stdout`), so small results would be shrunk for no reason.

JSON is never cut mid-token. Keys, numbers and booleans (`waitTimedOut`, `resumeCommand`, `status`) survive every round.

**`exportReadPayload(payload, outputPath, cwd)`**
- Behaves as described in the Trust boundary.
- Returns the receipt `{ outputFile, bytes, sha256 }`, always printed as JSON on stdout, even without `--json`.
- The receipt is computed before the file is created. A receipt that would itself exceed 8192 bytes is refused: `--output path is too long: its receipt would exceed 8192 bytes; pass a shorter path.` (exit 1, nothing created). The path and checksum are never shortened.
- `EEXIST` gives the error `--output <path> already exists; pass a new path.` (the resolved absolute path) with exit 1. Other errors are raw, exit 1.
- Before a `status <id> --wait` starts waiting, an `lstat` of the resolved path fails the command early with the same error. That check is a courtesy; the `wx` open is the guard.

**What is kept.** Nothing in this plugin is private the way the reference's lease/seal fields are, so no public filter is ported. `logFile` (a useful debug path), `requestFile` (a path, the file is 0600) and `pidIdentity` stay. There is no "viewed/acknowledge" concept to port.

**`buildStatusSnapshot` gains two fields:**
- `totalJobs` = the session-filtered job count;
- `omittedJobs` = `options.all ? 0 : jobs.slice(maxJobs).filter(finished && not latestFinished).length`.

A non-zero `omittedJobs` makes the view truncated. Its `nextStep` is: `Use --all to include omitted records, with --output <new-path> for the complete JSON payload.` Otherwise status says: `Use --output <new-path> for the complete JSON payload.`

The `result` nextStep carries the resolved id: ``Full output: `result <id> --wait` (text) or `result <id> --output <new-path>` (JSON).``

**Read-view modes.** Exit codes 0/1/3 are unchanged throughout.

| # | Command | Bounded | Summary drops `request`/`result`/`rendered` | Text render |
|---|---|---|---|---|
| 1 | `status` (list), text or `--json` | yes | yes | `renderStatusReport` |
| 2 | `status <id>` [`--wait`, including the exit-1 timeout snapshot with `waitTimedOut`] | yes | yes | `renderJobStatusReport`, plus the `Timed out after <N>s …` line |
| 3 | `result [<id>]`, terminal record | yes | no (strings and arrays shrink only) | `renderStoredJobResult` |
| 4 | `result <id>` on an active job (exit 3 hint, carries `resumeCommand`) | yes | yes | `Job <id> is still <status>. Re-run: …` |
| 5 | `result <id> --wait`: the terminal record or the exit-3 timeout hint | no, full as in 1.4.3 | – | unchanged |
| 6 | `task --await` result or timeout hint (the rescue path; shares `outputJobResult`) | no, full | – | unchanged |
| 7 | rows 1–4 with `--output <new-path>` | file = the full pre-1.5.0 `--json` payload; stdout = receipt JSON | – | – |
| 8 | `result --wait --output` | refused: `--output cannot be combined with --wait; result --wait already prints the full record.` (exit 1) | – | – |

**`/codex:result` command file.** The command presents the stdout as it is. When the output ends with a `Truncated:` block, that is the preview plus the `Full output:` line; Claude does not re-run the command on its own. The user asks for the full text, and only then Claude runs the `result <id> --wait` from that line (a `node` call, allowed by `Bash(node:*)`; no `Read` tool is added).

**Usage text.** `status … [--output <new-path>]` and `result … [--output <new-path>]`.

### 3.3 S3 review surface

**Dispatch.** Validation happens in the handler, in both modes, before any job record exists, in this order:
1. `--wait` with `--background` → `Choose either --wait or --background.` (today both are accepted silently);
2. model and effort;
3. `--config` and `--turn-timeout-ms`;
4. `resolveReviewTarget`: git repository, scope, `--base` (#653);
5. `ensureCodexAvailable` (today it runs only inside `executeReviewRun`, so a foreground review without codex left a failed record behind);
6. the mapping to the built-in reviewer's target.

Transport is decided per run by the existing `withAppServer`: broker when reachable and free, direct otherwise (on busy, or with no broker).

| # | Command | Focus text | `--background` | Reviewer | Runs in | stdout (text) |
|---|---|---|---|---|---|---|
| 1 | `review` | none | no | built-in (`review/start`) | companion | the built-in review, rendered as today |
| 2 | `review` | none | yes | built-in | detached worker | queued line |
| 3 | `review` | given | no | adversarial (prompt + schema, same target) | companion | notice line, then the adversarial review |
| 4 | `review` | given | yes | adversarial | worker | notice line, then the queued line |
| 5 | `adversarial-review` | any | no | adversarial | companion | as today |
| 6 | `adversarial-review` | any | yes | adversarial | worker | queued line |

- **Notice (rows 3–4):** `Focus text given: running the adversarial reviewer (the built-in reviewer accepts no instructions).`
  - Written to the job log.
  - Prepended to the stored `rendered`, so `result` shows it too.
  - Added to the JSON payload and the queued payload as `notice`.
  - Rows 3–4 get the `adversarial-review` kind and the `Codex Adversarial Review` title.
- **Queued line:** `<title> started in the background as <id>. Check /codex:status <id> for progress.` With `--json` the payload is `{ jobId, status: "queued", title, summary, logFile[, notice] }`.
- **Request file:** `{ cwd, base, scope, model, effort, config, focusText, reviewName, notice, turnTimeoutMs, jobId }`.
- **Record:** every review record (foreground too) gets a top-level `focusText` (null when absent). `pushJobDetails` renders it as `Focus: <shortened to 96>`, because the status summary drops `request`.
- **`/codex:review` without focus** stays the built-in reviewer, including its scope limits (no staged-only or unstaged-only review).

**Worker (#615).**
- `enqueueBackgroundJob` is the task enqueue, unchanged: queued record, 0600 request file, spawn, `recordWorkerPid`, `background: true`.
- `handleTaskWorker(argv, runners)` runs `runners.review` when `storedJob.jobClass === "review"`, otherwise `runners.task` (a pre-1.5.0 queued task, or a record without `jobClass`, falls to task). `main` passes `{ review: executeReviewRun, task: executeTaskRun }`.
- The subcommand name `task-worker` and its argv stay, so `workerCommandLine` (`task-worker.*--job-id <id>`) and the reaper's `codex-companion.mjs` match are unchanged.
- The worker re-resolves `{ base, scope }` (see Limits).

**Worker diagnostics** (every detached worker, task and review; the sister's rule).
- The worker's stdout and stderr are appended to the job log (`logFile` in `status --json`); before, they were discarded, so an error printed before the worker could write its own log was lost and the reaper recorded only a generic dead-worker message.
- The worker registers its crash guard before it reads the request. A worker that cannot read its request file ends the job `failed` with `errorMessage` `worker could not start: <reason>`; for a JSON error the reason is `its request file is not valid JSON` (the parser's own text quotes the file, which may hold a `--config` value, and is never recorded). The log gets `Marked failed: <errorMessage>`.
- A failed spawn (`error` event) leaves `Could not spawn the background Codex worker: <message>` in the log.

**Cancel, SessionEnd and reaper for a detached review** follow the task rules exactly:
- **SessionEnd** leaves a `background: true` job alone. The broker stays while any job is active.
- **Reaper:** unchanged.
- **Cancel:** a native review records `turnId` and `transport`, because `captureTurn` gets `turn/started` on `sourceThreadId`, which equals `state.threadId` for inline delivery (`codex.mjs:571-592`). So:
  - brokered: v1.4.2 rows 3–6 (`turn/interrupt`, wait up to 10 s, never kill; `turn-not-interrupted` when the turn does not end);
  - direct: row 2 (verified kill of the worker, which owns its app-server);
  - queued, no turn yet: row 1, and `commitCancel` removes the request file.

**#714 verbatim focus.** New `splitArgsWithVerbatimTail(raw, spec)` in `lib/args.mjs`:
- It tokenizes shell-like, with the existing splitter, until the first positional or `--`.
- The value of a value or repeatable option (including `-m`, and a `--flag=value` form) is taken as one token.
- From the first positional's start offset (or after `--`), the rest of the raw string, trimmed, becomes ONE token. Apostrophes, quotes, backslashes and newlines are kept byte for byte, and focus starting with `-` works after `--`.
- `applyArgsStdin(argv, spec)` uses it only when `main` passes `REVIEW_ARG_SPEC` (exported by `commands/review.mjs`, and also used for its own `parseCommandInput`). That happens for `review` and `adversarial-review`.
- `review` now parses with `stopAtFirstPositional` like the adversarial variant. The #547 rule stays: text after the first positional is focus, even if it looks like a flag.
- Unchanged: `task --args-stdin`, the single-string argv form (`normalizeArgv`, `argv.length === 1`), and plain argv.

**#653 base validation.** In `resolveReviewTarget` (`lib/git.mjs:135`), for an explicit `--base <ref>`:
- If `ref` starts with `-`, or `git rev-parse --verify --quiet <ref>^{commit}` exits non-zero, it throws: `Base ref "<ref>" not found in this repository; pass a branch, tag or commit that resolves locally (git fetch it first for a remote ref).` Exit 1.
- The check runs before any job, request file or `codex` start. It covers both commands, and the worker's re-resolve too.
- Detected bases are not re-checked: `detectDefaultBranch` already verifies them with `show-ref`.

**#529 persisted, named threads.**
- `runAppServerReview` starts its thread with `ephemeral: false` and `threadName` (today `ephemeral: true` at `codex.mjs:1238`).
- The adversarial path calls `runAppServerTurn` with `persistThread: true` and `threadName`.
- Names come from `buildReviewThreadName(reviewName, label)` = `Codex Companion <reviewName>: <label shortened to 56>`, where the label is the focus text, else the target label.
- No name starts with `TASK_THREAD_PREFIX` ("Codex Companion Task", `codex.mjs:57`), so `findLatestTaskThread` (`codex.mjs:1443-1463`) and `--resume-last` never pick a review thread.
- The fake already stores `ephemeral` in `lastThreadStart` (`fake-codex-fixture.mjs:379`) and names through `thread/name/set` (`:386-391`).

**#405 prompt caps**, in `lib/git.mjs` and the prompt builder:
- An untracked symlink is reported as `### <path>` + `(skipped: symlink)` and costs only that line; a broken link keeps `(skipped: broken symlink or unreadable file)`.
- The inline diff is read with the inline cap as its bound (the size probe and the read are two git calls, and the diff can grow between them; today an overflow past 1 MiB throws a raw `ENOBUFS`). An overflow at the read falls back to the self-collect sections, and `inputMode`/`collectionGuidance` report what was actually inlined.
- `MAX_UNTRACKED_TOTAL_BYTES = 262144`: the total of the formatted untracked entries in both inline and self-collect modes. Today the untracked bodies are inlined even in self-collect mode (`git.mjs:234` inline, `:244` self-collect). Past the cap each file is left out and one line is added: `(<N> untracked file(s) omitted: aggregate untracked content exceeds the 262144 byte limit; see Git Status for the full list and inspect them directly.)`
- `MAX_REVIEW_PROMPT_CHARS = 786432` (75 % of Codex's 1,048,576-character input limit). If the interpolated prompt is longer:
  - `REVIEW_INPUT` is cut at the last newline that fits;
  - the line `[Repository context truncated at <N> characters: inspect the target yourself with read-only git commands before finalizing findings.]` is appended;
  - the guidance switches to the self-collect text;
  - the log gets `Review context truncated to fit the prompt ceiling (<N> of <M> characters).`
- Reasons for the numbers:
  - 256 KiB matches the inline-diff cap (`git.mjs:9`) and upstream #461. The worst inline case (256 KiB of diff plus 256 KiB of untracked content plus status) fits under the ceiling, so the ceiling fires only on huge status, log or file lists (a months-long `--base`, tens of thousands of untracked files).
  - The 25 % margin covers the template and schema. JS `length` counts UTF-16 units, which is ≥ code points, so the check errs on the safe side.

**#583 fenced JSON.** `parseStructuredOutput` tries `JSON.parse` on the capture of `^\s*```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$`, which only matches a fence around the whole message (the upstream #583 rule). `rawOutput` stays the raw message. Prose, malformed JSON and empty output fail as today.

**#679 built-in `--json` shape.**
- `exitedReviewMode` delivers only a string (`codex.mjs:516`), so a result in the schema's shape is impossible without guessing.
- The built-in payload therefore gains `result: null`, `rawOutput: <review text>`, and `parseError: "The built-in reviewer returns prose, not the review-output schema; use adversarial-review (or /codex:review with focus text) for structured findings."`
- `review` (built-in or adversarial) tells the two shapes apart.
- Consequence: `isStructuredReviewStoredResult` becomes true (`render.mjs:75-85`), so `result` prints the stored `rendered` (heading, target, text, reasoning), the same as the foreground output. Before, it printed the bare `codex.stdout` (`render.mjs:400` vs `408-411`). Pre-1.5.0 records are unchanged.

**Command files.**
- `commands/review.md` and `commands/adversarial-review.md` drop the ` ```typescript ` `Bash(..., run_in_background: true)` block. Background flow: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <cmd> --background --args-stdin <<'CODEX_ARGS'` (`--background` before `--args-stdin` survives the splice), and return its stdout verbatim.
- The text becomes "the companion detaches a `--background` review itself".
- `review.md` says focus text runs the adversarial reviewer.
- `--wait`/`--background` count as mode flags only among the leading flags — before the first word that is neither a flag nor a flag's value, and before `--`; the same words inside the focus text are focus.
- The heredoc delimiter is `CODEX_ARGS_<random>` in every command file (Trust boundary).
- `printUsage` shows `review … [focus text]`.

## Testing

**S0/S1**
- `session-lifecycle-hook.test.mjs`: the table passes `isPidAliveImpl: () => false`.
- `broker-idle-timeout.test.mjs`: the connected-client test runs with a 2000 ms idle timeout and reports the broker's stderr on failure.
- New `cli.test.mjs`:
  - `COMPANION_SCRIPT === helpers.SCRIPT`, and `REVIEW_SCHEMA` exists;
  - error texts of `parseTimeoutOption`, `parseConfigOverrides` and `normalizeReasoningEffort`;
  - `normalizeArgv` splits a single string.
- `module-boundaries.test.mjs`:
  - commands/* import only `../lib/**` and `./shared.mjs`;
  - `shared.mjs` imports only `../lib/**`;
  - the entry allow-list (`cli` plus the command modules and `shared.mjs`).
- S1 proof, by the v1.4.3 method (`review-v143-whole-branch.md:18`):
  - test titles only added;
  - the sorted-line multiset of the old file equals that of the split files, except for imports and exports, the two renames at their definitions and call sites, the `runners` dispatch in `handleTaskWorker`, the `ROOT_DIR` depth and the inlined `renderStatusPayload`; the proof script pins that residue line by line;
  - `--help` output diffs to nothing.

**S2**
- `module-boundaries.test.mjs`: `read-views` is in `LEAVES` (it lands with the file).
- New `read-views.test.mjs`:
  - a small payload is complete (`truncated: false`);
  - a 60 KB string gives JSON that parses, is ≤ 8192 bytes, has `strings ≥ 1` and a `nextStep`;
  - summary mode lists `request`, `result` and `rendered` in `fieldNames`; the same payload in text mode prints no `Truncated:` line;
  - a payload with several long strings, which does not fit at 4096, still lands under the limit;
  - `omittedJobs` counts in `records`;
  - text-mode output fits the limit;
  - a wide object bottoms out to the minimal view; an oversized `nextStep` or job id still prints ≤ 8192 bytes in both formats;
  - `__proto__` survives as an own key; a dropped summary array counts its records in JSON and prints no `Truncated:` line in text; a depth-limit `null` does print it;
  - eight records with 5000-byte strings all survive in summary mode.
- `exportReadPayload`:
  - receipt `sha256` = the file's hash;
  - mode 0600 (posix);
  - `EEXIST` on an existing path;
  - a symlink is refused (`{ skip: win32 }`);
  - an injected write failure (`t.mock.method(fs, "writeFileSync")`) removes the file;
  - a path whose receipt would exceed 8192 bytes is refused and nothing is created.
- `runtime-status.test.mjs`:
  - a background task with a 60 KB prompt:
    - `status --json` is ≤ 8192 bytes, has no `request` and has `truncated: true`;
    - `status <id> --wait --output <existing path>` on a running job exits 1 without waiting;
    - text output is ≤ 8192 bytes;
    - `--output` writes a file containing the prompt and prints the receipt;
    - a second `--output` to the same path exits 1 with `already exists`;
  - 12 finished jobs give `omittedJobs > 0`, and `nextStep` mentions `--all`;
  - two regressions ported from the reference: an oversized list (4 active and 30 finished records with 6 KB CJK summaries: exact `totalJobs`, `omittedJobs` and `omissions.records`, ≤ 8192 bytes in both formats), and a finished record with CJK and astral-plane text read through `status <id>` and `result <id>` in both formats (no broken surrogate, the stored record untouched);
  - a 20 KB result:
    - `result <id>` shows the preview plus the `Full output: \`result <id> --wait\`` line;
    - `result <id> --wait` is byte-identical to the stored `rendered` plus the session lines;
    - `result --wait --output` exits 1.
- `runtime-task.test.mjs`:
  - `:955-966`, `:1024-1038` (`exposures`) and `:1081-1084` no longer require `[redacted]` or the key name in `status --json` (the absence of the secret is still asserted). The presence checks move to `result --json`, except at `:1081-1084`: that job is still queued, so its `result --json` is the summary too, and the check reads a `status <id> --output <file>` export instead;
  - `task --await --json` of a 20 KB result has no `truncated` key.
- `commands.test.mjs`:
  - `:213`: the `result.md` argument-hint regex takes the new `[--output <new-path>]`;
  - `result.md` pins the preview rule: present the `Truncated:` block and the `Full output:` line as printed, and run `result <id> --wait` only when the user asks for the full text;
  - `:422-440` is kept (the sentence stays true).

**S3**
- `runtime-review.test.mjs`:
  - `:219`: focus now runs the adversarial reviewer; the first line is the notice; `lastTurnStart.prompt` contains the focus and the adversarial template; the kind is `adversarial-review`; `focusText` is on the record.
  - `:281` "review accepts --background…" is rewritten: the queued payload comes back at once, then `status <id> --wait` shows completed; the record has `background: true`, `jobClass: "review"` and a redacted `request.config`; the request file is gone.
  - New tests:
    - `--wait --background` → error;
    - `--base nope`, `--base -x` → exit 1 with the text, no job in the state index, no `appServerStarts` (both commands);
    - `--args-stdin` input `--base main don't mangle "this"\nline 2` reaches the prompt verbatim;
    - `-- --model is wrong` becomes the focus;
    - `lastThreadStart.ephemeral === false` plus a thread name for both reviewers;
    - `review --json` has `result: null`, `rawOutput` and `parseError`.
- `args.test.mjs` (`splitArgsWithVerbatimTail`): apostrophes; quotes; newlines; `--model sol` then focus containing `--model x`; `-m sol`; `--config k=v`; `-- -x`; flags only (no tail); empty input.
- `git.test.mjs`:
  - missing base, a tree sha and `-x` are rejected; a branch, tag, sha and `origin/…` are accepted;
  - 300 × 20 KB untracked files give a section ≤ 256 KiB plus the notice with the count;
  - an untracked symlink to a file outside the repository is skipped and none of the target's content is in the context (both modes);
  - a diff larger than the bound at the read gives self-collect context, not an exception (working tree and branch).
- Prompt ceiling: unit test of `buildAdversarialReviewPrompt` with a 1 MB context → ≤ 786432 characters, the marker line and the self-collect text.
- New `codex-structured-output.test.mjs` (port of #583's table): bare, `json`-fenced, untagged fence, CRLF, backticks inside a string, malformed, prose, empty.
- `render.test.mjs`: the `Focus:` line; a stored built-in review with `parseError` renders `rendered`.
- `runtime-cancel.test.mjs`, new tests:
  - brokered background built-in review (`FAKE_CODEX_REVIEW_DELAY_MS`) → interrupt, then `cancelled`, `transport: "broker"`, nothing killed (posix, `{ timeout: 90_000 }`);
  - a win32 twin in the style of `:641` (broker and its subtree still alive);
  - a queued-window review cancel removes the request file.
- `commands.test.mjs:17-76`:
  - remove the checks for ` ```typescript `, `run_in_background: true`, the `command:` template, `description: "Codex …"`, `Do not call \`BashOutput\``, the "Claude Code's `Bash(..., run_in_background: true)` … detaches" line, and "or extra focus text";
  - add `<cmd> --background --args-stdin <<'CODEX_ARGS_<random>'`, `doesNotMatch(/run_in_background/)`, the focus → adversarial sentence and the leading-flags rule for `--wait`/`--background`;
  - a scan of `commands/*.md`, `agents/*.md` and `skills/*/SKILL.md`: every heredoc is quoted and uses the `_<random>` delimiter with its selection rule.
- `runtime-task.test.mjs`, worker diagnostics: a worker that throws before it tracks its job leaves the error in the job log; a corrupted request file fails the job with `worker could not start: its request file is not valid JSON`, and the file's content reaches neither the log nor the state index.
- `runtime-hooks.test.mjs`: the SessionEnd test holds the review's turn, sees `running` before and after the hook with the worker and broker alive, then cancels.
- `runtime-cancel.test.mjs`: two background reviews at once — the second falls back to `transport: "direct"`; cancelling it kills its worker and leaves the brokered one to complete (posix).
- `runtime-review.test.mjs`: stdin `investigate --background handling` runs in the foreground with that exact focus.
- New fake knob `FAKE_CODEX_REVIEW_DELAY_MS=N`: `review/start` answers and sends `turn/started` and `enteredReviewMode`, then completes after N ms. It is registered in `interruptibleTurns`, so `turn/interrupt` completes it as `interrupted`, and the `FAKE_CODEX_IGNORE_*` knobs apply.
- Timing (`docs/agent/testing-and-ci.md`):
  - no absolute bound under 10 s;
  - `waitFor` at 30 s;
  - `{ timeout }` plus a `t.after` SIGKILL wherever a worker or broker runs;
  - failures print the stored record and the job-log tail.

## Limits

- **`result` without `--wait` shows a preview when the output is over 8 KB.** `/codex:result` shows that preview and the `Full output:` line; the full text needs a second, explicit request (`result <id> --wait`, or `--output` for the JSON). `status`, including `status <id> --wait`, never shows `request` (the prompt); read it with `result --json` or `--output`.
- **Only the bounded commands carry the new fields.** Every bounded view has `truncated` and `omissions`. `task --await --json` and `result --wait --json` keep the 1.4.3 shape without them. A caller that read fields past 8 KB from `--json` now gets `…`-shortened strings and must use `--output`.
- **Any positional text on `/codex:review` selects the adversarial reviewer.** That includes #522's model/effort words in kana: they become focus text, not a model choice. Non-English alias parsing is not implemented.
- **Verbatim focus applies only to review commands fed through `--args-stdin`.** Quotes the user types reach the prompt literally. Flags after the focus are focus text (#547). `task --args-stdin` and the single-string form keep shell-like splitting and its backslash rule.
- **A brokered background review follows the v1.4.2 cancel rules.** Cancel may answer `turn-not-interrupted` and kills nothing. Whether a real app-server honours `turn/interrupt` on a `review/start` turn is assumed; it is only exercised against the fake.
- **A background review keeps running after the session.** It outlives `SessionEnd` and keeps the session broker alive while it runs. A concurrent foreground run gets `busy` and falls back to direct (pre-existing).
- **The worker re-resolves the review target.** With `auto` scope, a tree that changed between enqueue and worker start is reviewed as found.
- **Focus text is never cut.** A focus text that is itself longer than the prompt ceiling leaves the prompt over 786,432 characters; Codex's own input limit then decides.
- **Prompt caps affect coverage.** Untracked content past 256 KiB is only listed by name. Context past 786,432 characters is cut at a line, and findings on the omitted part depend on the model's own git reads. The built-in reviewer collects its own diff and has no plugin-side cap.
- **No wall-clock limit per job** (#615 defect 3). Use `--turn-timeout-ms`.
- **The built-in reviewer never returns a schema-shaped `result`** (#679). `parseError` says so.
- **Persisted review threads write rollouts** to `~/.codex/sessions`. `codex resume <id>` now works for them; they are never `--resume-last` candidates.
- **Structured output: only a fence around the whole message is unwrapped.** The sister also recovers a JSON object embedded in prose; that is not ported, because a prose reply that quotes an object would be taken for the review result.
- **The sister's throwaway review worktree is not ported.** It contains a reviewer that can write; here the reviewer runs in Codex's read-only sandbox.
- **`--output` must name a path that is free when the command starts.** `status <id> --wait --output` refuses an occupied path before waiting, even if it would be free by the end of the wait. A path so long that its receipt would exceed 8192 bytes is refused.
- **`--output` has limits of its own.** Windows ignores the 0600 mode; the symlink-refusal test is posix-only; every export needs a new path. A crash between create and write can leave a partial file.
- **Cancelling a foreground review is unchanged** (pre-existing): its pid is the companion itself, not a `task-worker`.

## Rollout

**CHANGELOG 1.5.0** (bump with `node scripts/bump-version.mjs 1.5.0`, which updates `package.json`, `plugin.json` and `marketplace.json`; copy the result byte-identical to `plugins/codex/CHANGELOG.md`):
- **Added**
  - `--output <new-path>` on `status` and `result`;
  - `totalJobs` and `omittedJobs`;
  - `review --background` / `adversarial-review --background` detach inside the companion;
  - `/codex:review <focus>` runs the adversarial reviewer, with the notice;
  - `focusText` on review records and the `Focus:` line;
  - named, persisted review threads.
- **Changed**
  - bounded `status`/`result` output, text and `--json`. This is an intentional compatibility change: `truncated`/`omissions`/`nextStep`, the summary drops `request`/`result`/`rendered`, and `result` shows a preview;
  - the built-in review `--json` gains `result: null`/`rawOutput`/`parseError`, and its `result` text prints the rendered review;
  - `--wait` together with `--background` is an error;
  - Codex availability is checked before a review job is recorded;
  - the command files no longer use Claude background Bash.
- **Fixed**
  - #714 focus mangling;
  - #653 unresolved `--base` (and a `-`-leading ref);
  - #405 unbounded adversarial prompt;
  - #583 fenced JSON;
  - the fixed heredoc delimiter in every command file (an argument line equal to it ran the rest on the host shell);
  - untracked symlinks followed into the review context; the unbounded inline diff read;
  - a detached worker's startup failure lost its reason.
- **Internal**
  - the S1 split;
  - the AGENTS.md install rule;
  - the SessionEnd test's liveness injection and the broker idle-timeout test's wider window.
- **Known limitations:** the Limits bullets, each ending `(spec §Limits)`.

**Docs**
- README: `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, the task/`result` bullet at L167 (`{ job, storedJob }` becomes bounded with `truncated`/`omissions`; the pinned exit-code sentence stays), L232, "Start Something Long-Running". Keep them free of `scripts/lib/` paths and `name()` calls (`docs-contracts.test.mjs:55-60`).
- `docs/windows.md:25` Code path: `codex-companion.mjs (cancel)` becomes `scripts/commands/cancel.mjs`.
- `docs/state-and-lifecycle.md` Code path: `lib/read-views.mjs`, `commands/status.mjs`.

**Upstream (comments need approval)**
- Closed: #714 (and #333), #653/#658, #529/#557, #405/#461, #583, #679.
- Partially closed: #615 (defect 2; reaping already exists, no wall-clock limit per job), #522 (parity only).
- Ported PRs (#461, #557, #583, #658, #714) keep their authors' `Co-authored-by:`.

**Order and gate.** Order: S0 → S1 (a pure move, reviewed alone) → S2 → S3. Gate per `docs/agent/process.md`: a Fable review per task, then `/codex:adversarial-review --base main --effort max` under the stop rule, then `docs/RELEASING.md` steps 0–6, including the plugin update in every config dir.

## Revision log

| rev | date | trigger | change |
|---|---|---|---|
| 1 | 2026-09-30 | controller rulings S0–S3 for v1.5.0 | initial |
| 2 | 2026-09-30 | user review of rev. 1; CI 36700963516 | `/codex:result` shows the preview and does not re-run with `--wait` on its own; `status <id> --wait` confirmed bounded; S0(a) is committed; S0(c) broker idle-timeout test added |
| 3 | 2026-09-30 | plan writers' code reading; controller rulings on S2 | first shrink step 4096 instead of 512; a summary drop alone prints no `Truncated:` block in text mode; `--output` is checked before a `status --wait` starts waiting; S1 residue, entry allow-list and exports corrected; test sites `runtime-task:955-966`, `:1081-1084` (via `--output`), `commands.test:213` added; line references corrected; limit "focus text is never cut" added |
| 4 | 2026-09-30 | user: compare with the sister plugin; Codex (gpt-6.1-sol) read the plan against cc-plugin-codex 66846d9 | random heredoc delimiter in every command file; untracked symlinks skipped; inline diff read bounded; worker stdout/stderr to the job log and `worker could not start: …` (one spawn option changes, threat model walked); bottom-out view measured, receipt preflight, own-property projection; first shrink step 512 for summary views and 4096 only for the `result` preview; summary-dropped arrays counted; depth nulls count as shortened in text; mode flags only before the focus; sister regressions and the concurrent-review cancel test added; limits: prose-embedded JSON and the review worktree not ported, `--output` path free at start |
