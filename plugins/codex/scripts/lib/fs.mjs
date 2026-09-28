import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

// ponytail: 50 × 20 ms of consecutive EAGAIN on a non-blocking stdin, then throw
// rather than hand back a partial prompt; raise if a slow producer ever needs more.
const STDIN_EAGAIN_RETRIES = 50;
const STDIN_EAGAIN_WAIT_MS = 20;

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let retries = 0;
  for (;;) {
    let read;
    try {
      read = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EOF") {
        break;
      }
      if (error.code !== "EAGAIN" || ++retries > STDIN_EAGAIN_RETRIES) {
        throw error.code === "EAGAIN" ? new Error("stdin stayed unreadable (EAGAIN); refusing to use a partial input.") : error;
      }
      Atomics.wait(sleeper, 0, 0, STDIN_EAGAIN_WAIT_MS);
      continue;
    }
    if (read === 0) {
      break;
    }
    retries = 0;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
