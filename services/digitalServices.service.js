const { add, compare, multiplyRatio, subtract } = require("../lib/money");
const { decryptSetting, encryptSetting } = require("../lib/settingsCrypto");

const PRODUCT_CACHE_TTL_MS = 1000 * 60 * 15;
const DELIVERY_KEYS = ["delivery", "credentials", "codes", "pin", "pins", "account", "accounts", "license", "licenses", "serial", "serials"];
const SUCCESS_STATUSES = new Set(["success", "successful", "completed", "complete", "delivered", "fulfilled", "paid"]);
const FAILURE_STATUSES = new Set(["failed", "failure", "cancelled", "canceled", "refunded", "rejected"]);
const PROCESSING_STATUSES = new Set(["pending", "processing", "queued", "created", "submitted", "in_progress"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  return String(value ?? fallback).replace(/\s+/g, " ").trim();
}

function firstValue(object = {}, keys = []) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
      return object[key];
    }
  }
  return "";
}

function normalizeProductId(raw = {}) {
  return String(firstValue(raw, ["id", "product_id", "productId", "variation_id", "sku"]) || "").trim();
}

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAmountText(value, fallback = "0") {
  const text = String(value ?? "").replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? text : String(fallback);
}

function normalizeCategory(raw = {}) {
  return normalizeText(firstValue(raw, ["category", "category_name", "type", "service", "group"]), "Digital");
}

function normalizeName(raw = {}) {
  return normalizeText(firstValue(raw, ["name", "title", "product_name", "service_name", "label"]), "Digital Service");
}

function normalizeDescription(raw = {}) {
  return normalizeText(firstValue(raw, ["description", "details", "summary", "short_description"]), "");
}

function normalizeCurrency(raw = {}) {
  return String(firstValue(raw, ["currency", "currency_code"]) || "NGN").trim().toUpperCase();
}

function normalizeProviderCost(raw = {}) {
  return normalizeAmountText(firstValue(raw, ["price", "reseller_price", "cost", "amount", "rate", "selling_price"]), "0");
}

function normalizeStock(raw = {}) {
  const stock = firstValue(raw, ["stock", "available_quantity", "quantity_available", "qty", "available"]);
  if (stock === true) {
    return 999999;
  }
  if (stock === false) {
    return 0;
  }
  return Math.max(0, Math.floor(normalizeNumber(stock, 999999)));
}

function normalizeStatus(raw = {}) {
  const status = normalizeText(firstValue(raw, ["status", "availability", "state"]), "active").toLowerCase();
  return status || "active";
}

function isProductAvailable(raw = {}) {
  const status = normalizeStatus(raw);
  if (["inactive", "disabled", "unavailable", "out_of_stock", "out of stock", "sold_out"].includes(status)) {
    return false;
  }
  return normalizeStock(raw) > 0;
}

function getImageCandidate(raw = {}) {
  const image = firstValue(raw, ["image", "image_url", "imageUrl", "thumbnail", "thumbnail_url", "icon", "logo", "photo"]);
  if (Array.isArray(image)) {
    return image[0] || "";
  }
  return String(image || "");
}

function normalizeMarkupMode(value) {
  const mode = String(value || "percentage").trim().toLowerCase();
  return ["percentage", "fixed", "custom"].includes(mode) ? mode : "percentage";
}

function mapSupplierStatus(payload = {}) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const status = normalizeText(firstValue(source, ["status", "order_status", "state"]), "").toLowerCase();
  if (SUCCESS_STATUSES.has(status)) {
    return "delivered";
  }
  if (FAILURE_STATUSES.has(status)) {
    return status === "refunded" ? "refunded" : "failed";
  }
  if (PROCESSING_STATUSES.has(status)) {
    return "processing";
  }
  return "processing";
}

function extractSupplierOrderId(payload = {}) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return String(firstValue(source, ["id", "order_id", "orderId", "reference", "request_id"]) || "").trim();
}

function extractDeliveryPayload(payload = {}) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const delivery = {};
  for (const key of DELIVERY_KEYS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      delivery[key] = source[key];
    }
  }
  return Object.keys(delivery).length ? delivery : null;
}

class DigitalServicesService {
  constructor({ financialService, akundingService, clock = () => new Date().toISOString() } = {}) {
    this.financialService = financialService;
    this.akundingService = akundingService;
    this.clock = clock;
  }

  getStatus() {
    const settings = this.financialService.getDigitalServiceSettings();
    const supplier = this.akundingService.getPublicStatus();
    return {
      settings,
      supplier,
      configured: settings.enabled && supplier.configured,
    };
  }

  normalizeSupplierProduct(raw = {}) {
    const supplierProductId = normalizeProductId(raw);
    return {
      id: supplierProductId,
      supplierProductId,
      provider: "akunding",
      name: normalizeName(raw),
      description: normalizeDescription(raw),
      category: normalizeCategory(raw),
      currency: normalizeCurrency(raw),
      providerCost: normalizeProviderCost(raw),
      stock: normalizeStock(raw),
      providerStatus: normalizeStatus(raw),
      available: isProductAvailable(raw),
      imageUrl: getImageCandidate(raw),
      deliveryLabel: normalizeText(firstValue(raw, ["delivery", "delivery_time", "delivery_label", "duration"]), "After purchase"),
      planLabel: normalizeText(firstValue(raw, ["plan", "duration", "validity"]), ""),
      raw,
      syncedAt: this.clock(),
    };
  }

  async syncProducts({ force = true } = {}) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled && !force) {
      return this.financialService.listDigitalServiceProducts();
    }
    const products = await this.akundingService.listProducts({ includeOutOfStock: true });
    const normalized = (Array.isArray(products) ? products : [])
      .map((product) => this.normalizeSupplierProduct(product))
      .filter((product) => product.supplierProductId);
    return this.financialService.replaceDigitalServiceProducts(normalized, { provider: "akunding" });
  }

  async listProducts({ query = "", category = "", force = false } = {}) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled) {
      return [];
    }
    let products = this.financialService.listDigitalServiceProducts({ includeInactive: false });
    const lastSync = products.reduce((latest, product) => Math.max(latest, Date.parse(product.syncedAt || "") || 0), 0);
    const stale = !lastSync || Date.now() - lastSync > PRODUCT_CACHE_TTL_MS;
    if (settings.enabled && this.akundingService.isConfigured() && (force || stale || !products.length)) {
      products = await this.syncProducts({ force });
    }
    return this.financialService.listDigitalServiceProducts({ query, category, includeInactive: false });
  }

  getProduct(productId) {
    return this.financialService.getDigitalServiceProduct(productId);
  }

  async purchase(user, input = {}, requestMeta = {}) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled) {
      throw new Error("Digital Services is not available now.");
    }
    if (!this.akundingService.isConfigured()) {
      throw new Error("Digital Services supplier is not configured.");
    }
    const product = this.financialService.getDigitalServiceProduct(input.productId, { admin: true });
    const quantity = Math.max(1, Math.min(Math.floor(Number(input.quantity || 1)), 1000));
    const order = this.financialService.createDigitalServiceOrder(user, {
      product,
      quantity,
    }, requestMeta);
    try {
      const providerResponse = await this.akundingService.createOrder({
        productId: Number(product.supplierProductId),
        quantity,
        idempotencyKey: order.requestId,
      });
      return this.applySupplierResult(order.id, providerResponse, user, requestMeta);
    } catch (error) {
      const isFinalFailure = Number(error.statusCode || 0) > 0 && Number(error.statusCode || 0) < 500 && error.code !== "AKUNDING_TIMEOUT";
      const payload = {
        status: isFinalFailure ? "failed" : "processing",
        supplierStatus: error.code === "AKUNDING_TIMEOUT" ? "unknown" : "error",
        message: isFinalFailure ? error.message : "Supplier status is pending confirmation.",
      };
      return this.financialService.applyDigitalServiceOrderResult(order.id, payload, user, requestMeta);
    }
  }

  async requeryOrder(actor, orderId, requestMeta = {}) {
    const order = this.financialService.getDigitalServiceOrder(actor, orderId);
    if (!order.supplierOrderId) {
      throw new Error("This order does not have a supplier order ID yet.");
    }
    const providerResponse = await this.akundingService.getOrder(order.supplierOrderId);
    return this.applySupplierResult(order.id, providerResponse, actor, requestMeta);
  }

  applySupplierResult(orderId, providerResponse, actor, requestMeta = {}) {
    return this.financialService.applyDigitalServiceOrderResult(orderId, {
      status: mapSupplierStatus(providerResponse),
      supplierStatus: normalizeText(firstValue(providerResponse?.data && typeof providerResponse.data === "object" ? providerResponse.data : providerResponse, ["status", "order_status", "state"]), "processing"),
      supplierOrderId: extractSupplierOrderId(providerResponse),
      delivery: extractDeliveryPayload(providerResponse),
      providerResponse,
    }, actor, requestMeta);
  }

  decryptDelivery(order = {}) {
    if (!order.deliveryEncrypted) {
      return null;
    }
    try {
      return JSON.parse(decryptSetting(order.deliveryEncrypted));
    } catch {
      return null;
    }
  }

  encryptDelivery(delivery) {
    return delivery ? encryptSetting(JSON.stringify(delivery)) : "";
  }
}

module.exports = {
  DigitalServicesService,
  PRODUCT_CACHE_TTL_MS,
  mapSupplierStatus,
};
