const { getEnvValue } = require("../lib/env");

const DEFAULT_EFEM_RESELLER_BASE_URL = "https://api-geminipro.ignorelist.com/api/reseller/v1";
const DEFAULT_TIMEOUT_MS = 25000;

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_EFEM_RESELLER_BASE_URL).replace(/\/+$/, "");
}

function extractRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  for (const key of ["products", "orders", "items", "results", "records", "data"]) {
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

class EfemResellerService {
  constructor({ fetchImpl = global.fetch, logger = console, config = null } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.baseUrl = normalizeBaseUrl(config?.baseUrl || getEnvValue("EFEM_RESELLER_BASE_URL", "EFEM_STORE_BASE_URL") || DEFAULT_EFEM_RESELLER_BASE_URL);
    this.apiKey = String(config?.apiKey || getEnvValue("EFEM_RESELLER_API_KEY", "EFEM_STORE_API_KEY", "GEMINIPRO_RESELLER_API_KEY") || "").trim();
    this.enabled = config?.enabled !== false;
    this.timeoutMs = Number(config?.timeoutMs || getEnvValue("EFEM_RESELLER_TIMEOUT_MS") || DEFAULT_TIMEOUT_MS);
    this.lastBalance = null;
    this.lastBalanceCurrency = "";
    this.lastBalanceCheckedAt = null;
  }

  withConfig(config = {}) {
    return new EfemResellerService({
      fetchImpl: this.fetchImpl,
      logger: this.logger,
      config,
    });
  }

  isConfigured() {
    return this.enabled && !!this.apiKey;
  }

  getPublicStatus() {
    return {
      baseUrl: this.baseUrl,
      configured: this.isConfigured(),
      catalogEndpoint: "/products",
      balanceEndpoint: "/account/balance",
      accountEndpoint: "/account/info",
      orderEndpoint: "/orders",
      authentication: this.apiKey ? "x-api-key" : "",
      automaticFulfillment: true,
      orderReconciliation: true,
      supportsIdempotency: false,
      supportsSafeRetry: false,
      supplierBalance: this.lastBalance,
      supplierBalanceCurrency: this.lastBalanceCurrency,
      lastBalanceCheckedAt: this.lastBalanceCheckedAt,
    };
  }

  buildUrl(path = "") {
    const cleanPath = String(path || "").trim();
    return new URL(cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`, `${this.baseUrl}/`).toString();
  }

  async request(path = "", { method = "GET", body = null, postMayHaveReachedSupplier = false } = {}) {
    if (!this.isConfigured()) {
      const error = new Error("Efem Store API key is not configured.");
      error.code = "EFEM_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    if (!this.fetchImpl) {
      throw new Error("Fetch API is unavailable for Efem Store requests.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(this.timeoutMs) ? this.timeoutMs : DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.buildUrl(path), {
        method,
        headers: {
          Accept: "application/json",
          "X-API-Key": this.apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
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
        const code = String(payload.error || payload.code || payload.reason || "").trim();
        const message = String(payload.message || payload.detail || code || `Efem Store request failed with HTTP ${response.status}.`);
        const error = new Error(message);
        error.statusCode = response.status;
        error.code = code || `EFEM_HTTP_${response.status}`;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("Efem Store request timed out.");
        timeoutError.code = "EFEM_TIMEOUT";
        timeoutError.statusCode = 504;
        timeoutError.ambiguousSupplierPurchase = !!postMayHaveReachedSupplier;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAccountInfo() {
    return this.request("/account/info", { method: "GET" });
  }

  async getBalance() {
    const payload = await this.request("/account/balance", { method: "GET" });
    const source = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
    this.lastBalance = source?.balance ?? null;
    this.lastBalanceCurrency = String(source?.currency || "USD").trim();
    this.lastBalanceCheckedAt = new Date().toISOString();
    return payload;
  }

  getAccount() {
    return this.getAccountInfo();
  }

  async testConnection() {
    const account = await this.getAccountInfo();
    await this.getBalance().catch(() => null);
    return account;
  }

  listProducts() {
    return this.request("/products", { method: "GET" });
  }

  async getProduct(productId) {
    const id = encodeURIComponent(String(productId || "").trim());
    if (!id) {
      throw new Error("Efem product ID is required.");
    }
    return this.request(`/products/${id}`, { method: "GET" });
  }

  createOrder({ productId, quantity } = {}) {
    const normalizedProductId = Number(productId);
    const normalizedQuantity = Math.max(1, Math.floor(Number(quantity || 1)));
    if (!Number.isFinite(normalizedProductId) || normalizedProductId <= 0) {
      const error = new Error("Efem product ID must be numeric.");
      error.statusCode = 400;
      throw error;
    }
    return this.request("/orders", {
      method: "POST",
      body: {
        productId: normalizedProductId,
        quantity: normalizedQuantity,
      },
      postMayHaveReachedSupplier: true,
    });
  }

  listOrders() {
    return this.request("/orders", { method: "GET" });
  }

  getOrder(orderCode) {
    const code = encodeURIComponent(String(orderCode || "").trim());
    if (!code) {
      throw new Error("Efem order code is required.");
    }
    return this.request(`/orders/${code}`, { method: "GET" });
  }
}

module.exports = {
  DEFAULT_EFEM_RESELLER_BASE_URL,
  EfemResellerService,
  extractRows,
};
