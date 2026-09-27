# Task 6 Report: Transfer учитывает `CLAUDE_CONFIG_DIR` (#721)

## What was implemented

`plugins/codex/scripts/lib/claude-session-transfer.mjs`:
- Removed the module constant `CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects")`.
- Added `export function resolveClaudeProjectsDir(env = process.env)`, returning
  `path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(String(env.CLAUDE_CONFIG_DIR)) : path.join(os.homedir(), ".claude"), "projects")`.
- `resolveClaudeSessionPath(cwd, options = {})` now does `const env = options.env ?? process.env;`,
  computes `projectsDir = resolveClaudeProjectsDir(env)`, reads the transcript-path env var from
  `env[TRANSCRIPT_PATH_ENV]` (was `process.env[...]`), and uses `projectsDir` at both prior
  `CLAUDE_PROJECTS_DIR` use sites (the `realpathSync` call and the error message), preserving the
  exact sentence shape `Codex can import Claude sessions only from <projectsDir>: <source>` so the
  existing `/only from .*\.claude.*projects/` regex in `tests/runtime.test.mjs` still matches in the
  default (no `CLAUDE_CONFIG_DIR`) case.

Caller check: `rg -n "resolveClaudeSessionPath" plugins/codex/scripts` showed one caller,
`executeTransfer` in `plugins/codex/scripts/codex-companion.mjs:824`, which passes only
`{ source: options.source }` — no `env` — so it continues to default to `process.env`
unchanged; no caller update was needed.

`tests/test-env.mjs`: added `"CLAUDE_CONFIG_DIR"` as the last entry in the hermetic-strip array
(single line, as scoped — left the rest of the file untouched for Task 7).

`README.md`: appended one sentence to the `/codex:transfer` section: "The transcript root honours
`CLAUDE_CONFIG_DIR` when set, resolving to `<CLAUDE_CONFIG_DIR>/projects` instead of
`~/.claude/projects`."

## Tests and results

New test in `tests/runtime.test.mjs`, placed directly after the four existing `transfer ...` tests
(before `task reports the actual Codex auth error ...`):

```js
test("transfer resolves transcripts under CLAUDE_CONFIG_DIR when it is set (#721)", () => {
  const configDir = makeTempDir();
  const projectDir = path.join(configDir, "projects", "-tmp-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "sess.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  const env = { CLAUDE_CONFIG_DIR: configDir };
  assert.equal(resolveClaudeProjectsDir(env), path.join(configDir, "projects"));
  assert.equal(resolveClaudeSessionPath(process.cwd(), { source: transcript, env }), fs.realpathSync(transcript));

  const otherConfigDir = makeTempDir();
  fs.mkdirSync(path.join(otherConfigDir, "projects"), { recursive: true });
  assert.throws(
    () => resolveClaudeSessionPath(process.cwd(), { source: transcript, env: { CLAUDE_CONFIG_DIR: otherConfigDir } }),
    /can import Claude sessions only from/
  );
});
```

Also added the top-level import:
`import { resolveClaudeSessionPath, resolveClaudeProjectsDir } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";`

### Deviation from the brief's verbatim test (documented, with reason)

The brief's Step 1 test used `env: {}` for the third (reject-path) assertion. Traced through
`resolveClaudeSessionPath`: with `env: {}`, `resolveClaudeProjectsDir({})` falls back to
`path.join(os.homedir(), ".claude", "projects")` — the **real, host** `~/.claude/projects`
(`os.homedir()` is unaffected by the `env` object passed to `resolveClaudeProjectsDir`; it reads
the actual process `HOME`). On this dev machine that directory exists (`/Users/g.mehrenin/.claude/projects`),
so the assertion passed locally. But `rg -n "npm test" .github/workflows/` shows both
`pull-request-ci.yml` and `release-verify.yml` run `npm test` in CI, on a bare GitHub Actions
runner where `~/.claude/projects` does not exist — there `fs.realpathSync(projectsDir)` would throw
`ENOENT`, caught and rethrown as `Claude session file not found: ...` instead of
`can import Claude sessions only from ...`, failing the `assert.throws(/only from/)` regex match in
CI while passing locally. Caught by the advisor before commit.

Fix: replaced `env: {}` with a second, real (but empty) temp `CLAUDE_CONFIG_DIR` — the transcript
lives under the first temp dir's `projects/`, the reject case now supplies a *different* temp dir's
`projects/` as the configured root, so the mismatch (and thus the throw) is deterministic and fully
hermetic, independent of the host's real `~/.claude/projects`. Same behavior under test (env's
`CLAUDE_CONFIG_DIR` is honored on the reject path too), no host dependency.

### TDD evidence

RED — `node --import ./tests/test-env.mjs --test --test-name-pattern "transfer" tests/runtime.test.mjs`
(run with only the test added, before the implementation):
```
file:///.../tests/runtime.test.mjs:11
import { resolveClaudeSessionPath, resolveClaudeProjectsDir } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";
                                   ^^^^^^^^^^^^^^^^^^^^^^^^
SyntaxError: The requested module '../plugins/codex/scripts/lib/claude-session-transfer.mjs' does not provide an export named 'resolveClaudeProjectsDir'
...
✖ tests/runtime.test.mjs (31.545458ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```
Note: this is a module-link-time `SyntaxError` rather than the brief's predicted runtime
`"resolveClaudeProjectsDir is not a function"` — expected difference: a static ESM `import` of a
name the module doesn't export fails at link time (whole file, before any test body runs), whereas
a CJS `require`/property-access pattern would only fail at call time. Same root cause (function not
yet defined/exported), equivalent RED signal.

GREEN (after implementation, and again after the hermetic-test fix) —
`node --import ./tests/test-env.mjs --test --test-name-pattern "transfer" tests/runtime.test.mjs`:
```
✔ transfer delegates the current Claude session directly to native import (334.389541ms)
✔ transfer reports an actionable upgrade error when native import is unsupported (328.382958ms)
✔ transfer fails visibly when native import completes without a ledger record (325.181542ms)
✔ transfer rejects sources outside the Claude projects directory (90.09675ms)
✔ transfer resolves transcripts under CLAUDE_CONFIG_DIR when it is set (#721) (0.992875ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

Full gate (final, after all changes, before commit):
```
$ npm test > /tmp/npm-test-t6.log 2>&1; st=$?; rg -e 'ℹ (tests|pass|fail)' -e '^not ok' /tmp/npm-test-t6.log; echo exit_status=$st
ℹ tests 257
ℹ pass 257
ℹ fail 0
exit_status=0
```
(256 base + 1 new test = 257, all pass, 0 fail — matches expectation.)
```
$ sleep 10; pgrep -f codex-plugin-test- | wc -l
0
```
```
$ npm run build
> @cbepx/codex-plugin-cc@1.2.1 prebuild
> mkdir -p plugins/codex/.generated/app-server-types && codex app-server generate-ts --out plugins/codex/.generated/app-server-types
> @cbepx/codex-plugin-cc@1.2.1 build
> tsc -p tsconfig.app-server.json
```
(no errors from either step)

## Files changed

- `plugins/codex/scripts/lib/claude-session-transfer.mjs` (implementation)
- `tests/runtime.test.mjs` (new test + import)
- `tests/test-env.mjs` (added `"CLAUDE_CONFIG_DIR"` to the strip array)
- `README.md` (one sentence in the `/codex:transfer` section)

Commit: `b756bdf` — `fix(transfer): resolve Claude transcripts under CLAUDE_CONFIG_DIR`
(4 files changed, 32 insertions(+), 6 deletions(-)), trailer
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — matches the trailer convention used by
every other commit already on `release/v1.3.0` (verified via `git log --format='%h %s%n%b' -8`),
consistent with this task's explicit instruction.

## Self-review findings

- `CLAUDE_CONFIG_DIR` relative values are resolved via `path.resolve(String(env.CLAUDE_CONFIG_DIR))` — confirmed.
- `options.env` defaults to `process.env` (`options.env ?? process.env`) — confirmed; the one real
  caller (`executeTransfer` in `codex-companion.mjs`) doesn't pass `env`, so it keeps reading the
  live process environment, meaning `CLAUDE_CONFIG_DIR` set on the host is picked up automatically
  in production use.
- `TRANSCRIPT_PATH_ENV` lookup also reads from `env` (`env[TRANSCRIPT_PATH_ENV]`), not
  `process.env` directly — confirmed.
- All four pre-existing transfer tests (native import, unsupported-native error, missing-ledger
  error, outside-projects-dir rejection) pass unmodified — confirmed, they don't set
  `CLAUDE_CONFIG_DIR` and don't pass `options.env`, so they exercise the same default-`process.env`
  path as before, with `HOME` faked per-test exactly as before.
- No unrequested abstraction added: `resolveClaudeProjectsDir` is the only new export, matching the
  brief's interface line exactly; no config layer, no extra options beyond `env`.
- Found and fixed one hermeticity issue in the brief's verbatim test (see Deviation section above)
  before it could leak into CI.

## Concerns

- One test assertion was changed from the brief's verbatim `env: {}` to a two-temp-dir hermetic
  version, for the CI-environment reason documented above. This was necessary to keep the suite
  green on GitHub Actions (which has no `~/.claude/projects`), not a scope change — flagging per the
  task's "fix, re-run covering tests, append a fix report" review-response contract, even though
  this was resolved during the initial pass rather than as a resumed review-findings fix.
- No other concerns. Gate is clean: 257/257 pass, 0 lingering `codex-plugin-test-` processes,
  `npm run build` succeeds.
