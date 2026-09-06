const crypto = require("node:crypto");

const KEY_ENV_NAME = "SETTINGS_ENCRYPTION_KEY";

function getEncryptionKeyMaterial() {
  return String(process.env[KEY_ENV_NAME] || "").trim();
}

function getSettingsEncryptionKey() {
  const material = getEncryptionKeyMaterial();
  if (!material) {
    const error = new Error(`${KEY_ENV_NAME} is required before saving encrypted integration credentials.`);
    error.code = "SETTINGS_ENCRYPTION_KEY_MISSING";
    throw error;
  }

  if (/^[a-f0-9]{64}$/i.test(material)) {
    return Buffer.from(material, "hex");
  }

  try {
    const decoded = Buffer.from(material, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // Fall back to UTF-8 handling below.
  }

  const raw = Buffer.from(material, "utf8");
  if (raw.length < 32) {
    const error = new Error(`${KEY_ENV_NAME} must contain at least 32 bytes of secret material.`);
    error.code = "SETTINGS_ENCRYPTION_KEY_WEAK";
    throw error;
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptSetting(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  const key = getSettingsEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSetting(payload) {
  const text = String(payload || "").trim();
  if (!text) {
    return "";
  }
  const [version, ivBase64, tagBase64, encryptedBase64] = text.split(":");
  if (version !== "v1" || !ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error("Encrypted setting payload is invalid.");
  }
  const key = getSettingsEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function maskSecret(value, { visibleStart = 2, visibleEnd = 2 } = {}) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= visibleStart + visibleEnd + 2) {
    return `${text.slice(0, 1)}***`;
  }
  return `${text.slice(0, visibleStart)}***${text.slice(-visibleEnd)}`;
}

module.exports = {
  KEY_ENV_NAME,
  decryptSetting,
  encryptSetting,
  getSettingsEncryptionKey,
  maskSecret,
};
