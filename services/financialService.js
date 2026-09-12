const {
  add,
  clampDebit,
  compare,
  isPositive,
  multiplyRatio,
  percentChange,
  subtract,
} = require("../lib/money");
const crypto = require("node:crypto");
const { getEnvValue } = require("../lib/env");
const { randomId } = require("../lib/security");
const { decryptSetting, encryptSetting, maskSecret } = require("../lib/settingsCrypto");
const { maskAccountNumber, toKobo } = require("./paystackService");

const SUPPORTED_CURRENCIES = ["USDT", "NGN"];
const WITHDRAWAL_STATUSES = ["PENDING", "APPROVED", "PROCESSING", "SUCCESS", "FAILED", "REJECTED", "REVERSED", "COMPLETED", "CANCELLED"];
const DEPOSIT_STATUSES = ["PENDING", "APPROVED", "REJECTED"];
const ACTIVE_WITHDRAWAL_STATUSES = ["PENDING", "APPROVED", "PROCESSING"];
const MIN_WITHDRAWAL_AMOUNTS = {
  NGN: "500",
  USDT: "50",
};
const DEFAULT_NGN_WITHDRAWAL_FEE = "100";
const DEFAULT_MIN_TRADE_JOIN_USDT = "1";
const DEFAULT_REFERRAL_BONUS_NGN = "500";
const DEFAULT_REFERRAL_MIN_DEPOSIT_NGN = "2000";
const DEFAULT_REFERRAL_MIN_SPEND_NGN = "2000";
const DEFAULT_REFERRAL_MIN_TRADES = 2;
const DEFAULT_REFERRAL_MAX_EARNINGS_NGN = "100000";
const REFERRAL_CODE_PREFIX = "NTR";
const MESSAGE_NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24;
const VTU_FINAL_STATUSES = ["successful", "failed", "refunded"];
const VTU_ACTIVE_STATUSES = ["initiated", "processing"];
const VTU_LEDGER_TYPES = ["VTU_AIRTIME", "VTU_DATA", "VTU_REFUND"];
const DIGITAL_SERVICE_FINAL_STATUSES = ["delivered", "failed", "refunded"];
const DIGITAL_SERVICE_ACTIVE_STATUSES = ["created", "payment_reserved", "submitted", "processing"];
const DIGITAL_SERVICE_LEDGER_TYPES = ["DIGITAL_SERVICE", "DIGITAL_SERVICE_REFUND"];
const DEFAULT_DIGITAL_SERVICE_MARKUP_PERCENT = "0";
const DEFAULT_DIGITAL_SERVICE_FALLBACK_IMAGE = "/services/default-digital-service.png";

function nowIso() {
  return new Date().toISOString();
}

function addMillisecondsToIso(isoValue, durationMs) {
  const timestamp = Date.parse(isoValue || "");
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + durationMs).toISOString();
}

function normalizeCurrency(value, fallback = "USDT") {
  const currency = String(value || fallback).trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return currency;
}

function normalizeAmount(value, label = "Amount") {
  const amount = String(value ?? "").replace(/,/g, "").trim();
  if (!isPositive(amount)) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return amount;
}

function normalizeNonNegativeAmount(value, label = "Amount") {
  const amount = String(value ?? "").replace(/,/g, "").trim();
  if (compare(amount || "0", "0") < 0) {
    throw new Error(`${label} cannot be negative.`);
  }
  return amount || "0";
}

function normalizeGiftCardCode(value) {
  const code = String(value || "").replace(/\D/g, "").trim();
  if (!/^\d{14}$/.test(code)) {
    throw new Error("Enter a valid 14 digit gift card number.");
  }
  return code;
}

function normalizeGiftCardPin(value) {
  const pin = String(value || "").replace(/\D/g, "").trim();
  if (pin && !/^\d{4,8}$/.test(pin)) {
    throw new Error("Enter a valid gift card PIN.");
  }
  return pin;
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function normalizePercent(value, label = "Percent") {
  const percent = normalizeNonNegativeAmount(value ?? "0", label);
  if (compare(percent, "100") > 0) {
    throw new Error(`${label} cannot be more than 100%.`);
  }
  return percent;
}

function normalizeMarkupMode(value) {
  const mode = String(value || "percentage").trim().toLowerCase();
  return ["percentage", "fixed", "custom"].includes(mode) ? mode : "percentage";
}

function normalizeOptionalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeWholeNumber(value, fallback, label = "Value") {
  const source = value === undefined || value === null || String(value).trim() === "" ? fallback : value;
  const numeric = Number(source);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} cannot be negative.`);
  }
  return Math.floor(numeric);
}

function minAmount(a, b) {
  return compare(a, b) <= 0 ? String(a) : String(b);
}

function mapVtuProviderStatus(status, fallbackCode = "") {
  const normalized = String(status || "").trim().toLowerCase();
  const fallback = String(fallbackCode || "").trim().toLowerCase();
  if (["completed-api", "successful", "success"].includes(normalized)) {
    return "successful";
  }
  if (normalized === "refunded") {
    return "refunded";
  }
  if (["failed", "cancelled"].includes(normalized) || fallback === "error") {
    return "failed";
  }
  return "processing";
}

function normalizeNameToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getUserFirstLastName(user = {}) {
  const fullNameTokens = normalizeNameToken(user.name);
  const firstName = normalizeNameToken(user.firstName)[0] || fullNameTokens[0] || "";
  const lastName = normalizeNameToken(user.lastName)[0] || fullNameTokens[fullNameTokens.length - 1] || "";
  return { firstName, lastName };
}

function getNormalizedFullName(user = {}) {
  const { firstName, lastName } = getUserFirstLastName(user);
  return [firstName, lastName].filter(Boolean).join(" ");
}

function getBankAccountNameMatchDetails(user = {}, bank = {}) {
  const { firstName, lastName } = getUserFirstLastName(user);
  const accountTokens = new Set(normalizeNameToken(bank.accountName));
  const expectedTokens = [...new Set([firstName, lastName].filter(Boolean))];
  const matchedTokens = expectedTokens.filter((token) => accountTokens.has(token));
  return {
    expectedFirstName: firstName,
    expectedLastName: lastName,
    expectedName: [firstName, lastName].filter(Boolean).join(" "),
    accountName: bank.accountName || "",
    matchedTokens,
    matchedCount: matchedTokens.length,
    requiredCount: 2,
    matches: expectedTokens.length >= 2 && matchedTokens.length >= 2,
  };
}

function getBankNameMismatchWarning() {
  return "Resolved account name does not match your registered name. Please use a bank account with the same first and last name or your withdrawal may be rejected and your account may be blocked.";
}

function bankAccountNameMatchesUser(user = {}, bank = {}) {
  return getBankAccountNameMatchDetails(user, bank).matches;
}

function isSuspiciousFraudReview(review = {}) {
  return String(review.status || "").trim().toUpperCase() === "SUSPICIOUS";
}

function addMapSet(map, key, value) {
  if (!key) {
    return;
  }
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}

const LEGACY_USDT_BALANCE_FIELDS = ["usdtBalance", "balanceUsdt", "availableUsdt", "availableBalanceUsdt"];
const LEGACY_NGN_BALANCE_FIELDS = ["ngnBalance", "nairaBalance", "balanceNgn", "availableNgn", "availableBalanceNgn"];
const LEGACY_GENERIC_BALANCE_FIELDS = ["balance", "availableBalance", "accountBalance", "walletBalance"];

function readLegacyAmount(user, fields) {
  for (const field of fields) {
    const raw = user?.[field];
    if (raw === undefined || raw === null || raw === "") {
      continue;
    }
    try {
      const cleaned = String(raw).replace(/,/g, "").replace(/(?:NGN|NAIRA|USDT|USD|\$|₦)/gi, "").trim();
      const amount = normalizeNonNegativeAmount(cleaned, field);
      if (compare(amount, "0") > 0) {
        return amount;
      }
    } catch {
      // Ignore historical non-balance strings on legacy user records.
    }
  }
  return "0";
}

function inferLegacyGenericBalanceCurrency(user, amount) {
  const explicit = String(user?.balanceCurrency || user?.currency || user?.walletCurrency || "").trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.includes(explicit)) {
    return explicit;
  }
  return Number(amount || 0) >= 1000 ? "NGN" : "USDT";
}

function defaultSettings() {
  const configuredRate = getEnvValue("USDT_NGN_RATE", "BYBIT_USDT_NGN_RATE") || "1600";
  return {
    general: {
      platformName: getEnvValue("PLATFORM_NAME") || "NetrueFX",
      supportEmail: getEnvValue("SUPPORT_EMAIL") || "support@netrue.local",
      maintenanceMode: false,
    },
    deposit: {
      ngnEnabled: true,
      bankName: getEnvValue("DEPOSIT_BANK_NAME") || "",
      accountName: getEnvValue("DEPOSIT_ACCOUNT_NAME") || "",
      accountNumber: getEnvValue("DEPOSIT_ACCOUNT_NUMBER") || "",
      bankNote: getEnvValue("DEPOSIT_BANK_NOTE") || "",
      usdtAddress: getEnvValue("DEPOSIT_USDT_ADDRESS") || "",
      usdtNetwork: getEnvValue("DEPOSIT_USDT_NETWORK") || "TRC20",
      minUsdt: getEnvValue("MIN_DEPOSIT_USDT") || "1",
      maxUsdt: getEnvValue("MAX_DEPOSIT_USDT") || "1000000",
      minNgn: getEnvValue("MIN_DEPOSIT_NGN") || "1000",
      maxNgn: getEnvValue("MAX_DEPOSIT_NGN") || "1000000000",
    },
    withdrawal: {
      ngnEnabled: true,
      usdtEnabled: true,
      minUsdt: getEnvValue("MIN_WITHDRAWAL_USDT") || "50",
      maxUsdt: getEnvValue("MAX_WITHDRAWAL_USDT") || "1000000",
      minNgn: getEnvValue("MIN_WITHDRAWAL_NGN") || "500",
      maxNgn: getEnvValue("MAX_WITHDRAWAL_NGN") || "1000000000",
      maxDailyCount: 0,
      maxDailyNgn: getEnvValue("MAX_DAILY_WITHDRAWAL_NGN") || "10000000",
      usdtFee: getEnvValue("WITHDRAWAL_USDT_FEE") || "0",
      ngnFee: getEnvValue("WITHDRAWAL_NGN_FEE") || DEFAULT_NGN_WITHDRAWAL_FEE,
    },
    exchangeRate: {
      usdtToNgn: configuredRate,
      updatedAt: nowIso(),
      updatedBy: "system",
    },
    telegram: {
      channelUsername: getEnvValue("TELEGRAM_SIGNAL_CHANNEL", "TELEGRAM_CHANNEL_USERNAME") || "netruesignal",
    },
    vtu: {
      provider: "vtu_ng",
      usernameEncrypted: "",
      passwordEncrypted: "",
      pinEncrypted: "",
      accessTokenEncrypted: "",
      tokenObtainedAt: null,
      tokenExpiresAt: null,
      airtimeEnabled: false,
      dataEnabled: false,
      airtimeMarkupPercent: "0",
      dataMarkupPercent: "0",
      minAirtimeAmount: "100",
      maxAirtimeAmount: "50000",
      lowBalanceThreshold: "5000",
      configured: false,
      lastConnectionTestAt: null,
      lastConnectionStatus: "",
      lastKnownBalance: null,
      lastBalanceCheckedAt: null,
      updatedBy: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    digitalServices: {
      provider: "akunding",
      enabled: false,
      globalMarkupPercent: getEnvValue("AKUNDING_GLOBAL_MARKUP_PERCENT") || DEFAULT_DIGITAL_SERVICE_MARKUP_PERCENT,
      fallbackImageUrl: DEFAULT_DIGITAL_SERVICE_FALLBACK_IMAGE,
      allowedImageDomains: ["akunding.shop"],
      productOverrides: {},
      lastSyncAt: null,
      lastSyncStatus: "",
      lastSyncError: "",
      supplierBalance: null,
      supplierBalanceCurrency: "",
      lastBalanceCheckedAt: null,
      updatedBy: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    trading: {
      tradingEnabled: true,
      dailyPerformanceMode: "manual",
      supportedExchanges: ["bybit", "binance"],
      minJoinUsdt: getEnvValue("MIN_TRADE_JOIN_USDT") || DEFAULT_MIN_TRADE_JOIN_USDT,
    },
    referral: {
      enabled: true,
      bonusAmountNgn: getEnvValue("REFERRAL_BONUS_NGN") || DEFAULT_REFERRAL_BONUS_NGN,
      minimumDepositNgn: getEnvValue("REFERRAL_MIN_DEPOSIT_NGN") || DEFAULT_REFERRAL_MIN_DEPOSIT_NGN,
      minimumSpendNgn: getEnvValue("REFERRAL_MIN_SPEND_NGN") || DEFAULT_REFERRAL_MIN_SPEND_NGN,
      minimumTrades: normalizeWholeNumber(getEnvValue("REFERRAL_MIN_TRADES"), DEFAULT_REFERRAL_MIN_TRADES, "Referral minimum trades"),
      maximumEarningsNgn: getEnvValue("REFERRAL_MAX_EARNINGS_NGN") || DEFAULT_REFERRAL_MAX_EARNINGS_NGN,
      campaignMaximumNgn: getEnvValue("REFERRAL_CAMPAIGN_MAXIMUM_NGN") || DEFAULT_REFERRAL_MAX_EARNINGS_NGN,
      updatedAt: nowIso(),
      updatedBy: "system",
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toDecimalText(value, fallback = "0") {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return number.toFixed(8).replace(/\.?0+$/, "") || "0";
}

class FinancialService {
  constructor({ db, persist = () => undefined, idGenerator = randomId, clock = nowIso, notificationPublisher = null } = {}) {
    this.db = db;
    this.persist = persist;
    this.idGenerator = idGenerator;
    this.clock = clock;
    this.notificationPublisher = notificationPublisher;
  }

  ensureState() {
    this.db.wallets = Array.isArray(this.db.wallets) ? this.db.wallets : [];
    this.db.transactions = Array.isArray(this.db.transactions) ? this.db.transactions : [];
    this.db.deposits = Array.isArray(this.db.deposits) ? this.db.deposits : [];
    this.db.withdrawals = Array.isArray(this.db.withdrawals) ? this.db.withdrawals : [];
    this.db.giftCards = Array.isArray(this.db.giftCards) ? this.db.giftCards : [];
    this.db.tradeInvestments = Array.isArray(this.db.tradeInvestments) ? this.db.tradeInvestments : [];
    this.db.referrals = Array.isArray(this.db.referrals) ? this.db.referrals : [];
    this.db.notifications = Array.isArray(this.db.notifications) ? this.db.notifications : [];
    this.db.chatMessages = Array.isArray(this.db.chatMessages) ? this.db.chatMessages : [];
    this.db.dailyPerformances = Array.isArray(this.db.dailyPerformances) ? this.db.dailyPerformances : [];
    this.db.auditLogs = Array.isArray(this.db.auditLogs) ? this.db.auditLogs : [];
    this.db.idempotencyKeys = Array.isArray(this.db.idempotencyKeys) ? this.db.idempotencyKeys : [];
    this.db.webhookEvents = Array.isArray(this.db.webhookEvents) ? this.db.webhookEvents : [];
    this.db.pushSubscriptions = Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : [];
    this.db.pushNotificationEvents = Array.isArray(this.db.pushNotificationEvents) ? this.db.pushNotificationEvents : [];
    this.db.vtuTransactions = Array.isArray(this.db.vtuTransactions) ? this.db.vtuTransactions : [];
    this.db.digitalServiceProducts = Array.isArray(this.db.digitalServiceProducts) ? this.db.digitalServiceProducts : [];
    this.db.digitalServiceOrders = Array.isArray(this.db.digitalServiceOrders) ? this.db.digitalServiceOrders : [];
    this.db.systemSettings = {
      ...defaultSettings(),
      ...(this.db.systemSettings || {}),
      general: {
        ...defaultSettings().general,
        ...(this.db.systemSettings?.general || {}),
      },
      deposit: {
        ...defaultSettings().deposit,
        ...(this.db.systemSettings?.deposit || {}),
      },
      withdrawal: {
        ...defaultSettings().withdrawal,
        ...(this.db.systemSettings?.withdrawal || {}),
      },
      exchangeRate: {
        ...defaultSettings().exchangeRate,
        ...(this.db.systemSettings?.exchangeRate || {}),
      },
      telegram: {
        ...defaultSettings().telegram,
        ...(this.db.systemSettings?.telegram || {}),
      },
      vtu: {
        ...defaultSettings().vtu,
        ...(this.db.systemSettings?.vtu || {}),
      },
      digitalServices: {
        ...defaultSettings().digitalServices,
        ...(this.db.systemSettings?.digitalServices || {}),
      },
      trading: {
        ...defaultSettings().trading,
        ...(this.db.systemSettings?.trading || {}),
      },
      referral: {
        ...defaultSettings().referral,
        ...(this.db.systemSettings?.referral || {}),
      },
    };
    if (compare(this.db.systemSettings.withdrawal.minUsdt || "0", MIN_WITHDRAWAL_AMOUNTS.USDT) < 0) {
      this.db.systemSettings.withdrawal.minUsdt = MIN_WITHDRAWAL_AMOUNTS.USDT;
    }
    if (compare(this.db.systemSettings.withdrawal.minNgn || "0", MIN_WITHDRAWAL_AMOUNTS.NGN) < 0) {
      this.db.systemSettings.withdrawal.minNgn = MIN_WITHDRAWAL_AMOUNTS.NGN;
    }
    this.db.systemSettings.referral = this.normalizeReferralSettings(this.db.systemSettings.referral);
    this.db.systemSettings.digitalServices = this.normalizeDigitalServiceSettings(this.db.systemSettings.digitalServices);

    for (const user of this.db.users || []) {
      if (user.role === "user") {
        this.ensureReferralCode(user);
        user.pnlLots = Array.isArray(user.pnlLots) ? user.pnlLots : [];
        user.bankAccounts = Array.isArray(user.bankAccounts) ? user.bankAccounts : [];
        if (user.bankAccount && !user.bankAccount.id) {
          user.bankAccount.id = this.idGenerator(12);
        }
        for (const currency of SUPPORTED_CURRENCIES) {
          this.ensureWallet(user.id, currency);
        }
        this.migrateLegacyUserBalance(user);
      }
    }

    for (const withdrawal of this.db.withdrawals) {
      withdrawal.status = String(withdrawal.status || "PENDING").trim().toUpperCase();
      withdrawal.currency = normalizeCurrency(withdrawal.currency || "NGN");
      withdrawal.fee = normalizeNonNegativeAmount(
        withdrawal.fee ?? (withdrawal.currency === "NGN" ? this.db.systemSettings.withdrawal.ngnFee : this.db.systemSettings.withdrawal.usdtFee),
        "Withdrawal fee"
      );
      withdrawal.feeCurrency = withdrawal.feeCurrency || withdrawal.currency;
      withdrawal.requestedAmount = withdrawal.requestedAmount || withdrawal.amount;
      withdrawal.netAmount = withdrawal.netAmount || withdrawal.amount;
      if (this.isLegacyReviewedPaystackReopen(withdrawal)) {
        this.finalizeLegacyReviewedPaystackReopen(withdrawal);
      }
      withdrawal.balanceReserved = withdrawal.balanceReserved !== false && ACTIVE_WITHDRAWAL_STATUSES.includes(withdrawal.status);
      if (withdrawal.currency === "NGN") {
        withdrawal.amountKobo = Number(withdrawal.amountKobo || toKobo(withdrawal.netAmount || withdrawal.amount || "0"));
        withdrawal.paystackReference = withdrawal.paystackReference || withdrawal.externalTransactionReference || this.createPaystackReference();
        withdrawal.bank = withdrawal.bank || withdrawal.destination || {};
      }
    }
  }

  getSettings() {
    this.ensureState();
    const settings = clone(this.db.systemSettings);
    settings.vtu = this.sanitizeVtuSettings(settings.vtu);
    settings.digitalServices = this.sanitizeDigitalServiceSettings(settings.digitalServices, { admin: true });
    return settings;
  }

  normalizeDigitalServiceSettings(settings = {}) {
    const allowedImageDomains = Array.isArray(settings.allowedImageDomains)
      ? settings.allowedImageDomains
      : String(settings.allowedImageDomains || "akunding.shop")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const rawOverrides = settings.productOverrides && typeof settings.productOverrides === "object" && !Array.isArray(settings.productOverrides)
      ? settings.productOverrides
      : {};
    const productOverrides = {};
    for (const [id, override] of Object.entries(rawOverrides)) {
      const normalizedId = String(id || "").trim();
      if (!normalizedId || !override || typeof override !== "object" || Array.isArray(override)) {
        continue;
      }
      productOverrides[normalizedId] = {
        enabled: override.enabled !== undefined ? normalizeBoolean(override.enabled) : true,
        featured: normalizeBoolean(override.featured, false),
        order: normalizeWholeNumber(override.order, 0, "Product order"),
        displayName: String(override.displayName || "").trim(),
        displayCategory: String(override.displayCategory || "").trim(),
        customImageUrl: normalizeOptionalUrl(override.customImageUrl),
        markupMode: normalizeMarkupMode(override.markupMode),
        markupValue: normalizeNonNegativeAmount(override.markupValue ?? "0", "Product markup"),
        customPriceNgn: normalizeNonNegativeAmount(override.customPriceNgn ?? "0", "Custom product price"),
      };
    }
    return {
      provider: "akunding",
      enabled: settings.enabled !== undefined ? normalizeBoolean(settings.enabled) : false,
      globalMarkupPercent: normalizePercent(settings.globalMarkupPercent ?? DEFAULT_DIGITAL_SERVICE_MARKUP_PERCENT, "Digital Services markup"),
      fallbackImageUrl: settings.fallbackImageUrl || DEFAULT_DIGITAL_SERVICE_FALLBACK_IMAGE,
      allowedImageDomains: allowedImageDomains.length ? allowedImageDomains : ["akunding.shop"],
      productOverrides,
      lastSyncAt: settings.lastSyncAt || null,
      lastSyncStatus: settings.lastSyncStatus || "",
      lastSyncError: settings.lastSyncError || "",
      supplierBalance: settings.supplierBalance ?? null,
      supplierBalanceCurrency: settings.supplierBalanceCurrency || "",
      lastBalanceCheckedAt: settings.lastBalanceCheckedAt || null,
      updatedBy: settings.updatedBy || "system",
      createdAt: settings.createdAt || this.clock(),
      updatedAt: settings.updatedAt || this.clock(),
    };
  }

  sanitizeDigitalServiceSettings(settings = this.db.systemSettings?.digitalServices || {}, { admin = false } = {}) {
    const normalized = this.normalizeDigitalServiceSettings(settings);
    const summary = {
      provider: "akunding",
      enabled: normalized.enabled,
      configured: !!normalized.enabled,
      globalMarkupPercent: normalized.globalMarkupPercent,
      fallbackImageUrl: normalized.fallbackImageUrl,
      lastSyncAt: normalized.lastSyncAt,
      lastSyncStatus: normalized.lastSyncStatus,
      lastSyncError: admin ? normalized.lastSyncError : "",
      productCount: this.db.digitalServiceProducts?.length || 0,
      updatedAt: normalized.updatedAt,
    };
    if (admin) {
      summary.allowedImageDomains = normalized.allowedImageDomains;
      summary.productOverrides = clone(normalized.productOverrides);
      summary.supplierBalance = normalized.supplierBalance;
      summary.supplierBalanceCurrency = normalized.supplierBalanceCurrency;
      summary.lastBalanceCheckedAt = normalized.lastBalanceCheckedAt;
      summary.updatedBy = normalized.updatedBy;
    }
    return summary;
  }

  getDigitalServiceSettings() {
    this.ensureState();
    return this.sanitizeDigitalServiceSettings(this.db.systemSettings.digitalServices, { admin: true });
  }

  normalizeReferralSettings(settings = {}) {
    return {
      enabled: settings.enabled !== undefined ? normalizeBoolean(settings.enabled) : true,
      bonusAmountNgn: normalizeNonNegativeAmount(settings.bonusAmountNgn ?? DEFAULT_REFERRAL_BONUS_NGN, "Referral bonus"),
      minimumDepositNgn: normalizeNonNegativeAmount(settings.minimumDepositNgn ?? DEFAULT_REFERRAL_MIN_DEPOSIT_NGN, "Referral minimum deposit"),
      minimumSpendNgn: normalizeNonNegativeAmount(settings.minimumSpendNgn ?? DEFAULT_REFERRAL_MIN_SPEND_NGN, "Referral minimum spend"),
      minimumTrades: normalizeWholeNumber(settings.minimumTrades, DEFAULT_REFERRAL_MIN_TRADES, "Referral minimum trades"),
      maximumEarningsNgn: normalizeNonNegativeAmount(settings.maximumEarningsNgn ?? DEFAULT_REFERRAL_MAX_EARNINGS_NGN, "Maximum referral earnings"),
      campaignMaximumNgn: normalizeNonNegativeAmount(
        settings.campaignMaximumNgn ?? settings.maximumEarningsNgn ?? DEFAULT_REFERRAL_MAX_EARNINGS_NGN,
        "Referral campaign maximum"
      ),
      updatedAt: settings.updatedAt || this.clock(),
      updatedBy: settings.updatedBy || "system",
    };
  }

  generateReferralCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      let suffix = "";
      for (let index = 0; index < 6; index += 1) {
        suffix += alphabet[crypto.randomInt(0, alphabet.length)];
      }
      const code = `${REFERRAL_CODE_PREFIX}-${suffix}`;
      if (!this.db.users.some((user) => String(user.referralCode || "").toUpperCase() === code)) {
        return code;
      }
    }
    return `${REFERRAL_CODE_PREFIX}-${this.idGenerator(12).replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
  }

  ensureReferralCode(user) {
    if (!user || user.role !== "user") {
      return "";
    }
    const current = String(user.referralCode || "").trim().toUpperCase();
    const duplicate = current && this.db.users.some((item) => item.id !== user.id && String(item.referralCode || "").trim().toUpperCase() === current);
    if (current && !duplicate) {
      user.referralCode = current;
      return current;
    }
    user.referralCode = this.generateReferralCode();
    user.referralCodeCreatedAt = user.referralCodeCreatedAt || this.clock();
    return user.referralCode;
  }

  getReferralSettings() {
    this.ensureState();
    return clone(this.db.systemSettings.referral);
  }

  findUserByReferralCode(code) {
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) {
      return null;
    }
    this.ensureState();
    return this.db.users.find((user) => user.role === "user" && String(user.referralCode || "").trim().toUpperCase() === normalized) || null;
  }

  registerReferralForSignup(referredUser, referralCode = "", requestMeta = {}) {
    this.ensureState();
    if (!referredUser || referredUser.role !== "user") {
      return null;
    }
    this.ensureReferralCode(referredUser);
    const code = String(referralCode || "").trim().toUpperCase();
    if (!code) {
      return null;
    }
    const referrer = this.findUserByReferralCode(code);
    if (!referrer || referrer.id === referredUser.id || referrer.referredByUserId === referredUser.id) {
      return null;
    }
    const existing = this.db.referrals.find((item) => item.referredUserId === referredUser.id);
    if (existing) {
      return clone(existing);
    }
    const referral = {
      id: this.idGenerator(12),
      referrerUserId: referrer.id,
      referredUserId: referredUser.id,
      referralCode: referrer.referralCode,
      status: "registered",
      depositQualified: false,
      spendQualified: false,
      tradeQualified: false,
      qualifiedDepositAmount: "0",
      qualifiedSpendAmount: "0",
      qualifiedTradeCount: 0,
      depositQualifiedAt: null,
      activityQualifiedAt: null,
      qualifiedAt: null,
      rewardAmount: "0",
      rewardAmountSnapshot: "0",
      rewardedAt: null,
      rewardTransactionId: "",
      rewardReference: `referral:${referredUser.id}`,
      createdAt: this.clock(),
      updatedAt: this.clock(),
    };
    referredUser.referredByUserId = referrer.id;
    referredUser.referredByReferralCode = referrer.referralCode;
    this.db.referrals.unshift(referral);
    this.audit(referredUser, "REFERRAL_REGISTERED", "Referral", referral.id, {
      referrerUserId: referrer.id,
    }, requestMeta);
    this.persist();
    return clone(referral);
  }

  getReferralDepositTotalNgn(userId) {
    return this.db.deposits
      .filter((deposit) => deposit.userId === userId && String(deposit.status || "").toUpperCase() === "APPROVED")
      .reduce((sum, deposit) => {
        const amount = deposit.currency === "NGN"
          ? String(deposit.amount || "0")
          : String(deposit.displayAmounts?.NGN || this.convertAmount(deposit.amount || "0", deposit.currency || "USDT", "NGN", deposit.exchangeRate));
        return add(sum, normalizeNonNegativeAmount(amount, "Referral deposit amount"));
      }, "0");
  }

  getReferralSpendTotalNgn(userId) {
    return this.db.vtuTransactions
      .filter((transaction) =>
        transaction.userId === userId &&
        ["airtime", "data"].includes(String(transaction.productType || "").toLowerCase()) &&
        String(transaction.status || "").toLowerCase() === "successful"
      )
      .reduce((sum, transaction) => add(sum, normalizeNonNegativeAmount(transaction.amountCharged || "0", "Referral spend amount")), "0");
  }

  getReferralTradeCount(userId) {
    return this.db.tradeInvestments
      .filter((investment) => investment.userId === userId && String(investment.status || "").toUpperCase() === "ACTIVE")
      .length;
  }

  getReferralPaidTotalNgn(referrerUserId) {
    return this.db.referrals
      .filter((referral) => referral.referrerUserId === referrerUserId && referral.rewardedAt)
      .reduce((sum, referral) => add(sum, referral.rewardAmount || "0"), "0");
  }

  maskReferralUser(user = {}) {
    const source = String(user.id || user.email || "");
    const suffix = source.replace(/[^a-z0-9]/gi, "").slice(-4).padStart(4, "*");
    return `User ****${suffix}`;
  }

  serializeReferral(referral, { admin = false } = {}) {
    const referrer = this.db.users.find((user) => user.id === referral.referrerUserId) || {};
    const referred = this.db.users.find((user) => user.id === referral.referredUserId) || {};
    const settings = this.db.systemSettings.referral;
    const depositActivity = {
      amount: referral.qualifiedDepositAmount || "0",
      required: settings.minimumDepositNgn,
      qualified: !!referral.depositQualified,
    };
    const spendActivity = {
      amount: referral.qualifiedSpendAmount || "0",
      required: settings.minimumSpendNgn,
      qualified: !!referral.spendQualified,
    };
    const tradeActivity = {
      count: Number(referral.qualifiedTradeCount || 0),
      required: Number(settings.minimumTrades || 0),
      qualified: !!referral.tradeQualified,
    };
    const base = {
      id: referral.id,
      status: referral.status,
      depositQualified: !!referral.depositQualified,
      spendQualified: !!referral.spendQualified,
      tradeQualified: !!referral.tradeQualified,
      depositProgress: depositActivity,
      spendProgress: spendActivity,
      tradeProgress: tradeActivity,
      qualifiedAt: referral.qualifiedAt || null,
      rewardedAt: referral.rewardedAt || null,
      rewardAmount: referral.rewardAmount || "0",
      rewardAmountSnapshot: referral.rewardAmountSnapshot || referral.rewardAmount || "0",
      createdAt: referral.createdAt,
      updatedAt: referral.updatedAt,
    };
    if (admin) {
      return {
        ...base,
        referralCode: referral.referralCode,
        referrer: { id: referrer.id || "", name: referrer.name || "", email: referrer.email || "" },
        referredUser: { id: referred.id || "", name: referred.name || "", email: referred.email || "" },
      };
    }
    return {
      ...base,
      referredUser: {
        label: this.maskReferralUser(referred),
        registeredAt: referred.createdAt || referral.createdAt,
      },
    };
  }

  issueReferralReward(referral, settings, requestMeta = {}) {
    if (referral.rewardedAt) {
      return false;
    }
    const existingReward = this.db.transactions.find((transaction) => transaction.reference === referral.rewardReference);
    if (existingReward) {
      referral.rewardedAt = referral.rewardedAt || existingReward.createdAt || this.clock();
      referral.rewardAmount = referral.rewardAmount || existingReward.amount || "0";
      referral.rewardTransactionId = existingReward.id;
      referral.status = "rewarded";
      referral.updatedAt = this.clock();
      return false;
    }
    if (!settings.enabled || compare(settings.bonusAmountNgn, "0") <= 0) {
      return false;
    }

    const maxEarnings = settings.maximumEarningsNgn || "0";
    const paidTotal = this.getReferralPaidTotalNgn(referral.referrerUserId);
    const remainingCap = compare(maxEarnings, "0") > 0 ? subtract(maxEarnings, paidTotal) : settings.bonusAmountNgn;
    if (compare(remainingCap, "0") <= 0) {
      referral.status = "qualified";
      referral.updatedAt = this.clock();
      return false;
    }
    const rewardAmount = compare(maxEarnings, "0") > 0 ? minAmount(settings.bonusAmountNgn, remainingCap) : settings.bonusAmountNgn;
    const wallet = this.ensureWallet(referral.referrerUserId, "NGN");
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = add(wallet.availableBalance, rewardAmount);
    wallet.updatedAt = this.clock();
    this.clearUserPnlLots(referral.referrerUserId);

    const transaction = {
      id: this.idGenerator(12),
      userId: referral.referrerUserId,
      type: "REFERRAL_BONUS",
      currency: "NGN",
      amount: rewardAmount,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: referral.rewardReference,
      status: "SUCCESSFUL",
      description: "Referral Bonus",
      createdBy: "system",
      createdAt: this.clock(),
      metadata: {
        type: "referral_bonus",
        referralId: referral.id,
        referredUserId: referral.referredUserId,
        bonusAmountSnapshot: rewardAmount,
        uniqueReference: referral.rewardReference,
        displayAmounts: this.getDisplayAmounts(rewardAmount, "NGN"),
      },
    };
    this.db.transactions.unshift(transaction);
    referral.rewardAmount = rewardAmount;
    referral.rewardAmountSnapshot = rewardAmount;
    referral.rewardedAt = transaction.createdAt;
    referral.rewardTransactionId = transaction.id;
    referral.status = "rewarded";
    referral.updatedAt = this.clock();
    this.createNotification({
      userId: referral.referrerUserId,
      type: "REFERRAL",
      title: "Referral Bonus",
      message: `${rewardAmount} NGN has been added to your wallet.`,
      entityType: "Referral",
      entityId: referral.id,
      route: "/?tab=referral",
      dedupeKey: referral.rewardReference,
    });
    this.audit({ id: "system", role: "system" }, "REFERRAL_REWARD_PAID", "Referral", referral.id, {
      amount: rewardAmount,
      currency: "NGN",
    }, requestMeta);
    return true;
  }

  evaluateReferralQualification(referredUserId, requestMeta = {}) {
    this.ensureState();
    const referral = this.db.referrals.find((item) => item.referredUserId === referredUserId);
    if (!referral) {
      return null;
    }
    if (referral.rewardedAt) {
      return clone(referral);
    }
    const settings = this.db.systemSettings.referral;
    const depositTotal = this.getReferralDepositTotalNgn(referredUserId);
    const spendTotal = this.getReferralSpendTotalNgn(referredUserId);
    const tradeCount = this.getReferralTradeCount(referredUserId);
    const depositQualified = compare(depositTotal, settings.minimumDepositNgn) >= 0;
    const spendQualified = compare(spendTotal, settings.minimumSpendNgn) >= 0;
    const tradeQualified = tradeCount >= Number(settings.minimumTrades || 0);
    const activityQualified = spendQualified || tradeQualified;
    const fullyQualified = depositQualified && activityQualified;

    referral.depositQualified = depositQualified;
    referral.spendQualified = spendQualified;
    referral.tradeQualified = tradeQualified;
    referral.qualifiedDepositAmount = depositTotal;
    referral.qualifiedSpendAmount = spendTotal;
    referral.qualifiedTradeCount = tradeCount;
    referral.depositQualifiedAt = depositQualified ? referral.depositQualifiedAt || this.clock() : null;
    referral.activityQualifiedAt = activityQualified ? referral.activityQualifiedAt || this.clock() : null;
    referral.qualifiedAt = fullyQualified ? referral.qualifiedAt || this.clock() : null;
    referral.status = referral.rewardedAt
      ? "rewarded"
      : fullyQualified
        ? "qualified"
        : (depositQualified || activityQualified ? "in_progress" : "registered");
    referral.updatedAt = this.clock();

    if (fullyQualified) {
      this.issueReferralReward(referral, settings, requestMeta);
    }
    this.persist();
    return clone(referral);
  }

  getReferralStatsForUser(userId) {
    const referrals = this.db.referrals.filter((referral) => referral.referrerUserId === userId);
    return {
      totalReferrals: referrals.length,
      qualifiedReferrals: referrals.filter((referral) => referral.qualifiedAt).length,
      pendingReferrals: referrals.filter((referral) => !referral.qualifiedAt).length,
      rewardedReferrals: referrals.filter((referral) => referral.rewardedAt).length,
      totalReferralEarnings: referrals.reduce((sum, referral) => add(sum, referral.rewardedAt ? referral.rewardAmount || "0" : "0"), "0"),
    };
  }

  getReferralProfile(user) {
    this.ensureState();
    const code = this.ensureReferralCode(user);
    const settings = this.getReferralSettings();
    const referrals = this.db.referrals
      .filter((referral) => referral.referrerUserId === user.id)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .map((referral) => this.serializeReferral(referral));
    return {
      settings,
      referralCode: code,
      referralPath: `/signup?ref=${encodeURIComponent(code)}`,
      stats: this.getReferralStatsForUser(user.id),
      referrals,
    };
  }

  getAdminReferralSummary({ limit = 50, offset = 0 } = {}) {
    this.ensureState();
    const referrals = this.db.referrals
      .slice()
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    const totalPayout = referrals.reduce((sum, referral) => add(sum, referral.rewardedAt ? referral.rewardAmount || "0" : "0"), "0");
    return {
      settings: this.getReferralSettings(),
      stats: {
        totalReferrals: referrals.length,
        qualifiedReferrals: referrals.filter((referral) => referral.qualifiedAt).length,
        pendingReferrals: referrals.filter((referral) => !referral.qualifiedAt).length,
        rewardsPaid: referrals.filter((referral) => referral.rewardedAt).length,
        totalReferralPayout: totalPayout,
      },
      total: referrals.length,
      limit,
      offset,
      referrals: referrals.slice(offset, offset + limit).map((referral) => this.serializeReferral(referral, { admin: true })),
    };
  }

  sanitizeVtuSettings(settings = this.db.systemSettings?.vtu || {}) {
    const username = settings.usernameEncrypted ? decryptSetting(settings.usernameEncrypted) : "";
    return {
      provider: settings.provider || "vtu_ng",
      configured: !!(settings.configured && settings.usernameEncrypted && settings.passwordEncrypted),
      username: username ? maskSecret(username, { visibleStart: 2, visibleEnd: 2 }) : "",
      usernameMasked: username ? maskSecret(username, { visibleStart: 2, visibleEnd: 2 }) : "",
      hasUsername: !!settings.usernameEncrypted,
      hasPassword: !!settings.passwordEncrypted,
      hasPin: !!settings.pinEncrypted,
      tokenCached: !!settings.accessTokenEncrypted,
      tokenObtainedAt: settings.tokenObtainedAt || null,
      tokenExpiresAt: settings.tokenExpiresAt || null,
      airtimeEnabled: !!settings.airtimeEnabled,
      dataEnabled: !!settings.dataEnabled,
      airtimeMarkupPercent: String(settings.airtimeMarkupPercent ?? "0"),
      dataMarkupPercent: String(settings.dataMarkupPercent ?? "0"),
      minAirtimeAmount: String(settings.minAirtimeAmount ?? "100"),
      maxAirtimeAmount: String(settings.maxAirtimeAmount ?? "50000"),
      lowBalanceThreshold: String(settings.lowBalanceThreshold ?? "5000"),
      lastConnectionTestAt: settings.lastConnectionTestAt || null,
      lastConnectionStatus: settings.lastConnectionStatus || "",
      lastKnownBalance: settings.lastKnownBalance ?? null,
      lastBalanceCheckedAt: settings.lastBalanceCheckedAt || null,
      updatedBy: settings.updatedBy || "",
      createdAt: settings.createdAt || null,
      updatedAt: settings.updatedAt || null,
    };
  }

  getRawVtuSettings() {
    this.ensureState();
    return clone(this.db.systemSettings.vtu);
  }

  updateVtuSettings(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const before = this.db.systemSettings.vtu || defaultSettings().vtu;
    const next = {
      ...before,
      provider: "vtu_ng",
      airtimeEnabled: input.airtimeEnabled !== undefined ? normalizeBoolean(input.airtimeEnabled) : !!before.airtimeEnabled,
      dataEnabled: input.dataEnabled !== undefined ? normalizeBoolean(input.dataEnabled) : !!before.dataEnabled,
      airtimeMarkupPercent: normalizePercent(input.airtimeMarkupPercent ?? before.airtimeMarkupPercent ?? "0", "Airtime markup"),
      dataMarkupPercent: normalizePercent(input.dataMarkupPercent ?? before.dataMarkupPercent ?? "0", "Data markup"),
      minAirtimeAmount: normalizeAmount(input.minAirtimeAmount ?? before.minAirtimeAmount ?? "100", "Minimum airtime amount"),
      maxAirtimeAmount: normalizeAmount(input.maxAirtimeAmount ?? before.maxAirtimeAmount ?? "50000", "Maximum airtime amount"),
      lowBalanceThreshold: normalizeNonNegativeAmount(input.lowBalanceThreshold ?? before.lowBalanceThreshold ?? "5000", "Low balance threshold"),
      updatedBy: admin?.id || "admin",
      updatedAt: this.clock(),
    };
    if (compare(next.minAirtimeAmount, next.maxAirtimeAmount) > 0) {
      throw new Error("Minimum airtime amount cannot be higher than maximum airtime amount.");
    }
    if (Object.prototype.hasOwnProperty.call(input, "username") && String(input.username || "").trim()) {
      next.usernameEncrypted = encryptSetting(String(input.username || "").trim());
      next.accessTokenEncrypted = "";
      next.tokenObtainedAt = null;
      next.tokenExpiresAt = null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "password") && String(input.password || "").trim()) {
      next.passwordEncrypted = encryptSetting(String(input.password || ""));
      next.accessTokenEncrypted = "";
      next.tokenObtainedAt = null;
      next.tokenExpiresAt = null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "pin") && String(input.pin || "").trim()) {
      next.pinEncrypted = encryptSetting(String(input.pin || "").trim());
    }
    next.configured = !!(next.usernameEncrypted && next.passwordEncrypted);
    this.db.systemSettings.vtu = next;
    this.audit(admin, "VTU_SETTINGS_UPDATED", "SystemSettings", "vtu", {
      airtimeEnabled: next.airtimeEnabled,
      dataEnabled: next.dataEnabled,
      configured: next.configured,
    }, requestMeta);
    this.persist();
    return this.sanitizeVtuSettings(next);
  }

  saveVtuToken(input = {}) {
    this.ensureState();
    this.db.systemSettings.vtu = {
      ...this.db.systemSettings.vtu,
      accessTokenEncrypted: input.accessTokenEncrypted || "",
      tokenObtainedAt: input.tokenObtainedAt || this.clock(),
      tokenExpiresAt: input.tokenExpiresAt || null,
      updatedAt: this.clock(),
    };
    this.persist();
  }

  updateVtuBalanceCache(balance, status = "connected") {
    this.ensureState();
    this.db.systemSettings.vtu = {
      ...this.db.systemSettings.vtu,
      lastKnownBalance: String(balance ?? "0"),
      lastBalanceCheckedAt: this.clock(),
      lastConnectionTestAt: this.clock(),
      lastConnectionStatus: status,
      updatedAt: this.clock(),
    };
    this.persist();
    return this.sanitizeVtuSettings(this.db.systemSettings.vtu);
  }

  createVtuRequestId(productType = "vtu") {
    const prefix = String(productType || "vtu").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "vtu";
    return `${prefix}_${Date.now().toString(36)}_${this.idGenerator(10).toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 50);
  }

  calculateVtuSellingPrice(providerCost, markupPercent = "0") {
    const cost = normalizeAmount(providerCost, "VTU amount");
    const markup = multiplyRatio(cost, normalizePercent(markupPercent, "VTU markup"), "100");
    return {
      providerCost: cost,
      markupAmount: markup,
      sellingPrice: add(cost, markup),
    };
  }

  migrateLegacyUserBalance(user) {
    if (!user || user.legacyBalanceMigratedAt) {
      return false;
    }

    const usdtWallet = this.ensureWallet(user.id, "USDT");
    const ngnWallet = this.ensureWallet(user.id, "NGN");
    const hasWalletBalance =
      compare(usdtWallet.availableBalance, "0") > 0 ||
      compare(usdtWallet.lockedBalance, "0") > 0 ||
      compare(ngnWallet.availableBalance, "0") > 0 ||
      compare(ngnWallet.lockedBalance, "0") > 0;

    if (hasWalletBalance) {
      return false;
    }

    let migrated = false;
    const legacyUsdt = readLegacyAmount(user, LEGACY_USDT_BALANCE_FIELDS);
    const legacyNgn = readLegacyAmount(user, LEGACY_NGN_BALANCE_FIELDS);

    if (compare(legacyUsdt, "0") > 0) {
      usdtWallet.availableBalance = legacyUsdt;
      usdtWallet.updatedAt = this.clock();
      migrated = true;
    }

    if (compare(legacyNgn, "0") > 0) {
      ngnWallet.availableBalance = legacyNgn;
      ngnWallet.updatedAt = this.clock();
      migrated = true;
    }

    if (!migrated) {
      const legacyGeneric = readLegacyAmount(user, LEGACY_GENERIC_BALANCE_FIELDS);
      if (compare(legacyGeneric, "0") > 0) {
        const currency = inferLegacyGenericBalanceCurrency(user, legacyGeneric);
        const wallet = currency === "NGN" ? ngnWallet : usdtWallet;
        wallet.availableBalance = legacyGeneric;
        wallet.updatedAt = this.clock();
        migrated = true;
      }
    }

    if (migrated) {
      user.legacyBalanceMigratedAt = this.clock();
    }

    return migrated;
  }

  updateSettings(admin, patch = {}, requestMeta = {}) {
    this.ensureState();
    const before = clone(this.db.systemSettings);
    const next = {
      ...before,
      general: {
        ...before.general,
        ...(patch.general || {}),
      },
      deposit: {
        ...before.deposit,
        ...(patch.deposit || {}),
      },
      withdrawal: {
        ...before.withdrawal,
        ...(patch.withdrawal || {}),
      },
      exchangeRate: {
        ...before.exchangeRate,
        ...(patch.exchangeRate || {}),
      },
      telegram: {
        ...before.telegram,
        ...(patch.telegram || {}),
      },
      trading: {
        ...before.trading,
        ...(patch.trading || {}),
      },
      referral: {
        ...before.referral,
        ...(patch.referral || {}),
      },
      digitalServices: {
        ...before.digitalServices,
        ...(patch.digitalServices || {}),
      },
    };

    if (patch.exchangeRate?.usdtToNgn !== undefined) {
      next.exchangeRate.usdtToNgn = normalizeAmount(patch.exchangeRate.usdtToNgn, "USDT to NGN rate");
      next.exchangeRate.updatedAt = this.clock();
      next.exchangeRate.updatedBy = admin.id;
    }

    if (patch.telegram?.channelUsername !== undefined) {
      next.telegram.channelUsername = String(patch.telegram.channelUsername || "").trim();
    }

    next.deposit.minUsdt = normalizeAmount(next.deposit.minUsdt || "1", "Minimum USDT deposit");
    next.deposit.maxUsdt = normalizeAmount(next.deposit.maxUsdt || "1000000", "Maximum USDT deposit");
    next.deposit.minNgn = normalizeAmount(next.deposit.minNgn || "1000", "Minimum NGN deposit");
    next.deposit.maxNgn = normalizeAmount(next.deposit.maxNgn || "1000000000", "Maximum NGN deposit");
    next.withdrawal.minUsdt = normalizeAmount(next.withdrawal.minUsdt || MIN_WITHDRAWAL_AMOUNTS.USDT, "Minimum USDT withdrawal");
    next.withdrawal.maxUsdt = normalizeAmount(next.withdrawal.maxUsdt || "1000000", "Maximum USDT withdrawal");
    next.withdrawal.minNgn = normalizeAmount(next.withdrawal.minNgn || MIN_WITHDRAWAL_AMOUNTS.NGN, "Minimum NGN withdrawal");
    next.withdrawal.maxNgn = normalizeAmount(next.withdrawal.maxNgn || "1000000000", "Maximum NGN withdrawal");
    next.withdrawal.usdtFee = normalizeNonNegativeAmount(next.withdrawal.usdtFee || "0", "USDT withdrawal fee");
    next.withdrawal.ngnFee = normalizeNonNegativeAmount(next.withdrawal.ngnFee || DEFAULT_NGN_WITHDRAWAL_FEE, "NGN withdrawal fee");
    next.trading.minJoinUsdt = normalizeAmount(next.trading.minJoinUsdt || DEFAULT_MIN_TRADE_JOIN_USDT, "Minimum trade join amount");
    next.referral = this.normalizeReferralSettings({
      ...next.referral,
      updatedBy: patch.referral ? admin.id : next.referral.updatedBy,
      updatedAt: patch.referral ? this.clock() : next.referral.updatedAt,
    });
    next.digitalServices = this.normalizeDigitalServiceSettings({
      ...next.digitalServices,
      updatedBy: patch.digitalServices ? admin.id : next.digitalServices.updatedBy,
      updatedAt: patch.digitalServices ? this.clock() : next.digitalServices.updatedAt,
    });
    next.withdrawal.maxDailyCount = 0;
    next.withdrawal.maxDailyNgn = normalizeAmount(next.withdrawal.maxDailyNgn || "10000000", "Daily withdrawal limit");
    this.db.systemSettings = next;
    this.audit(admin, "SETTINGS_UPDATED", "SystemSettings", "current", { sections: Object.keys(patch) }, requestMeta);
    this.persist();
    return this.getSettings();
  }

  updateDigitalServiceSettings(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const before = this.db.systemSettings.digitalServices || defaultSettings().digitalServices;
    const next = this.normalizeDigitalServiceSettings({
      ...before,
      enabled: input.enabled !== undefined ? input.enabled : before.enabled,
      globalMarkupPercent: input.globalMarkupPercent ?? before.globalMarkupPercent,
      fallbackImageUrl: input.fallbackImageUrl || before.fallbackImageUrl,
      allowedImageDomains: input.allowedImageDomains ?? before.allowedImageDomains,
      productOverrides: input.productOverrides ?? before.productOverrides,
      updatedBy: admin?.id || "admin",
      updatedAt: this.clock(),
    });
    this.db.systemSettings.digitalServices = next;
    this.audit(admin, "DIGITAL_SERVICES_SETTINGS_UPDATED", "SystemSettings", "digitalServices", {
      enabled: next.enabled,
      globalMarkupPercent: next.globalMarkupPercent,
    }, requestMeta);
    this.persist();
    return this.sanitizeDigitalServiceSettings(next, { admin: true });
  }

  updateDigitalServiceSyncStatus({ status = "", error = "", supplierBalance = null, supplierBalanceCurrency = "" } = {}) {
    this.ensureState();
    const current = this.db.systemSettings.digitalServices || defaultSettings().digitalServices;
    this.db.systemSettings.digitalServices = this.normalizeDigitalServiceSettings({
      ...current,
      lastSyncAt: this.clock(),
      lastSyncStatus: status,
      lastSyncError: error,
      supplierBalance: supplierBalance === null ? current.supplierBalance : String(supplierBalance),
      supplierBalanceCurrency: supplierBalanceCurrency || current.supplierBalanceCurrency || "",
      lastBalanceCheckedAt: supplierBalance === null ? current.lastBalanceCheckedAt : this.clock(),
      updatedAt: this.clock(),
    });
    this.persist();
    return this.sanitizeDigitalServiceSettings(this.db.systemSettings.digitalServices, { admin: true });
  }

  convertAmount(amount, fromCurrency, toCurrency, rate = this.db.systemSettings.exchangeRate.usdtToNgn) {
    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    if (from === to) {
      return String(amount);
    }
    normalizeAmount(rate, "USDT to NGN rate");
    return from === "USDT"
      ? multiplyRatio(amount, rate, "1")
      : multiplyRatio(amount, "1", rate);
  }

  getDisplayAmounts(amount, currency, rate = this.db.systemSettings.exchangeRate.usdtToNgn) {
    const normalizedCurrency = normalizeCurrency(currency);
    return {
      USDT: normalizedCurrency === "USDT" ? String(amount) : this.convertAmount(amount, "NGN", "USDT", rate),
      NGN: normalizedCurrency === "NGN" ? String(amount) : this.convertAmount(amount, "USDT", "NGN", rate),
      rate: String(rate),
    };
  }

  createPaystackReference() {
    return `wd_${this.idGenerator(24).toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
  }

  normalizeBankAccount(input = {}) {
    const bankName = String(input.bankName || input.bank || input.bank_name || "").trim();
    const bankCode = String(input.bankCode || input.bank_code || "").trim();
    const accountName = String(input.accountName || input.account_name || "").trim();
    const accountNumber = String(input.accountNumber || input.account_number || "").replace(/\D/g, "").trim();
    if (!bankName || !bankCode || !accountName || !/^\d{10}$/.test(accountNumber)) {
      throw new Error("A verified Nigerian bank account is required.");
    }
    const nameMatch = input.nameMatch === undefined ? undefined : !!input.nameMatch;
    return {
      id: String(input.id || this.idGenerator(12)).trim(),
      type: "NGN_BANK",
      bankName,
      bankCode,
      accountNumber,
      maskedAccountNumber: maskAccountNumber(accountNumber),
      accountName,
      ...(nameMatch === undefined
        ? {}
        : {
            nameMatch,
            nameMatchWarning: nameMatch ? "" : getBankNameMismatchWarning(),
            matchedNameCount: Number(input.matchedNameCount || 0),
            expectedName: String(input.expectedName || "").trim(),
          }),
      paystackRecipientCode: String(input.paystackRecipientCode || input.recipientCode || "").trim(),
      verified: input.verified !== false,
      verifiedAt: input.verifiedAt || this.clock(),
      updatedAt: this.clock(),
    };
  }

  evaluateBankAccountNameMatch(user, bank = {}) {
    const details = getBankAccountNameMatchDetails(user, bank);
    return {
      ...details,
      warning: details.matches ? "" : getBankNameMismatchWarning(),
    };
  }

  enrichBankAccountForUser(user, bank = null) {
    if (!bank) {
      return null;
    }
    const match = this.evaluateBankAccountNameMatch(user, bank);
    return {
      ...clone(bank),
      nameMatch: match.matches,
      nameMatchWarning: match.warning,
      matchedNameCount: match.matchedCount,
      expectedName: match.expectedName,
    };
  }

  getVerifiedBankAccount(user, bankAccountId = "") {
    const candidates = [
      ...(Array.isArray(user.bankAccounts) ? user.bankAccounts : []),
      user.bankAccount,
    ].filter(Boolean);
    const targetId = String(bankAccountId || "").trim();
    const account = targetId
      ? candidates.find((item) => item.id === targetId)
      : candidates.find((item) => item.verified);
    if (!account || !account.verified) {
      throw new Error("Add and verify a Nigerian bank account before withdrawal.");
    }
    const match = this.evaluateBankAccountNameMatch(user, account);
    return this.normalizeBankAccount({
      ...account,
      nameMatch: match.matches,
      matchedNameCount: match.matchedCount,
      expectedName: match.expectedName,
    });
  }

  updateVerifiedBankAccount(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const nameMatch = this.evaluateBankAccountNameMatch(user, input);
    const bankAccount = this.normalizeBankAccount({
      ...input,
      verified: true,
      nameMatch: nameMatch.matches,
      matchedNameCount: nameMatch.matchedCount,
      expectedName: nameMatch.expectedName,
    });
    user.bankAccount = bankAccount;
    user.bankAccounts = Array.isArray(user.bankAccounts) ? user.bankAccounts : [];
    user.bankAccounts = [
      bankAccount,
      ...user.bankAccounts.filter(
        (item) => item.accountNumber !== bankAccount.accountNumber || item.bankCode !== bankAccount.bankCode
      ),
    ];
    this.audit(user, "BANK_ACCOUNT_VERIFIED", "User", user.id, {
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode,
      maskedAccountNumber: bankAccount.maskedAccountNumber,
      nameMatch: bankAccount.nameMatch,
    }, requestMeta);
    this.persist();
    return clone(bankAccount);
  }

  removeVerifiedBankAccount(user, bankAccountId = "", requestMeta = {}) {
    this.ensureState();
    if (!user || user.role !== "user") {
      throw new Error("User not found.");
    }
    const targetId = String(bankAccountId || "").trim();
    if (!targetId) {
      throw new Error("Saved account was not found.");
    }
    const bankAccounts = [
      ...(Array.isArray(user.bankAccounts) ? user.bankAccounts : []),
      user.bankAccount,
    ].filter(Boolean);
    const target = bankAccounts.find((account) => String(account.id || "").trim() === targetId);
    if (!target) {
      throw new Error("Saved account was not found.");
    }
    const targetKey = `${target.bankCode || ""}:${target.accountNumber || ""}`;
    const nextAccounts = [];
    const seen = new Set();
    for (const account of bankAccounts) {
      const key = `${account.id || ""}:${account.bankCode || ""}:${account.accountNumber || ""}`;
      if (String(account.id || "").trim() === targetId || `${account.bankCode || ""}:${account.accountNumber || ""}` === targetKey) {
        continue;
      }
      if (!seen.has(key)) {
        seen.add(key);
        nextAccounts.push(account);
      }
    }
    user.bankAccounts = nextAccounts;
    user.bankAccount = nextAccounts[0] || null;
    this.audit(user, "BANK_ACCOUNT_REMOVED", "User", user.id, {
      bankName: target.bankName,
      bankCode: target.bankCode,
      maskedAccountNumber: target.maskedAccountNumber || maskAccountNumber(target.accountNumber),
    }, requestMeta);
    this.persist();
    return {
      bankAccount: this.enrichBankAccountForUser(user, user.bankAccount || null),
      bankAccounts: clone(user.bankAccounts || []).map((account) => this.enrichBankAccountForUser(user, account)),
      removedBankAccountId: targetId,
    };
  }

  ensureWallet(userId, currency) {
    const normalizedCurrency = normalizeCurrency(currency);
    let wallet = this.db.wallets.find((item) => item.userId === userId && item.currency === normalizedCurrency);
    if (!wallet) {
      wallet = {
        id: this.idGenerator(12),
        userId,
        currency: normalizedCurrency,
        availableBalance: "0",
        lockedBalance: "0",
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.db.wallets.push(wallet);
    } else {
      const availableFallback = wallet.availableBalance ?? wallet.balance ?? wallet.amount ?? "0";
      const lockedFallback = wallet.lockedBalance ?? wallet.locked ?? "0";
      wallet.availableBalance = normalizeNonNegativeAmount(availableFallback, "Available balance");
      wallet.lockedBalance = normalizeNonNegativeAmount(lockedFallback, "Locked balance");
    }
    return wallet;
  }

  getWallets(userId) {
    this.ensureState();
    return SUPPORTED_CURRENCIES.map((currency) => this.ensureWallet(userId, currency)).map(clone);
  }

  getTransactions(userId, { limit = 50, offset = 0 } = {}) {
    this.ensureState();
    return this.db.transactions
      .filter((item) => item.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(offset, offset + limit)
      .map(clone);
  }

  listTransactions(user, { limit = 200, offset = 0 } = {}) {
    this.ensureState();
    return this.db.transactions
      .filter((item) => user.role === "admin" || item.userId === user.id)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(offset, offset + limit)
      .map((transaction) => this.enrichUserRecord(transaction));
  }

  getUserFinanceProfile(userId) {
    this.ensureState();
    const user = this.db.users.find((item) => item.id === userId && item.role === "user");
    if (!user) {
      throw new Error("User not found.");
    }
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      wallets: this.getWallets(user.id),
      recentTransactions: this.getTransactions(user.id, { limit: 12 }),
    };
  }

  getWalletHistory(user, { limit = 80 } = {}) {
    this.ensureState();
    const canSee = (record) => user.role === "admin" || record.userId === user.id;
    const deposits = this.db.deposits
      .filter(canSee)
      .map((deposit) => ({
        id: deposit.id,
        kind: "DEPOSIT",
        type: "DEPOSIT",
        status: deposit.status,
        currency: deposit.currency,
        amount: deposit.amount,
        displayAmounts: deposit.displayAmounts || this.getDisplayAmounts(deposit.amount, deposit.currency, deposit.exchangeRate),
        reference: deposit.transactionHash || deposit.id,
        description: "Deposit",
        createdAt: deposit.submittedAt,
        userId: deposit.userId,
      }));
    const withdrawals = this.db.withdrawals
      .filter(canSee)
      .map((withdrawal) => ({
        id: withdrawal.id,
        kind: "WITHDRAWAL",
        type: "WITHDRAWAL",
        status: withdrawal.status,
        currency: withdrawal.currency,
        amount: `-${withdrawal.amount}`,
        displayAmounts: withdrawal.displayAmounts || this.getDisplayAmounts(withdrawal.amount, withdrawal.currency, withdrawal.exchangeRate),
        reference: withdrawal.externalTransactionReference || withdrawal.id,
        description: "Withdrawal",
        createdAt: withdrawal.submittedAt,
        userId: withdrawal.userId,
      }));
    const vtuPurchases = this.db.vtuTransactions
      .filter(canSee)
      .map((transaction) => ({
        id: transaction.id,
        kind: "VTU",
        type: transaction.productType === "data" ? "VTU_DATA" : "VTU_AIRTIME",
        status: String(transaction.status || "processing").toUpperCase(),
        currency: "NGN",
        amount: `-${transaction.amountCharged}`,
        displayAmounts: this.getDisplayAmounts(transaction.amountCharged, "NGN"),
        reference: transaction.requestId,
        description: transaction.productType === "data"
          ? `Data ${String(transaction.network || "").toUpperCase()} ${transaction.planName || ""}`.trim()
          : `Airtime ${String(transaction.network || "").toUpperCase()}`.trim(),
        createdAt: transaction.createdAt,
        userId: transaction.userId,
        metadata: {
          productType: transaction.productType,
          phone: transaction.phone,
          network: transaction.network,
          planName: transaction.planName,
          faceValue: transaction.faceValue,
          providerStatus: transaction.providerStatus,
        },
      }));
    const digitalPurchases = this.db.digitalServiceOrders
      .filter(canSee)
      .map((order) => ({
        id: order.id,
        kind: "DIGITAL_SERVICE",
        type: "DIGITAL_SERVICE",
        status: String(order.status || "processing").toUpperCase(),
        currency: "NGN",
        amount: `-${order.amountCharged}`,
        displayAmounts: this.getDisplayAmounts(order.amountCharged, "NGN"),
        reference: order.requestId,
        description: `Digital service ${order.productName || ""}`.trim(),
        createdAt: order.createdAt,
        userId: order.userId,
        metadata: {
          productId: order.productId,
          productName: order.productName,
          category: order.category,
          quantity: order.quantity,
          supplierStatus: order.supplierStatus,
        },
      }));
    const ledgerTransactions = this.db.transactions
      .filter((transaction) => canSee(transaction) && !["DEPOSIT", "WITHDRAWAL", "WITHDRAWAL_COMPLETED", "REVERSAL", ...VTU_LEDGER_TYPES, ...DIGITAL_SERVICE_LEDGER_TYPES].includes(transaction.type))
      .map((transaction) => ({
        ...clone(transaction),
        kind: "LEDGER",
        displayAmounts: transaction.metadata?.displayAmounts || this.getDisplayAmounts(transaction.amount, transaction.currency),
      }));

    return [...deposits, ...withdrawals, ...vtuPurchases, ...digitalPurchases, ...ledgerTransactions]
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, limit)
      .map((item) => this.enrichUserRecord(item));
  }

  createVtuTransaction(user, input = {}, requestMeta = {}) {
    this.ensureState();
    if (!user || user.role !== "user") {
      throw new Error("User not found.");
    }
    const productType = String(input.productType || "").trim().toLowerCase();
    if (!["airtime", "data"].includes(productType)) {
      throw new Error("Select airtime or data.");
    }
    const requestId = String(input.requestId || this.createVtuRequestId(productType)).trim();
    const amountCharged = normalizeAmount(input.amountCharged, "Amount");
    const providerCost = normalizeAmount(input.providerCost ?? amountCharged, "Provider amount");
    const wallet = this.ensureWallet(user.id, "NGN");
    if (compare(wallet.availableBalance, amountCharged) < 0) {
      const error = new Error("Insufficient NGN balance.");
      error.code = "INSUFFICIENT_BALANCE";
      throw error;
    }

    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = subtract(wallet.availableBalance, amountCharged);
    wallet.lockedBalance = add(wallet.lockedBalance, amountCharged);
    wallet.updatedAt = this.clock();

    const transaction = {
      id: this.idGenerator(12),
      userId: user.id,
      requestId,
      provider: "vtu_ng",
      productType,
      phone: String(input.phone || "").trim(),
      network: String(input.network || "").trim().toLowerCase(),
      variationId: String(input.variationId || "").trim(),
      planName: String(input.planName || "").trim(),
      faceValue: String(input.faceValue || providerCost),
      providerCost,
      amountCharged,
      markupAmount: String(input.markupAmount || "0"),
      status: "processing",
      providerOrderId: "",
      providerStatus: "queued",
      providerResponse: null,
      failureReason: "",
      walletReservedAmount: amountCharged,
      balanceReserved: true,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      completedAt: null,
      refundedAt: null,
    };
    this.db.vtuTransactions.unshift(transaction);
    this.db.transactions.unshift({
      id: this.idGenerator(12),
      userId: user.id,
      type: productType === "data" ? "VTU_DATA" : "VTU_AIRTIME",
      currency: "NGN",
      amount: `-${amountCharged}`,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: requestId,
      status: "PROCESSING",
      description: productType === "data" ? `Data purchase ${transaction.planName}` : "Airtime purchase",
      createdBy: user.id,
      createdAt: this.clock(),
      metadata: {
        productType,
        phone: transaction.phone,
        network: transaction.network,
        displayAmounts: this.getDisplayAmounts(amountCharged, "NGN"),
      },
    });
    this.createNotification({
      userId: user.id,
      type: "VTU",
      title: productType === "data" ? "Data order" : "Airtime order",
      message: "Your order is processing.",
      entityType: "VTU",
      entityId: transaction.id,
    });
    this.notifyAdmins({
      type: "VTU",
      title: productType === "data" ? "Data recharge" : "Airtime recharge",
      message: `${user.name || user.email || "A user"} bought ${productType === "data" ? transaction.planName || "data" : transaction.faceValue} for ${transaction.phone}.`,
      entityType: "VTU",
      entityId: transaction.id,
      route: "/?tab=history",
      dedupeKey: `vtu-admin-purchase:${transaction.id}`,
      metadata: {
        category: "transactions",
        productType,
        requestId,
        userId: user.id,
      },
    });
    this.audit(user, "VTU_PURCHASE_CREATED", "VtuTransaction", transaction.id, {
      productType,
      amountCharged,
      requestId,
    }, requestMeta);
    this.persist();
    return clone(transaction);
  }

  updateVtuLedgerStatus(requestId, status, balanceAfter = null) {
    const normalized = String(requestId || "").trim();
    const ledger = this.db.transactions.find((item) => VTU_LEDGER_TYPES.includes(item.type) && item.reference === normalized);
    if (ledger) {
      ledger.status = status;
      if (balanceAfter !== null) {
        ledger.balanceAfter = balanceAfter;
      }
    }
  }

  applyVtuProviderResult(requestId, payload = {}, actor = { id: "vtu", role: "system" }, requestMeta = {}) {
    this.ensureState();
    const normalizedRequestId = String(requestId || "").trim();
    const transaction = this.db.vtuTransactions.find((item) => item.requestId === normalizedRequestId || item.id === normalizedRequestId);
    if (!transaction) {
      throw new Error("VTU transaction not found.");
    }
    const providerData = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const mappedStatus = payload.mappedStatus || mapVtuProviderStatus(providerData.status, payload.code);
    if (VTU_FINAL_STATUSES.includes(transaction.status) && !transaction.balanceReserved) {
      return clone(transaction);
    }
    transaction.providerStatus = String(providerData.status || transaction.providerStatus || "").trim();
    transaction.providerOrderId = String(providerData.order_id || providerData.orderId || providerData.id || transaction.providerOrderId || "").trim();
    transaction.providerResponse = clone(payload || {});
    if (providerData.amount_charged !== undefined && providerData.amount_charged !== null && providerData.amount_charged !== "") {
      transaction.providerCost = normalizeAmount(providerData.amount_charged, "Provider amount");
      transaction.markupAmount = subtract(transaction.amountCharged, transaction.providerCost);
    }
    transaction.updatedAt = this.clock();

    const wallet = this.ensureWallet(transaction.userId, "NGN");
    if (mappedStatus === "successful") {
      if (transaction.balanceReserved) {
        wallet.lockedBalance = subtract(wallet.lockedBalance, transaction.walletReservedAmount);
        wallet.updatedAt = this.clock();
        transaction.balanceReserved = false;
      }
      transaction.status = "successful";
      transaction.completedAt = transaction.completedAt || this.clock();
      this.updateVtuLedgerStatus(transaction.requestId, "SUCCESSFUL", wallet.availableBalance);
      this.createNotification({
        userId: transaction.userId,
        type: "VTU",
        title: "Order successful",
        message: transaction.productType === "data" ? "Your data purchase is complete." : "Your airtime purchase is complete.",
        entityType: "VTU",
        entityId: transaction.id,
      });
    } else if (mappedStatus === "failed" || mappedStatus === "refunded") {
      if (transaction.balanceReserved) {
        const balanceBefore = wallet.availableBalance;
        wallet.availableBalance = add(wallet.availableBalance, transaction.walletReservedAmount);
        wallet.lockedBalance = subtract(wallet.lockedBalance, transaction.walletReservedAmount);
        wallet.updatedAt = this.clock();
        this.db.transactions.unshift({
          id: this.idGenerator(12),
          userId: transaction.userId,
          type: "VTU_REFUND",
          currency: "NGN",
          amount: transaction.walletReservedAmount,
          balanceBefore,
          balanceAfter: wallet.availableBalance,
          reference: transaction.requestId,
          status: "SUCCESSFUL",
          description: "VTU refund",
          createdBy: actor?.id || "vtu",
          createdAt: this.clock(),
          metadata: {
            vtuTransactionId: transaction.id,
            productType: transaction.productType,
            displayAmounts: this.getDisplayAmounts(transaction.walletReservedAmount, "NGN"),
          },
        });
        transaction.balanceReserved = false;
      }
      transaction.status = mappedStatus;
      transaction.refundedAt = mappedStatus === "refunded" ? (transaction.refundedAt || this.clock()) : transaction.refundedAt;
      transaction.completedAt = transaction.completedAt || this.clock();
      transaction.failureReason = String(providerData.message || payload.message || providerData.reason || transaction.failureReason || "").trim();
      this.updateVtuLedgerStatus(transaction.requestId, mappedStatus === "refunded" ? "REFUNDED" : "FAILED", wallet.availableBalance);
      this.createNotification({
        userId: transaction.userId,
        type: "VTU",
        title: mappedStatus === "refunded" ? "Order refunded" : "Order failed",
        message: "Your wallet has been updated.",
        entityType: "VTU",
        entityId: transaction.id,
      });
    } else {
      transaction.status = "processing";
      this.updateVtuLedgerStatus(transaction.requestId, "PROCESSING");
    }

    this.audit(actor, "VTU_PROVIDER_RESULT_APPLIED", "VtuTransaction", transaction.id, {
      requestId: transaction.requestId,
      status: transaction.status,
    }, requestMeta);
    this.persist();
    return clone(transaction);
  }

  listVtuTransactions(user, { limit = 100, offset = 0, status = "" } = {}) {
    this.ensureState();
    const normalizedStatus = String(status || "").trim().toLowerCase();
    return this.db.vtuTransactions
      .filter((item) => (user.role === "admin" || item.userId === user.id) && (!normalizedStatus || item.status === normalizedStatus))
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(offset, offset + limit)
      .map((item) => this.enrichUserRecord(item));
  }

  getVtuTransaction(user, idOrRequestId) {
    this.ensureState();
    const lookup = String(idOrRequestId || "").trim();
    const transaction = this.db.vtuTransactions.find((item) => item.id === lookup || item.requestId === lookup);
    if (!transaction || (user.role !== "admin" && transaction.userId !== user.id)) {
      throw new Error("VTU transaction not found.");
    }
    return clone(transaction);
  }

  getVtuAdminSummary() {
    this.ensureState();
    const summary = {
      totalSales: "0",
      successfulSales: "0",
      processingSales: "0",
      refundedSales: "0",
      estimatedProfit: "0",
      totalCount: this.db.vtuTransactions.length,
      successfulCount: 0,
      processingCount: 0,
      failedCount: 0,
      settings: this.sanitizeVtuSettings(this.db.systemSettings.vtu),
    };
    for (const transaction of this.db.vtuTransactions) {
      if (transaction.status === "successful") {
        summary.successfulCount += 1;
        summary.totalSales = add(summary.totalSales, transaction.amountCharged || "0");
        summary.successfulSales = add(summary.successfulSales, transaction.amountCharged || "0");
        summary.estimatedProfit = add(summary.estimatedProfit, transaction.markupAmount || "0");
      } else if (VTU_ACTIVE_STATUSES.includes(transaction.status)) {
        summary.processingCount += 1;
        summary.processingSales = add(summary.processingSales, transaction.amountCharged || "0");
      } else {
        summary.failedCount += 1;
        summary.refundedSales = add(summary.refundedSales, transaction.amountCharged || "0");
      }
    }
    return summary;
  }

  listNotifications(user, { limit = 20, includeRead = true } = {}) {
    this.ensureState();
    this.pruneExpiredMessageNotifications();
    return this.db.notifications
      .filter((item) => item.userId === user.id && (includeRead || !item.readAt))
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, limit)
      .map((item) => this.enrichUserRecord(item));
  }

  markNotificationRead(user, notificationId) {
    this.ensureState();
    this.pruneExpiredMessageNotifications();
    const notification = this.db.notifications.find((item) => item.id === notificationId && item.userId === user.id);
    if (!notification) {
      throw new Error("Notification not found.");
    }
    notification.readAt = notification.readAt || this.clock();
    this.persist();
    return clone(notification);
  }

  createNotification(input = {}) {
    const createdAt = this.clock();
    const dedupeKey = String(input.dedupeKey || input.metadata?.dedupeKey || "").trim();
    if (dedupeKey) {
      const existing = this.db.notifications.find((item) => item.userId === input.userId && item.dedupeKey === dedupeKey);
      if (existing) {
        return existing;
      }
    }
    const notification = {
      id: this.idGenerator(12),
      userId: input.userId || "",
      type: String(input.type || "INFO").trim().toUpperCase(),
      title: String(input.title || "Update").trim(),
      message: String(input.message || "").trim(),
      entityType: String(input.entityType || "").trim(),
      entityId: String(input.entityId || "").trim(),
      category: String(input.category || input.metadata?.category || "").trim(),
      route: String(input.route || input.metadata?.route || "").trim(),
      dedupeKey,
      metadata: input.metadata && typeof input.metadata === "object" ? clone(input.metadata) : {},
      expiresAt: input.expiresAt || null,
      readAt: null,
      createdAt,
    };
    this.db.notifications.unshift(notification);
    if (this.notificationPublisher) {
      Promise.resolve()
        .then(() => this.notificationPublisher(clone(notification)))
        .catch((error) => {
          console.warn("Push notification delivery failed:", error.message || error);
        });
    }
    return notification;
  }

  pruneExpiredMessageNotifications() {
    this.ensureState();
    const beforeNotifications = this.db.notifications.length;
    const beforeChatMessages = this.db.chatMessages.length;
    const now = Date.parse(this.clock());
    this.db.notifications = this.db.notifications.filter((item) => {
      if (String(item.type || "").toUpperCase() !== "MESSAGE") {
        return true;
      }
      const expiresAt = Date.parse(item.expiresAt || "");
      return !Number.isFinite(expiresAt) || expiresAt > now;
    });
    this.db.chatMessages = this.db.chatMessages.filter((item) => {
      const expiresAt = Date.parse(item.expiresAt || "");
      return !Number.isFinite(expiresAt) || expiresAt > now;
    });
    if (this.db.notifications.length !== beforeNotifications || this.db.chatMessages.length !== beforeChatMessages) {
      this.persist();
    }
  }

  createChatMessage(input = {}) {
    const createdAt = this.clock();
    const message = {
      id: this.idGenerator(12),
      conversationUserId: String(input.conversationUserId || "").trim(),
      senderId: String(input.senderId || "").trim(),
      senderRole: String(input.senderRole || "").trim().toLowerCase(),
      recipientId: String(input.recipientId || "").trim(),
      recipientRole: String(input.recipientRole || "").trim().toLowerCase(),
      title: String(input.title || "Message").trim(),
      message: String(input.message || "").trim(),
      expiresAt: input.expiresAt || addMillisecondsToIso(createdAt, MESSAGE_NOTIFICATION_TTL_MS),
      createdAt,
    };
    this.db.chatMessages.unshift(message);
    return message;
  }

  notifyAdmins(input = {}) {
    for (const admin of this.db.users.filter((user) => user.role === "admin")) {
      this.createNotification({ ...input, userId: admin.id });
    }
  }

  scanDuplicateUserReviews({ persistChanges = true } = {}) {
    this.ensureState();
    const users = (this.db.users || []).filter((user) => user.role === "user");
    const emailMap = new Map();
    const nameMap = new Map();
    const bankMap = new Map();
    const reasonsByUser = new Map();

    const addReason = (userId, reason, relatedUserIds = []) => {
      if (!userId) {
        return;
      }
      if (!reasonsByUser.has(userId)) {
        reasonsByUser.set(userId, { reasons: new Set(), relatedUserIds: new Set() });
      }
      const bucket = reasonsByUser.get(userId);
      bucket.reasons.add(reason);
      relatedUserIds.forEach((id) => {
        if (id && id !== userId) {
          bucket.relatedUserIds.add(id);
        }
      });
    };

    users.forEach((user) => {
      addMapSet(emailMap, String(user.email || "").trim().toLowerCase(), user.id);
      addMapSet(nameMap, getNormalizedFullName(user), user.id);
      [
        ...(Array.isArray(user.bankAccounts) ? user.bankAccounts : []),
        user.bankAccount,
      ]
        .filter(Boolean)
        .forEach((account) => {
          const accountNumber = String(account.accountNumber || "").replace(/\D/g, "").trim();
          const bankCode = String(account.bankCode || "").trim();
          addMapSet(bankMap, accountNumber ? `${bankCode}:${accountNumber}` : "", user.id);
        });
    });

    for (const ids of emailMap.values()) {
      if (ids.size > 1) {
        const related = [...ids];
        related.forEach((id) => addReason(id, "DUPLICATE_EMAIL", related));
      }
    }
    for (const ids of nameMap.values()) {
      if (ids.size > 1) {
        const related = [...ids];
        related.forEach((id) => addReason(id, "DUPLICATE_FULL_NAME", related));
      }
    }
    for (const ids of bankMap.values()) {
      if (ids.size > 1) {
        const related = [...ids];
        related.forEach((id) => addReason(id, "DUPLICATE_BANK_ACCOUNT", related));
      }
    }

    for (let index = 0; index < users.length; index += 1) {
      const left = users[index];
      const leftTokens = new Set(normalizeNameToken(`${left.firstName || ""} ${left.lastName || ""} ${left.name || ""}`));
      for (let nextIndex = index + 1; nextIndex < users.length; nextIndex += 1) {
        const right = users[nextIndex];
        const rightTokens = new Set(normalizeNameToken(`${right.firstName || ""} ${right.lastName || ""} ${right.name || ""}`));
        const shared = [...leftTokens].filter((token) => rightTokens.has(token));
        if (shared.length >= 2 && getNormalizedFullName(left) !== getNormalizedFullName(right)) {
          addReason(left.id, "SIMILAR_NAME", [right.id]);
          addReason(right.id, "SIMILAR_NAME", [left.id]);
        }
      }
    }

    let flaggedCount = 0;
    const now = this.clock();
    for (const user of users) {
      const currentStatus = String(user.fraudReview?.status || "").trim().toUpperCase();
      if (currentStatus === "CLEARED") {
        continue;
      }
      const duplicateReview = reasonsByUser.get(user.id);
      if (!duplicateReview) {
        continue;
      }
      user.fraudReview = {
        ...(user.fraudReview || {}),
        status: "SUSPICIOUS",
        reason: "DUPLICATE_ACCOUNT_REVIEW",
        reasons: [...duplicateReview.reasons],
        relatedUserIds: [...duplicateReview.relatedUserIds],
        flaggedAt: user.fraudReview?.flaggedAt || now,
        updatedAt: now,
      };
      flaggedCount += 1;
    }

    if (flaggedCount && persistChanges) {
      this.persist();
    }

    return {
      flaggedCount,
      reviewedCount: users.length,
    };
  }

  clearUserFraudReview(admin, userId, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }
    targetUser.fraudReview = {
      status: "CLEARED",
      reason: "",
      reasons: [],
      relatedUserIds: [],
      reviewedAt: this.clock(),
      reviewedBy: admin.id,
      clearedAt: this.clock(),
      updatedAt: this.clock(),
    };
    this.audit(admin, "USER_FRAUD_REVIEW_CLEARED", "User", targetUser.id, {}, requestMeta);
    this.persist();
    return clone(targetUser.fraudReview);
  }

  syncLowBalanceNotification(user, totalNgnEquivalent) {
    const threshold = normalizeNonNegativeAmount(
      user.lowBalanceThresholdNgn || this.db.systemSettings.vtu?.lowBalanceThreshold || "5000",
      "Low balance threshold"
    );
    const balance = normalizeNonNegativeAmount(totalNgnEquivalent || "0", "Balance");
    user.notificationState = user.notificationState && typeof user.notificationState === "object" ? user.notificationState : {};
    const wasBelow = !!user.notificationState.lowBalanceNgnBelowThreshold;
    const isBelow = compare(balance, threshold) < 0;

    if (isBelow && !wasBelow) {
      this.createNotification({
        userId: user.id,
        type: "LOW_BALANCE",
        category: "lowBalance",
        title: "Low balance",
        message: `Your NetrueFi NGN balance is below NGN ${threshold}.`,
        entityType: "Wallet",
        entityId: user.id,
        route: "/?tab=home",
        dedupeKey: `low-balance:${user.id}:${this.clock().slice(0, 10)}:${threshold}`,
      });
    }

    if (user.notificationState.lowBalanceNgnBelowThreshold !== isBelow) {
      user.notificationState.lowBalanceNgnBelowThreshold = isBelow;
      user.notificationState.lowBalanceNgnCheckedAt = this.clock();
      this.persist();
    }
  }

  getDashboard(user) {
    this.ensureState();
    const wallets = this.getWallets(user.id);
    const usdtWallet = wallets.find((wallet) => wallet.currency === "USDT");
    const ngnWallet = wallets.find((wallet) => wallet.currency === "NGN");
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const availableUsdtEquivalent = add(usdtWallet.availableBalance, this.convertAmount(ngnWallet.availableBalance, "NGN", "USDT", rate));
    const totalNgnEquivalent = add(ngnWallet.availableBalance, this.convertAmount(usdtWallet.availableBalance, "USDT", "NGN", rate));
    const lockedUsdtEquivalent = add(usdtWallet.lockedBalance, this.convertAmount(ngnWallet.lockedBalance, "NGN", "USDT", rate));
    const lockedNgnEquivalent = add(ngnWallet.lockedBalance, this.convertAmount(usdtWallet.lockedBalance, "USDT", "NGN", rate));
    const today = this.clock().slice(0, 10);
    const todayTransactions = this.db.transactions
      .filter(
        (transaction) =>
          transaction.userId === user.id &&
          ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type) &&
          String(transaction.createdAt || "").startsWith(today)
      );
    const todayPerformance = todayTransactions
      .reduce((sum, transaction) => add(sum, transaction.amount), "0");
    const todayMirroredPercentage = todayTransactions
      .find((transaction) => transaction.metadata?.profitLossPercentage)
      ?.metadata?.profitLossPercentage || "0";
    this.syncLowBalanceNotification(user, totalNgnEquivalent);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      bankAccount: this.enrichBankAccountForUser(user, user.bankAccount || null),
      bankAccounts: clone(user.bankAccounts || []).map((account) => this.enrichBankAccountForUser(user, account)),
      wallets,
      totalBalance: {
        usdt: availableUsdtEquivalent,
        ngnEquivalent: totalNgnEquivalent,
        lockedUsdt: lockedUsdtEquivalent,
        lockedNgnEquivalent,
        usdtToNgnRate: rate,
      },
      performance: {
        todayUsdt: todayPerformance,
        todayPercentage: todayMirroredPercentage,
        totalUsdt: this.db.transactions
          .filter((transaction) => transaction.userId === user.id && ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type))
          .reduce((sum, transaction) => add(sum, transaction.amount), "0"),
      },
      recentTransactions: this.getTransactions(user.id, { limit: 10 }),
      walletHistory: this.getWalletHistory(user, { limit: 80 }),
      notifications: this.listNotifications(user, { limit: 12, includeRead: false }),
      settings: {
        deposit: clone(this.db.systemSettings.deposit),
        withdrawal: clone(this.db.systemSettings.withdrawal),
        exchangeRate: clone(this.db.systemSettings.exchangeRate),
        telegram: clone(this.db.systemSettings.telegram),
        trading: clone(this.db.systemSettings.trading),
      },
    };
  }

  getMirrorPnlPercentage(mirror = {}) {
    const rawPercentage = toDecimalText(mirror.todayPnlPercent ?? mirror.percent ?? "0");
    const adminPnlValue = toDecimalText(mirror.todayPnlValue ?? mirror.amountUsdt ?? "0");
    const adminCapitalBase = toDecimalText(mirror.todayCapitalBase ?? mirror.todayOpeningUsdt ?? mirror.baseUsdt ?? "0");

    if (compare(rawPercentage, "0") !== 0 || compare(adminPnlValue, "0") === 0 || compare(adminCapitalBase, "0") === 0) {
      return rawPercentage;
    }

    return multiplyRatio(adminPnlValue, "100", adminCapitalBase);
  }

  getMirrorDayKey(mirror = {}) {
    return String(mirror.todayLabel || mirror.dayKey || this.clock().slice(0, 10)).slice(0, 10);
  }

  getUserPnlLots(userId) {
    const user = this.db.users.find((item) => item.id === userId);
    if (!user) {
      return [];
    }
    user.pnlLots = Array.isArray(user.pnlLots) ? user.pnlLots : [];
    return user.pnlLots;
  }

  clearUserPnlLots(userId) {
    const user = this.db.users.find((item) => item.id === userId);
    if (!user) {
      return false;
    }
    const hadLots = Array.isArray(user.pnlLots) && user.pnlLots.length > 0;
    user.pnlLots = [];
    return hadLots;
  }

  clearUserActiveTradeInvestmentsForBalanceOverwrite(userId, adminId = "") {
    this.db.tradeInvestments = Array.isArray(this.db.tradeInvestments) ? this.db.tradeInvestments : [];
    const clearedAt = this.clock();
    const releasedSources = [];
    let clearedCount = 0;

    for (const investment of this.db.tradeInvestments) {
      if (investment.userId !== userId || investment.status !== "ACTIVE") {
        continue;
      }

      const fundingSources = Array.isArray(investment.fundingSources) ? investment.fundingSources : [];
      for (const source of fundingSources) {
        const currency = normalizeCurrency(source.currency || "USDT");
        const amount = normalizeNonNegativeAmount(source.amount || "0", "Investment amount");
        if (compare(amount, "0") <= 0) {
          continue;
        }

        const wallet = this.ensureWallet(userId, currency);
        const lockedBefore = wallet.lockedBalance;
        const releaseAmount = clampDebit(amount, lockedBefore);
        if (compare(releaseAmount, "0") <= 0) {
          continue;
        }

        wallet.lockedBalance = subtract(wallet.lockedBalance, releaseAmount);
        wallet.updatedAt = clearedAt;
        releasedSources.push({
          investmentId: investment.id,
          currency,
          amount: releaseAmount,
          lockedBefore,
          lockedAfter: wallet.lockedBalance,
        });
      }

      investment.status = "STOPPED";
      investment.stoppedAt = investment.stoppedAt || clearedAt;
      investment.stopReason = "ADMIN_BALANCE_OVERWRITE";
      investment.settledPnlUsdt = investment.settledPnlUsdt || "0";
      investment.netSettlementUsdt = investment.netSettlementUsdt || "0";
      investment.adminStoppedBy = adminId || "";
      investment.updatedAt = clearedAt;
      clearedCount += 1;
    }

    return { clearedCount, releasedSources };
  }

  getAvailableUsdtEquivalent(userId, rate = this.db.systemSettings.exchangeRate.usdtToNgn) {
    const usdtWallet = this.ensureWallet(userId, "USDT");
    const ngnWallet = this.ensureWallet(userId, "NGN");
    return add(usdtWallet.availableBalance, this.convertAmount(ngnWallet.availableBalance, "NGN", "USDT", rate));
  }

  resetPnlLotsToCurrentBalance(userId, mirror = {}, { source = "BALANCE_BASELINE", referenceId = "" } = {}) {
    const user = this.db.users.find((item) => item.id === userId);
    if (!user) {
      return null;
    }
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const principalUsdt = this.getAvailableUsdtEquivalent(userId, rate);
    const baselinePercent = this.getMirrorPnlPercentage(mirror);
    const dayKey = this.getMirrorDayKey(mirror);
    const principalNgn = this.convertAmount(principalUsdt, "USDT", "NGN", rate);
    user.pnlLots = compare(principalUsdt, "0") > 0 ? [{
      id: this.idGenerator(12),
      referenceId,
      source,
      currency: "USDT",
      principalUsdt,
      principalNgn,
      baselinePercent,
      lastMirrorPercent: baselinePercent,
      dayKey,
      createdAt: this.clock(),
    }] : [];
    return user.pnlLots[0] || null;
  }

  ensurePnlBaselineForBalance(userId, baseUsdt, rate, mirror = {}) {
    const lots = this.getUserPnlLots(userId);
    if (lots.length || compare(baseUsdt, "0") <= 0) {
      return false;
    }

    const baselinePercent = this.getMirrorPnlPercentage(mirror);
    lots.push({
      id: this.idGenerator(12),
      source: "BALANCE_BASELINE",
      currency: "USDT",
      principalUsdt: String(baseUsdt),
      principalNgn: this.convertAmount(baseUsdt, "USDT", "NGN", rate),
      baselinePercent,
      lastMirrorPercent: baselinePercent,
      dayKey: this.getMirrorDayKey(mirror),
      createdAt: this.clock(),
    });
    return true;
  }

  calculatePnlLotsAtMirror(userId, mirror = {}) {
    const lots = this.getUserPnlLots(userId);
    const percentage = this.getMirrorPnlPercentage(mirror);
    return lots.reduce((sum, lot) => {
      const deltaPercent = subtract(percentage, toDecimalText(lot.baselinePercent || "0"));
      return add(sum, multiplyRatio(lot.principalUsdt || "0", deltaPercent, "100"));
    }, "0");
  }

  settleCurrentUserPnl(userId, mirror = {}) {
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const baseUsdt = this.getAvailableUsdtEquivalent(userId, rate);
    const baselineCreated = this.ensurePnlBaselineForBalance(userId, baseUsdt, rate, mirror);
    const daySettlement = this.settleUserPnlLotsForMirror(userId, mirror);
    const pnlUsdt = this.calculatePnlLotsAtMirror(userId, mirror);
    if (compare(pnlUsdt, "0") !== 0) {
      const wallet = this.ensureWallet(userId, "USDT");
      wallet.availableBalance = add(wallet.availableBalance, pnlUsdt);
      wallet.updatedAt = this.clock();
    }
    this.resetPnlLotsToCurrentBalance(userId, mirror, { source: "PNL_SETTLED" });
    return {
      pnlUsdt,
      changed: baselineCreated || daySettlement.changed || compare(pnlUsdt, "0") !== 0,
    };
  }

  settleUserPnlLotsForMirror(userId, mirror = {}) {
    const lots = this.getUserPnlLots(userId);
    const percentage = this.getMirrorPnlPercentage(mirror);
    const dayKey = this.getMirrorDayKey(mirror);
    let settledUsdt = "0";
    let changed = false;

    for (const lot of lots) {
      lot.principalUsdt = toDecimalText(lot.principalUsdt || "0");
      lot.baselinePercent = toDecimalText(lot.baselinePercent ?? percentage);
      lot.lastMirrorPercent = toDecimalText(lot.lastMirrorPercent ?? lot.baselinePercent);
      lot.dayKey = String(lot.dayKey || dayKey).slice(0, 10);

      if (lot.dayKey !== dayKey) {
        const previousDelta = subtract(lot.lastMirrorPercent, lot.baselinePercent);
        const lotPnlUsdt = multiplyRatio(lot.principalUsdt, previousDelta, "100");
        if (compare(lotPnlUsdt, "0") !== 0) {
          settledUsdt = add(settledUsdt, lotPnlUsdt);
          lot.principalUsdt = add(lot.principalUsdt, lotPnlUsdt);
        }
        lot.baselinePercent = percentage;
        lot.lastMirrorPercent = percentage;
        lot.dayKey = dayKey;
        changed = true;
      }
    }

    if (compare(settledUsdt, "0") !== 0) {
      const wallet = this.ensureWallet(userId, "USDT");
      wallet.availableBalance = add(wallet.availableBalance, settledUsdt);
      wallet.updatedAt = this.clock();
      changed = true;
    }

    return { lots, changed, settledUsdt };
  }

  calculateUserMirroredPnl(userId, baseUsdt, rate, mirror = {}) {
    const baselineCreated = this.ensurePnlBaselineForBalance(userId, baseUsdt, rate, mirror);
    const settled = this.settleUserPnlLotsForMirror(userId, mirror);
    const effectiveBaseUsdt = add(baseUsdt, settled.settledUsdt || "0");
    const percentage = this.getMirrorPnlPercentage(mirror);
    let pnlUsdt = "0";
    let changed = baselineCreated || settled.changed;

    for (const lot of settled.lots) {
      const deltaPercent = subtract(percentage, toDecimalText(lot.baselinePercent || "0"));
      pnlUsdt = add(pnlUsdt, multiplyRatio(lot.principalUsdt || "0", deltaPercent, "100"));
      if (lot.lastMirrorPercent !== percentage) {
        lot.lastMirrorPercent = percentage;
        changed = true;
      }
    }

    if (changed) {
      this.persist();
    }

    return {
      baseUsdt: effectiveBaseUsdt,
      baseNgnEquivalent: this.convertAmount(effectiveBaseUsdt, "USDT", "NGN", rate),
      pnlUsdt,
      percentage: compare(effectiveBaseUsdt, "0") === 0 ? "0" : multiplyRatio(pnlUsdt, "100", effectiveBaseUsdt),
      lots: clone(settled.lots),
    };
  }

  applyMirroredPnlToDashboard(dashboard, mirror = {}) {
    const userId = dashboard?.user?.id || "";
    const rawBaseUsdt = String(dashboard?.totalBalance?.usdt || "0");
    const rate = String(dashboard?.totalBalance?.usdtToNgnRate || this.db.systemSettings.exchangeRate.usdtToNgn);
    const mirrored = this.calculateUserMirroredPnl(userId, rawBaseUsdt, rate, mirror);
    const baseUsdt = mirrored.baseUsdt;
    const baseNgnEquivalent = mirrored.baseNgnEquivalent;
    const pnlUsdt = mirrored.pnlUsdt;
    const liveUsdt = add(baseUsdt, pnlUsdt);
    const liveNgn = this.convertAmount(liveUsdt, "USDT", "NGN", rate);
    return {
      ...dashboard,
      totalBalance: {
        ...dashboard.totalBalance,
        baseUsdt,
        baseNgnEquivalent,
        usdt: baseUsdt,
        ngnEquivalent: baseNgnEquivalent,
        liveUsdt,
        liveNgnEquivalent: liveNgn,
      },
      performance: {
        ...dashboard.performance,
        todayUsdt: pnlUsdt,
        todayPercentage: mirrored.percentage,
        mirroredFrom: mirror.source || "ADMIN_BYBIT",
      },
      mirrorPnl: {
        source: mirror.source || "ADMIN_BYBIT",
        percent: mirrored.percentage,
        adminPercent: this.getMirrorPnlPercentage(mirror),
        amountUsdt: pnlUsdt,
        adminAmountUsdt: String(mirror.todayPnlValue ?? mirror.amountUsdt ?? "0"),
        adminCapitalBase: String(mirror.todayCapitalBase ?? mirror.todayOpeningUsdt ?? "0"),
        assetPnl: Array.isArray(mirror.todayAssetPnl) ? clone(mirror.todayAssetPnl) : [],
        baseUsdt,
        liveUsdt,
        lots: mirrored.lots,
        stale: !!mirror.stale,
        updatedAt: mirror.updatedAt || mirror.cachedAt || null,
      },
    };
  }

  createDeposit(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const idempotent = this.findIdempotent("deposit:create", user.id, requestMeta.idempotencyKey);
    if (idempotent) {
      return idempotent;
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Deposit amount");
    const settings = this.db.systemSettings.deposit;
    if (currency === "NGN" && settings.ngnEnabled === false) {
      throw new Error("NGN deposits are currently disabled.");
    }

    const min = currency === "NGN" ? settings.minNgn || "1000" : settings.minUsdt || "1";
    const max = currency === "NGN" ? settings.maxNgn || "1000000000" : settings.maxUsdt || "1000000";
    if (compare(amount, min) < 0 || compare(amount, max) > 0) {
      throw new Error(`Deposit amount must be between ${min} and ${max} ${currency}.`);
    }

    const deposit = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      currency,
      exchangeRate: this.db.systemSettings.exchangeRate.usdtToNgn,
      displayAmounts: this.getDisplayAmounts(amount, currency),
      depositAddress: currency === "USDT" ? settings.usdtAddress : "",
      network: currency === "USDT" ? settings.usdtNetwork : "BANK",
      status: "PENDING",
      transactionHash: String(input.transactionHash || "").trim(),
      depositorName: String(input.depositorName || "").trim(),
      submittedAt: this.clock(),
      reviewedAt: null,
      reviewedBy: null,
      adminNote: "",
    };
    this.db.deposits.unshift(deposit);
    this.notifyAdmins({
      type: "DEPOSIT",
      title: "Deposit request",
      message: `${user.name || "User"} submitted ${amount} ${currency}.`,
      entityType: "Deposit",
      entityId: deposit.id,
    });
    this.audit(user, "DEPOSIT_SUBMITTED", "Deposit", deposit.id, { amount, currency }, requestMeta);
    this.saveIdempotent("deposit:create", user.id, requestMeta.idempotencyKey, deposit);
    this.persist();
    return clone(deposit);
  }

  listDeposits(user, { status } = {}) {
    this.ensureState();
    const normalizedStatus = status ? String(status).trim().toUpperCase() : "";
    return this.db.deposits
      .filter((deposit) => {
        if (user.role !== "admin" && deposit.userId !== user.id) {
          return false;
        }
        return !normalizedStatus || deposit.status === normalizedStatus;
      })
      .map((deposit) => this.enrichUserRecord(deposit));
  }

  approveDeposit(admin, depositId, input = {}, requestMeta = {}) {
    this.ensureState();
    const deposit = this.getDeposit(depositId);
    if (deposit.status !== "PENDING") {
      throw new Error("Deposit request is no longer pending.");
    }

    const wallet = this.ensureWallet(deposit.userId, deposit.currency);
    if (!deposit.creditedAt) {
      const balanceBefore = wallet.availableBalance;
      wallet.availableBalance = add(wallet.availableBalance, deposit.amount);
      wallet.updatedAt = this.clock();
      this.clearUserPnlLots(deposit.userId);
      deposit.creditedAt = this.clock();
      deposit.creditedBy = admin.id;
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: deposit.userId,
        type: "DEPOSIT",
        currency: deposit.currency,
        amount: deposit.amount,
        balanceBefore,
        balanceAfter: wallet.availableBalance,
        reference: deposit.id,
        status: "APPROVED",
        description: `Manual ${deposit.currency} deposit approved by admin.`,
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          displayAmounts: deposit.displayAmounts || this.getDisplayAmounts(deposit.amount, deposit.currency, deposit.exchangeRate),
          principalCredit: true,
        },
      });
    }
    deposit.status = "APPROVED";
    deposit.reviewedAt = this.clock();
    deposit.reviewedBy = admin.id;
    deposit.adminNote = String(input.adminNote || "").trim();
    for (const transaction of this.db.transactions.filter((item) => item.type === "DEPOSIT" && item.reference === deposit.id)) {
      transaction.status = "APPROVED";
      transaction.description = `Manual ${deposit.currency} deposit approved by admin.`;
      transaction.reviewedAt = deposit.reviewedAt;
      transaction.reviewedBy = admin.id;
    }
    this.createNotification({
      userId: deposit.userId,
      type: "DEPOSIT",
      title: "Deposit approved",
      message: `${deposit.amount} ${deposit.currency} added to your wallet.`,
      entityType: "Deposit",
      entityId: deposit.id,
    });
    this.audit(admin, "DEPOSIT_APPROVED", "Deposit", deposit.id, { amount: deposit.amount, currency: deposit.currency }, requestMeta);
    this.persist();
    return clone(deposit);
  }

  rejectDeposit(admin, depositId, input = {}, requestMeta = {}) {
    this.ensureState();
    const deposit = this.getDeposit(depositId);
    if (deposit.status !== "PENDING") {
      throw new Error("Deposit request is no longer pending.");
    }
    const wallet = this.ensureWallet(deposit.userId, deposit.currency);
    if (deposit.creditedAt && !deposit.reversedAt) {
      const balanceBefore = wallet.availableBalance;
      wallet.availableBalance = subtract(wallet.availableBalance, deposit.amount);
      wallet.updatedAt = this.clock();
      deposit.reversedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: deposit.userId,
        type: "REVERSAL",
        currency: deposit.currency,
        amount: `-${deposit.amount}`,
        balanceBefore,
        balanceAfter: wallet.availableBalance,
        reference: deposit.id,
        status: "REJECTED",
        description: "Rejected deposit reversed.",
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          displayAmounts: deposit.displayAmounts || this.getDisplayAmounts(deposit.amount, deposit.currency, deposit.exchangeRate),
          principalCredit: true,
        },
      });
    }
    deposit.status = "REJECTED";
    deposit.reviewedAt = this.clock();
    deposit.reviewedBy = admin.id;
    deposit.adminNote = String(input.adminNote || "").trim();
    for (const transaction of this.db.transactions.filter((item) => item.type === "DEPOSIT" && item.reference === deposit.id)) {
      transaction.status = "REJECTED";
      transaction.description = "Deposit rejected.";
      transaction.reviewedAt = deposit.reviewedAt;
      transaction.reviewedBy = admin.id;
    }
    this.createNotification({
      userId: deposit.userId,
      type: "DEPOSIT",
      title: "Deposit rejected",
      message: deposit.adminNote || "Your deposit request was rejected.",
      entityType: "Deposit",
      entityId: deposit.id,
    });
    this.audit(admin, "DEPOSIT_REJECTED", "Deposit", deposit.id, { amount: deposit.amount, currency: deposit.currency }, requestMeta);
    this.persist();
    return clone(deposit);
  }

  updateUserBankAccount(user, input = {}, requestMeta = {}) {
    this.ensureState();
    if (input.verified === true || input.accountName || input.account_name) {
      return this.updateVerifiedBankAccount(user, input.destination || input, requestMeta);
    }
    throw new Error("Verify the bank account before saving it.");
  }

  generateGiftCardCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let code = "";
      for (let index = 0; index < 14; index += 1) {
        code += String(crypto.randomInt(0, 10));
      }
      if (!this.db.giftCards.some((card) => card.code === code)) {
        return code;
      }
    }

    const fallback = crypto
      .createHash("sha256")
      .update(`${this.idGenerator(24)}:${this.clock()}`)
      .digest("hex")
      .replace(/\D/g, "")
      .padEnd(14, "0")
      .slice(0, 14);
    return this.db.giftCards.some((card) => card.code === fallback)
      ? String(Date.now()).slice(-14).padStart(14, "0")
      : fallback;
  }

  generateGiftCardPin() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  }

  createGiftCard(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const currency = normalizeCurrency(input.currency || "NGN");
    const amount = normalizeAmount(input.amount, "Gift card amount");
    const note = String(input.note || "Netrue Gift Card").trim();
    const isQuestReward = input.isQuestReward === true || String(input.rewardPool || "").trim().toLowerCase() === "quest";
    const giftCard = {
      id: this.idGenerator(12),
      code: this.generateGiftCardCode(),
      pin: this.generateGiftCardPin(),
      amount,
      currency,
      status: "UNUSED",
      note,
      rewardPool: isQuestReward ? "quest" : "standard",
      isQuestReward,
      assignedTo: "",
      assignedToName: "",
      assignedToEmail: "",
      assignedAt: null,
      revealedAt: null,
      questId: "",
      questSessionId: "",
      createdBy: admin.id,
      createdAt: this.clock(),
      redeemedAt: null,
      redeemedByUserId: "",
      redeemedByName: "",
      redeemedByEmail: "",
      transactionId: "",
    };
    this.db.giftCards.unshift(giftCard);
    this.audit(admin, "GIFT_CARD_CREATED", "GiftCard", giftCard.id, { amount, currency }, requestMeta);
    this.persist();
    return clone(giftCard);
  }

  listGiftCards(admin, { status } = {}) {
    this.ensureState();
    if (admin.role !== "admin") {
      throw new Error("Admin access is required.");
    }
    const normalizedStatus = String(status || "").trim().toUpperCase();
    return this.db.giftCards
      .filter((card) => !normalizedStatus || String(card.status || "").toUpperCase() === normalizedStatus)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .map(clone);
  }

  redeemGiftCard(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const idempotent = this.findIdempotent("gift-card:redeem", user.id, requestMeta.idempotencyKey);
    if (idempotent) {
      return idempotent;
    }
    if (["SUSPENDED", "BLOCKED"].includes(String(user.status || "").trim().toUpperCase())) {
      throw new Error("This account cannot redeem gift cards right now.");
    }

    const code = normalizeGiftCardCode(input.code);
    const giftCard = this.db.giftCards.find((card) => card.code === code);
    if (!giftCard) {
      throw new Error("Gift card not found.");
    }
    const cardStatus = String(giftCard.status || "").toUpperCase();
    const assignedTo = String(giftCard.assignedTo || "").trim();
    if (["ASSIGNED", "REVEALED"].includes(cardStatus)) {
      if (!assignedTo || assignedTo !== user.id) {
        throw new Error("Gift card has already been assigned.");
      }
    } else if (cardStatus !== "UNUSED") {
      throw new Error("Gift card has already been used.");
    }
    const pin = normalizeGiftCardPin(input.pin);
    if (pin && giftCard.pin && pin !== String(giftCard.pin)) {
      throw new Error("Gift card PIN is incorrect.");
    }

    const currency = normalizeCurrency(giftCard.currency || "NGN");
    const amount = normalizeAmount(giftCard.amount, "Gift card amount");
    const wallet = this.ensureWallet(user.id, currency);
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = add(wallet.availableBalance, amount);
    wallet.updatedAt = this.clock();
    this.clearUserPnlLots(user.id);
    const transaction = {
      id: this.idGenerator(12),
      userId: user.id,
      type: "GIFT_CARD",
      currency,
      amount,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: giftCard.id,
      status: "APPROVED",
      description: "Netrue Gift Card redeemed.",
      createdBy: user.id,
      createdAt: this.clock(),
      metadata: {
        displayAmounts: this.getDisplayAmounts(amount, currency),
        giftCardCodeLast4: code.slice(-4),
        principalCredit: true,
      },
    };
    this.db.transactions.unshift(transaction);
    giftCard.status = "USED";
    giftCard.redeemedAt = this.clock();
    giftCard.redeemedByUserId = user.id;
    giftCard.redeemedByName = user.name || "";
    giftCard.redeemedByEmail = user.email || "";
    giftCard.transactionId = transaction.id;
    this.createNotification({
      userId: user.id,
      type: "GIFT_CARD",
      title: "Gift card redeemed",
      message: `${amount} ${currency} added to your wallet.`,
      entityType: "GiftCard",
      entityId: giftCard.id,
    });
    this.notifyAdmins({
      type: "GIFT_CARD",
      title: "Gift card used",
      message: `${user.name || "User"} redeemed ${amount} ${currency}.`,
      entityType: "GiftCard",
      entityId: giftCard.id,
    });
    this.audit(user, "GIFT_CARD_REDEEMED", "GiftCard", giftCard.id, { amount, currency }, requestMeta);
    const response = {
      giftCard: clone(giftCard),
      transaction: clone(transaction),
      dashboard: this.getDashboard(user),
    };
    this.saveIdempotent("gift-card:redeem", user.id, requestMeta.idempotencyKey, response);
    this.persist();
    return response;
  }

  addBonus(admin, userId, input = {}, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Bonus amount");
    const note = String(input.note || "Bonus").trim();
    const wallet = this.ensureWallet(targetUser.id, currency);
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = add(wallet.availableBalance, amount);
    wallet.updatedAt = this.clock();
    this.clearUserPnlLots(targetUser.id);
    const transaction = {
      id: this.idGenerator(12),
      userId: targetUser.id,
      type: "BONUS",
      currency,
      amount,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: this.idGenerator(12),
      status: "APPROVED",
      description: note,
      createdBy: admin.id,
      createdAt: this.clock(),
    };
    this.db.transactions.unshift(transaction);
    this.createNotification({
      userId: targetUser.id,
      type: "BONUS",
      title: "Bonus added",
      message: `${amount} ${currency} added to your wallet.`,
      entityType: "Transaction",
      entityId: transaction.id,
    });
    this.audit(admin, "BONUS_ADDED", "User", targetUser.id, { amount, currency }, requestMeta);
    this.persist();
    return {
      transaction: clone(transaction),
      profile: this.getUserFinanceProfile(targetUser.id),
    };
  }

  transferBetweenUsers(sender, input = {}, requestMeta = {}) {
    this.ensureState();
    const idempotent = this.findIdempotent("transfer:create", sender?.id, requestMeta.idempotencyKey);
    if (idempotent) {
      return idempotent;
    }
    if (!sender || sender.role !== "user") {
      throw new Error("User not found.");
    }
    if (["SUSPENDED", "BLOCKED"].includes(String(sender.status || "").trim().toUpperCase())) {
      throw new Error("This account cannot send transfers right now.");
    }

    const email = String(input.email || input.recipientEmail || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter the recipient registered email.");
    }
    const recipient = this.db.users.find((user) => user.role === "user" && String(user.email || "").trim().toLowerCase() === email);
    if (!recipient) {
      throw new Error("Recipient account was not found.");
    }
    if (recipient.id === sender.id) {
      throw new Error("You cannot transfer to yourself.");
    }
    if (["SUSPENDED", "BLOCKED"].includes(String(recipient.status || "").trim().toUpperCase())) {
      throw new Error("Recipient account cannot receive transfers right now.");
    }

    const currency = normalizeCurrency(input.currency || "NGN");
    const amount = normalizeAmount(input.amount, "Transfer amount");
    const senderWallet = this.ensureWallet(sender.id, currency);
    const recipientWallet = this.ensureWallet(recipient.id, currency);
    if (compare(senderWallet.availableBalance, amount) < 0) {
      throw new Error(`Insufficient ${currency} balance.`);
    }

    const reference = this.idGenerator(12);
    const note = String(input.note || "In-app transfer").trim();
    const senderBalanceBefore = senderWallet.availableBalance;
    const recipientBalanceBefore = recipientWallet.availableBalance;
    senderWallet.availableBalance = subtract(senderWallet.availableBalance, amount);
    recipientWallet.availableBalance = add(recipientWallet.availableBalance, amount);
    senderWallet.updatedAt = this.clock();
    recipientWallet.updatedAt = this.clock();
    this.clearUserPnlLots(sender.id);
    this.clearUserPnlLots(recipient.id);

    const senderTransaction = {
      id: this.idGenerator(12),
      userId: sender.id,
      type: "TRANSFER_SENT",
      currency,
      amount: `-${amount}`,
      balanceBefore: senderBalanceBefore,
      balanceAfter: senderWallet.availableBalance,
      reference,
      status: "SUCCESS",
      description: note,
      createdBy: sender.id,
      createdAt: this.clock(),
      metadata: {
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        recipientName: recipient.name || "",
        displayAmounts: this.getDisplayAmounts(amount, currency),
      },
    };
    const recipientTransaction = {
      id: this.idGenerator(12),
      userId: recipient.id,
      type: "TRANSFER_RECEIVED",
      currency,
      amount,
      balanceBefore: recipientBalanceBefore,
      balanceAfter: recipientWallet.availableBalance,
      reference,
      status: "SUCCESS",
      description: note,
      createdBy: sender.id,
      createdAt: this.clock(),
      metadata: {
        senderUserId: sender.id,
        senderEmail: sender.email,
        senderName: sender.name || "",
        displayAmounts: this.getDisplayAmounts(amount, currency),
      },
    };
    this.db.transactions.unshift(recipientTransaction, senderTransaction);
    this.createNotification({
      userId: sender.id,
      type: "TRANSFER",
      title: "Transfer sent",
      message: `${amount} ${currency} sent to ${recipient.name || recipient.email}.`,
      entityType: "Transaction",
      entityId: senderTransaction.id,
    });
    this.createNotification({
      userId: recipient.id,
      type: "TRANSFER",
      title: "Transfer received",
      message: `${amount} ${currency} received from ${sender.name || sender.email}.`,
      entityType: "Transaction",
      entityId: recipientTransaction.id,
    });
    this.audit(sender, "TRANSFER_SENT", "User", recipient.id, { amount, currency }, requestMeta);
    const response = {
      transaction: clone(senderTransaction),
      recipientTransaction: clone(recipientTransaction),
      profile: this.getUserFinanceProfile(sender.id),
    };
    this.saveIdempotent("transfer:create", sender.id, requestMeta.idempotencyKey, response);
    this.persist();
    return response;
  }

  setUserBalance(admin, userId, input = {}, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeNonNegativeAmount(input.amount, "Balance");
    const note = String(input.note || "Balance updated").trim();
    const wallet = this.ensureWallet(targetUser.id, currency);
    const alternateCurrency = currency === "USDT" ? "NGN" : "USDT";
    const alternateWallet = this.ensureWallet(targetUser.id, alternateCurrency);
    const balanceBefore = wallet.availableBalance;
    const alternateBalanceBefore = alternateWallet.availableBalance;
    const clearedInvestments = this.clearUserActiveTradeInvestmentsForBalanceOverwrite(targetUser.id, admin.id);
    wallet.availableBalance = amount;
    alternateWallet.availableBalance = "0";
    wallet.updatedAt = this.clock();
    alternateWallet.updatedAt = this.clock();
    this.clearUserPnlLots(targetUser.id);
    targetUser.legacyBalanceMigratedAt = targetUser.legacyBalanceMigratedAt || this.clock();
    targetUser.balanceOverrideAt = this.clock();
    targetUser.balanceOverrideCurrency = currency;
    targetUser.balanceOverrideAmount = amount;
    const transaction = {
      id: this.idGenerator(12),
      userId: targetUser.id,
      type: "BALANCE_ADJUSTMENT",
      currency,
      amount: subtract(amount, balanceBefore),
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: this.idGenerator(12),
      status: "APPROVED",
      description: note,
      createdBy: admin.id,
      createdAt: this.clock(),
      metadata: {
        overwriteUnifiedBalance: true,
        clearedCurrency: alternateCurrency,
        clearedBalanceBefore: alternateBalanceBefore,
        clearedActiveInvestments: clearedInvestments.clearedCount,
        releasedInvestmentLocks: clearedInvestments.releasedSources,
      },
    };
    this.db.transactions.unshift(transaction);
    this.createNotification({
      userId: targetUser.id,
      type: "BALANCE",
      title: "Balance updated",
      message: `${currency} balance is now ${amount}.`,
      entityType: "Transaction",
      entityId: transaction.id,
    });
    this.audit(admin, "BALANCE_UPDATED", "User", targetUser.id, { amount, currency }, requestMeta);
    this.persist();
    return {
      transaction: clone(transaction),
      profile: this.getUserFinanceProfile(targetUser.id),
    };
  }

  sendAdminMessage(admin, userId, input = {}, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }
    const message = String(input.message || "").trim();
    if (!message) {
      throw new Error("Message is required.");
    }
    const expiresAt = addMillisecondsToIso(this.clock(), MESSAGE_NOTIFICATION_TTL_MS);
    const chatMessage = this.createChatMessage({
      conversationUserId: targetUser.id,
      senderId: admin.id,
      senderRole: "admin",
      recipientId: targetUser.id,
      recipientRole: "user",
      title: String(input.title || "Admin message").trim(),
      message,
      expiresAt,
    });
    const notification = this.createNotification({
      userId: targetUser.id,
      type: "MESSAGE",
      category: "messages",
      title: String(input.title || "Admin message").trim(),
      message,
      entityType: "ChatMessage",
      entityId: chatMessage.id,
      route: "/?tab=home",
      dedupeKey: `message:${chatMessage.id}`,
      metadata: {
        chatMessageId: chatMessage.id,
        conversationUserId: targetUser.id,
        senderId: admin.id,
        senderRole: "admin",
      },
      expiresAt,
    });
    this.audit(admin, "ADMIN_MESSAGE_SENT", "User", targetUser.id, {
      notificationId: notification.id,
      chatMessageId: chatMessage.id,
    }, requestMeta);
    this.persist();
    return { notification: clone(notification), message: clone(chatMessage) };
  }

  sendSupportMessage(user, input = {}, requestMeta = {}) {
    this.ensureState();
    if (!user || user.role !== "user") {
      throw new Error("Only users can send support messages.");
    }
    const message = String(input.message || "").trim();
    if (!message) {
      throw new Error("Message is required.");
    }
    const title = String(input.title || "Support message").trim() || "Support message";
    const notifications = [];
    for (const admin of this.db.users.filter((item) => item.role === "admin")) {
      const expiresAt = addMillisecondsToIso(this.clock(), MESSAGE_NOTIFICATION_TTL_MS);
      const chatMessage = this.createChatMessage({
        conversationUserId: user.id,
        senderId: user.id,
        senderRole: "user",
        recipientId: admin.id,
        recipientRole: "admin",
        title,
        message,
        expiresAt,
      });
      notifications.push(this.createNotification({
        userId: admin.id,
        type: "MESSAGE",
        category: "messages",
        title,
        message: `${user.name || user.email || "User"}: ${message}`,
        entityType: "ChatMessage",
        entityId: chatMessage.id,
        route: "/?tab=home",
        dedupeKey: `message:${chatMessage.id}`,
        metadata: {
          chatMessageId: chatMessage.id,
          conversationUserId: user.id,
          senderId: user.id,
          senderRole: "user",
        },
        expiresAt,
      }));
    }
    this.audit(user, "SUPPORT_MESSAGE_SENT", "User", user.id, { count: notifications.length }, requestMeta);
    this.persist();
    return notifications.map((notification) => clone(notification));
  }

  resolveWithdrawalFunding(userId, currency, amount) {
    const primaryWallet = this.ensureWallet(userId, currency);
    if (compare(primaryWallet.availableBalance, amount) >= 0) {
      return [{ wallet: primaryWallet, currency, amount }];
    }

    const sources = [];
    let remainingAmount = amount;
    if (compare(primaryWallet.availableBalance, "0") > 0) {
      sources.push({ wallet: primaryWallet, currency, amount: primaryWallet.availableBalance });
      remainingAmount = subtract(remainingAmount, primaryWallet.availableBalance);
    }

    const alternateCurrency = currency === "USDT" ? "NGN" : "USDT";
    const alternateAmount = this.convertAmount(remainingAmount, currency, alternateCurrency);
    const alternateWallet = this.ensureWallet(userId, alternateCurrency);
    if (compare(alternateWallet.availableBalance, alternateAmount) < 0) {
      throw new Error("Insufficient available balance.");
    }

    sources.push({ wallet: alternateWallet, currency: alternateCurrency, amount: alternateAmount });
    return sources;
  }

  findActiveWithdrawalForUser(userId, { excludeId = "" } = {}) {
    return this.db.withdrawals.find((withdrawal) =>
      withdrawal.userId === userId &&
      withdrawal.id !== excludeId &&
      ACTIVE_WITHDRAWAL_STATUSES.includes(String(withdrawal.status || "").trim().toUpperCase())
    );
  }

  assertNoActiveWithdrawal(userId, { excludeId = "" } = {}) {
    const activeWithdrawal = this.findActiveWithdrawalForUser(userId, { excludeId });
    if (activeWithdrawal) {
      throw new Error("A withdrawal request is already processing. Please wait for success or rejection before placing another withdrawal.");
    }
  }

  markWithdrawalReservationTransactions(withdrawal, status, description = "") {
    const normalizedStatus = String(status || "").trim().toUpperCase();
    for (const transaction of this.db.transactions.filter((item) =>
      item.type === "WITHDRAWAL" &&
      item.reference === withdrawal.id
    )) {
      transaction.status = normalizedStatus;
      if (description) {
        transaction.description = description;
      }
      transaction.updatedAt = this.clock();
    }
  }

  findRelatedFraudReviewUsers(user, bank = {}) {
    const normalizedName = getNormalizedFullName(user);
    const accountNumber = String(bank.accountNumber || "").trim();
    const bankCode = String(bank.bankCode || "").trim();
    return (this.db.users || [])
      .filter((item) => item.role === "user" && item.id !== user.id)
      .filter((item) => {
        const sameName = normalizedName && getNormalizedFullName(item) === normalizedName;
        const accounts = [
          ...(Array.isArray(item.bankAccounts) ? item.bankAccounts : []),
          item.bankAccount,
        ].filter(Boolean);
        const sameBank = accountNumber && accounts.some((account) =>
          String(account.accountNumber || "").trim() === accountNumber &&
          (!bankCode || String(account.bankCode || "").trim() === bankCode)
        );
        return sameName || sameBank;
      })
      .map((item) => item.id);
  }

  createWithdrawalFraudReview(user, bank = {}, currency = "NGN", amount = "0") {
    const nameMatched = currency !== "NGN" || bankAccountNameMatchesUser(user, bank);
    const relatedUserIds = nameMatched ? [] : this.findRelatedFraudReviewUsers(user, bank);
    const now = this.clock();
    const review = {
      status: nameMatched ? "CLEAR" : "SUSPICIOUS",
      reason: nameMatched ? "" : "BANK_NAME_MISMATCH",
      expectedFirstName: getUserFirstLastName(user).firstName,
      expectedLastName: getUserFirstLastName(user).lastName,
      accountName: bank.accountName || "",
      accountNumberLast4: String(bank.accountNumber || "").slice(-4),
      relatedUserIds,
      flaggedAt: nameMatched ? null : now,
      reviewedAt: null,
      reviewedBy: "",
    };
    if (!nameMatched) {
      const flaggedUsers = [user.id, ...relatedUserIds];
      for (const targetUser of this.db.users.filter((item) => flaggedUsers.includes(item.id))) {
        targetUser.fraudReview = {
          status: "SUSPICIOUS",
          reason: targetUser.id === user.id ? "BANK_NAME_MISMATCH" : "RELATED_BANK_OR_NAME_MATCH",
          relatedWithdrawalAmount: amount,
          relatedWithdrawalCurrency: currency,
          sourceUserId: user.id,
          accountName: bank.accountName || "",
          accountNumberLast4: String(bank.accountNumber || "").slice(-4),
          flaggedAt: targetUser.fraudReview?.flaggedAt || now,
          updatedAt: now,
        };
      }
    }
    return review;
  }

  createWithdrawal(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const idempotent = this.findIdempotent("withdrawal:create", user.id, requestMeta.idempotencyKey);
    if (idempotent) {
      return idempotent;
    }
    if (["SUSPENDED", "BLOCKED"].includes(String(user.status || "").trim().toUpperCase())) {
      throw new Error("This account cannot request withdrawals right now.");
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Withdrawal amount");
    this.validateWithdrawalSettings(currency, amount);
    const fee = currency === "NGN"
      ? normalizeNonNegativeAmount(this.db.systemSettings.withdrawal.ngnFee || DEFAULT_NGN_WITHDRAWAL_FEE, "NGN withdrawal fee")
      : normalizeNonNegativeAmount(this.db.systemSettings.withdrawal.usdtFee || "0", "USDT withdrawal fee");
    const netAmount = currency === "NGN" && compare(fee, "0") > 0 ? subtract(amount, fee) : amount;
    if (compare(netAmount, "0") <= 0) {
      throw new Error(`Withdrawal amount must be greater than the ${fee} ${currency} fee.`);
    }
    const activeInvestments = this.db.tradeInvestments.filter((item) => item.userId === user.id && item.status === "ACTIVE");
    if (activeInvestments.length) {
      throw new Error("Stop active trades before requesting a withdrawal.");
    }
    this.assertNoActiveWithdrawal(user.id);
    this.validateDailyWithdrawalLimit(user.id, currency, amount);
    let destination = null;
    let bank = null;
    if (currency === "NGN") {
      const transientBankAccount = input.bankAccount && typeof input.bankAccount === "object"
        ? input.bankAccount
        : null;
      bank = transientBankAccount
        ? this.normalizeBankAccount({ ...transientBankAccount, verified: true })
        : this.getVerifiedBankAccount(user, input.bankAccountId);
      destination = {
        type: "NGN_BANK",
        bankName: bank.bankName,
        bankCode: bank.bankCode,
        accountName: bank.accountName,
        accountNumber: bank.accountNumber,
        maskedAccountNumber: bank.maskedAccountNumber,
      };
      const duplicate = this.db.withdrawals.find((withdrawal) =>
        withdrawal.userId === user.id &&
        withdrawal.currency === "NGN" &&
        withdrawal.amount === amount &&
        ACTIVE_WITHDRAWAL_STATUSES.includes(withdrawal.status) &&
        (withdrawal.bank?.accountNumber || withdrawal.destination?.accountNumber) === bank.accountNumber
      );
      if (duplicate) {
        throw new Error("A matching withdrawal request is already in review.");
      }
    }
    const fundingSources = this.resolveWithdrawalFunding(user.id, currency, amount);
    if (currency !== "NGN") {
      destination = this.normalizeWithdrawalDestination(currency, input.destination || input);
    }
    const fraudReview = this.createWithdrawalFraudReview(user, bank || {}, currency, amount);
    const paystackReference = currency === "NGN" ? this.createPaystackReference() : "";
    const withdrawal = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      requestedAmount: amount,
      netAmount,
      amountKobo: currency === "NGN" ? toKobo(netAmount) : 0,
      currency,
      status: "PENDING",
      exchangeRate: this.db.systemSettings.exchangeRate.usdtToNgn,
      displayAmounts: this.getDisplayAmounts(amount, currency),
      bank,
      destination,
      paystackRecipientCode: bank?.paystackRecipientCode || "",
      paystackTransferCode: "",
      paystackReference,
      fee,
      feeCurrency: currency,
      submittedAt: this.clock(),
      approvedAt: null,
      approvedBy: null,
      processingAt: null,
      processedBy: null,
      completedAt: null,
      completedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: "",
      failureReason: "",
      telegramMessageId: "",
      balanceReserved: true,
      fundingSources: fundingSources.map((source) => ({
        currency: source.currency,
        amount: source.amount,
      })),
      externalTransactionReference: paystackReference,
      adminNote: "",
      fraudReview,
      metadata: {
        fraudReviewStatus: fraudReview.status,
      },
    };

    for (const source of fundingSources) {
      const balanceBefore = source.wallet.availableBalance;
      const lockedBefore = source.wallet.lockedBalance;
      source.wallet.availableBalance = subtract(source.wallet.availableBalance, source.amount);
      source.wallet.lockedBalance = add(source.wallet.lockedBalance, source.amount);
      source.wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: user.id,
        type: "WITHDRAWAL",
        currency: source.currency,
        amount: `-${source.amount}`,
        balanceBefore,
        balanceAfter: source.wallet.availableBalance,
        reference: withdrawal.id,
        status: "PENDING",
        description: currency === source.currency ? "Withdrawal amount reserved." : `Reserved for ${currency} withdrawal.`,
        createdBy: user.id,
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: currency,
          requestedAmount: amount,
          lockedBalanceBefore: lockedBefore,
          lockedBalanceAfter: source.wallet.lockedBalance,
        },
      });
    }
    this.db.withdrawals.unshift(withdrawal);
    const withdrawalSplitMessage = currency === "NGN" && compare(fee, "0") > 0
      ? ` Fee: ${fee} ${currency}. Payout: ${netAmount} ${currency}.`
      : "";
    this.notifyAdmins({
      type: fraudReview.status === "SUSPICIOUS" ? "WITHDRAWAL_FRAUD_REVIEW" : "WITHDRAWAL_REQUEST",
      title: fraudReview.status === "SUSPICIOUS" ? "Suspicious Withdrawal" : "New Withdrawal Request",
      message: fraudReview.status === "SUSPICIOUS"
        ? `${user.name || "User"} requested ${amount} ${currency} with a bank name mismatch.${withdrawalSplitMessage}`
        : `${user.name || "User"} requested ${amount} ${currency}.${withdrawalSplitMessage}`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.createNotification({
      userId: user.id,
      type: "WITHDRAWAL",
      title: "Withdrawal submitted",
      message: withdrawalSplitMessage
        ? `Your withdrawal request of ${amount} ${currency} is awaiting approval.${withdrawalSplitMessage}`
        : `Your withdrawal request of ${amount} ${currency} is awaiting approval.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(user, "WITHDRAWAL_CREATED", "Withdrawal", withdrawal.id, { amount, currency, fraudReviewStatus: fraudReview.status }, requestMeta);
    this.saveIdempotent("withdrawal:create", user.id, requestMeta.idempotencyKey, withdrawal);
    this.persist();
    return clone(withdrawal);
  }

  listWithdrawals(user, { status } = {}) {
    this.ensureState();
    const normalizedStatus = status ? String(status).trim().toUpperCase() : "";
    return this.db.withdrawals
      .filter((withdrawal) => {
        if (user.role !== "admin" && withdrawal.userId !== user.id) {
          return false;
        }
        return !normalizedStatus || withdrawal.status === normalizedStatus;
      })
      .map((withdrawal) => this.enrichUserRecord(withdrawal));
  }

  processWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    const current = this.getWithdrawal(withdrawalId);
    if (current.currency === "NGN" && current.paystackReference) {
      throw new Error("Use Paystack approval for NGN bank withdrawals.");
    }
    const withdrawal = this.changeWithdrawalStatus(admin, withdrawalId, "PROCESSING", input, requestMeta);
    withdrawal.processingAt = this.clock();
    withdrawal.processedBy = admin.id;
    this.markWithdrawalReservationTransactions(withdrawal, "PROCESSING", "Withdrawal amount held for processing.");
    this.persist();
    return clone(withdrawal);
  }

  setWithdrawalTelegramMessage(withdrawalId, telegramMessageId) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    withdrawal.telegramMessageId = String(telegramMessageId || "").trim();
    this.persist();
    return clone(withdrawal);
  }

  setWithdrawalRecipientCode(withdrawalId, recipientCode) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    const code = String(recipientCode || "").trim();
    withdrawal.paystackRecipientCode = code;
    const user = this.db.users.find((item) => item.id === withdrawal.userId);
    if (user?.bankAccount && withdrawal.bank && user.bankAccount.accountNumber === withdrawal.bank.accountNumber && user.bankAccount.bankCode === withdrawal.bank.bankCode) {
      user.bankAccount.paystackRecipientCode = code;
      user.bankAccounts = Array.isArray(user.bankAccounts) ? user.bankAccounts : [];
      user.bankAccounts = user.bankAccounts.map((account) =>
        account.accountNumber === withdrawal.bank.accountNumber && account.bankCode === withdrawal.bank.bankCode
          ? { ...account, paystackRecipientCode: code }
          : account
      );
    }
    this.persist();
    return clone(withdrawal);
  }

  approvePaystackWithdrawal(admin, withdrawalId, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.currency !== "NGN") {
      throw new Error("Only NGN bank withdrawals can be approved through Paystack.");
    }
    if (withdrawal.status !== "PENDING") {
      const error = new Error("Withdrawal has already been processed.");
      error.statusCode = 409;
      throw error;
    }
    if (withdrawal.balanceReserved !== true) {
      throw new Error("Withdrawal balance was not reserved.");
    }
    withdrawal.status = "APPROVED";
    withdrawal.approvedBy = admin.id;
    withdrawal.approvedAt = this.clock();
    withdrawal.paystackReference = withdrawal.paystackReference || this.createPaystackReference();
    withdrawal.externalTransactionReference = withdrawal.paystackReference;
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      approvalIpAddress: requestMeta.ipAddress || "",
    };
    if (isSuspiciousFraudReview(withdrawal.fraudReview)) {
      withdrawal.fraudReview = {
        ...(withdrawal.fraudReview || {}),
        status: "APPROVED",
        reviewedAt: this.clock(),
        reviewedBy: admin.id,
      };
      withdrawal.metadata.fraudReviewStatus = "APPROVED";
    }
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal approved",
      message: "Your withdrawal has been approved and payment is being processed.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_APPROVED", "Withdrawal", withdrawal.id, {
      amount: withdrawal.amount,
      currency: withdrawal.currency,
      maskedAccountNumber: withdrawal.bank?.maskedAccountNumber || maskAccountNumber(withdrawal.bank?.accountNumber),
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferAttempt(admin, withdrawalId, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackTransferAttemptedAt: withdrawal.metadata?.paystackTransferAttemptedAt || this.clock(),
      paystackTransferAttemptedBy: admin.id,
    };
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferRetryable(admin, withdrawalId, error, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.paystackTransferCode) {
      return this.markPaystackTransferUnclear(admin, withdrawalId, error, requestMeta);
    }
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      return clone(withdrawal);
    }
    withdrawal.status = "PENDING";
    withdrawal.approvedBy = "";
    withdrawal.approvedAt = null;
    withdrawal.processingAt = null;
    withdrawal.processedBy = "";
    withdrawal.failureReason = String(error?.message || error || "Paystack approval failed.").slice(0, 180);
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackRetryable: true,
      paystackTransferUnclear: false,
      paystackApprovalFailedAt: this.clock(),
      paystackApprovalFailureReason: withdrawal.failureReason,
    };
    this.markWithdrawalReservationTransactions(withdrawal, "PENDING", "Withdrawal amount reserved.");
    this.audit(admin, "PAYSTACK_TRANSFER_RETRYABLE", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      reason: withdrawal.failureReason,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferProcessing(admin, withdrawalId, paystackPayload = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only approved withdrawals can move to processing.");
    }
    const data = paystackPayload.data || paystackPayload || {};
    withdrawal.status = "PROCESSING";
    withdrawal.processingAt = withdrawal.processingAt || this.clock();
    withdrawal.processedBy = withdrawal.processedBy || admin.id;
    withdrawal.paystackTransferCode = String(data.transfer_code || withdrawal.paystackTransferCode || "").trim();
    withdrawal.paystackReference = String(data.reference || withdrawal.paystackReference || "").trim();
    withdrawal.externalTransactionReference = withdrawal.paystackReference;
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackStatus: String(data.status || "").trim(),
      paystackAcceptedAt: withdrawal.metadata?.paystackAcceptedAt || this.clock(),
      requiresOtp: /otp/i.test(String(paystackPayload.message || data.status || "")),
      paystackTransferResponse: {
        id: data.id || data.transfer_code || "",
        status: data.status || "",
      },
    };
    this.markWithdrawalReservationTransactions(withdrawal, "PROCESSING", "Withdrawal amount held while payment is processing.");
    this.audit(admin, "PAYSTACK_TRANSFER_INITIATED", "Withdrawal", withdrawal.id, {
      amountKobo: withdrawal.amountKobo,
      reference: withdrawal.paystackReference,
      transferCode: withdrawal.paystackTransferCode,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferUnclear(admin, withdrawalId, error, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackTransferUnclear: true,
      paystackTransferUnclearAt: this.clock(),
      paystackTransferUnclearReason: String(error?.message || error || "").slice(0, 180),
    };
    this.audit(admin, "PAYSTACK_TRANSFER_UNCLEAR", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  completeWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.currency === "NGN" && withdrawal.paystackReference) {
      throw new Error("Paystack webhook must confirm NGN withdrawal success.");
    }
    if (!["PENDING", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only pending or processing withdrawals can be completed.");
    }
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      if (compare(wallet.lockedBalance, source.amount) < 0) {
        throw new Error("Locked balance is lower than the withdrawal amount.");
      }
    }

    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const lockedBefore = wallet.lockedBalance;
      wallet.lockedBalance = subtract(wallet.lockedBalance, source.amount);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: withdrawal.userId,
        type: "WITHDRAWAL_COMPLETED",
        currency: source.currency,
        amount: `-${source.amount}`,
        balanceBefore: lockedBefore,
        balanceAfter: wallet.lockedBalance,
        reference: withdrawal.id,
        status: "COMPLETED",
        description: withdrawal.currency === source.currency ? "Withdrawal completed." : `${withdrawal.currency} withdrawal completed.`,
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
        },
      });
    }
    this.markWithdrawalReservationTransactions(withdrawal, "COMPLETED", "Withdrawal completed.");
    withdrawal.status = "COMPLETED";
    withdrawal.completedAt = this.clock();
    withdrawal.completedBy = admin.id;
    withdrawal.balanceReserved = false;
    withdrawal.externalTransactionReference = String(input.externalTransactionReference || input.transactionHash || "").trim();
    withdrawal.adminNote = String(input.adminNote || "").trim();
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal complete",
      message: `${withdrawal.amount} ${withdrawal.currency} sent.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_COMPLETED", "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  completeReviewedWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (!isSuspiciousFraudReview(withdrawal.fraudReview)) {
      throw new Error("Only flagged withdrawals can be approved as reviewed.");
    }
    if (["SUCCESS", "COMPLETED"].includes(withdrawal.status)) {
      return clone(withdrawal);
    }
    if (!["PENDING", "APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only pending or processing flagged withdrawals can be approved.");
    }
    if (withdrawal.balanceReserved !== true) {
      throw new Error("Withdrawal balance was not reserved.");
    }

    this.consumeWithdrawalReservation(withdrawal, admin, "SUCCESS", "Flagged withdrawal approved by admin.");
    withdrawal.status = "SUCCESS";
    withdrawal.approvedBy = withdrawal.approvedBy || admin.id;
    withdrawal.approvedAt = withdrawal.approvedAt || this.clock();
    withdrawal.completedAt = this.clock();
    withdrawal.completedBy = admin.id;
    withdrawal.externalTransactionReference = String(input.externalTransactionReference || withdrawal.externalTransactionReference || withdrawal.paystackReference || "").trim();
    withdrawal.adminNote = String(input.adminNote || withdrawal.adminNote || "Approved after admin review.").trim();
    withdrawal.fraudReview = {
      ...(withdrawal.fraudReview || {}),
      status: "APPROVED",
      reviewedAt: this.clock(),
      reviewedBy: admin.id,
    };
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      fraudReviewStatus: "APPROVED",
      reviewedApprovalAt: this.clock(),
    };
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal successful",
      message: `${withdrawal.amount} ${withdrawal.currency} sent.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_REVIEW_APPROVED", "Withdrawal", withdrawal.id, {
      amount: withdrawal.amount,
      currency: withdrawal.currency,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  completeManualWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (["SUCCESS", "COMPLETED"].includes(withdrawal.status)) {
      return clone(withdrawal);
    }
    if (!["PENDING", "APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only pending or processing withdrawals can be manually completed.");
    }
    if (withdrawal.balanceReserved !== true) {
      throw new Error("Withdrawal balance was not reserved.");
    }

    const manualReference = String(
      input.manualReference ||
        input.externalTransactionReference ||
        input.transactionHash ||
        withdrawal.externalTransactionReference ||
        `MANUAL-${withdrawal.id}`
    ).trim();
    this.consumeWithdrawalReservation(withdrawal, admin, "SUCCESS", "Withdrawal paid manually by admin.");
    withdrawal.status = "SUCCESS";
    withdrawal.approvedBy = withdrawal.approvedBy || admin.id;
    withdrawal.approvedAt = withdrawal.approvedAt || this.clock();
    withdrawal.completedAt = this.clock();
    withdrawal.completedBy = admin.id;
    withdrawal.externalTransactionReference = manualReference;
    withdrawal.adminNote = String(input.adminNote || withdrawal.adminNote || "Manual payout completed.").trim();
    withdrawal.failureReason = "";
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      manualPayout: true,
      manualPayoutAt: this.clock(),
      manualPayoutBy: admin.id,
      manualReference,
      paystackBypassed: withdrawal.currency === "NGN",
    };
    if (withdrawal.fraudReview) {
      withdrawal.fraudReview = {
        ...withdrawal.fraudReview,
        status: "APPROVED",
        reviewedAt: withdrawal.fraudReview.reviewedAt || this.clock(),
        reviewedBy: withdrawal.fraudReview.reviewedBy || admin.id,
      };
      withdrawal.metadata.fraudReviewStatus = "APPROVED";
    }
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal successful",
      message: `${withdrawal.amount} ${withdrawal.currency} sent.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_MANUAL_COMPLETED", "Withdrawal", withdrawal.id, {
      amount: withdrawal.amount,
      currency: withdrawal.currency,
      manualReference,
      paystackReference: withdrawal.paystackReference || "",
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  isLegacyReviewedPaystackReopen(withdrawal = {}) {
    return (
      withdrawal.currency === "NGN" &&
      ACTIVE_WITHDRAWAL_STATUSES.includes(String(withdrawal.status || "").trim().toUpperCase()) &&
      withdrawal.metadata?.reviewedApprovalAt &&
      withdrawal.metadata?.reviewedPaystackReopenedAt &&
      !withdrawal.metadata?.manualPayout &&
      !withdrawal.metadata?.paystackStatus
    );
  }

  finalizeLegacyReviewedPaystackReopen(withdrawal) {
    if (!this.isLegacyReviewedPaystackReopen(withdrawal)) {
      return withdrawal;
    }
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const releaseAmount = clampDebit(source.amount, wallet.lockedBalance || "0");
      if (compare(releaseAmount, "0") > 0) {
        wallet.lockedBalance = subtract(wallet.lockedBalance || "0", releaseAmount);
      }
      wallet.updatedAt = this.clock();
    }
    withdrawal.status = "SUCCESS";
    withdrawal.balanceReserved = false;
    withdrawal.completedAt = withdrawal.completedAt || withdrawal.metadata.reviewedApprovalAt || this.clock();
    withdrawal.completedBy = withdrawal.completedBy || withdrawal.approvedBy || "admin";
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      legacyReviewedPaystackReopenFinalizedAt: this.clock(),
      paystackRetryable: false,
    };
    this.markWithdrawalReservationTransactions(withdrawal, "SUCCESS", "Reviewed withdrawal finalized by admin.");
    this.persist();
    return withdrawal;
  }

  rejectWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    const hasPaystackAttempt = !!(withdrawal.metadata?.paystackTransferAttemptedAt || withdrawal.paystackTransferCode);
    if (withdrawal.status !== "PENDING" && !(withdrawal.status === "APPROVED" && !hasPaystackAttempt)) {
      throw new Error("Only pending withdrawals can be rejected.");
    }
    this.releaseWithdrawalReservation(withdrawal, admin, "REJECTED", "Withdrawal rejected.");
    withdrawal.status = "REJECTED";
    withdrawal.rejectedAt = this.clock();
    withdrawal.rejectedBy = admin.id;
    withdrawal.rejectionReason = String(input.reason || input.adminNote || "").trim();
    withdrawal.adminNote = withdrawal.rejectionReason;
    withdrawal.balanceReserved = false;
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal rejected",
      message: "Your withdrawal request was rejected.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_REJECTED", "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  consumeWithdrawalReservation(withdrawal, actor, status, description) {
    if (withdrawal.balanceReserved === false) {
      return;
    }
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      if (compare(wallet.lockedBalance, source.amount) < 0) {
        throw new Error("Locked balance is lower than the withdrawal amount.");
      }
    }
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const lockedBefore = wallet.lockedBalance;
      wallet.lockedBalance = subtract(wallet.lockedBalance, source.amount);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: withdrawal.userId,
        type: "WITHDRAWAL_COMPLETED",
        currency: source.currency,
        amount: `-${source.amount}`,
        balanceBefore: lockedBefore,
        balanceAfter: wallet.lockedBalance,
        reference: withdrawal.id,
        status,
        description,
        createdBy: actor?.id || "system",
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          paystackReference: withdrawal.paystackReference || "",
        },
      });
    }
    this.markWithdrawalReservationTransactions(withdrawal, status, description);
    withdrawal.balanceReserved = false;
  }

  releaseWithdrawalReservation(withdrawal, actor, status, description) {
    if (withdrawal.balanceReserved === false) {
      return;
    }
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      if (compare(wallet.lockedBalance, source.amount) < 0) {
        throw new Error("Locked balance is lower than the withdrawal amount.");
      }
    }
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const availableBefore = wallet.availableBalance;
      const lockedBefore = wallet.lockedBalance;
      wallet.lockedBalance = subtract(wallet.lockedBalance, source.amount);
      wallet.availableBalance = add(wallet.availableBalance, source.amount);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: withdrawal.userId,
        type: "REVERSAL",
        currency: source.currency,
        amount: source.amount,
        balanceBefore: availableBefore,
        balanceAfter: wallet.availableBalance,
        reference: withdrawal.id,
        status,
        description,
        createdBy: actor?.id || "system",
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          lockedBalanceBefore: lockedBefore,
          lockedBalanceAfter: wallet.lockedBalance,
          paystackReference: withdrawal.paystackReference || "",
        },
      });
    }
    this.markWithdrawalReservationTransactions(withdrawal, status, description);
    withdrawal.balanceReserved = false;
  }

  creditWithdrawalReversal(withdrawal, actor, description) {
    if (withdrawal.metadata?.reversalCreditedAt) {
      return;
    }
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const availableBefore = wallet.availableBalance;
      wallet.availableBalance = add(wallet.availableBalance, source.amount);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: withdrawal.userId,
        type: "REVERSAL",
        currency: source.currency,
        amount: source.amount,
        balanceBefore: availableBefore,
        balanceAfter: wallet.availableBalance,
        reference: withdrawal.id,
        status: "REVERSED",
        description,
        createdBy: actor?.id || "system",
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          paystackReference: withdrawal.paystackReference || "",
        },
      });
    }
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      reversalCreditedAt: this.clock(),
    };
  }

  applyPaystackTransferSuccess(reference, eventData = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawalByPaystackReference(reference);
    if (withdrawal.status === "SUCCESS") {
      return clone(withdrawal);
    }
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Withdrawal is not ready for Paystack success.");
    }
    this.assertPaystackEventMatchesWithdrawal(withdrawal, eventData);
    this.consumeWithdrawalReservation(withdrawal, { id: "paystack", role: "system" }, "SUCCESS", "Withdrawal paid by Paystack.");
    withdrawal.status = "SUCCESS";
    withdrawal.completedAt = this.clock();
    withdrawal.paystackTransferCode = String(eventData.transfer_code || withdrawal.paystackTransferCode || "").trim();
    withdrawal.failureReason = "";
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackStatus: String(eventData.status || "success"),
    };
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal paid",
      message: `Your withdrawal payout of ${withdrawal.netAmount || withdrawal.amount} NGN has been successfully paid to your bank account.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit({ id: "paystack", role: "system" }, "PAYSTACK_TRANSFER_SUCCESS", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      amountKobo: withdrawal.amountKobo,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  applyPaystackTransferFailed(reference, eventData = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawalByPaystackReference(reference);
    if (withdrawal.status === "FAILED") {
      return clone(withdrawal);
    }
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Withdrawal is not ready for Paystack failure.");
    }
    this.assertPaystackEventMatchesWithdrawal(withdrawal, eventData);
    this.releaseWithdrawalReservation(withdrawal, { id: "paystack", role: "system" }, "FAILED", "Paystack transfer failed.");
    withdrawal.status = "FAILED";
    withdrawal.failureReason = String(eventData.reason || eventData.gateway_response || "Paystack transfer failed.").slice(0, 180);
    withdrawal.balanceReserved = false;
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal failed",
      message: "We could not complete your withdrawal. The amount has been returned to your available balance.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit({ id: "paystack", role: "system" }, "PAYSTACK_TRANSFER_FAILED", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      amountKobo: withdrawal.amountKobo,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  applyPaystackTransferReversed(reference, eventData = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawalByPaystackReference(reference);
    if (withdrawal.status === "REVERSED") {
      return clone(withdrawal);
    }
    this.assertPaystackEventMatchesWithdrawal(withdrawal, eventData);
    if (withdrawal.balanceReserved !== false) {
      this.releaseWithdrawalReservation(withdrawal, { id: "paystack", role: "system" }, "REVERSED", "Paystack transfer reversed.");
    } else if (withdrawal.status === "SUCCESS") {
      this.creditWithdrawalReversal(withdrawal, { id: "paystack", role: "system" }, "Paystack transfer reversed.");
    }
    withdrawal.status = "REVERSED";
    withdrawal.failureReason = String(eventData.reason || eventData.gateway_response || "Paystack transfer reversed.").slice(0, 180);
    withdrawal.balanceReserved = false;
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal reversed",
      message: "Your withdrawal was reversed. The amount has been returned to your available balance.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit({ id: "paystack", role: "system" }, "PAYSTACK_TRANSFER_REVERSED", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      amountKobo: withdrawal.amountKobo,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  createDailyPerformance(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const startingCapital = normalizeAmount(input.startingCapital ?? input.adminCapital, "Starting capital");
    const endingCapital = normalizeNonNegativeAmount(input.endingCapital, "Ending capital");
    const profitLoss = subtract(endingCapital, startingCapital);
    const date = String(input.date || new Date().toISOString().slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Performance date must use YYYY-MM-DD.");
    }
    const existing = this.db.dailyPerformances.find((item) => item.date === date);
    if (existing) {
      throw new Error("Daily performance already exists for this date.");
    }
    const performance = {
      id: this.idGenerator(12),
      date,
      adminCapital: String(input.adminCapital || startingCapital),
      startingCapital,
      endingCapital,
      profitLoss,
      profitLossPercentage: percentChange(startingCapital, endingCapital),
      status: "DRAFT",
      createdBy: admin.id,
      createdAt: this.clock(),
      appliedAt: null,
      appliedBy: null,
    };
    this.db.dailyPerformances.unshift(performance);
    this.audit(admin, "DAILY_PERFORMANCE_CREATED", "DailyPerformance", performance.id, { date, profitLoss }, requestMeta);
    this.persist();
    return clone(performance);
  }

  applyDailyPerformance(admin, performanceId, requestMeta = {}) {
    this.ensureState();
    const performance = this.db.dailyPerformances.find((item) => item.id === performanceId);
    if (!performance) {
      throw new Error("Daily performance record not found.");
    }

    let appliedCount = 0;
    for (const user of this.db.users.filter((item) => item.role === "user" && item.status !== "SUSPENDED")) {
      const reference = `${performance.id}:${user.id}`;
      const exists = this.db.transactions.some((item) => item.reference === reference);
      if (exists) {
        continue;
      }
      const wallet = this.ensureWallet(user.id, "USDT");
      const eligibleBalance = wallet.availableBalance;
      if (compare(eligibleBalance, "0") <= 0) {
        continue;
      }
      let userPnl = multiplyRatio(eligibleBalance, performance.profitLossPercentage, "100");
      if (compare(userPnl, "0") < 0) {
        userPnl = `-${clampDebit(userPnl.slice(1), eligibleBalance)}`;
      }
      if (compare(userPnl, "0") === 0) {
        continue;
      }
      const balanceBefore = wallet.availableBalance;
      wallet.availableBalance = add(wallet.availableBalance, userPnl);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: user.id,
        type: compare(userPnl, "0") > 0 ? "TRADING_PROFIT" : "TRADING_LOSS",
        currency: "USDT",
        amount: userPnl,
        balanceBefore,
        balanceAfter: wallet.availableBalance,
        reference,
        status: "APPROVED",
        description: `Daily trading performance for ${performance.date}.`,
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          performanceId: performance.id,
          performanceDate: performance.date,
          profitLossPercentage: performance.profitLossPercentage,
        },
      });
      appliedCount += 1;
    }

    performance.status = "APPLIED";
    performance.appliedAt = performance.appliedAt || this.clock();
    performance.appliedBy = performance.appliedBy || admin.id;
    this.audit(admin, "DAILY_PERFORMANCE_APPLIED", "DailyPerformance", performance.id, { appliedCount }, requestMeta);
    this.persist();
    return {
      performance: clone(performance),
      appliedCount,
    };
  }

  getAdminDashboard() {
    this.ensureState();
    const totalUsers = this.db.users.filter((user) => user.role === "user").length;
    const activeUsers = this.db.users.filter((user) => user.role === "user" && user.status !== "SUSPENDED").length;
    const walletTotals = SUPPORTED_CURRENCIES.reduce((acc, currency) => {
      acc[currency] = this.db.wallets
        .filter((wallet) => wallet.currency === currency)
        .reduce((sum, wallet) => add(sum, add(wallet.availableBalance, wallet.lockedBalance)), "0");
      return acc;
    }, {});
    return {
      totalUsers,
      activeUsers,
      totalUserBalance: walletTotals,
      pendingDeposits: this.db.deposits.filter((deposit) => deposit.status === "PENDING").length,
      pendingWithdrawals: this.db.withdrawals.filter((withdrawal) => withdrawal.status === "PENDING").length,
      notifications: this.listNotifications(this.db.users.find((user) => user.role === "admin") || { role: "admin" }, { limit: 20, includeRead: false }),
      settings: {
        deposit: clone(this.db.systemSettings.deposit),
        withdrawal: clone(this.db.systemSettings.withdrawal),
        exchangeRate: clone(this.db.systemSettings.exchangeRate),
        telegram: clone(this.db.systemSettings.telegram),
        trading: clone(this.db.systemSettings.trading),
        referral: clone(this.db.systemSettings.referral),
        vtu: this.sanitizeVtuSettings(this.db.systemSettings.vtu),
        digitalServices: this.sanitizeDigitalServiceSettings(this.db.systemSettings.digitalServices, { admin: true }),
      },
      referral: this.getAdminReferralSummary({ limit: 5 }),
      vtu: this.getVtuAdminSummary(),
      digitalServices: this.getDigitalServiceAdminSummary(),
      todayPnl: this.getTodayPnl(),
      totalPnl: this.db.transactions
        .filter((transaction) => ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type))
        .reduce((sum, transaction) => add(sum, transaction.amount), "0"),
    };
  }

  getAuditLogs({ limit = 100 } = {}) {
    this.ensureState();
    return this.db.auditLogs.slice(0, limit).map(clone);
  }

  getDailyPerformances() {
    this.ensureState();
    return this.db.dailyPerformances.map(clone);
  }

  getTodayPnl() {
    const today = this.clock().slice(0, 10);
    return this.db.transactions
      .filter((transaction) => ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type) && String(transaction.createdAt || "").startsWith(today))
      .reduce((sum, transaction) => add(sum, transaction.amount), "0");
  }

  deleteFinanceHistory(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const transactionIds = new Set((input.transactionIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    const depositIds = new Set((input.depositIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    const withdrawalIds = new Set((input.withdrawalIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    const vtuTransactionIds = new Set((input.vtuTransactionIds || []).map((id) => String(id || "").trim()).filter(Boolean));

    if (!transactionIds.size && !depositIds.size && !withdrawalIds.size && !vtuTransactionIds.size) {
      throw new Error("Select at least one history item.");
    }

    const before = {
      transactions: this.db.transactions.length,
      deposits: this.db.deposits.length,
      withdrawals: this.db.withdrawals.length,
      vtuTransactions: this.db.vtuTransactions.length,
    };
    this.db.transactions = this.db.transactions.filter((item) => !transactionIds.has(item.id));
    this.db.deposits = this.db.deposits.filter((item) => !depositIds.has(item.id));
    this.db.withdrawals = this.db.withdrawals.filter((item) => !withdrawalIds.has(item.id));
    this.db.vtuTransactions = this.db.vtuTransactions.filter((item) => !vtuTransactionIds.has(item.id));

    const deleted = {
      transactions: before.transactions - this.db.transactions.length,
      deposits: before.deposits - this.db.deposits.length,
      withdrawals: before.withdrawals - this.db.withdrawals.length,
      vtuTransactions: before.vtuTransactions - this.db.vtuTransactions.length,
    };
    const deletedCount = deleted.transactions + deleted.deposits + deleted.withdrawals + deleted.vtuTransactions;
    if (!deletedCount) {
      throw new Error("Selected history was not found.");
    }

    this.audit(admin, "FINANCE_HISTORY_DELETED", "FinanceHistory", "bulk", deleted, requestMeta);
    this.persist();
    return { deletedCount, deleted };
  }

  getDeposit(depositId) {
    const deposit = this.db.deposits.find((item) => item.id === depositId);
    if (!deposit) {
      throw new Error("Deposit request not found.");
    }
    return deposit;
  }

  getWithdrawal(withdrawalId) {
    const withdrawal = this.db.withdrawals.find((item) => item.id === withdrawalId);
    if (!withdrawal) {
      throw new Error("Withdrawal request not found.");
    }
    return withdrawal;
  }

  getWithdrawalByPaystackReference(reference) {
    const normalized = String(reference || "").trim();
    const withdrawal = this.db.withdrawals.find((item) => item.paystackReference === normalized);
    if (!withdrawal) {
      throw new Error("Withdrawal request not found for Paystack reference.");
    }
    return withdrawal;
  }

  assertPaystackEventMatchesWithdrawal(withdrawal, eventData = {}) {
    const eventAmount = Number(eventData.amount || 0);
    if (eventAmount && eventAmount !== Number(withdrawal.amountKobo || 0)) {
      throw new Error("Paystack webhook amount does not match withdrawal.");
    }
    const eventReference = String(eventData.reference || "").trim();
    if (eventReference && eventReference !== withdrawal.paystackReference) {
      throw new Error("Paystack webhook reference does not match withdrawal.");
    }
    const recipientCode = String(eventData.recipient?.recipient_code || eventData.recipient || "").trim();
    if (recipientCode && withdrawal.paystackRecipientCode && recipientCode !== withdrawal.paystackRecipientCode) {
      throw new Error("Paystack webhook recipient does not match withdrawal.");
    }
  }

  recordPaystackWebhookEvent({ eventType, reference, payloadHash } = {}) {
    this.ensureState();
    const normalizedHash = String(payloadHash || "").trim();
    const existing = this.db.webhookEvents.find((item) => item.provider === "paystack" && item.payloadHash === normalizedHash);
    if (existing) {
      return { duplicate: !!existing.processed, event: clone(existing) };
    }
    const event = {
      id: this.idGenerator(12),
      provider: "paystack",
      eventType: String(eventType || "").trim(),
      reference: String(reference || "").trim(),
      payloadHash: normalizedHash,
      processed: false,
      createdAt: this.clock(),
      processedAt: null,
    };
    this.db.webhookEvents.unshift(event);
    this.persist();
    return { duplicate: false, event };
  }

  recordVtuWebhookEvent({ requestId, payloadHash, status = "" } = {}) {
    this.ensureState();
    const normalizedHash = String(payloadHash || "").trim();
    const normalizedRequestId = String(requestId || "").trim();
    const existing = this.db.webhookEvents.find(
      (item) => item.provider === "vtu_ng" && (item.payloadHash === normalizedHash || (normalizedRequestId && item.reference === normalizedRequestId && item.eventType === status))
    );
    if (existing) {
      return { duplicate: !!existing.processed, event: clone(existing) };
    }
    const event = {
      id: this.idGenerator(12),
      provider: "vtu_ng",
      eventType: String(status || "").trim(),
      reference: normalizedRequestId,
      payloadHash: normalizedHash,
      processed: false,
      createdAt: this.clock(),
      processedAt: null,
    };
    this.db.webhookEvents.unshift(event);
    this.persist();
    return { duplicate: false, event };
  }

  markPaystackWebhookEventProcessed(eventId) {
    const event = this.db.webhookEvents.find((item) => item.id === eventId);
    if (event) {
      event.processed = true;
      event.processedAt = this.clock();
      this.persist();
    }
  }

  getWithdrawalFundingSources(withdrawal) {
    const sources = Array.isArray(withdrawal.fundingSources) && withdrawal.fundingSources.length
      ? withdrawal.fundingSources
      : [{ currency: withdrawal.currency, amount: withdrawal.amount }];
    return sources.map((source) => ({
      currency: normalizeCurrency(source.currency || withdrawal.currency),
      amount: normalizeAmount(source.amount || withdrawal.amount, "Withdrawal funding amount"),
    }));
  }

  changeWithdrawalStatus(admin, withdrawalId, status, input = {}, requestMeta = {}) {
    this.ensureState();
    if (!WITHDRAWAL_STATUSES.includes(status)) {
      throw new Error("Unsupported withdrawal status.");
    }
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.status === "COMPLETED" || withdrawal.status === "REJECTED") {
      throw new Error("Finalized withdrawals cannot be changed.");
    }
    withdrawal.status = status;
    withdrawal.adminNote = String(input.adminNote || withdrawal.adminNote || "").trim();
    this.audit(admin, `WITHDRAWAL_${status}`, "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return withdrawal;
  }

  validateWithdrawalSettings(currency, amount) {
    const settings = this.db.systemSettings.withdrawal;
    if (currency === "USDT" && !settings.usdtEnabled) {
      throw new Error("USDT withdrawals are currently disabled.");
    }
    if (currency === "NGN" && !settings.ngnEnabled) {
      throw new Error("NGN withdrawals are currently disabled.");
    }
    const configuredMin = currency === "USDT" ? settings.minUsdt : settings.minNgn;
    const requiredMin = MIN_WITHDRAWAL_AMOUNTS[currency] || configuredMin;
    const min = compare(configuredMin || "0", requiredMin) > 0 ? configuredMin : requiredMin;
    const max = currency === "USDT" ? settings.maxUsdt : settings.maxNgn;
    if (compare(amount, min) < 0 || compare(amount, max) > 0) {
      throw new Error(`Withdrawal amount must be between ${min} and ${max} ${currency}.`);
    }
  }

  validateDailyWithdrawalLimit(userId, currency, amount) {
    const maxDailyNgn = String(this.db.systemSettings.withdrawal.maxDailyNgn || "10000000");
    if (!isPositive(maxDailyNgn)) {
      return;
    }
    const today = this.clock().slice(0, 10);
    const requestedNgn = currency === "NGN"
      ? amount
      : this.convertAmount(amount, currency, "NGN");
    const usedTodayNgn = this.db.withdrawals.reduce((sum, withdrawal) => {
      if (
        withdrawal.userId === userId &&
        !["REJECTED", "CANCELLED", "FAILED", "REVERSED"].includes(withdrawal.status) &&
        String(withdrawal.submittedAt || "").startsWith(today)
      ) {
        const withdrawalNgn = withdrawal.currency === "NGN"
          ? String(withdrawal.amount || "0")
          : this.convertAmount(withdrawal.amount || "0", withdrawal.currency, "NGN", withdrawal.exchangeRate);
        return add(sum, withdrawalNgn);
      }
      return sum;
    }, "0");
    const nextDailyNgn = add(usedTodayNgn, requestedNgn);
    if (compare(nextDailyNgn, maxDailyNgn) > 0) {
      throw new Error(`Daily withdrawal limit is ${maxDailyNgn} NGN.`);
    }
  }

  mergeBankDestination(saved = {}, input = {}) {
    const pick = (...values) => {
      for (const value of values) {
        const normalized = String(value || "").trim();
        if (normalized) {
          return normalized;
        }
      }
      return "";
    };
    return {
      bankName: pick(input.bankName, input.bank, input.bank_name, saved.bankName),
      accountName: pick(input.accountName, input.accountHolder, input.accountHolderName, input.name, saved.accountName),
      accountNumber: pick(input.accountNumber, input.accountNo, input.account, input.number, saved.accountNumber),
    };
  }

  normalizeWithdrawalDestination(currency, input = {}) {
    if (currency === "USDT") {
      const address = String(input.address || input.walletAddress || input.usdtAddress || input.destinationAddress || "").trim();
      const network = String(input.network || input.usdtNetwork || input.chain || this.db.systemSettings.deposit.usdtNetwork || "").trim();
      if (!address || !network) {
        throw new Error("USDT withdrawal address and network are required.");
      }
      return { type: "USDT_WALLET", address, network };
    }

    const bankName = String(input.bankName || input.bank || input.bank_name || "").trim();
    const accountName = String(input.accountName || input.accountHolder || input.accountHolderName || input.name || "").trim();
    const accountNumber = String(input.accountNumber || input.accountNo || input.account || input.number || "").replace(/\D/g, "").trim();
    if (!bankName || !accountName || !/^\d{10}$/.test(accountNumber)) {
      throw new Error("Bank name, account name, and a 10-digit account number are required.");
    }
    return { type: "NGN_BANK", bankName, accountName, accountNumber };
  }

  enrichUserRecord(record) {
    const user = this.db.users.find((item) => item.id === record.userId);
    return {
      ...clone(record),
      user: user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
          }
        : null,
    };
  }

  audit(actor, action, entityType, entityId, metadata = {}, requestMeta = {}) {
    this.db.auditLogs.unshift({
      id: this.idGenerator(12),
      actorId: actor?.id || "system",
      actorRole: actor?.role || "system",
      action,
      entityType,
      entityId,
      metadata: clone(metadata || {}),
      ipAddress: requestMeta.ipAddress || "",
      userAgent: requestMeta.userAgent || "",
      createdAt: this.clock(),
    });
  }

  createDigitalServiceRequestId() {
    return `digital_${Date.now().toString(36)}_${this.idGenerator(10).toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 50);
  }

  getDigitalServiceOverride(productId) {
    this.ensureState();
    const id = String(productId || "").trim();
    return this.db.systemSettings.digitalServices.productOverrides?.[id] || {};
  }

  normalizeRecoveredDigitalServiceStatus(order = {}, transaction = {}) {
    const status = String(order.status || transaction.status || "").trim().toLowerCase();
    if (["delivered", "successful", "success", "completed", "complete"].includes(status)) {
      return "delivered";
    }
    if (["failed", "failure"].includes(status)) {
      return "failed";
    }
    if (["refunded"].includes(status)) {
      return "refunded";
    }
    return "processing";
  }

  findCachedDigitalServiceOrder(userId, requestId) {
    const record = this.db.idempotencyKeys.find((item) =>
      item.scope === "digital-service:order" &&
      item.userId === userId &&
      item.response?.order &&
      item.response.order.requestId === requestId
    );
    return record?.response?.order || null;
  }

  findDigitalServiceProviderAudit(requestId) {
    return this.db.auditLogs.find((item) =>
      item.action === "DIGITAL_SERVICE_PROVIDER_RESULT_APPLIED" &&
      item.metadata?.requestId === requestId
    ) || null;
  }

  recoverMissingDigitalServiceOrdersFromHistory(actor = { id: "system", role: "system" }, requestMeta = {}) {
    this.ensureState();
    const existingReferences = new Set(this.db.digitalServiceOrders.map((order) => String(order.requestId || "").trim()).filter(Boolean));
    const existingIds = new Set(this.db.digitalServiceOrders.map((order) => String(order.id || "").trim()).filter(Boolean));
    const recovered = [];
    const userScope = actor?.role === "user" ? actor.id : "";
    const digitalTransactions = this.db.transactions
      .filter((transaction) =>
        transaction.type === "DIGITAL_SERVICE" &&
        transaction.userId &&
        transaction.reference &&
        (!userScope || transaction.userId === userScope)
      )
      .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));

    for (const transaction of digitalTransactions) {
      const requestId = String(transaction.reference || "").trim();
      if (!requestId || existingReferences.has(requestId)) {
        continue;
      }
      const cachedOrder = this.findCachedDigitalServiceOrder(transaction.userId, requestId) || {};
      const providerAudit = this.findDigitalServiceProviderAudit(requestId);
      const providerMetadata = providerAudit?.metadata || {};
      const metadata = transaction.metadata && typeof transaction.metadata === "object" ? transaction.metadata : {};
      const productId = String(cachedOrder.productId || metadata.productId || "").trim();
      const product = productId ? this.db.digitalServiceProducts.find((item) => item.id === productId || item.supplierProductId === productId) : null;
      const rawAmount = String(cachedOrder.amountCharged || transaction.amount || "0").replace(/,/g, "").replace(/^-/, "");
      const amountCharged = compare(rawAmount || "0", "0") > 0 ? rawAmount : "0";
      if (compare(amountCharged, "0") <= 0) {
        continue;
      }
      const quantity = Math.max(1, Math.min(Math.floor(Number(cachedOrder.quantity || metadata.quantity || 1)), 1000));
      const productName = String(
        cachedOrder.productName ||
        product?.name ||
        String(transaction.description || "").replace(/^Digital service\s*/i, "").trim() ||
        "Digital service"
      ).trim();
      const providerCostNgn = cachedOrder.providerCostNgn || (product?.providerCostNgn ? multiplyRatio(product.providerCostNgn, String(quantity), "1") : amountCharged);
      const status = cachedOrder.delivery ? "delivered" : this.normalizeRecoveredDigitalServiceStatus({
        ...cachedOrder,
        status: cachedOrder.status || providerMetadata.status,
      }, transaction);
      const wallet = this.ensureWallet(transaction.userId, "NGN");
      const balanceReserved = DIGITAL_SERVICE_ACTIVE_STATUSES.includes(status) && compare(wallet.lockedBalance || "0", amountCharged) >= 0;
      const recoveredOrder = {
        id: existingIds.has(String(cachedOrder.id || "")) ? this.idGenerator(12) : String(cachedOrder.id || this.idGenerator(12)),
        userId: transaction.userId,
        requestId,
        provider: cachedOrder.provider || "akunding",
        productId: productId || cachedOrder.productId || "recovered",
        supplierProductId: product?.supplierProductId || productId || "",
        productName,
        category: cachedOrder.category || product?.category || metadata.category || "Digital",
        imageUrl: cachedOrder.imageUrl || product?.imageUrl || DEFAULT_DIGITAL_SERVICE_FALLBACK_IMAGE,
        quantity,
        currency: "NGN",
        unitPrice: quantity > 0 ? multiplyRatio(amountCharged, "1", String(quantity)) : amountCharged,
        amountCharged,
        providerCost: cachedOrder.providerCost || providerCostNgn,
        providerCostNgn,
        markupAmount: compare(amountCharged, providerCostNgn) > 0 ? subtract(amountCharged, providerCostNgn) : "0",
        status,
        supplierStatus: cachedOrder.supplierStatus || providerMetadata.supplierStatus || status,
        supplierOrderId: cachedOrder.supplierOrderId || providerMetadata.supplierOrderId || "",
        supplierResponse: null,
        deliveryEncrypted: cachedOrder.delivery ? this.encryptDigitalServiceDelivery(cachedOrder.delivery) : "",
        failureReason: cachedOrder.failureReason || "",
        walletReservedAmount: amountCharged,
        balanceReserved,
        createdAt: cachedOrder.createdAt || transaction.createdAt || this.clock(),
        updatedAt: cachedOrder.updatedAt || transaction.createdAt || this.clock(),
        completedAt: cachedOrder.completedAt || (DIGITAL_SERVICE_FINAL_STATUSES.includes(status) ? (transaction.createdAt || this.clock()) : null),
        refundedAt: cachedOrder.refundedAt || (status === "refunded" ? (transaction.createdAt || this.clock()) : null),
        recoveredFromHistory: true,
        recoveredAt: this.clock(),
      };
      this.db.digitalServiceOrders.unshift(recoveredOrder);
      existingReferences.add(requestId);
      existingIds.add(recoveredOrder.id);
      recovered.push(this.sanitizeDigitalServiceOrder(recoveredOrder, { admin: actor?.role === "admin" }));
    }

    if (recovered.length) {
      this.audit(actor, "DIGITAL_SERVICE_ORDERS_RECOVERED", "DigitalServiceOrder", "history", {
        count: recovered.length,
      }, requestMeta);
      this.persist();
    }
    return {
      count: recovered.length,
      orders: recovered,
    };
  }

  isSafeDigitalServiceImageUrl(value = "") {
    const raw = String(value || "").trim();
    if (!raw) {
      return false;
    }
    if (raw.startsWith("/")) {
      return true;
    }
    try {
      const parsed = new URL(raw);
      const allowed = this.db.systemSettings.digitalServices.allowedImageDomains || [];
      return ["http:", "https:"].includes(parsed.protocol)
        && allowed.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  }

  isValidAdminDigitalServiceImageUrl(value = "") {
    const raw = String(value || "").trim();
    if (!raw) {
      return false;
    }
    if (raw.startsWith("/")) {
      return true;
    }
    try {
      const parsed = new URL(raw);
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  getDigitalServiceImageUrl(product = {}, override = this.getDigitalServiceOverride(product.id)) {
    const custom = override.customImageUrl || "";
    if (this.isValidAdminDigitalServiceImageUrl(custom)) {
      return custom;
    }
    if (this.isSafeDigitalServiceImageUrl(product.imageUrl)) {
      return product.imageUrl;
    }
    return this.db.systemSettings.digitalServices.fallbackImageUrl || DEFAULT_DIGITAL_SERVICE_FALLBACK_IMAGE;
  }

  getDigitalServiceProviderCostNgn(product = {}) {
    const amount = normalizeNonNegativeAmount(product.providerCost || "0", "Supplier cost");
    const currency = String(product.currency || "NGN").trim().toUpperCase();
    if (currency === "NGN") {
      return amount;
    }
    if (currency === "USDT" || currency === "USD") {
      return multiplyRatio(amount, this.db.systemSettings.exchangeRate.usdtToNgn, "1");
    }
    return amount;
  }

  priceDigitalServiceProduct(product = {}) {
    this.ensureState();
    const override = this.getDigitalServiceOverride(product.id);
    const providerCostNgn = this.getDigitalServiceProviderCostNgn(product);
    let markupAmount = multiplyRatio(providerCostNgn, this.db.systemSettings.digitalServices.globalMarkupPercent || "0", "100");
    let sellingPrice = add(providerCostNgn, markupAmount);
    const mode = normalizeMarkupMode(override.markupMode);
    if (mode === "fixed") {
      markupAmount = normalizeNonNegativeAmount(override.markupValue || "0", "Product fixed markup");
      sellingPrice = add(providerCostNgn, markupAmount);
    } else if (mode === "custom" && compare(override.customPriceNgn || "0", "0") > 0) {
      sellingPrice = normalizeAmount(override.customPriceNgn, "Custom product price");
      markupAmount = compare(sellingPrice, providerCostNgn) > 0 ? subtract(sellingPrice, providerCostNgn) : "0";
    } else if (override.markupValue !== undefined && compare(override.markupValue || "0", "0") > 0) {
      markupAmount = multiplyRatio(providerCostNgn, normalizePercent(override.markupValue, "Product markup"), "100");
      sellingPrice = add(providerCostNgn, markupAmount);
    }
    return {
      providerCostNgn,
      markupAmount,
      sellingPrice,
    };
  }

  sanitizeDigitalServiceProduct(product = {}, { admin = false } = {}) {
    const override = this.getDigitalServiceOverride(product.id);
    const pricing = this.priceDigitalServiceProduct(product);
    const overrideExists = Object.prototype.hasOwnProperty.call(override, "enabled");
    const enabled = overrideExists ? !!override.enabled : product.available !== false;
    const response = {
      id: String(product.id || product.supplierProductId || "").trim(),
      name: override.displayName || product.name || "Digital Service",
      description: product.description || "",
      category: override.displayCategory || product.category || "Digital",
      currency: "NGN",
      price: pricing.sellingPrice,
      sellingPrice: pricing.sellingPrice,
      supplierAvailable: product.available !== false,
      stock: Number(product.stock || 0),
      available: enabled && compare(pricing.sellingPrice, "0") > 0,
      featured: !!override.featured,
      order: Number(override.order || 0),
      imageUrl: this.getDigitalServiceImageUrl(product, override),
      deliveryLabel: product.deliveryLabel || "After purchase",
      planLabel: product.planLabel || "",
      providerStatus: product.providerStatus || "",
      syncedAt: product.syncedAt || null,
    };
    if (admin) {
      response.supplierProductId = product.supplierProductId || product.id || "";
      response.provider = product.provider || "akunding";
      response.providerCost = product.providerCost || "0";
      response.supplierCurrency = product.currency || "NGN";
      response.providerCostNgn = pricing.providerCostNgn;
      response.markupAmount = pricing.markupAmount;
      response.override = override;
    }
    return response;
  }

  listDigitalServiceProducts({ query = "", category = "", includeInactive = false, admin = false } = {}) {
    this.ensureState();
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const normalizedCategory = String(category || "").trim().toLowerCase();
    return this.db.digitalServiceProducts
      .map((product) => this.sanitizeDigitalServiceProduct(product, { admin }))
      .filter((product) => includeInactive || product.available)
      .filter((product) => !normalizedCategory || String(product.category || "").toLowerCase() === normalizedCategory)
      .filter((product) => {
        if (!normalizedQuery) {
          return true;
        }
        return `${product.name} ${product.description} ${product.category}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((a, b) => Number(b.featured) - Number(a.featured) || Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));
  }

  getDigitalServiceProduct(productId, { admin = false } = {}) {
    this.ensureState();
    const id = String(productId || "").trim();
    const product = this.db.digitalServiceProducts.find((item) => String(item.id || item.supplierProductId || "") === id);
    if (!product) {
      throw new Error("Digital service not found.");
    }
    const sanitized = this.sanitizeDigitalServiceProduct(product, { admin });
    if (!admin && !sanitized.available) {
      throw new Error("This digital service is not available now.");
    }
    return sanitized;
  }

  replaceDigitalServiceProducts(products = [], { provider = "akunding" } = {}) {
    this.ensureState();
    const normalizedProducts = products
      .map((product) => ({
        ...product,
        id: String(product.id || product.supplierProductId || "").trim(),
        supplierProductId: String(product.supplierProductId || product.id || "").trim(),
        provider,
        syncedAt: product.syncedAt || this.clock(),
      }))
      .filter((product) => product.id && product.supplierProductId);
    const nextById = new Map(normalizedProducts.map((product) => [product.id, product]));
    for (const existing of this.db.digitalServiceProducts) {
      if (!nextById.has(existing.id)) {
        nextById.set(existing.id, {
          ...existing,
          available: false,
          providerStatus: "unavailable",
          syncedAt: this.clock(),
        });
      }
    }
    this.db.digitalServiceProducts = [...nextById.values()];
    this.updateDigitalServiceSyncStatus({ status: "connected", error: "" });
    return this.listDigitalServiceProducts({ includeInactive: true, admin: true });
  }

  upsertDigitalServiceProduct(product = {}, { provider = "akunding" } = {}) {
    this.ensureState();
    const normalized = {
      ...product,
      id: String(product.id || product.supplierProductId || "").trim(),
      supplierProductId: String(product.supplierProductId || product.id || "").trim(),
      provider,
      syncedAt: product.syncedAt || this.clock(),
    };
    if (!normalized.id || !normalized.supplierProductId) {
      throw new Error("Digital service product is missing a supplier product ID.");
    }
    const index = this.db.digitalServiceProducts.findIndex((item) => String(item.id || item.supplierProductId || "") === normalized.id);
    if (index >= 0) {
      this.db.digitalServiceProducts[index] = {
        ...this.db.digitalServiceProducts[index],
        ...normalized,
      };
    } else {
      this.db.digitalServiceProducts.unshift(normalized);
    }
    this.updateDigitalServiceSyncStatus({ status: "connected", error: "" });
    return this.getDigitalServiceProduct(normalized.id, { admin: true });
  }

  updateDigitalServiceProductOverride(admin, productId, input = {}, requestMeta = {}) {
    this.ensureState();
    const product = this.getDigitalServiceProduct(productId, { admin: true });
    const current = this.db.systemSettings.digitalServices.productOverrides[product.id] || {};
    const next = this.normalizeDigitalServiceSettings({
      ...this.db.systemSettings.digitalServices,
      productOverrides: {
        ...this.db.systemSettings.digitalServices.productOverrides,
        [product.id]: {
          ...current,
          ...input,
        },
      },
      updatedBy: admin?.id || "admin",
      updatedAt: this.clock(),
    });
    this.db.systemSettings.digitalServices = next;
    this.audit(admin, "DIGITAL_SERVICE_PRODUCT_OVERRIDE_UPDATED", "DigitalServiceProduct", product.id, {
      productId: product.id,
    }, requestMeta);
    this.persist();
    return this.getDigitalServiceProduct(product.id, { admin: true });
  }

  encryptDigitalServiceDelivery(delivery) {
    if (!delivery || typeof delivery !== "object" || !Object.keys(delivery).length) {
      return "";
    }
    return encryptSetting(JSON.stringify(delivery));
  }

  decryptDigitalServiceDelivery(order = {}) {
    if (!order.deliveryEncrypted) {
      return null;
    }
    try {
      return JSON.parse(decryptSetting(order.deliveryEncrypted));
    } catch {
      return null;
    }
  }

  sanitizeDigitalServiceOrder(order = {}, { admin = false } = {}) {
    const response = {
      id: order.id,
      userId: order.userId,
      requestId: order.requestId,
      provider: order.provider || "akunding",
      productId: order.productId,
      productName: order.productName,
      category: order.category,
      imageUrl: order.imageUrl || DEFAULT_DIGITAL_SERVICE_FALLBACK_IMAGE,
      quantity: order.quantity,
      currency: "NGN",
      amountCharged: order.amountCharged,
      status: order.status,
      supplierStatus: order.supplierStatus || "",
      supplierOrderId: admin ? order.supplierOrderId || "" : "",
      failureReason: order.failureReason || "",
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      completedAt: order.completedAt || null,
      refundedAt: order.refundedAt || null,
      user: admin ? this.enrichUserRecord(order).user : undefined,
      delivery: ["delivered", "refunded"].includes(order.status) || admin ? this.decryptDigitalServiceDelivery(order) : null,
    };
    if (admin) {
      response.providerCost = order.providerCost;
      response.providerCostNgn = order.providerCostNgn;
      response.markupAmount = order.markupAmount;
      response.balanceReserved = !!order.balanceReserved;
    }
    return response;
  }

  listDigitalServiceOrders(user, { limit = 100, offset = 0, status = "" } = {}) {
    this.ensureState();
    const normalizedStatus = String(status || "").trim().toLowerCase();
    return this.db.digitalServiceOrders
      .filter((order) => (user.role === "admin" || order.userId === user.id) && (!normalizedStatus || order.status === normalizedStatus))
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(offset, offset + limit)
      .map((order) => this.sanitizeDigitalServiceOrder(order, { admin: user.role === "admin" }));
  }

  getDigitalServiceOrderRecord(user, orderId) {
    this.ensureState();
    const id = String(orderId || "").trim();
    const order = this.db.digitalServiceOrders.find((item) => item.id === id || item.requestId === id || item.supplierOrderId === id);
    if (!order || (user.role !== "admin" && order.userId !== user.id)) {
      throw new Error("Digital service order not found.");
    }
    return order;
  }

  getDigitalServiceOrder(user, orderId) {
    const order = this.getDigitalServiceOrderRecord(user, orderId);
    return this.sanitizeDigitalServiceOrder(order, { admin: user.role === "admin" });
  }

  updateDigitalServiceLedgerStatus(requestId, status, balanceAfter = null) {
    const ledger = this.db.transactions.find((item) => DIGITAL_SERVICE_LEDGER_TYPES.includes(item.type) && item.reference === requestId);
    if (ledger) {
      ledger.status = status;
      if (balanceAfter !== null) {
        ledger.balanceAfter = balanceAfter;
      }
    }
  }

  createDigitalServiceOrder(user, input = {}, requestMeta = {}) {
    this.ensureState();
    if (!user || user.role !== "user") {
      throw new Error("User not found.");
    }
    const product = input.product || this.getDigitalServiceProduct(input.productId);
    if (!product.available) {
      throw new Error("This digital service is not available now.");
    }
    const quantity = Math.max(1, Math.min(Math.floor(Number(input.quantity || 1)), 1000));
    const unitPrice = normalizeAmount(product.sellingPrice || product.price, "Digital service price");
    const amountCharged = multiplyRatio(unitPrice, String(quantity), "1");
    const providerCostNgn = multiplyRatio(product.providerCostNgn || "0", String(quantity), "1");
    const markupAmount = compare(amountCharged, providerCostNgn) > 0 ? subtract(amountCharged, providerCostNgn) : "0";
    const wallet = this.ensureWallet(user.id, "NGN");
    if (compare(wallet.availableBalance, amountCharged) < 0) {
      const error = new Error("Insufficient NGN balance.");
      error.code = "INSUFFICIENT_BALANCE";
      throw error;
    }
    const requestId = this.createDigitalServiceRequestId();
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = subtract(wallet.availableBalance, amountCharged);
    wallet.lockedBalance = add(wallet.lockedBalance, amountCharged);
    wallet.updatedAt = this.clock();
    const order = {
      id: this.idGenerator(12),
      userId: user.id,
      requestId,
      provider: "akunding",
      productId: product.id,
      supplierProductId: product.supplierProductId || product.id,
      productName: product.name,
      category: product.category,
      imageUrl: product.imageUrl,
      quantity,
      currency: "NGN",
      unitPrice,
      amountCharged,
      providerCost: product.providerCost || product.providerCostNgn || "0",
      providerCostNgn,
      markupAmount,
      status: "payment_reserved",
      supplierStatus: "queued",
      supplierOrderId: "",
      supplierResponse: null,
      deliveryEncrypted: "",
      failureReason: "",
      walletReservedAmount: amountCharged,
      balanceReserved: true,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      completedAt: null,
      refundedAt: null,
    };
    this.db.digitalServiceOrders.unshift(order);
    this.db.transactions.unshift({
      id: this.idGenerator(12),
      userId: user.id,
      type: "DIGITAL_SERVICE",
      currency: "NGN",
      amount: `-${amountCharged}`,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: requestId,
      status: "PROCESSING",
      description: `Digital service ${order.productName}`,
      createdBy: user.id,
      createdAt: this.clock(),
      metadata: {
        productId: order.productId,
        quantity,
        displayAmounts: this.getDisplayAmounts(amountCharged, "NGN"),
      },
    });
    this.createNotification({
      userId: user.id,
      type: "DIGITAL_SERVICE",
      title: "Digital service order",
      message: "Your order is processing.",
      entityType: "DIGITAL_SERVICE",
      entityId: order.id,
      route: "/?tab=store",
    });
    this.audit(user, "DIGITAL_SERVICE_ORDER_CREATED", "DigitalServiceOrder", order.id, {
      productId: order.productId,
      quantity,
      amountCharged,
      requestId,
    }, requestMeta);
    this.persist();
    return this.sanitizeDigitalServiceOrder(order, { admin: false });
  }

  applyDigitalServiceOrderResult(orderId, payload = {}, actor = { id: "digital-services", role: "system" }, requestMeta = {}) {
    this.ensureState();
    const order = this.db.digitalServiceOrders.find((item) => item.id === orderId || item.requestId === orderId || item.supplierOrderId === orderId);
    if (!order) {
      throw new Error("Digital service order not found.");
    }
    if (DIGITAL_SERVICE_FINAL_STATUSES.includes(order.status) && !order.balanceReserved) {
      return this.sanitizeDigitalServiceOrder(order, { admin: actor?.role === "admin" });
    }
    const nextStatus = String(payload.status || "processing").trim().toLowerCase();
    const supplierStatus = String(payload.supplierStatus || payload.status || order.supplierStatus || "processing").trim();
    order.supplierStatus = supplierStatus;
    order.supplierOrderId = String(payload.supplierOrderId || order.supplierOrderId || "").trim();
    order.supplierResponse = payload.providerResponse ? clone(payload.providerResponse) : order.supplierResponse;
    order.updatedAt = this.clock();
    if (payload.delivery) {
      order.deliveryEncrypted = this.encryptDigitalServiceDelivery(payload.delivery);
    }
    const wallet = this.ensureWallet(order.userId, "NGN");
    if (nextStatus === "delivered") {
      if (order.balanceReserved) {
        wallet.lockedBalance = subtract(wallet.lockedBalance, order.walletReservedAmount);
        wallet.updatedAt = this.clock();
        order.balanceReserved = false;
      }
      order.status = "delivered";
      order.completedAt = order.completedAt || this.clock();
      this.updateDigitalServiceLedgerStatus(order.requestId, "SUCCESSFUL", wallet.availableBalance);
      this.createNotification({
        userId: order.userId,
        type: "DIGITAL_SERVICE",
        title: "Order delivered",
        message: `${order.productName} is ready.`,
        entityType: "DIGITAL_SERVICE",
        entityId: order.id,
        route: "/?tab=store",
      });
      const user = this.db.users.find((item) => item.id === order.userId);
      this.notifyAdmins({
        type: "DIGITAL_SERVICE",
        title: "Store order completed",
        message: `${user?.name || user?.email || "A user"} completed ${order.productName}.`,
        entityType: "DIGITAL_SERVICE",
        entityId: order.id,
        route: "/?tab=store",
        dedupeKey: `digital-service-admin-completed:${order.id}`,
        metadata: {
          category: "transactions",
          orderId: order.id,
          requestId: order.requestId,
          userId: order.userId,
        },
      });
    } else if (nextStatus === "failed" || nextStatus === "refunded") {
      if (order.balanceReserved) {
        const balanceBefore = wallet.availableBalance;
        wallet.availableBalance = add(wallet.availableBalance, order.walletReservedAmount);
        wallet.lockedBalance = subtract(wallet.lockedBalance, order.walletReservedAmount);
        wallet.updatedAt = this.clock();
        this.db.transactions.unshift({
          id: this.idGenerator(12),
          userId: order.userId,
          type: "DIGITAL_SERVICE_REFUND",
          currency: "NGN",
          amount: order.walletReservedAmount,
          balanceBefore,
          balanceAfter: wallet.availableBalance,
          reference: order.requestId,
          status: "SUCCESSFUL",
          description: "Digital service refund",
          createdBy: actor?.id || "digital-services",
          createdAt: this.clock(),
          metadata: {
            digitalServiceOrderId: order.id,
            productId: order.productId,
            displayAmounts: this.getDisplayAmounts(order.walletReservedAmount, "NGN"),
          },
        });
        order.balanceReserved = false;
      }
      order.status = nextStatus === "refunded" ? "refunded" : "failed";
      order.refundedAt = order.refundedAt || this.clock();
      order.completedAt = order.completedAt || this.clock();
      order.failureReason = String(payload.message || order.failureReason || "").trim();
      this.updateDigitalServiceLedgerStatus(order.requestId, order.status === "refunded" ? "REFUNDED" : "FAILED", wallet.availableBalance);
      this.createNotification({
        userId: order.userId,
        type: "DIGITAL_SERVICE",
        title: order.status === "refunded" ? "Order refunded" : "Order failed",
        message: "Your NGN wallet has been updated.",
        entityType: "DIGITAL_SERVICE",
        entityId: order.id,
        route: "/?tab=store",
      });
    } else {
      order.status = DIGITAL_SERVICE_ACTIVE_STATUSES.includes(nextStatus) ? nextStatus : "processing";
      this.updateDigitalServiceLedgerStatus(order.requestId, "PROCESSING");
    }
    this.audit(actor, "DIGITAL_SERVICE_PROVIDER_RESULT_APPLIED", "DigitalServiceOrder", order.id, {
      requestId: order.requestId,
      status: order.status,
      supplierStatus: order.supplierStatus,
      supplierOrderId: order.supplierOrderId,
    }, requestMeta);
    this.persist();
    return this.sanitizeDigitalServiceOrder(order, { admin: actor?.role === "admin" });
  }

  getDigitalServiceAdminSummary() {
    this.ensureState();
    const today = this.clock().slice(0, 10);
    const summary = {
      settings: this.sanitizeDigitalServiceSettings(this.db.systemSettings.digitalServices, { admin: true }),
      productCount: this.db.digitalServiceProducts.length,
      ordersToday: 0,
      successCount: 0,
      pendingCount: 0,
      failedCount: 0,
      revenue: "0",
      cost: "0",
      profit: "0",
    };
    for (const order of this.db.digitalServiceOrders) {
      if (String(order.createdAt || "").startsWith(today)) {
        summary.ordersToday += 1;
      }
      if (order.status === "delivered") {
        summary.successCount += 1;
        summary.revenue = add(summary.revenue, order.amountCharged || "0");
        summary.cost = add(summary.cost, order.providerCostNgn || "0");
        summary.profit = add(summary.profit, order.markupAmount || "0");
      } else if (DIGITAL_SERVICE_ACTIVE_STATUSES.includes(order.status)) {
        summary.pendingCount += 1;
      } else {
        summary.failedCount += 1;
      }
    }
    return summary;
  }

  findIdempotent(scope, userId, key) {
    if (!key) {
      return null;
    }
    const record = this.db.idempotencyKeys.find((item) => item.scope === scope && item.userId === userId && item.key === key);
    return record ? clone(record.response) : null;
  }

  saveIdempotent(scope, userId, key, response) {
    if (!key) {
      return;
    }
    this.db.idempotencyKeys.push({
      scope,
      userId,
      key,
      response: clone(response),
      createdAt: this.clock(),
    });
  }
}

module.exports = {
  DEPOSIT_STATUSES,
  FinancialService,
  SUPPORTED_CURRENCIES,
  WITHDRAWAL_STATUSES,
};
