import {
  maybePrintCommandHelp,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  parseCommandInput,
  parseConfigOverrides,
  parseTimeoutOption,
  resolveCommandCwd,
  resolveCommandWorkspace,
  REVIEW_SCHEMA,
  ROOT_DIR
} from "../lib/cli.mjs";
import { buildReviewThreadName, parseStructuredOutput, readOutputSchema, runAppServerReview, runAppServerTurn } from "../lib/codex.mjs";
import { buildAdversarialCollectionGuidance, collectReviewContext, ensureGitRepository, resolveReviewTarget } from "../lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../lib/prompts.mjs";
import { renderNativeReviewResult, renderReviewResult, validateReviewResultShape } from "../lib/render.mjs";
import { createCompanionJob, ensureCodexAvailable, firstMeaningfulLine, runForegroundCommand } from "./shared.mjs";

// 75 % of Codex's 1,048,576-character input limit; the rest covers the template
// and the output schema (#405). `length` counts UTF-16 units, never fewer than
// code points, so the check errs on the safe side.
export const MAX_REVIEW_PROMPT_CHARS = 786432;

function truncationMarker(characters) {
  return `[Repository context truncated at ${characters} characters: inspect the target yourself with read-only git commands before finalizing findings.]`;
}

export function buildAdversarialReviewPrompt(context, focusText, onLog = null) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const variables = {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  };
  const prompt = interpolateTemplate(template, variables);
  if (prompt.length <= MAX_REVIEW_PROMPT_CHARS) {
    return prompt;
  }

  // Over the ceiling: keep whole lines of the context, say where it stops, and
  // have Codex collect the rest itself.
  const content = context.content;
  const selfCollect = { ...variables, REVIEW_COLLECTION_GUIDANCE: buildAdversarialCollectionGuidance({ includeDiff: false }) };
  const frame = interpolateTemplate(template, { ...selfCollect, REVIEW_INPUT: "" }).length;
  const budget = MAX_REVIEW_PROMPT_CHARS - frame - truncationMarker(content.length).length;
  const cutAt = budget > 0 ? content.lastIndexOf("\n", budget - 1) : -1;
  const kept = content.slice(0, cutAt + 1);
  onLog?.(`Review context truncated to fit the prompt ceiling (${kept.length} of ${content.length} characters).`);
  return interpolateTemplate(template, { ...selfCollect, REVIEW_INPUT: `${kept}${truncationMarker(kept.length)}` });
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      effort: request.effort,
      config: request.config,
      turnTimeoutMs: request.turnTimeoutMs,
      threadName: buildReviewThreadName(reviewName, focusText || target.label),
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      resolved: result.resolved,
      appServerExited: result.appServerExited,
      payload,
      rendered,
      errorMessage: result.error?.message ?? null,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText, request.onProgress);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort,
    config: request.config,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    turnTimeoutMs: request.turnTimeoutMs,
    persistThread: true,
    threadName: buildReviewThreadName(reviewName, focusText || context.target.label),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  if (parsed.parseError === null) {
    const validationError = validateReviewResultShape(parsed.parsed);
    if (validationError) {
      parsed.parsed = null;
      parsed.parseError = `Invalid review shape: ${validationError}`;
    }
  }
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    resolved: result.resolved,
    appServerExited: result.appServerExited,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    errorMessage: result.error?.message ?? null,
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

// One option table for `review` and `adversarial-review`. main hands it to
// applyArgsStdin so `--args-stdin` knows which flags take a value before the
// verbatim focus (#714). Text after the first positional is focus even when
// it looks like a flag (#547).
export const REVIEW_ARG_SPEC = {
  valueOptions: ["base", "scope", "model", "effort", "cwd", "turn-timeout-ms"],
  booleanOptions: ["json", "background", "wait"],
  repeatableOptions: ["config"],
  stopAtFirstPositional: true,
  aliasMap: { m: "model" }
};

export async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, REVIEW_ARG_SPEC);
  if (maybePrintCommandHelp(options)) {
    return;
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort, model);
  const configOverrides = parseConfigOverrides(options.config);
  const turnTimeoutMs = parseTimeoutOption(options["turn-timeout-ms"], "--turn-timeout-ms");
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    // A `--background` review is dispatched (under `nohup`/`&`) to outlive the
    // session that started it, so its record has to outlive it too.
    background: Boolean(options.background)
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        config: configOverrides,
        focusText,
        reviewName: config.reviewName,
        turnTimeoutMs,
        onProgress: progress
      }),
    { json: options.json }
  );
}

export async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}
