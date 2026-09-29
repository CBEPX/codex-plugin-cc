# State and lifecycle

## "Timed out … waiting for the Codex state lock"

Every write to this workspace's job state is serialized by a ticket lock: each
command takes a numbered ticket in `state.lock.d/` and waits for the tickets ahead
of it. A ticket whose process is gone is cleared automatically, so a crash never
wedges the workspace. A ticket whose process is still *running* is never taken
away — a slow writer and a stuck one look the same from outside, and taking the
lock from a process that is mid-write is how state gets corrupted — so the error
names that PID and the exact ticket file. If that process really is stuck, stop it
and the next command goes through; if the PID belongs to something unrelated (PID
reuse), delete the ticket file the error names.

## Raw EACCES / EIO from the state directory

The same lock refuses to guess. If a ticket in `state.lock.d/` cannot be listed,
read or `stat`ed, the command fails with that error instead of assuming the entry
is absent or abandoned — guessing there is what would let two commands write the
job state at once. Fix the permissions on the state directory (or remove the entry
the error names, once you know no Codex command is using it) and the next command
goes through.

## Code path

`plugins/codex/scripts/lib/state.mjs` (ticket lock, atomic writes), `plugins/codex/scripts/lib/tracked-jobs.mjs` (reaper).
