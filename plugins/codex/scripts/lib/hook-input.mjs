import process from "node:process";
import { StringDecoder } from "node:string_decoder";

function parseObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  const value = JSON.parse(trimmed);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hook input is not a JSON object");
  }
  return value;
}

// Reads a hook's JSON payload from stdin without trusting the host to close it
// (#530) and without the EAGAIN a non-blocking stdin gives `readFileSync(0)`.
// A payload that is complete when the deadline hits is accepted: only a late EOF
// is missing. `error.bytes` says how much arrived before a timeout.
export async function readHookInput({ timeoutMs = 2000, maxBytes = 1024 * 1024, stdin = process.stdin } = {}) {
  const override = Number(process.env.CODEX_HOOK_STDIN_TIMEOUT_MS);
  const deadlineMs = override > 0 ? override : timeoutMs;
  const decoder = new StringDecoder("utf8");
  let text = "";
  let bytes = 0;

  const outcome = await new Promise((resolve) => {
    const finish = (reason) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.pause();
      stdin.destroy?.();
      resolve(reason);
    };
    const onData = (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > maxBytes) {
        finish("overflow");
        return;
      }
      text += decoder.write(buffer);
    };
    const onEnd = () => {
      text += decoder.end();
      finish("end");
    };
    // A broken stdin is treated like one that stopped arriving.
    const onError = () => finish("deadline");
    const timer = setTimeout(() => finish("deadline"), deadlineMs);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });

  if (outcome === "overflow") {
    return { input: null, error: { code: "overflow", message: `hook input exceeded ${maxBytes} bytes` } };
  }
  if (outcome === "deadline") {
    try {
      if (text.trim()) {
        return { input: parseObject(text), error: null };
      }
    } catch {
      // Incomplete: fall through to the timeout.
    }
    return {
      input: null,
      error: {
        code: "timeout",
        bytes,
        message: bytes === 0 ? `hook input did not arrive within ${deadlineMs} ms` : `hook input was incomplete after ${deadlineMs} ms (${bytes} bytes)`
      }
    };
  }
  try {
    return { input: parseObject(text), error: null };
  } catch (error) {
    return { input: null, error: { code: "invalid-json", message: error.message } };
  }
}
