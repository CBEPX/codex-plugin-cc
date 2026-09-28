import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { IS_WIN } from "./helpers.mjs";
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

test("readStdinIfPiped keeps bytes across EAGAIN and refuses a partial read once retries run out", async () => {
  assert.equal(await readPipedWithGap(100), "OK part1-part2");
  if (!IS_WIN) {
    assert.match(await readPipedWithGap(1500), /^ERR stdin stayed unreadable \(EAGAIN\)/);
  }
});
