const { add, compare, multiplyRatio, subtract } = require("../lib/money");
const { decryptSetting, encryptSetting } = require("../lib/settingsCrypto");

const PRODUCT_CACHE_TTL_MS = 1000 * 60 * 15;
const DELIVERY_KEYS = [
  "delivery",
  "credentials",
  "codes",
  "pin",
  "pins",
  "account",
  "accounts",
  "license",
  "licenses",
  "serial",
  "serials",
  "link",
  "url",
  "activation_link",
  "activationLink",
  "activation_url",
  "activationUrl",
  "invite_link",
  "inviteLink",
  "invite_url",
  "inviteUrl",
  "order_link",
  "orderLink",
  "plan_link",
  "planLink",
  "redeem_link",
  "redeemLink",
  "download_link",
  "downloadLink",
  "gemini_link",
  "geminiLink",
  "access_link",
  "accessLink",
  "data",
  "value",
  "text",
  "message",
  "note",
  "details",
];
const SUCCESS_STATUSES = new Set(["success", "successful", "completed", "complete", "delivered", "fulfilled", "paid"]);
const FAILURE_STATUSES = new Set(["failed", "failure", "cancelled", "canceled", "refunded", "rejected"]);
const PROCESSING_STATUSES = new Set(["pending", "processing", "queued", "created", "submitted", "in_progress"]);
const PROVIDER_LABELS = {
  akunding: "Alaba Store",
  emma: "Emma Store",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  return String(value ?? fallback).replace(/\s+/g, " ").trim();
}

function isHttpUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function findHttpUrl(value) {
  if (typeof value === "string") {
    const direct = value.trim();
    if (isHttpUrl(direct)) {
      return direct;
    }
    const match = direct.match(/https?:\/\/[^\s"'<>]+/i);
    return match ? match[0] : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findHttpUrl(item);
      if (url) {
        return url;
      }
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const url = findHttpUrl(item);
      if (url) {
        return url;
      }
    }
  }
  return "";
}

function firstValue(object = {}, keys = []) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
      return object[key];
    }
  }
  return "";
}

function extractSupplierRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  for (const key of ["data", "products", "items", "results", "records"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      for (const nestedKey of ["data", "products", "items", "results", "records"]) {
        if (Array.isArray(value[nestedKey])) {
          return value[nestedKey];
        }
      }
    }
  }
  return [];
}

function extractSupplierRecord(payload) {
  if (typeof payload === "string") {
    return { message: payload };
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return {};
  }
  for (const key of ["data", "product", "item", "record", "result"]) {
    const value = payload[key];
    if (value && !Array.isArray(value) && typeof value === "object") {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      return { [key]: value };
    }
  }
  return payload;
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
  return normalizeAmountText(firstValue(raw, [
    "reseller_price",
    "resellerPrice",
    "reseller_amount",
    "resellerAmount",
    "wholesale_price",
    "wholesalePrice",
    "cost",
    "provider_cost",
    "providerCost",
    "api_cost",
    "apiCost",
    "price",
    "unit_price",
    "unitPrice",
    "amount",
    "rate",
    "selling_price",
    "sellingPrice",
    "naira_price",
    "ngn_price",
    "usd_price",
  ]), "0");
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
  const image = firstValue(raw, [
    "image",
    "image_url",
    "imageUrl",
    "product_image",
    "productImage",
    "photo_url",
    "photoUrl",
    "thumbnail",
    "thumbnail_url",
    "thumbnailUrl",
    "icon",
    "logo",
    "photo",
  ]);
  if (Array.isArray(image)) {
    return image[0] || "";
  }
  return String(image || "");
}

function normalizeSupplierImageUrl(value, baseUrl = "https://akunding.shop") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  try {
    return new URL(raw.replace(/^\.?\//, ""), `${String(baseUrl || "https://akunding.shop").replace(/\/+$/, "")}/`).toString();
  } catch {
    return "";
  }
}

function normalizeProviderKey(value = "akunding") {
  const key = String(value || "akunding").trim().toLowerCase();
  return key === "emma" ? "emma" : "akunding";
}

function getProviderStoreLabel(provider = "akunding") {
  return PROVIDER_LABELS[normalizeProviderKey(provider)] || "Alaba Store";
}

function createProviderProductId(provider, supplierProductId) {
  const id = String(supplierProductId || "").trim();
  return normalizeProviderKey(provider) === "emma" ? `emma:${id}` : id;
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
  if (extractDeliveryPayload(payload)) {
    return "delivered";
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
  const source = extractSupplierRecord(payload);
  const delivery = {};
  if (typeof payload === "string") {
    const activationLink = findHttpUrl(payload);
    return activationLink ? { message: payload, activationLink } : null;
  }
  for (const key of DELIVERY_KEYS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      if (["message", "note", "details"].includes(key) && !findHttpUrl(source[key])) {
        continue;
      }
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        Object.assign(delivery, source[key]);
      } else {
        delivery[key] = source[key];
      }
    }
  }
  const activationLink = findHttpUrl(delivery);
  if (activationLink && !delivery.activationLink) {
    delivery.activationLink = activationLink;
  }
  return Object.keys(delivery).length ? delivery : null;
}

function mergeSupplierPayloads(payloads = []) {
  const merged = {};
  const raw = [];
  for (const payload of payloads.filter(Boolean)) {
    raw.push(payload);
    const record = extractSupplierRecord(payload);
    if (record && typeof record === "object" && !Array.isArray(record)) {
      Object.assign(merged, record);
    }
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null && value !== "" && typeof value !== "object") {
          merged[key] = value;
        }
      }
    }
  }
  return raw.length ? { data: merged, raw } : null;
}

class DigitalServicesService {
  constructor({ financialService, akundingService, emmaService = null, clock = () => new Date().toISOString() } = {}) {
    this.financialService = financialService;
    this.akundingService = akundingService;
    this.emmaService = emmaService;
    this.clock = clock;
  }

  getProviderService(provider = "akunding") {
    return normalizeProviderKey(provider) === "emma" ? this.emmaService : this.akundingService;
  }

  getProviderStatuses() {
    return {
      akunding: this.akundingService?.getPublicStatus?.() || { configured: false },
      emma: this.emmaService?.getPublicStatus?.() || { configured: false },
    };
  }

  getStatus() {
    const settings = this.financialService.getDigitalServiceSettings();
    const suppliers = this.getProviderStatuses();
    return {
      settings,
      supplier: suppliers.akunding,
      suppliers,
      configured: settings.enabled && Object.values(suppliers).some((supplier) => supplier.configured),
    };
  }

  normalizeSupplierProduct(raw = {}, { provider = "akunding", service = this.getProviderService(provider) } = {}) {
    const normalizedProvider = normalizeProviderKey(provider);
    const supplierProductId = normalizeProductId(raw);
    return {
      id: createProviderProductId(normalizedProvider, supplierProductId),
      supplierProductId,
      provider: normalizedProvider,
      storeKey: normalizedProvider === "emma" ? "emma" : "alaba",
      storeName: getProviderStoreLabel(normalizedProvider),
      name: normalizeName(raw),
      description: normalizeDescription(raw),
      category: normalizeCategory(raw) || getProviderStoreLabel(normalizedProvider),
      currency: normalizeCurrency(raw),
      providerCost: normalizeProviderCost(raw),
      stock: normalizeStock(raw),
      providerStatus: normalizeStatus(raw),
      available: isProductAvailable(raw),
      imageUrl: normalizeSupplierImageUrl(getImageCandidate(raw), service?.baseUrl || "https://akunding.shop"),
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
    const synced = [];
    const errors = [];
    for (const provider of ["akunding", "emma"]) {
      const service = this.getProviderService(provider);
      if (!service?.isConfigured?.()) {
        continue;
      }
      try {
        const products = await service.listProducts({ includeOutOfStock: true });
        const normalized = extractSupplierRows(products)
          .map((product) => this.normalizeSupplierProduct(extractSupplierRecord(product), { provider, service }))
          .filter((product) => product.supplierProductId);
        synced.push(...this.financialService.replaceDigitalServiceProducts(normalized, { provider: normalizeProviderKey(provider) }));
      } catch (error) {
        errors.push(`${getProviderStoreLabel(provider)}: ${error.message}`);
      }
    }
    if (!synced.length && errors.length) {
      throw new Error(errors.join(" | "));
    }
    return this.financialService.listDigitalServiceProducts({ includeInactive: true, admin: true });
  }

  async refreshProduct(productId) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled) {
      throw new Error("Digital Services is not available now.");
    }
    const current = this.financialService.getDigitalServiceProduct(productId, { admin: true });
    const provider = normalizeProviderKey(current.provider);
    const service = this.getProviderService(provider);
    if (!service?.isConfigured?.()) {
      throw new Error("Digital Services supplier is not configured.");
    }
    const supplierProductId = current.supplierProductId || current.id || productId;
    const payload = await service.getProduct(supplierProductId);
    const normalized = this.normalizeSupplierProduct(extractSupplierRecord(payload), { provider, service });
    if (!normalized.supplierProductId) {
      normalized.id = current.id;
      normalized.supplierProductId = supplierProductId;
    }
    return this.financialService.upsertDigitalServiceProduct({
      ...normalized,
      id: current.id,
      supplierProductId,
    }, { provider });
  }

  async listProducts({ query = "", category = "", store = "", force = false } = {}) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled) {
      return [];
    }
    let products = this.financialService.listDigitalServiceProducts({ includeInactive: false });
    const lastSync = products.reduce((latest, product) => Math.max(latest, Date.parse(product.syncedAt || "") || 0), 0);
    const stale = !lastSync || Date.now() - lastSync > PRODUCT_CACHE_TTL_MS;
    const hasConfiguredSupplier = Object.values(this.getProviderStatuses()).some((supplier) => supplier.configured);
    if (settings.enabled && hasConfiguredSupplier && (force || stale || !products.length)) {
      products = await this.syncProducts({ force });
    }
    return this.financialService.listDigitalServiceProducts({ query, category, store, includeInactive: false });
  }

  getProduct(productId) {
    return this.financialService.getDigitalServiceProduct(productId);
  }

  async purchase(user, input = {}, requestMeta = {}) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled) {
      throw new Error("Digital Services is not available now.");
    }
    const product = this.financialService.getDigitalServiceProduct(input.productId, { admin: true });
    const provider = normalizeProviderKey(product.provider);
    const service = this.getProviderService(provider);
    if (!service?.isConfigured?.()) {
      throw new Error("Digital Services supplier is not configured.");
    }
    const quantity = Math.max(1, Math.min(Math.floor(Number(input.quantity || 1)), 1000));
    const order = this.financialService.createDigitalServiceOrder(user, {
      product,
      quantity,
    }, requestMeta);
    try {
      const providerResponse = await service.createOrder({
        productId: product.supplierProductId,
        quantity,
        idempotencyKey: order.requestId,
      });
      const supplierOrderId = extractSupplierOrderId(providerResponse);
      let supplementalPayloads = [];
      if (supplierOrderId) {
        supplementalPayloads = await this.fetchSupplierOrderPayloads({ ...order, supplierOrderId }).catch(() => []);
      }
      return this.applySupplierResult(order.id, mergeSupplierPayloads([providerResponse, ...supplementalPayloads]) || providerResponse, user, requestMeta);
    } catch (error) {
      if (extractDeliveryPayload(error.payload)) {
        return this.applySupplierResult(order.id, error.payload, user, requestMeta);
      }
      const isFinalFailure = Number(error.statusCode || 0) > 0 && Number(error.statusCode || 0) < 500 && !["AKUNDING_TIMEOUT", "EMMA_TIMEOUT"].includes(error.code);
      const payload = {
        status: isFinalFailure ? "failed" : "processing",
        supplierStatus: ["AKUNDING_TIMEOUT", "EMMA_TIMEOUT"].includes(error.code) ? "unknown" : "error",
        message: isFinalFailure ? error.message : "Supplier status is pending confirmation.",
      };
      return this.financialService.applyDigitalServiceOrderResult(order.id, payload, user, requestMeta);
    }
  }

  async requeryOrder(actor, orderId, requestMeta = {}) {
    const order = this.financialService.getDigitalServiceOrderRecord
      ? this.financialService.getDigitalServiceOrderRecord(actor, orderId)
      : this.financialService.getDigitalServiceOrder(actor, orderId);
    if (!order.supplierOrderId) {
      throw new Error("This order does not have a supplier order ID yet.");
    }
    const payloads = await this.fetchSupplierOrderPayloads(order);
    if (!payloads.length) {
      return this.financialService.applyDigitalServiceOrderResult(order.id, {
        status: "processing",
        supplierStatus: "not_found",
        supplierOrderId: order.supplierOrderId,
        message: "Supplier order is not available from the lookup endpoint yet.",
      }, actor, requestMeta);
    }
    return this.applySupplierResult(order.id, mergeSupplierPayloads(payloads), actor, requestMeta);
  }

  async fetchSupplierOrderPayloads(order = {}) {
    const supplierOrderId = String(order.supplierOrderId || "").trim();
    if (!supplierOrderId) {
      return [];
    }
    const payloads = [];
    const pushPayload = (payload) => {
      if (payload !== undefined && payload !== null && payload !== "") {
        payloads.push(payload);
      }
    };
    const trySupplierCall = async (call) => {
      try {
        pushPayload(await call());
      } catch (error) {
        if (extractDeliveryPayload(error.payload)) {
          pushPayload(error.payload);
        }
        if (![404, 422].includes(Number(error.statusCode || 0))) {
          throw error;
        }
      }
    };

    const service = this.getProviderService(order.provider);
    if (typeof service?.getOrder === "function") {
      await trySupplierCall(() => service.getOrder(supplierOrderId));
    }
    if (typeof service?.exportOrder === "function") {
      await trySupplierCall(() => service.exportOrder(supplierOrderId));
    }

    if (!payloads.some((payload) => extractDeliveryPayload(payload)) && typeof service?.listOrders === "function") {
      await trySupplierCall(async () => {
        const ordersPayload = await service.listOrders({ limit: 200 });
        const match = extractSupplierRows(ordersPayload).find((row) => {
          const record = extractSupplierRecord(row);
          return String(extractSupplierOrderId(record) || record.id || "").trim() === supplierOrderId;
        });
        return match || null;
      });
    }

    return payloads;
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
  extractDeliveryPayload,
  extractSupplierRows,
  mapSupplierStatus,
};
