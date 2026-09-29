# Windows spawn threat model

Any change to how the plugin spawns a process on Windows must satisfy all five points, and the Codex review brief for such a change must list them verbatim (v1.4.0 needed six adversarial passes; each found a new executable-substitution path):

(a) In-box tools only by absolute path under `%SystemRoot%\System32\…` (`systemExe`; PowerShell: `System32\WindowsPowerShell\v1.0\powershell.exe`, `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`).
(b) A bare name resolves only through `resolveExecutable` (fs lookup over absolute `PATH` entries × `PATHEXT`; no `where.exe`, no cwd, no relative entries) and fails with `ENOENT` without spawning.
(c) `.cmd` shims run through `cmd.exe /d /s /v:off /c` with double-caret escaping, a filtered `PATH` and `NoDefaultCurrentDirectoryInExePath=1`.
(d) No console-output decoding: request only ASCII/numeric fields from external tools (protocol lines `^[A-Z]+( \d+)*$`, no trimming).
(e) `%VAR:a=b%` substitution inside a `.cmd` argument is a documented ceiling; CR/LF in an argument is refused.

Windows CI must run the round trip with a planted `node.cmd` / `codex.cmd` / `powershell.cmd` in the cwd and in a relative `PATH` entry. Worked example: spec `docs/superpowers/specs/2026-09-28-codex-plugin-cc-v1.4.1-design.md` §2 "Trust boundary".
