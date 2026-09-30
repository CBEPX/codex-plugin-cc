import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// `status` and `result` (without `--wait`) print at most this many bytes, text
// or JSON. The full payload goes to a file with `--output <new-path>`.
export const PUBLIC_READ_BYTES = 8192;
const MAX_DEPTH = 12;
// Bodies a summary view (every `status` read, an active job's `result` hint)
// leaves out: the prompt and config keys, the stored result, its rendering.
const SUMMARY_FIELDS = new Set(["request", "result", "rendered"]);

const EXPORT_NEXT_STEP = "Use --output <new-path> for the complete JSON payload.";

export function statusNextStep(omittedJobs) {
  return omittedJobs > 0
    ? "Use --all to include omitted records, with --output <new-path> for the complete JSON payload."
    : EXPORT_NEXT_STEP;
}

export function resultNextStep(jobId) {
  return `Full output: \`result ${jobId} --wait\` (text) or \`result ${jobId} --output <new-path>\` (JSON).`;
}

// The longest prefix of `value` that fits in `maxBytes` UTF-8 bytes and does
// not end in the high half of a surrogate pair. A prefix of `maxBytes` code
// units already has at least `maxBytes` bytes, so the scan starts there.
function cutString(value, maxBytes) {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

// A copy of `value` with strings and arrays shrunk to `limits`, objects past
// MAX_DEPTH replaced by null and, in summary mode, the bodies dropped. Every
// loss is counted in `omissions`; `cuts` counts the losses a text renderer
// could have shown (not the deliberate summary drops). Values shrink before
// serialization, so the JSON printed from the copy is never cut mid-token.
function project(value, limits, summary, omissions, cuts, depth) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= limits.string) {
      return value;
    }
    omissions.strings += 1;
    cuts.count += 1;
    return `${cutString(value, limits.string)}…`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > MAX_DEPTH) {
    omissions.fields += 1;
    cuts.count += 1;
    return null;
  }
  if (Array.isArray(value)) {
    const sliced = Math.max(0, value.length - limits.items);
    omissions.records += sliced;
    cuts.count += sliced;
    return value.slice(0, limits.items).map((item) => project(item, limits, summary, omissions, cuts, depth + 1));
  }
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (summary && SUMMARY_FIELDS.has(key) && item != null) {
      omissions.fields += 1;
      if (Array.isArray(item)) {
        omissions.records += item.length;
      }
      if (!omissions.fieldNames.includes(key)) {
        omissions.fieldNames.push(key);
      }
      continue;
    }
    // defineProperty, not assignment: a JSON key "__proto__" stays an own key
    // instead of hitting the inherited setter and vanishing.
    Object.defineProperty(projected, key, {
      value: project(item, limits, summary, omissions, cuts, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return projected;
}

// The view a read command prints: the payload itself when it fits, otherwise
// the first projection whose PRINTED form (JSON, or `render`'s text plus the
// Truncated block) fits in PUBLIC_READ_BYTES. Unlike the cc-plugin-codex
// original the check is on the printed bytes: a `result` JSON view repeats the
// output three times (`rendered`, `result.rawOutput`, `codex.stdout`), so a
// JSON-size check would shrink small text results for nothing. Summary views
// (lists) start at 512-byte strings like the original, keeping 8 records; a
// `result` preview starts at 4096 bytes.
export function boundedReadView(payload, { summary = false, render = null, asJson = true, nextStep } = {}) {
  const omittedRecords = Number(payload?.omittedJobs) || 0;
  const asText = asJson === false && typeof render === "function";
  let limits = { string: Infinity, items: Infinity };
  for (;;) {
    const omissions = { fields: 0, fieldNames: [], records: omittedRecords, strings: 0 };
    const cuts = { count: omittedRecords };
    const projected = project(payload, limits, summary, omissions, cuts, 0);
    const truncated = omissions.fields + omissions.records + omissions.strings > 0;
    // Text reports only what it could have shown: a summary drop alone is no
    // truncation there (no text renderer prints `request`, `result`, `rendered`).
    const shortened = cuts.count > 0;
    const view = { ...projected, truncated, omissions, ...(truncated ? { nextStep } : {}) };
    let text;
    if (!asText) {
      text = `${JSON.stringify(view, null, 2)}\n`;
    } else if (shortened) {
      text = `${render(projected).trimEnd()}\n\nTruncated: ${JSON.stringify(omissions)}\n${nextStep}\n`;
    } else {
      text = render(projected);
    }
    if (Buffer.byteLength(text) <= PUBLIC_READ_BYTES) {
      return { view, text, complete: asText ? !shortened : !truncated };
    }
    limits = limits.string === Infinity
      ? { string: summary ? 512 : 4096, items: 8 }
      : { string: Math.floor(limits.string / 2), items: Math.floor(limits.items / 2) };
    if (limits.string === 0 && limits.items === 0) {
      return bottomOut(payload, omittedRecords, asText, nextStep);
    }
  }
}

// Nothing fits: an object with thousands of keys, or a `nextStep` that is itself
// too long (a job id of any length appears twice in `resultNextStep`). The
// fallback is measured too; when the caller's instruction does not fit, the
// fixed EXPORT_NEXT_STEP (no id, no path) is printed instead.
function bottomOut(payload, omittedRecords, asText, nextStep) {
  const omissions = { fields: Object.keys(payload ?? {}).length, fieldNames: [], records: omittedRecords, strings: 0 };
  const print = (step) => {
    const view = { truncated: true, omissions, nextStep: step };
    const text = asText
      ? `Truncated: output exceeds ${PUBLIC_READ_BYTES} bytes.\n${step}\n`
      : `${JSON.stringify(view, null, 2)}\n`;
    return { view, text, complete: false };
  };
  const printed = print(nextStep);
  return Buffer.byteLength(printed.text) <= PUBLIC_READ_BYTES ? printed : print(EXPORT_NEXT_STEP);
}

function outputExistsError(outputFile) {
  return new Error(`--output ${outputFile} already exists; pass a new path.`);
}

// Fails at once when anything (file, directory, symlink, dangling symlink) is
// at the path, so `status <id> --wait --output` does not wait minutes first.
// A courtesy, not a security boundary: exportReadPayload's `wx` open is the guard.
export function assertOutputPathFree(outputPath, cwd) {
  const outputFile = path.resolve(cwd, outputPath);
  try {
    fs.lstatSync(outputFile);
  } catch {
    return;
  }
  throw outputExistsError(outputFile);
}

// `--output <new-path>`: the full payload, exactly what `--json` printed before
// 1.5.0, in a new owner-only file. O_CREAT|O_EXCL never overwrites and never
// follows a symlink (a dangling one too): all of them are EEXIST. On Windows the
// mode is ignored (the directory ACL applies) and `wx` stays exclusive.
export function exportReadPayload(payload, outputPath, cwd) {
  const outputFile = path.resolve(cwd, outputPath);
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // The receipt is printed whole (never a shortened path or checksum), so a
  // path whose receipt would not fit in PUBLIC_READ_BYTES is refused up front.
  const receipt = { outputFile, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`) > PUBLIC_READ_BYTES) {
    throw new Error(`--output path is too long: its receipt would exceed ${PUBLIC_READ_BYTES} bytes; pass a shorter path.`);
  }
  let fd;
  try {
    fd = fs.openSync(outputFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw outputExistsError(outputFile);
    }
    throw error;
  }
  let created = null;
  try {
    created = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, bytes);
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {}
    // Remove only the file this call created: the path may name another entry by now.
    try {
      const current = fs.lstatSync(outputFile, { bigint: true });
      if (created && current.dev === created.dev && current.ino === created.ino) {
        fs.unlinkSync(outputFile);
      }
    } catch {}
    throw error;
  }
  return receipt;
}
