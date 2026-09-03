const crypto = require("node:crypto");

const { getEnvValue, normalizeEnvValue } = require("../lib/env");

const DEFAULT_BASE_URL = "https://api.paystack.co";
const BANK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function normalizeAmountText(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("Amount must be a valid NGN value.");
  }
  return text;
}

function toKobo(amountNgn) {
  const text = normalizeAmountText(amountNgn);
  const [whole, fraction = ""] = text.split(".");
  return Number(BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0"));
}

function fromKobo(amountKobo) {
  const value = BigInt(Number(amountKobo || 0));
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return fraction === "00" ? String(whole) : `${whole}.${fraction}`;
}

function maskAccountNumber(accountNumber = "") {
  const value = String(accountNumber || "").replace(/\D/g, "");
  if (value.length <= 4) {
    return value ? "****" : "";
  }
  return `${"*".repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`;
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class PaystackService {
  constructor({
    secretKey = getEnvValue("PAYSTACK_SECRET_KEY"),
    publicKey = getEnvValue("PAYSTACK_PUBLIC_KEY"),
    baseUrl = getEnvValue("PAYSTACK_BASE_URL") || DEFAULT_BASE_URL,
    fetchImpl = global.fetch,
    clock = () => Date.now(),
  } = {}) {
    this.secretKey = normalizeEnvValue(secretKey);
    this.publicKey = normalizeEnvValue(publicKey);
    this.baseUrl = normalizeEnvValue(baseUrl).replace(/\/+$/, "") || DEFAULT_BASE_URL;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.bankCache = {
      loadedAt: 0,
      banks: [],
    };
  }

  isEnabled() {
    return !!this.secretKey;
  }

  assertEnabled() {
    if (!this.secretKey) {
      throw new Error("Paystack is not configured.");
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Fetch API is unavailable for Paystack requests.");
    }
  }

  validateProductionEnvironment({ nodeEnv = process.env.NODE_ENV } = {}) {
    if (String(nodeEnv || "").toLowerCase() !== "production") {
      return;
    }
    const missing = [];
    if (!this.secretKey) {
      missing.push("PAYSTACK_SECRET_KEY");
    }
    if (!this.publicKey) {
      missing.push("PAYSTACK_PUBLIC_KEY");
    }
    if (missing.length) {
      throw new Error(`Missing required production payment environment variables: ${missing.join(", ")}`);
    }
  }

  async request(path, { method = "GET", body = null, timeoutMs = 30000 } = {}) {
    this.assertEnabled();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.status === false) {
        const error = new Error(payload.message || `Paystack request failed with HTTP ${response.status}.`);
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("Paystack request timed out.");
        timeoutError.code = "PAYSTACK_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getBanks({ forceRefresh = false } = {}) {
    const now = this.clock();
    if (!forceRefresh && this.bankCache.banks.length && now - this.bankCache.loadedAt < BANK_CACHE_TTL_MS) {
      return this.bankCache.banks;
    }
    const payload = await this.request("/bank?country=nigeria");
    const banks = Array.isArray(payload.data)
      ? payload.data.map((bank) => ({
          name: String(bank.name || "").trim(),
          code: String(bank.code || "").trim(),
          slug: String(bank.slug || "").trim(),
        })).filter((bank) => bank.name && bank.code)
      : [];
    this.bankCache = { loadedAt: now, banks };
    return banks;
  }

  async resolveAccount({ accountNumber, bankCode }) {
    const account = String(accountNumber || "").replace(/\D/g, "");
    const code = String(bankCode || "").trim();
    if (!/^\d{10}$/.test(account)) {
      throw new Error("Enter a valid 10 digit Nigerian account number.");
    }
    if (!code) {
      throw new Error("Select a bank.");
    }
    const payload = await this.request(`/bank/resolve?account_number=${encodeURIComponent(account)}&bank_code=${encodeURIComponent(code)}`);
    const data = payload.data || {};
    return {
      success: true,
      accountNumber: String(data.account_number || account).replace(/\D/g, ""),
      accountName: String(data.account_name || "").trim(),
      bankCode: code,
    };
  }

  async createTransferRecipient({ accountName, accountNumber, bankCode }) {
    const payload = await this.request("/transferrecipient", {
      method: "POST",
      body: {
        type: "nuban",
        name: String(accountName || "").trim(),
        account_number: String(accountNumber || "").replace(/\D/g, ""),
        bank_code: String(bankCode || "").trim(),
        currency: "NGN",
      },
    });
    return payload.data || {};
  }

  async initiateTransfer({ amountKobo, recipientCode, reference, reason }) {
    return this.request("/transfer", {
      method: "POST",
      body: {
        source: "balance",
        amount: Number(amountKobo),
        recipient: recipientCode,
        reference,
        reason,
      },
    });
  }

  async finalizeTransfer({ transferCode, otp }) {
    if (!String(otp || "").trim()) {
      throw new Error("OTP is required.");
    }
    return this.request("/transfer/finalize_transfer", {
      method: "POST",
      body: {
        transfer_code: transferCode,
        otp: String(otp || "").trim(),
      },
    });
  }

  async verifyTransfer(reference) {
    return this.request(`/transfer/verify/${encodeURIComponent(reference)}`);
  }

  verifyWebhookSignature(rawBody, signature) {
    if (!this.secretKey || !signature) {
      return false;
    }
    const hash = crypto.createHmac("sha512", this.secretKey).update(rawBody).digest("hex");
    return timingSafeEqualText(hash, signature);
  }
}

module.exports = {
  PaystackService,
  fromKobo,
  maskAccountNumber,
  toKobo,
};
