#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { readHookInput } from "./lib/hook-input.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, setConfig, listJobs, resolveStateFile, retryOnWindows } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { reapDeadJobs, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MINUTES = 13;
const STOP_REVIEW_TIMEOUT_MS = STOP_REVIEW_TIMEOUT_MINUTES * 60 * 1000;
// Tests only: shorten the review timeout instead of waiting the full 13 minutes.
const STOP_REVIEW_TIMEOUT_OVERRIDE_MS = Number(process.env.CODEX_STOP_REVIEW_TIMEOUT_MS) > 0 ? Number(process.env.CODEX_STOP_REVIEW_TIMEOUT_MS) : 0;
const DEFAULT_MAX_ROUNDS = 3;
const ESCAPE_HATCH = "Disable with /codex:setup --disable-review-gate.";
const MANUAL_HINT = `Run /codex:review --wait manually. ${ESCAPE_HATCH}`;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const GATE_ROUNDS_CONFIG_KEY = "stopReviewGateRoundsBySession";

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

// Cap on how many consecutive gate-induced rounds run in one session.
// Unset → DEFAULT_MAX_ROUNDS; an explicit 0 keeps the rounds unbounded; anything
// but a non-negative integer (0.5, 0x10, -1) → DEFAULT_MAX_ROUNDS with a warning.
function getMaxRounds() {
  const raw = process.env.CODEX_REVIEW_GATE_MAX_ROUNDS;
  if (raw == null || raw === "") {
    return DEFAULT_MAX_ROUNDS;
  }
  const parsed = /^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  logNote(`Ignoring CODEX_REVIEW_GATE_MAX_ROUNDS=${JSON.stringify(raw)}: not a plain digit string; using ${DEFAULT_MAX_ROUNDS}.`);
  return DEFAULT_MAX_ROUNDS;
}

function gateSessionId(input) {
  return input.session_id || process.env[SESSION_ID_ENV] || "default";
}

function readGateRounds(workspaceRoot, sessionId) {
  const rounds = getConfig(workspaceRoot)[GATE_ROUNDS_CONFIG_KEY];
  if (!rounds || typeof rounds !== "object") {
    return 0;
  }
  return Number(rounds[sessionId]) || 0;
}

function writeGateRounds(workspaceRoot, sessionId, count) {
  const current = getConfig(workspaceRoot)[GATE_ROUNDS_CONFIG_KEY];
  const next = current && typeof current === "object" ? { ...current } : {};
  if (count > 0) {
    next[sessionId] = count;
  } else {
    delete next[sessionId];
  }
  setConfig(workspaceRoot, GATE_ROUNDS_CONFIG_KEY, next);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        `The stop-time Codex review task returned no final output. ${MANUAL_HINT}`
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      `The stop-time Codex review task returned an unexpected answer. ${MANUAL_HINT}`
  };
}

function runStopReview(cwd, input = {}, config = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const args = [scriptPath, "task", "--json"];
  if (config.stopReviewGateModel) {
    args.push("--model", config.stopReviewGateModel);
  }
  if (config.stopReviewGateEffort) {
    args.push("--effort", config.stopReviewGateEffort);
  }
  // Via stdin, not argv: a long last_assistant_message overruns the argv limit
  // (32 KiB on Windows, 128 KiB per argument on Linux).
  args.push("--prompt-stdin");
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: childEnv,
    input: prompt,
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(STOP_REVIEW_TIMEOUT_OVERRIDE_MS || STOP_REVIEW_TIMEOUT_MS)),
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024
  });

  if (result.error?.code === "ETIMEDOUT") {
    const limit = STOP_REVIEW_TIMEOUT_OVERRIDE_MS ? `${STOP_REVIEW_TIMEOUT_OVERRIDE_MS} ms` : `${STOP_REVIEW_TIMEOUT_MINUTES} minutes`;
    return {
      ok: false,
      reason: `The stop-time Codex review task timed out after ${limit} and was terminated by signal ${result.signal ?? "SIGKILL"}. ${MANUAL_HINT}`
    };
  }

  if (result.signal) {
    return {
      ok: false,
      reason: `The stop-time Codex review task was terminated by signal ${result.signal}. ${MANUAL_HINT}`
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail} ${ESCAPE_HATCH}`
        : `The stop-time Codex review task failed. ${MANUAL_HINT}`
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        `The stop-time Codex review task returned invalid JSON. ${MANUAL_HINT}`
    };
  }
}

// Read directly, not via getConfig: loadState turns an unreadable or corrupt
// state file into defaults (gate off), which must not open the gate.
function gateEnabledForProject() {
  try {
    const stateFile = resolveStateFile(resolveWorkspaceRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd()));
    if (!fs.existsSync(stateFile)) {
      return false;
    }
    return Boolean(JSON.parse(retryOnWindows(() => fs.readFileSync(stateFile, "utf8"), ["EPERM", "EBUSY"])).config?.stopReviewGate);
  } catch {
    return true;
  }
}

async function main() {
  const { input, error } = await readHookInput();
  if (error) {
    // Gate off (as stored, unreadable counts as on): allow when nothing arrived
    // (#530) or the input overflowed, since a disabled gate never blocked. Every
    // other case (gate on, partial input, invalid JSON, read error) blocks.
    if (((error.code === "timeout" && error.bytes === 0) || error.code === "overflow") && !gateEnabledForProject()) {
      return;
    }
    emitDecision({
      decision: "block",
      reason:
        error.code === "invalid-json"
          ? "The stop review gate could not read or parse hook input; refusing to fail open."
          : `The stop review gate could not read hook input (${error.message}); refusing to fail open. ${ESCAPE_HATCH}`
    });
    return;
  }
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot)), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const sessionId = gateSessionId(input);
  const maxRounds = getMaxRounds();
  // A fresh user turn (not a gate-induced continuation) starts a new count.
  const priorRounds = input.stop_hook_active ? readGateRounds(workspaceRoot, sessionId) : 0;

  if (maxRounds > 0 && priorRounds >= maxRounds) {
    writeGateRounds(workspaceRoot, sessionId, 0);
    logNote(
      `Codex stop-time review gate reached its limit of ${maxRounds} round(s) for this session; allowing the stop. ` +
        "Set CODEX_REVIEW_GATE_MAX_ROUNDS to adjust, or run /codex:review --wait manually for another pass."
    );
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input, config);
  if (!review.ok) {
    writeGateRounds(workspaceRoot, sessionId, priorRounds + 1);
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  writeGateRounds(workspaceRoot, sessionId, 0);
  logNote(runningTaskNote);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
