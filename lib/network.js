const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

function isDeadLocalProxy(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    const hostname = String(parsed.hostname || "").trim().toLowerCase();
    const port = String(parsed.port || "").trim();
    return ["127.0.0.1", "localhost", "::1"].includes(hostname) && ["9", ""].includes(port);
  } catch {
    return false;
  }
}

function disableBrokenLocalProxyEnv(logger = console, label = "Outbound network") {
  const disabledKeys = [];

  for (const key of PROXY_ENV_KEYS) {
    if (!isDeadLocalProxy(process.env[key])) {
      continue;
    }

    delete process.env[key];
    disabledKeys.push(key);
  }

  if (disabledKeys.length) {
    logger.warn(`${label} bypassed broken local proxy env: ${disabledKeys.join(", ")}.`);
  }

  return disabledKeys;
}

module.exports = {
  disableBrokenLocalProxyEnv,
};
