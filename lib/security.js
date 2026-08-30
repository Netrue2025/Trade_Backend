const crypto = require("node:crypto");

const APP_SECRET = process.env.APP_SECRET || "dev-only-secret-change-me";

function randomId(size = 24) {
  return crypto.randomBytes(size).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  const actual = Buffer.from(hash, "hex");
  if (candidate.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidate, actual);
}

function buildKey() {
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", buildKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    buildKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

module.exports = {
  decryptSecret,
  encryptSecret,
  hashPassword,
  randomId,
  verifyPassword,
};
