export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const rejectUnknownOptions = Boolean(config.rejectUnknownOptions);
  const stopAtFirstPositional = Boolean(config.stopAtFirstPositional);
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      if (stopAtFirstPositional) {
        passthrough = true;
      }
      continue;
    }

    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const rawKey = separator === -1 ? token.slice(2) : token.slice(2, separator);
      const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key) || repeatableOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        if (repeatableOptions.has(key)) {
          (options[key] ??= []).push(nextValue);
        } else {
          options[key] = nextValue;
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (rejectUnknownOptions) {
        throw new Error(`Unknown option: --${rawKey}`);
      }

      positionals.push(token);
      if (stopAtFirstPositional) {
        passthrough = true;
      }
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key) || repeatableOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      if (repeatableOptions.has(key)) {
        (options[key] ??= []).push(nextValue);
      } else {
        options[key] = nextValue;
      }
      index += 1;
      continue;
    }

    if (rejectUnknownOptions) {
      throw new Error(`Unknown option: -${shortKey}`);
    }

    positionals.push(token);
    if (stopAtFirstPositional) {
      passthrough = true;
    }
  }

  return { options, positionals };
}

// The shell-like splitter, with each token's start/end offset in `raw`, so a
// caller can take the rest of the raw string verbatim from any token.
function tokenizeRawArguments(raw) {
  const tokens = [];
  let current = "";
  let start = -1;
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start === -1 && !/\s/.test(character)) {
      start = index;
    }
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      const next = raw[index + 1];
      if (next === "\"" || next === "'" || next === "\\" || /\s/.test(next ?? "")) {
        escaping = true;
        continue;
      }
      current += "\\";
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push({ value: current, start, end: index });
      }
      current = "";
      start = -1;
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push({ value: current, start, end: raw.length });
  }

  return tokens;
}

export function splitRawArgumentString(raw) {
  return tokenizeRawArguments(raw).map((token) => token.value);
}

// Review focus text is free prose (#714): split flags shell-like up to the first
// positional (or `--`), then hand the rest of the raw string over as ONE token,
// trimmed, with quotes, apostrophes, backslashes and newlines untouched. `spec`
// is the parseArgs config; only valueOptions, repeatableOptions and aliasMap
// matter here — they say which flag swallows the next token as its value. A tail
// that starts with `-` (a bullet list) goes after `--`, so parseArgs reads it as text.
export function splitArgsWithVerbatimTail(raw, spec = {}) {
  const takesValue = new Set([...(spec.valueOptions ?? []), ...(spec.repeatableOptions ?? [])]);
  const aliasMap = spec.aliasMap ?? {};
  const tokens = tokenizeRawArguments(raw);
  const argv = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const { value, start, end } = tokens[index];
    if (value === "--") {
      const tail = raw.slice(end).trim();
      return tail ? [...argv, "--", tail] : [...argv, "--"];
    }
    if (!value.startsWith("-") || value === "-") {
      const tail = raw.slice(start).trim();
      return tail.startsWith("-") && tail !== "-" ? [...argv, "--", tail] : [...argv, tail];
    }
    argv.push(value);
    const isLong = value.startsWith("--");
    if (isLong && value.includes("=")) {
      continue;
    }
    const name = value.slice(isLong ? 2 : 1);
    if (takesValue.has(aliasMap[name] ?? name) && index + 1 < tokens.length) {
      index += 1;
      argv.push(tokens[index].value);
    }
  }

  return argv;
}
