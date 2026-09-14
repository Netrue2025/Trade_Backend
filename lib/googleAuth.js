const crypto = require("node:crypto");

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

let cachedKeys = {
  expiresAt: 0,
  keys: [],
};

function base64UrlDecode(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, "="), "base64");
}

function parseJwtPart(value, label) {
  try {
    return JSON.parse(base64UrlDecode(value).toString("utf8"));
  } catch {
    throw new Error(`Invalid Google credential ${label}.`);
  }
}

function parseCacheControlMaxAge(value) {
  const match = String(value || "").match(/max-age=(\d+)/i);
  return match ? Number(match[1]) * 1000 : 60 * 60 * 1000;
}

async function getGoogleJwks({ fetchImpl = global.fetch, now = () => Date.now(), jwksUrl = GOOGLE_JWKS_URL } = {}) {
  if (cachedKeys.keys.length && cachedKeys.expiresAt > now()) {
    return cachedKeys.keys;
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Google authentication is unavailable.");
  }
  const response = await fetchImpl(jwksUrl);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload.keys)) {
    throw new Error("Unable to load Google signing keys.");
  }
  const maxAgeMs = parseCacheControlMaxAge(response.headers?.get?.("cache-control"));
  cachedKeys = {
    keys: payload.keys,
    expiresAt: now() + maxAgeMs,
  };
  return cachedKeys.keys;
}

function verifyJwtSignature({ token, header, key }) {
  if (header.alg !== "RS256") {
    throw new Error("Unsupported Google credential signature.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = String(token || "").split(".");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const publicKey = crypto.createPublicKey({ key, format: "jwk" });
  const signature = base64UrlDecode(encodedSignature);
  if (!verifier.verify(publicKey, signature)) {
    throw new Error("Invalid Google credential signature.");
  }
}

async function verifyGoogleCredential({
  credential,
  clientId,
  fetchImpl = global.fetch,
  now = () => Date.now(),
  jwksUrl = GOOGLE_JWKS_URL,
} = {}) {
  const expectedAudience = String(clientId || "").trim();
  if (!expectedAudience) {
    throw new Error("Google sign-in is not configured.");
  }
  const token = String(credential || "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid Google credential.");
  }
  const header = parseJwtPart(parts[0], "header");
  const payload = parseJwtPart(parts[1], "payload");
  const keys = await getGoogleJwks({ fetchImpl, now, jwksUrl });
  const key = keys.find((item) => item.kid === header.kid && item.kty === "RSA");
  if (!key) {
    throw new Error("Google signing key was not found.");
  }
  verifyJwtSignature({ token, header, key });

  const issuer = String(payload.iss || "");
  if (!["https://accounts.google.com", "accounts.google.com"].includes(issuer)) {
    throw new Error("Invalid Google credential issuer.");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new Error("Google credential audience does not match this app.");
  }
  const expiresAtMs = Number(payload.exp || 0) * 1000;
  if (!expiresAtMs || expiresAtMs <= now()) {
    throw new Error("Google credential has expired.");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new Error("Google email is not verified.");
  }
  const email = String(payload.email || "").trim().toLowerCase();
  const sub = String(payload.sub || "").trim();
  if (!email || !sub) {
    throw new Error("Google credential is missing account identity.");
  }
  return {
    sub,
    email,
    name: String(payload.name || "").trim(),
    firstName: String(payload.given_name || "").trim(),
    lastName: String(payload.family_name || "").trim(),
    picture: String(payload.picture || "").trim(),
  };
}

function __clearGoogleJwksCache() {
  cachedKeys = { expiresAt: 0, keys: [] };
}

module.exports = {
  GOOGLE_JWKS_URL,
  __clearGoogleJwksCache,
  verifyGoogleCredential,
};
