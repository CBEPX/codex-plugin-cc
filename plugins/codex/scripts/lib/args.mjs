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

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
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
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
