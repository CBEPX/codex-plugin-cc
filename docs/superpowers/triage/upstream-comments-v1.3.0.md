# Upstream comment drafts — CBEPX fork v1.3.0

Drafts only — nothing here has been posted. For the maintainer: post each section's body with

    gh issue comment <n> -R openai/codex-plugin-cc --body-file <file-with-that-section's-body>

Scope: the 18 upstream **issues** (no PRs) filed in the `### fixed-in 1.3.0` bucket of the
"Upstream comment queue" section of `docs/superpowers/triage/2026-09-27-upstream-triage.md`.

Note on attribution: the thanks on #753 and #757 come from an explicit triage note
(`see #762` / `see #763`). The thanks on #698 is grounded in the CHANGELOG's explicit
`(#NNN, PR #NNN)` pairing. The thanks on #483, #548 and #609 are inferred — matched by PR
title/content against the CHANGELOG's "ported with reference to" credit line, since the
triage note for those three issues is blank. Please double-check those three before posting
if that matters to you.

## #459 — Remove unsupported top-level description from hooks.json

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. `hooks.json` no longer declares the unsupported top-level `description` key, so the hook manifest matches what the host actually accepts.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #468 — Current Plugin does not support gpt-5.6 model family

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. Model aliases now resolve against the local Codex catalogue (`$CODEX_HOME/models_cache.json`, then `codex debug models --bundled`, with a hardcoded list only as a last resort), and `--effort` is validated against the resolved model, so newer model families such as GPT-5.6 are recognized without waiting on a plugin release. The same change also covers #703 and #485, which reported the same gap from different angles.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #483 — stop-review-gate-hook.mjs: fail-closed reason strings do not mention the /codex:setup --disable-review-gate escape valve

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. The stop-review gate's fail-closed message now always ends with the `/codex:setup --disable-review-gate` escape hatch, so a blocked turn tells you how to turn the gate off — thanks @SomSamantray for the PR, which we used as reference. Fixed in the same change as #589 (a different defect — dropped signal metadata — resolved alongside this one).

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #485 — codex-rescue agent references stale gpt-5-4-prompting skill; effort hint omits max/ultra (default model is now gpt-5.6-sol)

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. Model aliases now resolve against the local Codex catalogue instead of a hardcoded list, and `--effort` is validated per the resolved model, so the plugin no longer lags behind current model families or effort tiers; the stale `gpt-5-4-prompting` skill name this issue also flagged was already renamed to `codex-prompting` in the earlier 1.2.1 release. Same root cause as #468.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #521 — Predictable os.tmpdir() fallback state dir (0755) + unvalidated broker.json lets a co-located user MITM the Codex IPC and force arbitrary process-kill / file-delete

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. The fallback state directory used when `CLAUDE_PLUGIN_DATA` is unset is now created private (0700) and namespaced per user and per plugin, a symlinked root is refused, and `broker.json` is validated before it's trusted, closing the co-located-user MITM / arbitrary process-kill path this issue described. The same change also tightens the per-plugin isolation reported in #609.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #548 — Stop-review gate hook loops until CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (missing `stop_hook_active` guard)

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. The stop-review gate hook now uses the host's `stop_hook_active` flag when counting prior rounds, and `CODEX_REVIEW_GATE_MAX_ROUNDS` defaults to 3 (previously unbounded) so the hook stops re-invoking itself past that cap; set it to `0` explicitly to keep the old unbounded behavior. Thanks @mittalpk for the PR, which we used as reference.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #589 — stop-review-gate: signal-terminated review loses signal metadata in the fail-closed reason

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. When a review task is killed by a signal, the stop-review gate's fail-closed message now names that signal instead of dropping it. Fixed in the same change as #483 (a different defect — the missing `--disable-review-gate` escape hatch — resolved alongside this one).

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #609 — Plugin state dir has no plugin-identity segment: sibling plugins share one jobs array, and pruneJobs deletes the other plugin's records

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. The plugin's state directory now includes a plugin-identity segment, so sibling plugins no longer share one job-state file and `pruneJobs` can no longer delete another plugin's records — thanks @weivwang for the PR, which we used as reference. Same root cause as #631.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #631 — Companion writes all job state (broker.json, state.json, jobs/) into another plugin's data directory

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. Same root cause as #609: the plugin's state directory now includes a plugin-identity segment, so the companion can no longer write its job state into another plugin's data directory.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #698 — `captureTurn` treats the `error` notification as non-terminal, so a Codex-side failure hangs the turn forever and wedges the job at `status: running`

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. `captureTurn` now treats a terminal `error` notification as ending the turn (failed) instead of reading it as non-terminal and hanging forever; an error carrying `willRetry: true` still lets the turn continue, and a subagent's terminal error no longer fails the main turn. Thanks @ALV0612 for the PR, which we used as reference.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #703 — Skill gpt-5-4-prompting still targets GPT-5.4, retired from the rate card on 2026-08-31

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. Model aliases now resolve against the local Codex catalogue instead of a hardcoded list, and `--effort` is validated per the resolved model, so the plugin tracks current model families instead of a retired one; the skill itself was already renamed from `gpt-5-4-prompting` to `codex-prompting` in the earlier 1.2.1 release. Same root cause as #468.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #721 — /codex:transfer is broken when CLAUDE_CONFIG_DIR is set — Claude transcript root hardcoded to ~/.claude/projects

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. `/codex:transfer` now honors `CLAUDE_CONFIG_DIR` when it resolves Claude session transcripts, instead of always assuming the default `~/.claude/projects` root.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #743 — SessionEnd kills whatever pid `broker.json` names, without checking it is still a broker (pid reuse → SIGTERM to an unrelated process group)

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. `broker.json` (and job records/pid sidecars generally) now carry a `pidIdentity` instead of a bare pid, so a kill target can be verified before it's signalled. When `SessionEnd` can't confirm or deliver a kill, it now leaves that job's record in place and logs `[codex] SessionEnd left <id> running: <reason>`, instead of blindly sending SIGTERM to whatever process now holds the recorded pid. This identity check is posix-only for now — on Windows, kills issued from stored process records stay refused until process identity lands in v1.4.0.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #753 — ensureBrokerSession() deletes a live broker's state without killing it — the only production caller passes no killProcess

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. A live but wedged broker is now killed before `ensureBrokerSession` replaces it, instead of just deleting its state and leaving the old process running — thanks @Soumya95 for the PR, which we used as reference. Same root cause as #782; the identity-checked kill this relies on is posix-only until process identity support lands on Windows in v1.4.0.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #757 — A server-side turn failure that terminates stores no `errorMessage`, so `status` reports the reason as `Summary: {`

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. When a turn fails on the server side without throwing, the job record now persists a real `errorMessage` and a shortened summary, instead of `status` reporting the reason as the truncated `Summary: {`. Thanks @Soumya95 for the PR, which we used as reference.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #769 — Stop review gate has no way to pin the model or reasoning effort it reviews with

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. `setup --review-gate-model <model|inherit> --review-gate-effort <effort|inherit>` now lets you pin the stop-time review gate's model and reasoning effort independently of your regular Codex config.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #781 — captureTurn drops every notification (including turn/completed) when the start response has no turn.id, hanging the job forever

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. `captureTurn` no longer drops every notification (including `turn/completed`) when the initial `turn/start` response comes back without a `turn.id`, so the job no longer hangs forever waiting on notifications it could never match up.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.

## #782 — Broker processes leak on Windows: ensureBrokerSession tears down stale broker without killing it

This is addressed in the CBEPX fork release [v1.3.0](https://github.com/CBEPX/codex-plugin-cc/releases/tag/v1.3.0); see the [changelog](https://github.com/CBEPX/codex-plugin-cc/blob/main/CHANGELOG.md) for the full list of changes. Same root cause as #753: a live but wedged broker is now killed before `ensureBrokerSession` replaces it, instead of leaving the old process running. On Windows specifically, the actual kill is still refused until process identity support lands in v1.4.0 — for now the leak there is only bounded by the broker's idle timeout.

```
claude plugin marketplace add CBEPX/codex-plugin-cc && claude plugin install codex@cbepx
```

This is a fork release, not an upstream fix, so I'm leaving this issue open for the maintainers here.
