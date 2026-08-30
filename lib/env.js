function normalizeEnvValue(value, { stripInlineComment = false } = {}) {
  let normalized = String(value ?? "").replace(/^\uFEFF/, "").trim();
  if (!normalized) {
    return "";
  }

  if (stripInlineComment) {
    const commentIndex = normalized.search(/\s+#/);
    if (commentIndex !== -1) {
      normalized = normalized.slice(0, commentIndex).trim();
    }
  }

  while (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === "\"" || first === "'" || first === "`") && last === first) {
      normalized = normalized.slice(1, -1).trim();
      continue;
    }
    break;
  }

  return normalized;
}

function parseEnvFileValue(rawValue) {
  const value = String(rawValue ?? "").replace(/^\uFEFF/, "").trim();
  if (!value) {
    return "";
  }

  const quote = value[0];
  if ((quote === "\"" || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) {
    return normalizeEnvValue(value);
  }

  return normalizeEnvValue(value, { stripInlineComment: true });
}

function getEnvValue(...keys) {
  for (const key of keys.flat()) {
    if (!key || process.env[key] === undefined) {
      continue;
    }

    const value = normalizeEnvValue(process.env[key]);
    if (value) {
      return value;
    }
  }

  return "";
}

function isMongoConnectionString(value) {
  return /^mongodb(\+srv)?:\/\//i.test(normalizeEnvValue(value));
}

function getMongoDbNameFromUri(uri, fallback = "trade_mvp") {
  const normalized = normalizeEnvValue(uri);
  if (!isMongoConnectionString(normalized)) {
    return fallback;
  }

  try {
    return new URL(normalized).pathname.replace(/^\//, "") || fallback;
  } catch {
    return fallback;
  }
}

function assertValidMongoConnectionString(uri, label = "MongoDB connection string") {
  const normalized = normalizeEnvValue(uri);
  if (!normalized) {
    return "";
  }

  if (!isMongoConnectionString(normalized)) {
    throw new Error(
      `${label} is invalid. It must start with "mongodb://" or "mongodb+srv://". Remove surrounding quotes or extra text from your deployment environment variable.`
    );
  }

  return normalized;
}

module.exports = {
  assertValidMongoConnectionString,
  getEnvValue,
  getMongoDbNameFromUri,
  isMongoConnectionString,
  normalizeEnvValue,
  parseEnvFileValue,
};
