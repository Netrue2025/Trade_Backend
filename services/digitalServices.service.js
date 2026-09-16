const dns = require("node:dns/promises");
const net = require("node:net");
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
const GENERIC_TIMEOUT_MS = 25000;
const PRODUCT_FIELD_MAPPING_KEYS = {
  supplierProductId: ["id", "product_id", "productId", "variation_id", "sku"],
  name: ["name", "title", "product_name", "service_name", "label"],
  description: ["description", "details", "summary", "short_description"],
  category: ["category", "category_name", "type", "service", "group"],
  supplierCost: [
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
  ],
  availability: ["status", "availability", "availability_status", "availabilityStatus", "state", "available", "stock"],
  image: [
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
  ],
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

function getPathValue(object = {}, path = "") {
  const parts = String(path || "").split(".").map((part) => part.trim()).filter(Boolean);
  let current = object;
  for (const part of parts) {
    if (!current || typeof current !== "object" || current[part] === undefined || current[part] === null) {
      return "";
    }
    current = current[part];
  }
  return current === undefined || current === null ? "" : current;
}

function mappedValue(raw = {}, mapping = {}, field = "", fallbackKeys = []) {
  const mappedKey = String(mapping?.[field] || "").trim();
  if (mappedKey) {
    const value = getPathValue(raw, mappedKey);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return firstValue(raw, fallbackKeys);
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

function normalizeProductId(raw = {}, mapping = {}) {
  return String(mappedValue(raw, mapping, "supplierProductId", PRODUCT_FIELD_MAPPING_KEYS.supplierProductId) || "").trim();
}

function normalizeNumber(value, fallback = 0) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) {
    return fallback;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAmountText(value, fallback = "0") {
  const text = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "")
    .trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? text : String(fallback);
}

function normalizeCategory(raw = {}, mapping = {}) {
  return normalizeText(mappedValue(raw, mapping, "category", PRODUCT_FIELD_MAPPING_KEYS.category), "Digital");
}

function normalizeName(raw = {}, mapping = {}) {
  return normalizeText(mappedValue(raw, mapping, "name", PRODUCT_FIELD_MAPPING_KEYS.name), "Digital Service");
}

function normalizeDescription(raw = {}, mapping = {}) {
  return normalizeText(mappedValue(raw, mapping, "description", PRODUCT_FIELD_MAPPING_KEYS.description), "");
}

function normalizeCurrency(raw = {}, fallback = "NGN") {
  const rawCurrency = firstValue(raw, ["currency", "currency_code", "currencySymbol", "currency_symbol"]);
  const value = String(rawCurrency || fallback).trim().toUpperCase();
  if (["$", "US$", "USDOLLAR", "DOLLAR"].includes(value)) {
    return "USD";
  }
  if (["₦", "N", "NAIRA"].includes(value)) {
    return "NGN";
  }
  return value || fallback;
}

function normalizeProviderCost(raw = {}, mapping = {}) {
  return normalizeAmountText(mappedValue(raw, mapping, "supplierCost", PRODUCT_FIELD_MAPPING_KEYS.supplierCost), "0");
}

function normalizeStock(raw = {}, mapping = {}) {
  const stock = mappedValue(raw, mapping, "availability", ["stock", "available_quantity", "quantity_available", "quantityAvailable", "qty", "available_stock", "availableStock", "available"]);
  if (stock === true) {
    return 999999;
  }
  if (stock === false) {
    return 0;
  }
  return Math.max(0, Math.floor(normalizeNumber(stock, 999999)));
}

function normalizeStatus(raw = {}, mapping = {}) {
  const status = normalizeText(mappedValue(raw, mapping, "availability", ["status", "availability", "availability_status", "availabilityStatus", "state", "available"]), "active").toLowerCase();
  return status || "active";
}

function isProductAvailable(raw = {}, mapping = {}) {
  const status = normalizeStatus(raw, mapping);
  if (["false", "0", "inactive", "disabled", "unavailable", "temporary_unavailable", "temporarily_unavailable", "out_of_stock", "out of stock", "sold_out", "sold out"].includes(status)) {
    return false;
  }
  return normalizeStock(raw, mapping) > 0;
}

function getImageCandidate(raw = {}, mapping = {}) {
  const image = mappedValue(raw, mapping, "image", PRODUCT_FIELD_MAPPING_KEYS.image);
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
  const key = String(value || "akunding").trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || "akunding";
}

function getProviderStoreLabel(provider = "akunding", supplier = null) {
  return supplier?.name || PROVIDER_LABELS[normalizeProviderKey(provider)] || "Supplier Store";
}

function createProviderProductId(provider, supplierProductId) {
  const id = String(supplierProductId || "").trim();
  const providerKey = normalizeProviderKey(provider);
  return providerKey === "akunding" ? id : `${providerKey}:${id}`;
}

function isPrivateIp(address = "") {
  const value = String(address || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) {
    return true;
  }
  if (net.isIP(value) === 4) {
    const [a, b] = value.split(".").map((part) => Number(part));
    return a === 10
      || a === 127
      || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

function isBlockedSupplierHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return !host
    || host === "localhost"
    || host.endsWith(".localhost")
    || host === "metadata.google.internal"
    || host === "metadata"
    || host === "169.254.169.254"
    || isPrivateIp(host);
}

async function validateSupplierUrl(value = "", { allowHttp = process.env.NODE_ENV !== "production", resolveDns = true } = {}) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Supplier URL is invalid.");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Supplier URL protocol is not supported.");
  }
  if (url.protocol !== "https:" && !allowHttp) {
    throw new Error("Supplier URL must use HTTPS.");
  }
  if (isBlockedSupplierHostname(url.hostname)) {
    throw new Error("Supplier URL cannot target local or private networks.");
  }
  if (resolveDns && !net.isIP(url.hostname)) {
    const records = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (records.some((record) => isPrivateIp(record.address))) {
      throw new Error("Supplier URL resolves to a private network.");
    }
  }
  return url;
}

function joinSupplierUrl(baseUrl = "", endpoint = "") {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const cleanEndpoint = String(endpoint || "").trim();
  return new URL(cleanEndpoint.startsWith("/") ? cleanEndpoint : `/${cleanEndpoint}`, `${cleanBase}/`).toString();
}

function inferProductMapping(rows = []) {
  const sample = rows.find((row) => row && typeof row === "object" && !Array.isArray(row)) || {};
  const keys = new Set(Object.keys(sample));
  const mapping = {};
  for (const [field, candidates] of Object.entries(PRODUCT_FIELD_MAPPING_KEYS)) {
    const match = candidates.find((candidate) => keys.has(candidate));
    if (match) {
      mapping[field] = match;
    }
  }
  return mapping;
}

class GenericSupplierService {
  constructor({ config = {}, fetchImpl = global.fetch } = {}) {
    this.config = config || {};
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
    this.timeoutMs = Number(config.timeoutMs || GENERIC_TIMEOUT_MS);
  }

  isConfigured() {
    return !!this.baseUrl && !!this.config.productEndpoint && this.config.enabled !== false;
  }

  getPublicStatus() {
    return {
      configured: this.isConfigured(),
      enabled: this.config.enabled !== false,
      baseUrl: this.baseUrl,
      productSync: true,
      automaticFulfillment: false,
      orderReconciliation: false,
    };
  }

  buildHeaders(idempotencyKey = "") {
    const headers = { Accept: "application/json" };
    const authType = String(this.config.authType || "none").toLowerCase();
    if (idempotencyKey) {
      headers["X-Idempotency-Key"] = String(idempotencyKey).slice(0, 120);
    }
    if (authType === "api_key" && this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    }
    if (authType === "bearer" && this.config.bearerToken) {
      headers.Authorization = `Bearer ${this.config.bearerToken}`;
    }
    if (authType === "basic" && (this.config.username || this.config.password)) {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.username || ""}:${this.config.password || ""}`).toString("base64")}`;
    }
    if (authType === "custom_headers" && this.config.customHeaders && typeof this.config.customHeaders === "object") {
      for (const [key, value] of Object.entries(this.config.customHeaders)) {
        if (/^[A-Za-z0-9-]+$/.test(key) && value !== undefined && value !== null) {
          headers[key] = String(value);
        }
      }
    }
    return headers;
  }

  async request(endpoint = "", { method = "GET", body = null, idempotencyKey = "" } = {}) {
    if (!this.fetchImpl) {
      throw new Error("Fetch API is unavailable for supplier requests.");
    }
    const target = joinSupplierUrl(this.baseUrl, endpoint);
    await validateSupplierUrl(target);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(this.timeoutMs) ? this.timeoutMs : GENERIC_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(target, {
        method,
        redirect: "manual",
        headers: {
          ...this.buildHeaders(idempotencyKey),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(Number(response.status))) {
        const location = response.headers?.get?.("location") || "";
        if (!location) {
          throw new Error("Supplier redirected without a target.");
        }
        await validateSupplierUrl(new URL(location, target).toString());
        throw new Error("Supplier redirects are not followed automatically.");
      }
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { message: text };
      }
      if (!response.ok) {
        const error = new Error(String(payload.message || payload.detail || payload.error || `Supplier request failed with HTTP ${response.status}.`));
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("Supplier request timed out.");
        timeoutError.code = "SUPPLIER_TIMEOUT";
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  testConnection() {
    return this.request(this.config.productEndpoint || "", { method: "GET" });
  }

  listProducts() {
    return this.request(this.config.productEndpoint || "", { method: "GET" });
  }
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

function classifySupplierFulfillmentError(error = {}) {
  const statusCode = Number(error.statusCode || 0);
  const timeoutCodes = ["AKUNDING_TIMEOUT", "EMMA_TIMEOUT", "SUPPLIER_TIMEOUT"];
  const message = normalizeText(error.message || "Supplier fulfillment failed.");
  if (timeoutCodes.includes(error.code)) {
    return {
      status: "processing",
      supplierStatus: "unknown",
      fulfillmentStatus: "failed_retryable",
      message: "Supplier status is pending confirmation.",
    };
  }
  if (statusCode === 429) {
    return {
      status: "processing",
      supplierStatus: "rate_limited",
      fulfillmentStatus: "failed_retryable",
      message: `HTTP ${statusCode}: Supplier rate limit reached. Retry after the supplier cooldown.`,
    };
  }
  if ([502, 503, 504].includes(statusCode)) {
    return {
      status: "processing",
      supplierStatus: "supplier_unavailable",
      fulfillmentStatus: "failed_retryable",
      message: `HTTP ${statusCode}: Supplier service is temporarily unavailable.`,
    };
  }
  if ([401, 403].includes(statusCode)) {
    return {
      status: "processing",
      supplierStatus: "supplier_auth_error",
      fulfillmentStatus: "configuration_error",
      message: `HTTP ${statusCode}: Supplier authentication rejected the request. Check supplier credentials before retrying.`,
    };
  }
  if (statusCode === 404) {
    return {
      status: "processing",
      supplierStatus: "supplier_endpoint_unavailable",
      fulfillmentStatus: "configuration_error",
      message: `HTTP ${statusCode}: Supplier order endpoint rejected the request. Check the endpoint before retrying.`,
    };
  }
  if (statusCode === 405) {
    return {
      status: "processing",
      supplierStatus: "supplier_method_not_allowed",
      fulfillmentStatus: "configuration_error",
      message: `HTTP ${statusCode}: Supplier order endpoint rejected the request method. Check the endpoint and method before retrying.`,
    };
  }
  if ([400, 422].includes(statusCode)) {
    return {
      status: "processing",
      supplierStatus: "supplier_payload_error",
      fulfillmentStatus: "manual_review",
      message: `HTTP ${statusCode}: Supplier rejected the order payload. Review product mapping and request details before retrying.`,
    };
  }
  return {
    status: "processing",
    supplierStatus: "error",
    fulfillmentStatus: "failed_retryable",
    message: statusCode ? `HTTP ${statusCode}: ${message}` : "Supplier status is pending confirmation.",
  };
}

function extractSupplierOrderId(payload = {}) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return String(firstValue(source, [
    "id",
    "order_id",
    "orderId",
    "reference",
    "request_id",
    "requestId",
    "external_order_id",
    "externalOrderId",
  ]) || "").trim();
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
    this.fulfillmentRequests = new Map();
  }

  getProviderService(provider = "akunding") {
    const providerKey = normalizeProviderKey(provider);
    if (providerKey === "akunding") {
      return this.akundingService;
    }
    if (providerKey === "emma") {
      return this.emmaService;
    }
    const config = this.financialService.getDigitalServiceSupplierRuntimeConfig?.(providerKey);
    return config ? new GenericSupplierService({ config }) : null;
  }

  getProviderStatuses() {
    const statuses = {
      akunding: {
        id: "akunding",
        name: "Alaba Store",
        type: "akunding",
        enabled: true,
        productSync: true,
        automaticFulfillment: true,
        orderReconciliation: true,
        ...(this.akundingService?.getPublicStatus?.() || { configured: false }),
      },
      emma: {
        id: "emma",
        name: "Emma Store",
        type: "emma",
        enabled: true,
        productSync: true,
        automaticFulfillment: true,
        orderReconciliation: true,
        ...(this.emmaService?.getPublicStatus?.() || { configured: false }),
      },
    };
    for (const supplier of this.financialService.listDigitalServiceSuppliers?.({ includeBuiltIns: false }) || []) {
      statuses[supplier.id] = {
        ...supplier,
        configured: supplier.enabled !== false && !!supplier.baseUrl && !!supplier.productEndpoint,
      };
    }
    return statuses;
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

  normalizeSupplierProduct(raw = {}, { provider = "akunding", service = this.getProviderService(provider), supplier = null, mapping = null } = {}) {
    const normalizedProvider = normalizeProviderKey(provider);
    const supplierConfig = supplier || this.financialService.getDigitalServiceSupplierRuntimeConfig?.(normalizedProvider) || null;
    const productMapping = mapping || supplierConfig?.fieldMapping || {};
    const supplierProductId = normalizeProductId(raw, productMapping);
    const supplierCurrency = normalizeCurrency(raw, normalizedProvider === "emma" ? "USD" : "NGN");
    const storeName = getProviderStoreLabel(normalizedProvider, supplierConfig);
    const storeKey = supplierConfig?.storeKey || (normalizedProvider === "emma" ? "emma" : normalizedProvider === "akunding" ? "alaba" : normalizedProvider);
    const automaticFulfillment = normalizedProvider === "akunding" || normalizedProvider === "emma" || supplierConfig?.capabilities?.automaticFulfillment === true;
    return {
      id: createProviderProductId(normalizedProvider, supplierProductId),
      supplierProductId,
      provider: normalizedProvider,
      storeKey,
      storeName,
      name: normalizeName(raw, productMapping),
      description: normalizeDescription(raw, productMapping),
      category: normalizeCategory(raw, productMapping) || storeName,
      currency: normalizedProvider === "emma" && supplierCurrency === "NGN" ? "USD" : supplierCurrency,
      providerCost: normalizeProviderCost(raw, productMapping),
      stock: normalizeStock(raw, productMapping),
      providerStatus: normalizeStatus(raw, productMapping),
      available: automaticFulfillment && supplierConfig?.enabled !== false && isProductAvailable(raw, productMapping),
      sourceMissing: false,
      automaticFulfillment,
      imageUrl: normalizeSupplierImageUrl(getImageCandidate(raw, productMapping), service?.baseUrl || supplierConfig?.baseUrl || "https://akunding.shop"),
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
    for (const provider of this.getSyncProviderKeys()) {
      const service = this.getProviderService(provider);
      if (!service?.isConfigured?.()) {
        continue;
      }
      try {
        const products = await service.listProducts({ includeOutOfStock: true });
        const supplier = this.financialService.getDigitalServiceSupplierRuntimeConfig?.(provider) || null;
        const normalized = extractSupplierRows(products)
          .map((product) => this.normalizeSupplierProduct(extractSupplierRecord(product), { provider, service, supplier }))
          .filter((product) => product.supplierProductId);
        synced.push(...this.financialService.replaceDigitalServiceProducts(normalized, { provider: normalizeProviderKey(provider) }));
        this.financialService.updateDigitalServiceSupplierSyncStats?.(provider, normalized);
      } catch (error) {
        errors.push(`${getProviderStoreLabel(provider)}: ${error.message}`);
        this.financialService.updateDigitalServiceSupplierStatus?.(provider, { status: "failed", error: error.message });
      }
    }
    if (!synced.length && errors.length) {
      throw new Error(errors.join(" | "));
    }
    return this.financialService.listDigitalServiceProducts({ includeInactive: true, admin: true });
  }

  getSyncProviderKeys() {
    const keys = ["akunding", "emma"];
    for (const supplier of this.financialService.listDigitalServiceSuppliers?.({ includeBuiltIns: false }) || []) {
      if (supplier.enabled !== false && supplier.productSync !== false) {
        keys.push(supplier.id);
      }
    }
    return keys;
  }

  analyzeSupplierProducts(payload, { supplierId = "", mapping = null } = {}) {
    const rows = extractSupplierRows(payload).map((row) => extractSupplierRecord(row));
    const detectedMapping = mapping || inferProductMapping(rows);
    const missing = ["supplierProductId", "name", "supplierCost"].filter((field) => !detectedMapping[field]);
    return {
      rows,
      mapping: detectedMapping,
      missing,
      canImport: missing.length === 0,
      products: rows.slice(0, 50).map((row) => this.normalizeSupplierProduct(row, {
        provider: supplierId,
        supplier: this.financialService.getDigitalServiceSupplierRuntimeConfig?.(supplierId),
        mapping: detectedMapping,
        service: this.getProviderService(supplierId),
      })).filter((product) => product.supplierProductId),
    };
  }

  async testSupplierConnection(input = {}) {
    const service = new GenericSupplierService({ config: input });
    const payload = await service.testConnection();
    const rows = extractSupplierRows(payload);
    return {
      connected: true,
      productCount: rows.length,
      mapping: inferProductMapping(rows.map((row) => extractSupplierRecord(row))),
    };
  }

  async previewSupplierProducts(supplierId) {
    const supplier = this.financialService.getDigitalServiceSupplierRuntimeConfig(supplierId);
    if (!supplier || supplier.enabled === false) {
      throw new Error("Supplier is disabled or unavailable.");
    }
    const service = this.getProviderService(supplier.id);
    const payload = await service.listProducts();
    const preview = this.analyzeSupplierProducts(payload, { supplierId: supplier.id, mapping: supplier.fieldMapping });
    return {
      supplier: this.financialService.getDigitalServiceSupplier(supplier.id),
      productCount: preview.rows.length,
      availableCount: preview.products.filter((product) => product.available).length,
      unavailableCount: preview.products.filter((product) => !product.available).length,
      mapping: preview.mapping,
      missing: preview.missing,
      canImport: preview.canImport,
      products: preview.products,
    };
  }

  async importSupplierProducts(supplierId, { mapping = null } = {}) {
    const supplier = this.financialService.getDigitalServiceSupplierRuntimeConfig(supplierId);
    if (!supplier || supplier.enabled === false) {
      throw new Error("Supplier is disabled or unavailable.");
    }
    const service = this.getProviderService(supplier.id);
    const payload = await service.listProducts();
    const preview = this.analyzeSupplierProducts(payload, { supplierId: supplier.id, mapping: mapping || supplier.fieldMapping });
    if (!preview.canImport) {
      const error = new Error(`Map required fields before import: ${preview.missing.join(", ")}`);
      error.statusCode = 400;
      error.mapping = preview.mapping;
      error.missing = preview.missing;
      throw error;
    }
    if (mapping) {
      this.financialService.updateDigitalServiceSupplierMapping(supplier.id, preview.mapping);
    }
    const imported = this.financialService.replaceDigitalServiceProducts(preview.products, { provider: supplier.id });
    this.financialService.updateDigitalServiceSupplierSyncStats?.(supplier.id, preview.products);
    return {
      products: imported,
      summary: {
        importedCount: preview.products.length,
        availableCount: preview.products.filter((product) => product.available).length,
        unavailableCount: preview.products.filter((product) => !product.available).length,
      },
    };
  }

  async refreshProduct(productId) {
    const settings = this.financialService.getDigitalServiceSettings();
    if (!settings.enabled) {
      throw new Error("Digital Services is not available now.");
    }
    const current = this.financialService.getDigitalServiceProduct(productId, { admin: true });
    const provider = normalizeProviderKey(current.provider);
    const service = this.getProviderService(provider);
    const supplierConfig = this.financialService.getDigitalServiceSupplierRuntimeConfig?.(provider);
    if (supplierConfig?.enabled === false) {
      throw new Error("Digital Services supplier is disabled.");
    }
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
    const idempotencyKey = String(requestMeta.idempotencyKey || "").trim();
    const cached = this.financialService.findIdempotent("digital-service:purchase", user?.id, idempotencyKey);
    if (cached?.order) {
      return cached.order;
    }
    const product = this.financialService.getDigitalServiceProduct(input.productId, { admin: true });
    if (!product.available) {
      const error = new Error("This digital service is not available now.");
      error.code = "PRODUCT_UNAVAILABLE";
      error.statusCode = 409;
      throw error;
    }
    const provider = normalizeProviderKey(product.provider);
    const service = this.getProviderService(provider);
    if (!service?.isConfigured?.()) {
      throw new Error("Digital Services supplier is not configured.");
    }
    const quantity = Math.max(1, Math.min(Math.floor(Number(input.quantity || 1)), 1000));
    const quote = this.financialService.quoteDigitalServiceOrder(product, quantity);
    const expectedAmount = normalizeAmountText(input.expectedAmount || "", "");
    if (expectedAmount && compare(expectedAmount, quote.amountCharged) !== 0) {
      const error = new Error("Price updated. Please review the current price before checkout.");
      error.code = "PRICE_CHANGED";
      error.statusCode = 409;
      error.previousAmount = expectedAmount;
      error.currentAmount = quote.amountCharged;
      throw error;
    }
    const order = this.financialService.createDigitalServiceOrder(user, {
      product,
      quantity,
      paymentMethod: input.paymentMethod || "wallet",
    }, requestMeta);
    this.financialService.saveIdempotent("digital-service:purchase", user.id, idempotencyKey, { order });
    if (order.paymentMethod === "paystack") {
      return order;
    }
    const fulfilled = await this.fulfillPaidOrder(order.id, user, requestMeta);
    this.financialService.saveIdempotent("digital-service:purchase", user.id, idempotencyKey, { order: fulfilled });
    return fulfilled;
  }

  async fulfillPaidOrder(orderId, actor, requestMeta = {}) {
    const lockKey = String(orderId || "").trim();
    if (lockKey && this.fulfillmentRequests.has(lockKey)) {
      return this.fulfillmentRequests.get(lockKey);
    }
    const promise = this.fulfillPaidOrderUnlocked(orderId, actor, requestMeta);
    if (lockKey) {
      this.fulfillmentRequests.set(lockKey, promise);
    }
    try {
      return await promise;
    } finally {
      if (lockKey) {
        this.fulfillmentRequests.delete(lockKey);
      }
    }
  }

  async fulfillPaidOrderUnlocked(orderId, actor, requestMeta = {}) {
    const order = this.financialService.getDigitalServiceOrderRecord(actor, orderId);
    if (order.status === "delivered") {
      return this.financialService.getDigitalServiceOrder(actor, order.id);
    }
    if (!["paid", "payment_reserved", "processing", "submitted"].includes(String(order.status || "").toLowerCase())) {
      throw new Error("Order payment is not confirmed.");
    }
    if (order.supplierOrderId || extractDeliveryPayload(this.financialService.decryptDigitalServiceDelivery?.(order))) {
      return this.financialService.getDigitalServiceOrder(actor, order.id);
    }
    if (["fulfilled", "failed_final"].includes(String(order.fulfillmentStatus || "").toLowerCase())) {
      return this.financialService.getDigitalServiceOrder(actor, order.id);
    }
    order.fulfillmentAttemptCount = Number(order.fulfillmentAttemptCount || 0) + 1;
    order.lastFulfillmentAttemptAt = this.clock();
    order.fulfillmentAttemptedAt = order.fulfillmentAttemptedAt || order.lastFulfillmentAttemptAt;
    order.fulfillmentStatus = "processing";
    order.lastFulfillmentError = "";
    const product = this.financialService.getDigitalServiceProduct(order.productId, { admin: true });
    const provider = normalizeProviderKey(order.provider || product.provider);
    const service = this.getProviderService(provider);
    const supplierConfig = this.financialService.getDigitalServiceSupplierRuntimeConfig?.(provider);
    if (supplierConfig?.enabled === false || supplierConfig?.capabilities?.automaticFulfillment === false) {
      return this.financialService.applyDigitalServiceOrderResult(order.id, {
        status: "processing",
        supplierStatus: supplierConfig?.enabled === false ? "supplier_disabled" : "manual_fulfillment_required",
        fulfillmentStatus: "failed_retryable",
        message: supplierConfig?.enabled === false ? "Supplier is disabled." : "Supplier requires manual fulfillment/reconciliation.",
      }, actor, requestMeta);
    }
    if (!service?.isConfigured?.()) {
      return this.financialService.applyDigitalServiceOrderResult(order.id, {
        status: "processing",
        supplierStatus: "supplier_unconfigured",
        fulfillmentStatus: "failed_retryable",
        message: "Supplier fulfillment is pending configuration.",
      }, actor, requestMeta);
    }
    try {
      const reconciledPayloads = await this.fetchSupplierOrderPayloads(order).catch(() => []);
      const reconciled = mergeSupplierPayloads(reconciledPayloads);
      if (reconciled) {
        return this.applySupplierResult(order.id, reconciled, actor, requestMeta);
      }
      if (typeof service.createOrder !== "function") {
        return this.financialService.applyDigitalServiceOrderResult(order.id, {
          status: "processing",
          supplierStatus: "manual_fulfillment_required",
          fulfillmentStatus: "failed_retryable",
          message: "Supplier does not support automatic fulfillment.",
        }, actor, requestMeta);
      }
      const providerResponse = await service.createOrder({
        productId: order.supplierProductId || product.supplierProductId,
        quantity: order.quantity || 1,
        idempotencyKey: order.requestId,
      });
      const supplierOrderId = extractSupplierOrderId(providerResponse);
      let supplementalPayloads = [];
      if (supplierOrderId) {
        supplementalPayloads = await this.fetchSupplierOrderPayloads({ ...order, supplierOrderId }).catch(() => []);
      }
      return this.applySupplierResult(order.id, mergeSupplierPayloads([providerResponse, ...supplementalPayloads]) || providerResponse, actor, requestMeta);
    } catch (error) {
      if (extractDeliveryPayload(error.payload)) {
        return this.applySupplierResult(order.id, error.payload, actor, requestMeta);
      }
      const payload = classifySupplierFulfillmentError(error);
      return this.financialService.applyDigitalServiceOrderResult(order.id, payload, actor, requestMeta);
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
    const requestId = String(order.requestId || order.paymentReference || "").trim();
    if (!supplierOrderId && !requestId) {
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
    if (supplierOrderId && typeof service?.getOrder === "function") {
      await trySupplierCall(() => service.getOrder(supplierOrderId));
    }
    if (supplierOrderId && typeof service?.exportOrder === "function") {
      await trySupplierCall(() => service.exportOrder(supplierOrderId));
    }

    if (!payloads.some((payload) => extractDeliveryPayload(payload)) && typeof service?.listOrders === "function") {
      await trySupplierCall(async () => {
        const ordersPayload = await service.listOrders({ limit: 200 });
        const match = extractSupplierRows(ordersPayload).find((row) => {
          const record = extractSupplierRecord(row);
          const supplierId = String(extractSupplierOrderId(record) || record.id || "").trim();
          const clientReference = String(firstValue(record, [
            "request_id",
            "requestId",
            "reference",
            "client_reference",
            "clientReference",
            "idempotency_key",
            "idempotencyKey",
            "external_reference",
            "externalReference",
            "external_order_id",
            "externalOrderId",
          ]) || "").trim();
          return (supplierOrderId && supplierId === supplierOrderId) || (requestId && clientReference === requestId);
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
  GenericSupplierService,
  PRODUCT_CACHE_TTL_MS,
  classifySupplierFulfillmentError,
  extractDeliveryPayload,
  extractSupplierRows,
  inferProductMapping,
  mapSupplierStatus,
  validateSupplierUrl,
};
