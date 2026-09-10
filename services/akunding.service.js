const { getEnvValue } = require("../lib/env");

const DEFAULT_AKUNDING_BASE_URL = "https://akunding.shop";
const DEFAULT_TIMEOUT_MS = 25000;

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value === true || value === "true" || value === "1" || value === 1 || value === "yes";
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_AKUNDING_BASE_URL).replace(/\/+$/, "");
}

function createMockProducts(clock = () => new Date().toISOString()) {
  const now = clock();
  return [
    {
      id: 101,
      name: "Canva Pro Team Invite",
      category: "Design",
      description: "Shared premium design workspace access.",
      price: "2500",
      currency: "NGN",
      stock: 48,
      image: "https://akunding.shop/static/services/canva-pro.webp",
      delivery: "Instant credentials",
      updated_at: now,
    },
    {
      id: 102,
      name: "Netflix Premium Slot",
      category: "Streaming",
      description: "One month premium entertainment slot.",
      price: "4200",
      currency: "NGN",
      stock: 12,
      image: "https://akunding.shop/static/services/netflix.webp",
      delivery: "Manual delivery",
      updated_at: now,
    },
    {
      id: 103,
      name: "ChatGPT Plus Shared Access",
      category: "AI Tools",
      description: "Affordable productivity tool access.",
      price: "8500",
      currency: "NGN",
      stock: 7,
      image: "https://akunding.shop/static/services/ai-tools.webp",
      delivery: "Account details after purchase",
      updated_at: now,
    },
  ];
}

function createMockOrder({ productId, quantity, clock = () => new Date().toISOString() } = {}) {
  const orderId = Number(`${Date.now()}${String(productId || 0).slice(-3)}`.slice(-9));
  return {
    id: orderId,
    product_id: Number(productId),
    quantity: Number(quantity || 1),
    status: "delivered",
    delivery: {
      note: "Mock delivery credentials. Replace with live Akunding API in production.",
      pin: `MOCK-${String(orderId).slice(-6)}`,
    },
    created_at: clock(),
  };
}

class AkundingService {
  constructor({ fetchImpl = global.fetch, clock = () => new Date().toISOString(), logger = console } = {}) {
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.logger = logger;
    this.baseUrl = normalizeBaseUrl(getEnvValue("AKUNDING_BASE_URL") || DEFAULT_AKUNDING_BASE_URL);
    this.apiKey = String(getEnvValue("AKUNDING_API_KEY") || "").trim();
    this.mockMode = normalizeBoolean(getEnvValue("AKUNDING_MOCK_MODE"), false);
    this.timeoutMs = Number(getEnvValue("AKUNDING_TIMEOUT_MS") || DEFAULT_TIMEOUT_MS);
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

  async request(path, { method = "GET", query = null, body = null, idempotencyKey = "" } = {}) {
    if (this.mockMode) {
      return this.mockRequest(path, { method, query, body });
    }
    if (!this.apiKey) {
      const error = new Error("Akunding API key is not configured.");
      error.code = "AKUNDING_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    if (!this.fetchImpl) {
      throw new Error("Fetch API is unavailable for Akunding requests.");
    }

    const url = new URL(`${this.baseUrl}/api${path}`);
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
          Authorization: `Bearer ${this.apiKey}`,
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
        const error = new Error(String(payload.message || payload.detail || payload.error || "Akunding request failed."));
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("Akunding request timed out.");
        timeoutError.code = "AKUNDING_TIMEOUT";
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  mockRequest(path, { method = "GET", query = null, body = null } = {}) {
    if (method === "GET" && path === "/v1/me") {
      return { ok: true, balance: "100000", currency: "NGN", mode: "mock" };
    }
    if (method === "GET" && path === "/v1/products") {
      const includeOutOfStock = query?.include_out_of_stock === true || query?.include_out_of_stock === "true";
      const products = createMockProducts(this.clock);
      return includeOutOfStock ? products : products.filter((product) => Number(product.stock || 0) > 0);
    }
    const productMatch = path.match(/^\/v1\/products\/(\d+)$/);
    if (method === "GET" && productMatch) {
      const product = createMockProducts(this.clock).find((item) => Number(item.id) === Number(productMatch[1]));
      if (!product) {
        const error = new Error("Akunding product not found.");
        error.statusCode = 404;
        throw error;
      }
      return product;
    }
    if (method === "POST" && path === "/v1/orders") {
      return createMockOrder({ productId: body?.product_id, quantity: body?.quantity, clock: this.clock });
    }
    if (method === "GET" && path === "/v1/orders") {
      return [];
    }
    const orderMatch = path.match(/^\/v1\/orders\/(\d+)$/);
    if (method === "GET" && orderMatch) {
      return {
        id: Number(orderMatch[1]),
        status: "delivered",
        delivery: { note: "Mock order delivered." },
        updated_at: this.clock(),
      };
    }
    return {};
  }

  getAccount() {
    return this.request("/v1/me");
  }

  listProducts({ includeOutOfStock = true } = {}) {
    return this.request("/v1/products", {
      query: {
        include_out_of_stock: includeOutOfStock,
      },
    });
  }

  getProduct(productId) {
    return this.request(`/v1/products/${encodeURIComponent(Number(productId))}`);
  }

  createOrder({ productId, quantity, idempotencyKey = "" } = {}) {
    return this.request("/v1/orders", {
      method: "POST",
      idempotencyKey,
      body: {
        product_id: Number(productId),
        quantity: Number(quantity || 1),
      },
    });
  }

  listOrders({ limit = 50 } = {}) {
    return this.request("/v1/orders", {
      query: {
        limit: Math.max(1, Math.min(Number(limit || 50), 200)),
      },
    });
  }

  getOrder(orderId) {
    return this.request(`/v1/orders/${encodeURIComponent(Number(orderId))}`);
  }

  exportOrder(orderId, format = "txt") {
    return this.request(`/v1/orders/${encodeURIComponent(Number(orderId))}/export`, {
      query: { format },
    });
  }
}

module.exports = {
  AkundingService,
  DEFAULT_AKUNDING_BASE_URL,
};
