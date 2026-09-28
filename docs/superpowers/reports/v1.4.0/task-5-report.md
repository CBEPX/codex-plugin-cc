# Task 5 report — Windows spawn without `$SHELL`

Commit: 6af7267 on `release/v1.4.0` (BASE 0cccebd). Not pushed. Step 5 (Codex second pass) skipped, as instructed.

## Changes by file

- `plugins/codex/scripts/lib/process.mjs`
  - `resolveExecutable(command, { env, cwd, spawnSyncImpl })` calls `spawnSync("where.exe", [command], { shell:false, timeout:5000, encoding:"utf8", windowsHide:true, env, cwd })` directly, not through `runCommand`. It returns the first output line whose extension (via `path.win32.extname`, case-insensitive) is in `env.PATHEXT` (default `.COM;.EXE;.BAT;.CMD`) and is launchable (`.com/.exe/.bat/.cmd`). It returns `null` on an error, a non-zero exit or no match. It never checks the platform itself, so it can be tested on macOS. No cache.
  - `quoteForCmd(arg)` and `buildLaunch(file, args, env)`: see "Quoting rules" below.
  - `runCommand`: `platform` and `spawnSyncImpl` can now be injected. On win32, `shell:false` always. A command with a path separator or a `.com/.exe/.bat/.cmd` extension skips `where.exe`. A bare name goes through `resolveExecutable`, and if that returns `null` the bare name is spawned, so ENOENT surfaces as before (libuv tries only `.com`/`.exe`). `windowsVerbatimArguments` comes from the launch. The returned `command`/`args` are still the originals, which `formatCommandFailure` needs. Non-win32: `shell: options.shell ?? false`, the same as before.
  - `terminateProcessTree` (win32): now `"taskkill.exe"` with an explicit `shell:false`. The `/T /F` flags, `looksLikeMissingProcessMessage`, the ENOENT fallback and the throw paths are unchanged. `terminateRecordedProcess` and the identity refusals are untouched.
- `plugins/codex/scripts/lib/app-server.mjs`: on win32, `buildLaunch(resolveExecutable("codex", {cwd, env}) ?? "codex", ["app-server"], env)`, then `spawn(..., { shell:false, windowsVerbatimArguments, windowsHide:true })`. Posix spawns `codex app-server` with `shell:false`, the same as before. The `terminateChild` comment now describes the cmd.exe → node → codex tree, and `taskkill /T /F` on the live handle's pid is still used there.
- `plugins/codex/scripts/lib/broker-lifecycle.mjs`: `spawnBrokerProcess` now passes `windowsHide: true`.
- `tests/fake-codex-fixture.mjs`: on win32 the body is written as `codex.cjs` and `codex.cmd` = `@echo off\r\nnode "%~dp0codex.cjs" %*\r\n`. Posix is unchanged (extensionless `codex`).
- `tests/helpers.mjs`: comment only. `run()` was already `shell:false`, and no test passes `shell: true` (`rg -n 'shell: true' tests/` finds no calls).
- `tests/process.test.mjs`:
  - The existing taskkill test now expects `taskkill.exe` and spies on `options.shell === false`.
  - New `resolveExecutable` test: `where.exe`, `shell:false`, `timeout:5000` and `cwd` are asserted; the extensionless hit is skipped, including when its directory contains a dot (`C:\tools.d\codex`); `.CMD` is picked case-insensitively; PATHEXT decides between hits; non-zero exit, a spawn error and extensionless-only output each give `null`.
  - New `quoteForCmd` table: plain, path with space, `"`, empty string, `%PATH%`, `a&b`, trailing `\`.
  - New `buildLaunch` test: `.exe` runs directly; a `.cmd` under `Program Files` gets the full `cmd.exe /d /s /c` line with ComSpec; a `.BAT` falls back to `cmd.exe`.
  - New `runCommand` composition test on a simulated win32: `where.exe` is called, then `cmd.exe` with `shell:false` and verbatim arguments; an explicit `.exe` or a path skips `where.exe`; an unresolved name spawns the bare name.
  - New Windows-only round-trip test (`{ skip: !IS_WIN }`): an `argv-shim.cmd` plus `argv.cjs` in a `shim dir` directory (with a space), put first on `PATH`, called as the bare name `argv-shim` so `where.exe` is exercised too. The arguments `["plain","with space","q\"uote","","%PATH%","a&b","trail\\"]` must come back from `JSON.stringify(process.argv.slice(2))` unchanged.
- `README.md` (`### Windows`): one paragraph on the compatibility change. `codex`/`npm` that exist only inside Git Bash (an alias, a function or a bash-only PATH entry) are no longer found; `codex.cmd`/`codex.exe` must be on the Windows PATH.

## Quoting rules implemented (deviation from the brief, deliberate)

The rule the brief states for `quoteForCmd` ("Node shell:true rules": quote only on space, `"` or an empty string, and leave `& | < > ^ %` untouched inside quotes) cannot pass the brief's own Step 4 round-trip:
- `a&b` has no space, so it would stay unquoted, and cmd.exe would run `b` as a second command.
- `%PATH%` is expanded by cmd.exe whether or not it is quoted.
- The shim re-parses `%*` a second time, so a `"` followed by a metacharacter in the same argument flips cmd's quote state.

Instead I used cross-spawn's proven algorithm for cmd-shims (`node_modules/cross-spawn/lib/util/escape.js`):
1. CRT quoting for the final program: backslashes before a `"` are doubled and the `"` becomes `\"`; trailing backslashes are doubled; the whole argument is wrapped in `"…"`.
2. Every cmd metacharacter in `()[]%!^"`<>&|;, *?` is caret-escaped twice: one level for `cmd /c`, one for the shim's own parse of `%*`. cross-spawn double-escapes only for `node_modules/.bin/*.cmd`. Global npm `codex.cmd` uses the same cmd-shim template, and so does our fixture shim, so here double escaping applies to every `.cmd`/`.bat`. Because every `"` is escaped, cmd never enters quote mode, so metacharacters stay literal. `%PATH^^^%` names an undefined variable, so it is not expanded.
3. The command path gets a single caret escape (`C:\Program^ Files\…\codex.cmd`), and the line is wrapped as `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments: true`. ComSpec comes from `env.ComSpec`, falling back to `cmd.exe`.
- `// ponytail:` ceiling: this assumes the `.cmd` forwards `%*` (npm shims do). A batch file that reads `%1` itself would see carets.

## Only CI can verify

- The real cmd.exe and `%*` round-trip (Step 4 test): quoting, `%PATH%` literal, `a&b`, the space in the directory and command path, the trailing backslash.
- The real `where.exe` output format and ordering (CRLF, PATHEXT order), and that `taskkill.exe` and `cmd.exe` are found without a shell.
- The real global npm `%APPDATA%\npm\codex.cmd`: it uses the same cmd-shim template with `%*` on a parsed line, so double escaping should hold there too, but no test runs a real npm-installed shim, only the fixture's hand-written one.
- The whole suite on Windows through the `codex.cjs` + `codex.cmd` fixture (setup/status `binaryAvailable("codex"|"npm")`, direct app-server spawn and teardown via taskkill).

## Deviations from the brief

1. `quoteForCmd` uses cross-spawn's double caret escaping, not Node's `shell:true` rules (reasons above). The Step 4 expectations are kept literally, including `%PATH%`.
2. There is no `powershell.exe` spawn at BASE (checked with `rg`; the CIM identity is another task), so "direct powershell.exe" had nothing to change. `taskkill` is now `taskkill.exe`.
3. CHANGELOG is not edited (the controller's instruction; Task 9 writes the 1.4.0 notes). The README paragraph is added.
4. `resolveExecutable` also requires a launchable extension (`.com/.exe/.bat/.cmd`) besides PATHEXT membership, so a `.PS1`/`.JS` in PATHEXT is never direct-spawned.
5. `tests/helpers.mjs` `run()` already met Step 3 (`shell:false`); only its comment changed.

## Gate (`npm run check` exit=0; full log: `task-5-gate.log` in this directory)

```

> @cbepx/codex-plugin-cc@1.3.0 check
> npm run check-version && npm run check:changelog && npm run lint && npm run build && npm run typecheck:tests && npm test


> @cbepx/codex-plugin-cc@1.3.0 check-version
> node scripts/bump-version.mjs --check

All version metadata matches 1.3.0.

> @cbepx/codex-plugin-cc@1.3.0 check:changelog
> node scripts/check-changelog.mjs

Changelog OK: CHANGELOG.md has a non-empty section for 1.3.0 and matches plugins/codex/CHANGELOG.md.

> @cbepx/codex-plugin-cc@1.3.0 lint
[... lint/build/typecheck/test output ...]
✔ runTrackedJob records the worker identity and clears it with the pid (422.335833ms)
ℹ tests 331
ℹ suites 0
ℹ pass 330
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 165594.402291
exit=0

$ sleep 10; pgrep -f codex-plugin-test- | wc -l
       0
```
