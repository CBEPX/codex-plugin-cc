import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import { loadModelCatalog, resolveModelAlias, supportedEfforts } from "./model-catalog.mjs";
import { boundedReadView, exportReadPayload } from "./read-views.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const COMPANION_SCRIPT = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
export const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

export function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--review-gate-model <model|inherit>] [--review-gate-effort <effort|inherit>] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|astra|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--turn-timeout-ms <ms>] [--config key=value]...",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark|astra|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--turn-timeout-ms <ms>] [--config key=value]... [focus text]",
      "  node scripts/codex-companion.mjs task [--background|--await [--await-timeout-ms <ms>]] [--prompt-stdin] [--write] [--resume-last|--resume|--fresh] [--model <model|spark|astra|sol|luna|terra|mini>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--turn-timeout-ms <ms>] [--config key=value]... [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json] [--output <new-path>]",
      "  node scripts/codex-companion.mjs result [job-id] [--wait [--timeout-ms <ms>]] [--json] [--output <new-path>]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "",
      "Any subcommand also accepts --args-stdin: the whole argument string is read",
      "from stdin and tokenized here, so no shell ever sees the caller's text.",
      "`task --prompt-stdin` instead takes stdin verbatim as the prompt, so flags",
      "must be on the command line and --args-stdin cannot be combined with it.",
      "`task --await` and `result --wait` exit 3 with a re-run hint on timeout.",
      "--turn-timeout-ms (or CODEX_TURN_TIMEOUT_MS) fails a single Codex turn after",
      "that many ms — it interrupts the turn and returns a structured failed result;",
      "unset means unbounded."
    ].join("\n")
  );
}

export function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

export function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

// Rows 1–4 of the read-view table (spec §3.2): the bounded view — at most
// PUBLIC_READ_BYTES — on stdout or, with `--output`, the full payload in a new
// 0600 file and its receipt, always JSON, on stdout. `render` gets the projected
// view, never the original, so text mode is bounded too. `asJson === true`:
// without `--json` the option is undefined, and boundedReadView defaults to JSON.
export function outputReadView(payload, render, { asJson, summary, nextStep, outputPath = null, cwd }) {
  if (outputPath != null) {
    outputResult(exportReadPayload(payload, outputPath, cwd), true);
    return;
  }
  process.stdout.write(boundedReadView(payload, { summary, render, asJson: asJson === true, nextStep }).text);
}

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return resolveModelAlias(normalized, loadModelCatalog());
}

export function normalizeReasoningEffort(effort, model = null) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`
    );
  }
  if (model) {
    const allowed = supportedEfforts(model, loadModelCatalog());
    if (allowed && !allowed.includes(normalized)) {
      throw new Error(`Reasoning effort "${normalized}" is not supported by ${model}. ${model} supports: ${allowed.join(", ")}.`);
    }
  }
  return normalized;
}

export function parseConfigOverrides(list = []) {
  const config = {};
  for (const pair of list) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--config expects key=value, got "${pair}".`);
    }
    config[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return config;
}

// Claude Code substitutes `$ARGUMENTS` (and a rescue request's text) into the
// command body *before* bash runs it, so any `$(...)`/backtick the user typed
// would execute on the host shell, outside Codex's sandbox. Command bodies feed
// the raw argument string in through a quoted heredoc on stdin instead, and
// `--args-stdin` tokenizes it here with the same shell-like splitter
// `normalizeArgv` already uses — never through a shell.
const ARGS_STDIN_FLAG = "--args-stdin";
export const PROMPT_STDIN_FLAG = "--prompt-stdin";
let argvTokenizedFromStdin = false;

export function applyArgsStdin(argv) {
  const flagIndex = argv.indexOf(ARGS_STDIN_FLAG);

  // Decided before anything reads stdin: both flags consume it and it can only
  // be read once. `--prompt-stdin` therefore has to be on the command line, and
  // is never visible inside the `--args-stdin` heredoc.
  if (argv.includes(PROMPT_STDIN_FLAG)) {
    if (flagIndex !== -1) {
      throw new Error(
        `${PROMPT_STDIN_FLAG} cannot be combined with ${ARGS_STDIN_FLAG}; put flags on the command line.`
      );
    }
    return argv;
  }

  if (flagIndex === -1) {
    return argv;
  }
  argvTokenizedFromStdin = true;
  return [
    ...argv.slice(0, flagIndex),
    ...splitRawArgumentString(readStdinIfPiped()),
    ...argv.slice(flagIndex + 1)
  ];
}

export function normalizeArgv(argv) {
  if (!argvTokenizedFromStdin && argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

export function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    rejectUnknownOptions: true,
    ...config,
    booleanOptions: ["help", ...(config.booleanOptions ?? [])],
    aliasMap: {
      C: "cwd",
      h: "help",
      ...(config.aliasMap ?? {})
    }
  });
}

export function maybePrintCommandHelp(options) {
  if (!options.help) {
    return false;
  }
  printUsage();
  return true;
}

export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

export function parseTimeoutOption(value, flag) {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer number of milliseconds, got "${value}".`);
  }
  return parsed;
}
