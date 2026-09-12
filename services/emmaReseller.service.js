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
  }

  isConfigured() {
    return this.mockMode || !!this.apiKey;
  }

  getPublicStatus() {
    return {
      baseUrl: this.baseUrl,
      configured: this.isConfigured(),
      mockMode: this.mockMode,
    };
  }

  async request(path = "", { method = "GET", query = null, body = null, idempotencyKey = "" } = {}) {
    if (!this.apiKey && !this.mockMode) {
      const error = new Error("Emma Store API key is not configured.");
      error.code = "EMMA_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    if (!this.fetchImpl) {
      throw new Error("Fetch API is unavailable for Emma Store requests.");
    }

    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`.replace(/([^:]\/)\/+/g, "$1"));
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
          ...(idempotencyKey ? { "X-Idempotency-Key": String(idempotencyKey).slice(0, 120) } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}`, "X-API-Key": this.apiKey, apiKey: this.apiKey } : {}),
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

  async firstSuccessful(paths, options = {}) {
    let lastError = null;
    for (const path of paths) {
      try {
        return await this.request(path, options);
      } catch (error) {
        lastError = error;
        if (![404, 405].includes(Number(error.statusCode || 0))) {
          throw error;
        }
      }
    }
    throw lastError || new Error("Emma Store endpoint is not available.");
  }

  listProducts() {
    return this.firstSuccessful(["", "/products", "/services", "/v1/products"], { method: "GET" });
  }

  getProduct(productId) {
    const id = encodeURIComponent(String(productId || "").trim());
    return this.firstSuccessful([`/products/${id}`, `/services/${id}`, `/v1/products/${id}`], { method: "GET" });
  }

  createOrder({ productId, quantity, idempotencyKey = "" } = {}) {
    return this.firstSuccessful(["/orders", "/purchase", "/v1/orders"], {
      method: "POST",
      idempotencyKey,
      body: {
        product_id: productId,
        productId,
        quantity: Number(quantity || 1),
      },
    });
  }

  listOrders({ limit = 50 } = {}) {
    return this.firstSuccessful(["/orders", "/v1/orders"], {
      method: "GET",
      query: { limit: Math.max(1, Math.min(Number(limit || 50), 200)) },
    });
  }

  getOrder(orderId) {
    const id = encodeURIComponent(String(orderId || "").trim());
    return this.firstSuccessful([`/orders/${id}`, `/v1/orders/${id}`], { method: "GET" });
  }

  exportOrder(orderId, format = "txt") {
    const id = encodeURIComponent(String(orderId || "").trim());
    return this.firstSuccessful([`/orders/${id}/export`, `/v1/orders/${id}/export`], {
      method: "GET",
      query: { format },
    });
  }
}

module.exports = {
  DEFAULT_EMMA_RESELLER_BASE_URL,
  EmmaResellerService,
};
