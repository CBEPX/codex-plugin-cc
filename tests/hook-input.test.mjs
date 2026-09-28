import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";

import { readHookInput } from "../plugins/codex/scripts/lib/hook-input.mjs";

// Feeds a child's readStdinIfPiped() two writes `gapMs` apart, then EOF. A spawned
// child's stdin is non-blocking on POSIX, so the gap shows up as EAGAIN.
function readPipedWithGap(gapMs) {
  const fsLib = new URL("../plugins/codex/scripts/lib/fs.mjs", import.meta.url).href;
  const code = `import(${JSON.stringify(fsLib)}).then((m) => { try { process.stdout.write("OK " + m.readStdinIfPiped()); } catch (e) { process.stdout.write("ERR " + e.message); } });`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.on("error", () => {});
  child.stdin.write("part1-");
  setTimeout(() => {
    child.stdin.write("part2");
    setTimeout(() => child.stdin.end(), gapMs);
  }, gapMs);
  return new Promise((resolve) => child.on("close", () => resolve(out)));
}

test("hook input assembled from chunks is parsed at EOF", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 5000 });
  stdin.write('{"session_id":');
  stdin.write('"s1","cwd":"/tmp"}');
  stdin.end();
  assert.deepEqual(await pending, { input: { session_id: "s1", cwd: "/tmp" }, error: null });
});

test("a complete payload whose EOF never comes is accepted at the deadline", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 100 });
  stdin.write('{"stop_hook_active":true}\n');
  assert.deepEqual(await pending, { input: { stop_hook_active: true }, error: null });
});

test("a partial payload at the deadline is a timeout, never a parse", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 100 });
  stdin.write('{"session_id":"s1"');
  const { input, error } = await pending;
  assert.equal(input, null);
  assert.equal(error.code, "timeout");
});

test("a UTF-8 character split across chunks survives", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 5000 });
  const bytes = Buffer.from('{"m":"жё"}', "utf8");
  const cut = bytes.indexOf(Buffer.from("ж", "utf8")) + 1;
  stdin.write(bytes.subarray(0, cut));
  stdin.write(bytes.subarray(cut));
  stdin.end();
  assert.deepEqual(await pending, { input: { m: "жё" }, error: null });
});

test("input above maxBytes stops the read as overflow without parsing", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 5000, maxBytes: 16 });
  stdin.write('{"m":"0123456789abcdef"}');
  const { input, error } = await pending;
  assert.equal(input, null);
  assert.equal(error.code, "overflow");
});

test("malformed JSON at EOF is invalid-json", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 5000 });
  stdin.end("{not-json");
  const { input, error } = await pending;
  assert.equal(input, null);
  assert.equal(error.code, "invalid-json");
});

test("a stdin stream error is a read-error, even after a complete object", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 5000 });
  stdin.write('{"session_id":"s1"}');
  stdin.destroy(new Error("EIO"));
  const { input, error } = await pending;
  assert.equal(input, null);
  assert.equal(error.code, "read-error");
  assert.match(error.message, /EIO/);
});

test("an incomplete UTF-8 tail at the deadline is not dropped to make valid JSON", async () => {
  const stdin = new PassThrough();
  const pending = readHookInput({ stdin, timeoutMs: 100 });
  stdin.write(Buffer.from([0x7b, 0x7d, 0xc3]));
  const { input, error } = await pending;
  assert.equal(input, null);
  assert.equal(error.code, "timeout");
  assert.equal(error.bytes, 3);
});

test("an error while destroying stdin after the read does not crash the process", async () => {
  const stdin = new Readable({
    read() {},
    destroy(_error, callback) {
      callback(new Error("close failed"));
    }
  });
  const pending = readHookInput({ stdin, timeoutMs: 50 });
  stdin.push("{}");
  assert.deepEqual(await pending, { input: {}, error: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
});

// The refusal is not raced against a real writer (a loaded runner stretches the
// retry budget past any gap): the child's readSync throws EAGAIN forever.
function readWithEndlessEagain() {
  const fsLib = new URL("../plugins/codex/scripts/lib/fs.mjs", import.meta.url).href;
  const code = `import("node:fs").then((fs) => { let calls = 0; const orig = fs.default.readSync; fs.default.readSync = (fd, ...rest) => { if (fd !== 0) return orig(fd, ...rest); calls += 1; throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" }); }; return import(${JSON.stringify(fsLib)}).then((m) => { try { process.stdout.write("OK " + m.readStdinIfPiped()); } catch (e) { process.stdout.write("ERR " + e.message + " after " + calls); } }); });`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  return new Promise((resolve) => child.on("close", () => resolve(out)));
}

test("readStdinIfPiped keeps bytes across EAGAIN and refuses a partial read once retries run out", async () => {
  assert.equal(await readPipedWithGap(100), "OK part1-part2");
  assert.match(await readWithEndlessEagain(), /^ERR stdin stayed unreadable \(EAGAIN\).* after 51$/);
});
