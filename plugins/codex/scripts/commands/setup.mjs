import process from "node:process";

import {
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  outputResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace
} from "../lib/cli.mjs";
import { getCodexAuthStatus, getCodexAvailability, getSessionRuntimeStatus } from "../lib/codex.mjs";
import { binaryAvailable } from "../lib/process.mjs";
import { getConfig, setConfig } from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { renderSetupReport } from "../lib/render.mjs";

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    reviewGateModel: config.stopReviewGateModel ?? null,
    reviewGateEffort: config.stopReviewGateEffort ?? null,
    actionsTaken,
    nextSteps
  };
}

export async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "review-gate-model", "review-gate-effort"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (maybePrintCommandHelp(options)) {
    return;
  }

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  // Validate everything before writing anything: a rejected effort must not
  // leave a half-applied gate configuration behind.
  const isInherit = (value) => String(value).trim().toLowerCase() === "inherit";
  const modelGiven = options["review-gate-model"] != null;
  const effortGiven = options["review-gate-effort"] != null;
  for (const flag of ["review-gate-model", "review-gate-effort"]) {
    if (options[flag] != null && String(options[flag]).trim() === "") {
      throw new Error(`--${flag} needs a value; use inherit to clear it.`);
    }
  }
  const config = getConfig(workspaceRoot);
  const newModel = modelGiven && !isInherit(options["review-gate-model"]) ? normalizeRequestedModel(options["review-gate-model"]) : null;
  const effectiveModel = modelGiven ? newModel : (config.stopReviewGateModel ?? null);
  const newEffort =
    effortGiven && !isInherit(options["review-gate-effort"]) ? normalizeReasoningEffort(options["review-gate-effort"], effectiveModel) : null;
  // A model-only change must still fit the effort already stored with it.
  if (modelGiven && !effortGiven) {
    normalizeReasoningEffort(config.stopReviewGateEffort ?? null, effectiveModel);
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }
  if (modelGiven) {
    setConfig(workspaceRoot, "stopReviewGateModel", newModel);
    actionsTaken.push(newModel ? `Stop-time review gate model set to ${newModel}.` : "Stop-time review gate model now inherits Codex config.");
  }
  if (effortGiven) {
    setConfig(workspaceRoot, "stopReviewGateEffort", newEffort);
    actionsTaken.push(newEffort ? `Stop-time review gate effort set to ${newEffort}.` : "Stop-time review gate effort now inherits Codex config.");
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}
