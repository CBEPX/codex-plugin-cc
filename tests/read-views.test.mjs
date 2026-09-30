import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { IS_WIN, makeTempDir } from "./helpers.mjs";
import {
  PUBLIC_READ_BYTES,
  assertOutputPathFree,
  boundedReadView,
  exportReadPayload,
  resultNextStep,
  statusNextStep
} from "../plugins/codex/scripts/lib/read-views.mjs";

const NEXT = "Use --output <new-path> for the complete JSON payload.";
const bytes = (text) => Buffer.byteLength(text);

test("a small payload is complete and printed as plain JSON", () => {
  const payload = { job: { id: "task-1", status: "completed" }, count: 2 };
  const { view, text, complete } = boundedReadView(payload, { nextStep: NEXT });
  assert.equal(complete, true);
  assert.equal(view.truncated, false);
  assert.equal("nextStep" in view, false);
  assert.deepEqual(view.omissions, { fields: 0, fieldNames: [], records: 0, strings: 0 });
  assert.equal(text, `${JSON.stringify({ ...payload, truncated: false, omissions: view.omissions }, null, 2)}\n`);
});

test("a 60 KB string shrinks to parseable JSON within the limit; keys, numbers and booleans survive", () => {
  const payload = {
    job: { id: "task-1", status: "running" },
    waitTimedOut: true,
    timeoutMs: 25,
    resumeCommand: "node x result task-1 --wait",
    body: "x".repeat(60_000)
  };
  const { view, text, complete } = boundedReadView(payload, { nextStep: NEXT });
  assert.equal(complete, false);
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES, `${bytes(text)} bytes`);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, view);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.omissions.strings >= 1);
  assert.equal(parsed.nextStep, NEXT);
  assert.equal(parsed.body, `${"x".repeat(4096)}…`, "the first shrink step keeps 4096 bytes");
  assert.deepEqual(
    [parsed.job.status, parsed.waitTimedOut, parsed.timeoutMs, parsed.resumeCommand],
    ["running", true, 25, payload.resumeCommand]
  );
});

test("summary mode drops non-null request, result and rendered at any depth and names them", () => {
  const payload = {
    job: { id: "task-1", request: { prompt: "p" }, result: null },
    storedJob: { rendered: "r", nested: { result: { rawOutput: "o" } } }
  };
  const { view } = boundedReadView(payload, { summary: true, nextStep: NEXT });
  assert.equal(view.truncated, true);
  assert.deepEqual(view.omissions.fieldNames, ["request", "rendered", "result"]);
  assert.equal(view.omissions.fields, 3);
  assert.equal("request" in view.job, false);
  assert.equal(view.job.result, null, "a null field is kept and not counted");
  assert.deepEqual(view.storedJob, { nested: {} });
  const full = boundedReadView(payload, { nextStep: NEXT }).view;
  assert.equal(full.truncated, false, "without summary nothing is dropped");
  assert.equal(full.job.request.prompt, "p");
});

test("omittedJobs counts as omitted records; the next-step strings", () => {
  const nextStep = statusNextStep(3);
  const { view, complete } = boundedReadView({ omittedJobs: 3, recent: [] }, { summary: true, nextStep });
  assert.equal(complete, false);
  assert.equal(view.omissions.records, 3);
  assert.equal(view.nextStep, "Use --all to include omitted records, with --output <new-path> for the complete JSON payload.");
  assert.equal(statusNextStep(0), NEXT);
  assert.equal(
    resultNextStep("task-9"),
    "Full output: `result task-9 --wait` (text) or `result task-9 --output <new-path>` (JSON)."
  );
});

test("strings that do not fit at 4096 bytes shrink in later rounds and still parse", () => {
  const payload = { a: "a".repeat(60_000), b: "b".repeat(60_000), c: "c".repeat(60_000) };
  const { view, text } = boundedReadView(payload, { nextStep: NEXT });
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES, `${bytes(text)} bytes`);
  assert.deepEqual(JSON.parse(text), view);
  assert.equal(view.a, `${"a".repeat(2048)}…`, "3 × 4096 bytes is over the limit, 3 × 2048 is not");
  assert.equal(view.omissions.strings, 3);
});

test("a summary drop alone truncates the JSON view but not the text", () => {
  const payload = { job: { id: "task-1", status: "running", request: { prompt: "p".repeat(60_000) } } };
  const json = boundedReadView(payload, { summary: true, nextStep: NEXT });
  assert.equal(json.complete, false);
  assert.equal(json.view.truncated, true);
  assert.deepEqual(json.view.omissions.fieldNames, ["request"]);
  assert.equal(JSON.parse(json.text).nextStep, NEXT);
  const text = boundedReadView(payload, { summary: true, render: (view) => `${view.job.id} ${view.job.status}\n`, asJson: false, nextStep: NEXT });
  assert.equal(text.complete, true);
  assert.equal(text.text, "task-1 running\n", "no Truncated: block for a field the text never shows");
});

test("a summary view keeps eight records with 512-byte strings; a result view starts at 4096", () => {
  const recent = Array.from({ length: 8 }, (_, index) => ({ id: `job-${index}`, note: "n".repeat(5000) }));
  const { view, text } = boundedReadView({ recent }, { summary: true, nextStep: NEXT });
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES, `${bytes(text)} bytes`);
  assert.equal(view.recent.length, 8, "all eight records survive the first shrink step");
  assert.ok(view.recent.every((record) => record.note === `${"n".repeat(512)}…`));
  assert.equal(boundedReadView({ body: "r".repeat(20_000) }, { nextStep: NEXT }).view.body, `${"r".repeat(4096)}…`);
});

test("a summary-dropped array counts its records, in JSON only", () => {
  const payload = { job: { id: "task-1", result: [{ a: 1 }, { b: 2 }, { c: 3 }] } };
  const json = boundedReadView(payload, { summary: true, nextStep: NEXT });
  assert.deepEqual(json.view.omissions, { fields: 1, fieldNames: ["result"], records: 3, strings: 0 });
  const text = boundedReadView(payload, { summary: true, render: (view) => `${view.job.id}\n`, asJson: false, nextStep: NEXT });
  assert.equal(text.text, "task-1\n", "records the text never showed do not print a Truncated: block");
  assert.equal(text.complete, true);
});

test("a depth-limit null counts as shortened in text mode", () => {
  let deep = { leaf: "shown" };
  for (let level = 0; level < 15; level += 1) {
    deep = { d: deep };
  }
  const text = boundedReadView(deep, { render: () => "deep\n", asJson: false, nextStep: NEXT });
  assert.equal(text.complete, false);
  assert.equal(text.text, `deep\n\nTruncated: {"fields":1,"fieldNames":[],"records":0,"strings":0}\n${NEXT}\n`);
});

test("a __proto__ key stays an own key through every round", () => {
  const payload = JSON.parse(`{"safe":1,"__proto__":{"kept":2},"body":"${"b".repeat(60_000)}"}`);
  const { view, text } = boundedReadView(payload, { nextStep: NEXT });
  const parsed = JSON.parse(text);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), text.slice(0, 200));
  assert.deepEqual(parsed["__proto__"], { kept: 2 });
  assert.ok(Object.prototype.hasOwnProperty.call(view, "__proto__"));
  assert.deepEqual(view.omissions, { fields: 0, fieldNames: [], records: 0, strings: 1 });
});

test("an oversized next step falls back to the fixed export instruction in both formats", () => {
  const payload = { body: "x".repeat(60_000) };
  for (const nextStep of ["n".repeat(9000), resultNextStep("j".repeat(5000))]) {
    const json = boundedReadView(payload, { nextStep });
    assert.ok(bytes(json.text) <= PUBLIC_READ_BYTES, `${bytes(json.text)} bytes`);
    assert.deepEqual(JSON.parse(json.text), { truncated: true, omissions: { fields: 1, fieldNames: [], records: 0, strings: 0 }, nextStep: NEXT });
    const text = boundedReadView(payload, { render: (view) => `${view.body}\n`, asJson: false, nextStep });
    assert.equal(text.text, `Truncated: output exceeds 8192 bytes.\n${NEXT}\n`);
    assert.equal(text.complete, false);
  }
});

test("arrays are cut to the item limit and the cut items are counted", () => {
  const payload = { recent: Array.from({ length: 40 }, (_, index) => ({ id: `job-${index}`, note: "n".repeat(300) })) };
  const { view, text } = boundedReadView(payload, { nextStep: NEXT });
  assert.ok(bytes(text) <= PUBLIC_READ_BYTES);
  assert.equal(view.recent.length, 8);
  assert.equal(view.omissions.records, 32);
});

test("text mode prints the render, then the Truncated line and the next step, within the limit", () => {
  const render = (view) => `# Result\n\n${view.body}\n`;
  const small = boundedReadView({ body: "short" }, { render, asJson: false, nextStep: NEXT });
  assert.equal(small.text, "# Result\n\nshort\n");
  assert.equal(small.complete, true);
  const large = boundedReadView({ body: "y".repeat(60_000) }, { render, asJson: false, nextStep: NEXT });
  assert.ok(bytes(large.text) <= PUBLIC_READ_BYTES);
  assert.equal(
    large.text,
    `# Result\n\n${"y".repeat(4096)}…\n\nTruncated: {"fields":0,"fieldNames":[],"records":0,"strings":1}\n${NEXT}\n`
  );
});

test("the text-mode size check is on the printed bytes, not on the JSON view", () => {
  const text3k = "z".repeat(3000);
  const payload = { rendered: text3k, rawOutput: text3k, stdout: text3k };
  const render = (view) => `${view.rendered}\n`;
  const printed = boundedReadView(payload, { render, asJson: false, nextStep: NEXT });
  assert.equal(printed.complete, true);
  assert.equal(printed.text, `${text3k}\n`);
  assert.equal(boundedReadView(payload, { nextStep: NEXT }).complete, false, "the same payload as JSON is over the limit");
});

test("strings are cut on a code-point boundary within the byte limit", () => {
  const { view } = boundedReadView({ s: `a${"😀".repeat(5000)}` }, { nextStep: NEXT });
  assert.equal(view.s.at(-1), "…");
  const cut = view.s.slice(0, -1);
  assert.equal(bytes(cut), 4093, "1 + 1023 × 4 bytes: the 1024th emoji's lone high surrogate is dropped");
  assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut, "no lone surrogate");
});

test("nesting deeper than 12 levels becomes null", () => {
  let deep = { leaf: 1 };
  for (let level = 0; level < 15; level += 1) {
    deep = { d: deep };
  }
  const { view } = boundedReadView(deep, { nextStep: NEXT });
  let node = view;
  for (let level = 0; level < 12; level += 1) {
    node = node.d;
  }
  assert.equal(node.d, null);
  assert.equal(view.omissions.fields, 1);
  assert.equal(view.truncated, true);
});

test("a payload too wide for any limit bottoms out to the minimal view", () => {
  const wide = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`key${String(index).padStart(4, "0")}`, "v"]));
  const json = boundedReadView(wide, { nextStep: NEXT });
  assert.equal(json.complete, false);
  assert.deepEqual(json.view, { truncated: true, omissions: { fields: 2000, fieldNames: [], records: 0, strings: 0 }, nextStep: NEXT });
  assert.equal(json.text, `${JSON.stringify(json.view, null, 2)}\n`);
  const text = boundedReadView(wide, { render: () => "x".repeat(9000), asJson: false, nextStep: NEXT });
  assert.equal(text.text, `Truncated: output exceeds 8192 bytes.\n${NEXT}\n`);
});

test("exportReadPayload writes the full JSON to a new file and returns its receipt", () => {
  const dir = makeTempDir();
  const payload = { job: { id: "task-1" }, body: "😀".repeat(20_000) };
  const receipt = exportReadPayload(payload, "full.json", dir);
  const outputFile = path.join(dir, "full.json");
  const written = fs.readFileSync(outputFile);
  assert.deepEqual(receipt, { outputFile, bytes: written.length, sha256: createHash("sha256").update(written).digest("hex") });
  assert.equal(written.toString("utf8"), `${JSON.stringify(payload, null, 2)}\n`);
  const absolute = path.join(dir, "absolute.json");
  assert.equal(exportReadPayload(payload, absolute, makeTempDir()).outputFile, absolute, "an absolute path ignores cwd");
});

test("exportReadPayload refuses a path whose receipt would not fit, before creating anything", () => {
  const dir = makeTempDir();
  // Each U+0001 is 6 bytes once JSON-escaped: 1400 of them push the receipt past 8192 bytes.
  assert.throws(() => exportReadPayload({ a: 1 }, `${"\u0001".repeat(1400)}.json`, dir), {
    message: "--output path is too long: its receipt would exceed 8192 bytes; pass a shorter path."
  });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("exportReadPayload creates the file owner-only", { skip: IS_WIN }, () => {
  const { outputFile } = exportReadPayload({ a: 1 }, "private.json", makeTempDir());
  assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
});

test("exportReadPayload refuses an existing file untouched; other errors stay raw", () => {
  const dir = makeTempDir();
  const existing = path.join(dir, "existing.json");
  fs.writeFileSync(existing, "keep");
  assert.throws(() => exportReadPayload({ a: 1 }, "existing.json", dir), {
    message: `--output ${existing} already exists; pass a new path.`
  });
  assert.equal(fs.readFileSync(existing, "utf8"), "keep");
  assert.throws(() => exportReadPayload({ a: 1 }, path.join("no-such-dir", "x.json"), dir), { code: "ENOENT" });
});

test("exportReadPayload refuses a symlink, live or dangling", { skip: IS_WIN }, () => {
  const dir = makeTempDir();
  const target = path.join(dir, "target.json");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, path.join(dir, "live-link.json"));
  fs.symlinkSync(path.join(dir, "missing.json"), path.join(dir, "dangling-link.json"));
  for (const name of ["live-link.json", "dangling-link.json"]) {
    assert.throws(() => exportReadPayload({ a: 1 }, name, dir), /already exists; pass a new path\.$/, name);
  }
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(dir, "missing.json")), false, "a dangling link is never followed");
  assert.ok(fs.lstatSync(path.join(dir, "live-link.json")).isSymbolicLink());
});

test("exportReadPayload refuses an existing directory and leaves it untouched", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "a-dir");
  fs.mkdirSync(target);
  assert.throws(() => exportReadPayload({ a: 1 }, "a-dir", dir), { message: `--output ${target} already exists; pass a new path.` });
  assert.ok(fs.lstatSync(target).isDirectory());
  assert.deepEqual(fs.readdirSync(target), []);
});

test("a non-numeric omittedJobs cannot inflate the printed view", () => {
  const payload = { omittedJobs: "j".repeat(9000), body: "x".repeat(60_000) };
  const json = boundedReadView(payload, { nextStep: NEXT });
  assert.ok(bytes(json.text) <= PUBLIC_READ_BYTES, `${bytes(json.text)} bytes`);
  assert.equal(typeof json.view.omissions.records, "number");
  const text = boundedReadView(payload, { render: () => "x".repeat(9000), asJson: false, nextStep: NEXT });
  assert.ok(bytes(text.text) <= PUBLIC_READ_BYTES, `${bytes(text.text)} bytes`);
});

test("exportReadPayload removes the file it created when the write fails", (t) => {
  const dir = makeTempDir();
  t.mock.method(fs, "writeFileSync", (fd) => {
    fs.writeSync(fd, "partial");
    throw new Error("injected disk full");
  });
  assert.throws(() => exportReadPayload({ a: 1 }, "partial.json", dir), /injected disk full/);
  assert.equal(fs.existsSync(path.join(dir, "partial.json")), false);
});

test("exportReadPayload keeps an entry that replaced its file before the failure", { skip: IS_WIN }, (t) => {
  const dir = makeTempDir();
  const outputFile = path.join(dir, "raced.json");
  t.mock.method(fs, "writeFileSync", () => {
    fs.renameSync(outputFile, `${outputFile}.moved`);
    const other = fs.openSync(outputFile, "w");
    fs.writeSync(other, "someone else's");
    fs.closeSync(other);
    throw new Error("injected after replace");
  });
  assert.throws(() => exportReadPayload({ a: 1 }, outputFile, dir), /injected after replace/);
  assert.equal(fs.readFileSync(outputFile, "utf8"), "someone else's", "only the file this call created may be removed");
});

test("assertOutputPathFree refuses any existing entry before a long wait", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "file.json"), "keep");
  fs.mkdirSync(path.join(dir, "a-dir"));
  for (const name of ["file.json", "a-dir"]) {
    assert.throws(() => assertOutputPathFree(name, dir), { message: `--output ${path.join(dir, name)} already exists; pass a new path.` });
  }
  assert.equal(assertOutputPathFree("free.json", dir), undefined);
  assert.equal(fs.existsSync(path.join(dir, "free.json")), false, "the check creates nothing");
});

test("assertOutputPathFree refuses a dangling symlink", { skip: IS_WIN }, () => {
  const dir = makeTempDir();
  fs.symlinkSync(path.join(dir, "missing.json"), path.join(dir, "dangling.json"));
  assert.throws(() => assertOutputPathFree("dangling.json", dir), /already exists; pass a new path\.$/);
});
