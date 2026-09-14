const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { __clearGoogleJwksCache, verifyGoogleCredential } = require("../lib/googleAuth");

function base64Url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createGoogleToken(payloadOverrides = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: "https://accounts.google.com",
    aud: "web-client-id",
    sub: "google-sub-1",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada User",
    given_name: "Ada",
    family_name: "User",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payloadOverrides,
  };
  const encoded = `${base64Url(header)}.${base64Url(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(encoded), privateKey)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const jwk = publicKey.export({ format: "jwk" });
  return { token: `${encoded}.${signature}`, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

function fetchForJwk(jwk) {
  return async () => ({
    ok: true,
    headers: { get: () => "max-age=3600" },
    json: async () => ({ keys: [jwk] }),
  });
}

test("Google credential verifier accepts a valid verified email token", async () => {
  __clearGoogleJwksCache();
  const { token, jwk } = createGoogleToken();
  const profile = await verifyGoogleCredential({
    credential: token,
    clientId: "web-client-id",
    fetchImpl: fetchForJwk(jwk),
  });
  assert.equal(profile.sub, "google-sub-1");
  assert.equal(profile.email, "ada@example.com");
  assert.equal(profile.firstName, "Ada");
});

test("Google credential verifier rejects wrong audience, expired, and unverified tokens", async () => {
  __clearGoogleJwksCache();
  const valid = createGoogleToken();
  await assert.rejects(
    () => verifyGoogleCredential({ credential: valid.token, clientId: "other-client", fetchImpl: fetchForJwk(valid.jwk) }),
    /audience/i
  );

  __clearGoogleJwksCache();
  const expired = createGoogleToken({ exp: Math.floor(Date.now() / 1000) - 5 });
  await assert.rejects(
    () => verifyGoogleCredential({ credential: expired.token, clientId: "web-client-id", fetchImpl: fetchForJwk(expired.jwk) }),
    /expired/i
  );

  __clearGoogleJwksCache();
  const unverified = createGoogleToken({ email_verified: false });
  await assert.rejects(
    () => verifyGoogleCredential({ credential: unverified.token, clientId: "web-client-id", fetchImpl: fetchForJwk(unverified.jwk) }),
    /not verified/i
  );
});
