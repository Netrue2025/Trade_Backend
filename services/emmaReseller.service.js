const { getEnvValue } = require("../lib/env");

const DEFAULT_EMMA_RESELLER_BASE_URL = "https://ssondigitalworks.online/api/reseller";
const DEFAULT_TIMEOUT_MS = 25000;

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value === true || value === "true" || value === "1" || value === 1 || value === "yes";
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_EMMA_RESELLER_BASE_URL).replace(/\/+$/, "");
}

class EmmaResellerService {
  constructor({ fetchImpl = global.fetch, logger = console } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.baseUrl = normalizeBaseUrl(getEnvValue("EMMA_RESELLER_BASE_URL", "SSON_RESELLER_BASE_URL") || DEFAULT_EMMA_RESELLER_BASE_URL);
    this.apiKey = String(getEnvValue("EMMA_RESELLER_API_KEY", "SSON_RESELLER_API_KEY", "SSON_DIGITAL_WORKS_API_KEY") || "").trim();
    this.mockMode = normalizeBoolean(getEnvValue("EMMA_RESELLER_MOCK_MODE"), false);
    this.timeoutMs = Number(getEnvValue("EMMA_RESELLER_TIMEOUT_MS") || DEFAULT_TIMEOUT_MS);
    this.lastBalance = null;
    this.lastBalanceCurrency = "";
    this.lastBalanceCheckedAt = null;
  }

  isConfigured() {
    return this.mockMode || !!this.apiKey;
  }

  getPublicStatus() {
    return {
      baseUrl: this.baseUrl,
      configured: this.isConfigured(),
      mockMode: this.mockMode,
      catalogEndpoint: "?action=products",
      balanceEndpoint: "?action=balance",
      orderEndpoint: "?action=order",
      authentication: this.apiKey || this.mockMode ? "bearer" : "",
      automaticFulfillment: true,
      orderReconciliation: true,
      supportsIdempotency: true,
      supportsSafeRetry: true,
      idempotencyField: "external_order_id",
      supplierBalance: this.lastBalance,
      supplierBalanceCurrency: this.lastBalanceCurrency,
      lastBalanceCheckedAt: this.lastBalanceCheckedAt,
    };
  }

  async request(action = "", { method = "GET", query = null, body = null } = {}) {
    if (!this.apiKey && !this.mockMode) {
      const error = new Error("Emma Store API key is not configured.");
      error.code = "EMMA_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    if (!this.fetchImpl) {
      throw new Error("Fetch API is unavailable for Emma Store requests.");
    }

    const url = new URL(this.baseUrl);
    if (action) {
      url.searchParams.set("action", String(action).trim());
    }
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(this.timeoutMs) ? this.timeoutMs : DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { message: text };
      }
      if (!response.ok) {
        const error = new Error(String(payload.message || payload.detail || payload.error || "Emma Store request failed."));
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("Emma Store request timed out.");
        timeoutError.code = "EMMA_TIMEOUT";
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  listProducts() {
    return this.request("products", { method: "GET" });
  }

  async getProduct(productId) {
    const expectedId = String(productId || "").trim();
    const payload = await this.listProducts();
    const rows = extractRows(payload);
    const match = rows.find((row) => {
      const record = row && typeof row === "object" && !Array.isArray(row) ? row : {};
      return String(record.id ?? record.product_id ?? record.productId ?? record.sku ?? "").trim() === expectedId;
    });
    if (!match) {
      const error = new Error("Emma Store product was not found in the documented catalog endpoint.");
      error.statusCode = 404;
      throw error;
    }
    return match;
  }

  async getBalance() {
    const payload = await this.request("balance", { method: "GET" });
    const source = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
    this.lastBalance = source?.balance ?? source?.wallet_balance ?? source?.walletBalance ?? source?.amount ?? null;
    this.lastBalanceCurrency = String(source?.currency || source?.balance_currency || source?.balanceCurrency || "NGN").trim();
    this.lastBalanceCheckedAt = new Date().toISOString();
    return payload;
  }

  getAccount() {
    return this.getBalance();
  }

  testConnection() {
    return this.getBalance();
  }

  createOrder({ productId, quantity, idempotencyKey = "" } = {}) {
    const externalOrderId = String(idempotencyKey || "").trim();
    if (!externalOrderId) {
      const error = new Error("Emma Store external_order_id is required for idempotent fulfillment.");
      error.statusCode = 400;
      throw error;
    }
    return this.request("order", {
      method: "POST",
      body: {
        product_id: productId,
        quantity: Number(quantity || 1),
        external_order_id: externalOrderId,
      },
    });
  }

}

function extractRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  for (const key of ["products", "items", "results", "records", "data"]) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
    if (payload[key] && typeof payload[key] === "object") {
      const nested = extractRows(payload[key]);
      if (nested.length) {
        return nested;
      }
    }
  }
  return [];
}

module.exports = {
  DEFAULT_EMMA_RESELLER_BASE_URL,
  EmmaResellerService,
};
