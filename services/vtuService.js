const crypto = require("node:crypto");

const { decryptSetting, encryptSetting } = require("../lib/settingsCrypto");

const VTU_BASE_URL = "https://vtu.ng/wp-json";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 6;
const DATA_PLAN_CACHE_MS = 1000 * 60 * 10;
const NETWORKS = new Set(["mtn", "airtel", "glo", "9mobile"]);
const PROCESSING_STATUSES = new Set(["initiated-api", "processing-api", "queued-api", "pending", "on-hold"]);
const SUCCESS_STATUSES = new Set(["completed-api", "successful", "success"]);
const REFUND_STATUSES = new Set(["refunded"]);
const FAILURE_STATUSES = new Set(["failed", "cancelled"]);

function toNairaAmount(value) {
  const numeric = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

function normalizeNetwork(value) {
  const network = String(value || "").trim().toLowerCase();
  if (!NETWORKS.has(network)) {
    throw new Error("Select a valid network.");
  }
  return network;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  const plusNormalized = raw.startsWith("+") ? `+${raw.slice(1).replace(/\D/g, "")}` : raw.replace(/\D/g, "");
  const digits = plusNormalized.startsWith("+234")
    ? `0${plusNormalized.slice(4)}`
    : plusNormalized.startsWith("234")
      ? `0${plusNormalized.slice(3)}`
      : plusNormalized;
  if (!/^\d{11,16}$/.test(digits)) {
    throw new Error("Enter a valid Nigerian phone number.");
  }
  return digits;
}

function normalizeProviderStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function mapProviderStatus(status, fallbackCode = "") {
  const normalized = normalizeProviderStatus(status);
  if (SUCCESS_STATUSES.has(normalized)) {
    return "successful";
  }
  if (REFUND_STATUSES.has(normalized)) {
    return "refunded";
  }
  if (FAILURE_STATUSES.has(normalized)) {
    return "failed";
  }
  if (PROCESSING_STATUSES.has(normalized) || fallbackCode === "success") {
    return "processing";
  }
  return "processing";
}

function parseDataPlanName(name) {
  const text = String(name || "").trim();
  const parts = text.split(/\s+-\s+/);
  return {
    size: parts[0] || text,
    validity: parts.slice(1).join(" - "),
  };
}

function sanitizeDataPlan(plan, markupPercent = 0) {
  const providerCost = toNairaAmount(plan.price);
  const markupAmount = Math.round(providerCost * Number(markupPercent || 0)) / 100;
  const sellingPrice = Math.round((providerCost + markupAmount) * 100) / 100;
  const parsed = parseDataPlanName(plan.data_plan || plan.name || "");
  return {
    id: String(plan.variation_id || plan.id || "").trim(),
    network: normalizeProviderStatus(plan.service_id || plan.network),
    networkName: String(plan.service_name || "").trim(),
    name: String(plan.data_plan || plan.name || "").trim(),
    size: parsed.size,
    validity: parsed.validity,
    providerCost: String(providerCost),
    sellingPrice: String(sellingPrice),
    availability: String(plan.availability || "").trim(),
  };
}

function parseVtuBalance(payload = {}) {
  return toNairaAmount(payload?.data?.balance ?? payload?.balance ?? 0);
}

function extractProviderData(payload = {}) {
  return payload.data && typeof payload.data === "object" ? payload.data : payload;
}

function isAuthError(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  return status === 401 || status === 403;
}

class VtuService {
  constructor({ financialService, fetchImpl = global.fetch, clock = () => new Date().toISOString(), logger = console } = {}) {
    this.financialService = financialService;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.logger = logger;
    this.dataPlanCache = {
      fetchedAt: 0,
      plans: [],
    };
  }

  getRawSettings() {
    return this.financialService.getRawVtuSettings();
  }

  getCredentials() {
    const settings = this.getRawSettings();
    if (!settings?.usernameEncrypted || !settings?.passwordEncrypted) {
      const error = new Error("VTU_NOT_CONFIGURED");
      error.code = "VTU_NOT_CONFIGURED";
      throw error;
    }
    return {
      username: decryptSetting(settings.usernameEncrypted),
      password: decryptSetting(settings.passwordEncrypted),
      pin: settings.pinEncrypted ? decryptSetting(settings.pinEncrypted) : "",
    };
  }

  async request(path, { method = "GET", body = null, token = "", publicEndpoint = false } = {}) {
    if (!this.fetchImpl) {
      throw new Error("Fetch API is unavailable for VTU.ng requests.");
    }
    const headers = {
      Accept: "application/json",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }
    if (token && !publicEndpoint) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await this.fetchImpl(`${VTU_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }
    if (!response.ok) {
      const error = new Error(String(payload.message || payload.error || "VTU.ng request failed."));
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    if (String(payload.code || "").trim().toLowerCase() === "error") {
      const error = new Error(String(payload.message || payload.error || "VTU.ng request failed."));
      error.statusCode = response.status || 400;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async authenticate(credentials = this.getCredentials()) {
    try {
      const payload = await this.request("/jwt-auth/v1/token", {
        method: "POST",
        body: {
          username: credentials.username,
          password: credentials.password,
        },
        publicEndpoint: true,
      });
      const token = String(payload.token || "").trim();
      if (!token) {
        throw new Error("VTU.ng did not return an access token.");
      }
      const obtainedAt = this.clock();
      const expiresAt = new Date(Date.parse(obtainedAt) + TOKEN_TTL_MS).toISOString();
      this.financialService.saveVtuToken({
        accessTokenEncrypted: encryptSetting(token),
        tokenObtainedAt: obtainedAt,
        tokenExpiresAt: expiresAt,
      });
      return token;
    } catch (error) {
      if (isAuthError(error) || /\bincorrect\b|\bpassword\b|\bauth/i.test(error.message || "")) {
        const friendly = new Error("Unable to authenticate with VTU.ng. Check your reseller username/email and password.");
        friendly.statusCode = 401;
        throw friendly;
      }
      throw error;
    }
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    const settings = this.getRawSettings();
    if (!forceRefresh && settings?.accessTokenEncrypted && Date.parse(settings.tokenExpiresAt || "") > Date.now() + 1000 * 60 * 10) {
      return decryptSetting(settings.accessTokenEncrypted);
    }
    return this.authenticate();
  }

  async authenticatedRequest(path, options = {}) {
    let token = await this.getAccessToken();
    try {
      return await this.request(path, { ...options, token });
    } catch (error) {
      if (!isAuthError(error)) {
        throw error;
      }
      token = await this.getAccessToken({ forceRefresh: true });
      return this.request(path, { ...options, token });
    }
  }

  async getWalletBalance() {
    const payload = await this.authenticatedRequest("/api/v2/balance");
    const balance = parseVtuBalance(payload);
    this.financialService.updateVtuBalanceCache(balance, "connected");
    return {
      success: true,
      message: "VTU.ng connected successfully.",
      balance,
      rawCode: payload.code || "",
    };
  }

  async getDataPlans({ network = "", forceRefresh = false, markupPercent = 0 } = {}) {
    const normalizedNetwork = network ? normalizeNetwork(network) : "";
    const cacheFresh = Date.now() - this.dataPlanCache.fetchedAt < DATA_PLAN_CACHE_MS;
    let plans = this.dataPlanCache.plans;
    if (forceRefresh || !cacheFresh || !plans.length) {
      const query = normalizedNetwork ? `?service_id=${encodeURIComponent(normalizedNetwork)}` : "";
      const payload = await this.request(`/api/v2/variations/data${query}`, { publicEndpoint: true });
      plans = Array.isArray(payload.data) ? payload.data : [];
      this.dataPlanCache = {
        fetchedAt: Date.now(),
        plans,
      };
    }
    return plans
      .map((plan) => sanitizeDataPlan(plan, markupPercent))
      .filter((plan) => plan.id && (!normalizedNetwork || plan.network === normalizedNetwork));
  }

  async purchaseAirtime({ requestId, phone, network, amount }) {
    return this.authenticatedRequest("/api/v2/airtime", {
      method: "POST",
      body: {
        request_id: requestId,
        phone,
        service_id: network,
        amount: Number(amount),
      },
    });
  }

  async purchaseData({ requestId, phone, network, variationId }) {
    return this.authenticatedRequest("/api/v2/data", {
      method: "POST",
      body: {
        request_id: requestId,
        phone,
        service_id: network,
        variation_id: String(variationId),
      },
    });
  }

  async requeryOrder(requestId) {
    return this.authenticatedRequest("/api/v2/requery", {
      method: "POST",
      body: {
        request_id: String(requestId || "").trim(),
      },
    });
  }

  verifyWebhook(rawBody, signature) {
    const { pin } = this.getCredentials();
    if (!pin) {
      return false;
    }
    const payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "{}"));
    const canonical = JSON.stringify(payload);
    const compact = JSON.stringify(payload, Object.keys(payload).sort());
    const candidates = [rawBody, canonical, compact].map((item) =>
      crypto.createHmac("sha256", pin).update(item).digest("hex")
    );
    const signatureBuffer = Buffer.from(String(signature || "").trim());
    return candidates.some((candidate) => {
      const candidateBuffer = Buffer.from(candidate);
      return candidateBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(candidateBuffer, signatureBuffer);
    });
  }
}

module.exports = {
  FAILURE_STATUSES,
  PROCESSING_STATUSES,
  REFUND_STATUSES,
  SUCCESS_STATUSES,
  VTU_BASE_URL,
  VtuService,
  extractProviderData,
  mapProviderStatus,
  normalizeNetwork,
  normalizePhone,
  sanitizeDataPlan,
  toNairaAmount,
};
