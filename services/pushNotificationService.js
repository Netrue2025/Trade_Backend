const webpush = require("web-push");

const { getEnvValue } = require("../lib/env");
const { randomId } = require("../lib/security");

const DEFAULT_PREFERENCES = {
  transactions: true,
  messages: true,
  quest: true,
  lowBalance: true,
  vtuPurchases: true,
  tradingSignals: true,
  appUpdates: true,
};

const CATEGORY_BY_TYPE = {
  DEPOSIT: "transactions",
  WITHDRAWAL: "transactions",
  BONUS: "transactions",
  TRANSFER: "transactions",
  BALANCE: "transactions",
  QUEST: "quest",
  VTU: "vtuPurchases",
  AIRTIME: "vtuPurchases",
  DATA: "vtuPurchases",
  SIGNAL: "tradingSignals",
  TRADE: "tradingSignals",
  LOW_BALANCE: "lowBalance",
  APP_UPDATE: "appUpdates",
  MESSAGE: "messages",
  INFO: "appUpdates",
};

const ALLOWED_ROUTE_PREFIXES = [
  "/",
  "/?tab=home",
  "/?tab=wallet",
  "/?tab=history",
  "/?tab=signals",
  "/?tab=quest",
  "/?tab=settings",
  "/?tab=services",
  "/?tab=admin",
  "/?tab=adminQuests",
];

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function sanitizeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeRoute(route = "") {
  const raw = String(route || "/?tab=home").trim();
  let path = "/";
  try {
    const parsed = raw.startsWith("http") ? new URL(raw) : new URL(raw, "https://netruefi.org");
    path = `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    path = "/?tab=home";
  }
  return ALLOWED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}&`))
    ? path
    : "/?tab=home";
}

function inferRoute(notification = {}) {
  const route = notification.route || notification.metadata?.route || "";
  if (route) {
    return normalizeRoute(route);
  }
  const type = String(notification.type || "").toUpperCase();
  const entityType = String(notification.entityType || "").toUpperCase();
  if (type === "QUEST" || entityType.includes("QUEST")) {
    return "/?tab=quest";
  }
  if (type === "SIGNAL" || type === "TRADE") {
    return "/?tab=signals";
  }
  if (type === "VTU") {
    return "/?tab=services";
  }
  if (type === "MESSAGE" || entityType === "CHATMESSAGE") {
    return "/?tab=home";
  }
  if (["DEPOSIT", "WITHDRAWAL", "TRANSFER", "BONUS", "BALANCE"].includes(type)) {
    return "/?tab=history";
  }
  return "/?tab=home";
}

function inferCategory(notification = {}) {
  const explicit = String(notification.category || notification.metadata?.category || "").trim();
  if (DEFAULT_PREFERENCES[explicit] !== undefined) {
    return explicit;
  }
  return CATEGORY_BY_TYPE[String(notification.type || "").toUpperCase()] || "appUpdates";
}

class PushNotificationService {
  constructor({ db, persist = () => undefined, logger = console } = {}) {
    this.db = db;
    this.persist = persist;
    this.logger = logger;
    this.publicKey = String(getEnvValue("VAPID_PUBLIC_KEY") || "").trim();
    this.privateKey = String(getEnvValue("VAPID_PRIVATE_KEY") || "").trim();
    this.subject = String(getEnvValue("VAPID_SUBJECT") || "mailto:support@netruefi.org").trim();
    this.configured = !!(this.publicKey && this.privateKey && this.subject);
    if (this.configured) {
      webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
    }
  }

  ensureState() {
    this.db.pushSubscriptions = Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : [];
    this.db.pushNotificationEvents = Array.isArray(this.db.pushNotificationEvents) ? this.db.pushNotificationEvents : [];
    for (const user of this.db.users || []) {
      if (user.role !== "user" && user.role !== "admin") {
        continue;
      }
      user.notificationPreferences = {
        ...DEFAULT_PREFERENCES,
        ...(user.notificationPreferences || {}),
      };
    }
  }

  getPublicConfig() {
    return {
      enabled: this.configured,
      publicKey: this.configured ? this.publicKey : "",
      subject: this.configured ? this.subject : "",
      preferences: clone(DEFAULT_PREFERENCES),
    };
  }

  getPreferences(user) {
    this.ensureState();
    user.notificationPreferences = {
      ...DEFAULT_PREFERENCES,
      ...(user.notificationPreferences || {}),
    };
    return clone(user.notificationPreferences);
  }

  updatePreferences(user, input = {}) {
    this.ensureState();
    const current = this.getPreferences(user);
    const next = { ...current };
    for (const key of Object.keys(DEFAULT_PREFERENCES)) {
      if (input[key] !== undefined) {
        next[key] = normalizeBoolean(input[key], current[key]);
      }
    }
    user.notificationPreferences = next;
    this.persist();
    return clone(next);
  }

  subscribeUser(user, input = {}, requestMeta = {}) {
    this.ensureState();
    if (!this.configured) {
      throw new Error("Web push is not configured.");
    }
    const endpoint = String(input.endpoint || input.subscription?.endpoint || "").trim();
    const keys = input.keys || input.subscription?.keys || {};
    if (!endpoint || !keys.p256dh || !keys.auth) {
      throw new Error("Invalid push subscription.");
    }

    const existing = this.db.pushSubscriptions.find((item) => item.endpoint === endpoint);
    const subscription = existing || {
      id: randomId(12),
      endpoint,
      createdAt: nowIso(),
    };
    subscription.userId = user.id;
    subscription.keys = {
      p256dh: String(keys.p256dh || ""),
      auth: String(keys.auth || ""),
    };
    subscription.platform = sanitizeText(input.platform || requestMeta.platform || "");
    subscription.browser = sanitizeText(input.browser || requestMeta.browser || "");
    subscription.enabled = true;
    subscription.updatedAt = nowIso();
    subscription.lastUsedAt = subscription.lastUsedAt || null;
    subscription.userAgent = sanitizeText(requestMeta.userAgent || "");

    if (!existing) {
      this.db.pushSubscriptions.push(subscription);
    }
    this.persist();
    return this.sanitizeSubscription(subscription);
  }

  unsubscribeUser(user, endpoint = "") {
    this.ensureState();
    const normalizedEndpoint = String(endpoint || "").trim();
    let changed = false;
    for (const subscription of this.db.pushSubscriptions) {
      if (subscription.userId === user.id && (!normalizedEndpoint || subscription.endpoint === normalizedEndpoint)) {
        subscription.enabled = false;
        subscription.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return { ok: true };
  }

  sanitizeSubscription(subscription) {
    return {
      id: subscription.id,
      platform: subscription.platform || "",
      browser: subscription.browser || "",
      enabled: !!subscription.enabled,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      lastUsedAt: subscription.lastUsedAt || null,
    };
  }

  listUserSubscriptions(user) {
    this.ensureState();
    return this.db.pushSubscriptions
      .filter((item) => item.userId === user.id && item.enabled !== false)
      .map((item) => this.sanitizeSubscription(item));
  }

  hasSentEvent(dedupeKey) {
    if (!dedupeKey) {
      return false;
    }
    return this.db.pushNotificationEvents.some((item) => item.dedupeKey === dedupeKey);
  }

  recordEvent(dedupeKey, details = {}) {
    if (!dedupeKey || this.hasSentEvent(dedupeKey)) {
      return;
    }
    this.db.pushNotificationEvents.unshift({
      id: randomId(12),
      dedupeKey,
      ...details,
      createdAt: nowIso(),
    });
    this.db.pushNotificationEvents = this.db.pushNotificationEvents.slice(0, 5000);
    this.persist();
  }

  async sendToUser(userId, payload = {}, { category = "appUpdates", dedupeKey = "" } = {}) {
    this.ensureState();
    if (!this.configured || !userId) {
      return { sent: 0, skipped: true };
    }
    if (dedupeKey && this.hasSentEvent(dedupeKey)) {
      return { sent: 0, skipped: true, duplicate: true };
    }

    const user = this.db.users.find((item) => item.id === userId);
    const preferences = user ? this.getPreferences(user) : DEFAULT_PREFERENCES;
    if (preferences[category] === false) {
      return { sent: 0, skipped: true, preference: category };
    }

    const subscriptions = this.db.pushSubscriptions.filter((item) => item.userId === userId && item.enabled !== false);
    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
          },
          JSON.stringify(payload)
        );
        subscription.lastUsedAt = nowIso();
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error.statusCode === 404 || error.statusCode === 410) {
          subscription.enabled = false;
          subscription.updatedAt = nowIso();
        } else {
          this.logger.warn("Web push delivery failed:", error.message || error);
        }
      }
    }

    this.recordEvent(dedupeKey, { userId, category, sent, failed });
    return { sent, failed };
  }

  async sendForNotification(notification = {}) {
    const category = inferCategory(notification);
    const route = inferRoute(notification);
    const explicitDedupeKey = String(notification.dedupeKey || notification.metadata?.dedupeKey || "").trim();
    const dedupeKey = explicitDedupeKey || `notification:${notification.id || randomId(12)}`;
    const payload = {
      title: sanitizeText(notification.title || "NetrueFi"),
      body: sanitizeText(notification.message || "You have a new NetrueFi update."),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: dedupeKey || notification.id || undefined,
      data: {
        type: sanitizeText(notification.type || "INFO"),
        route,
        entityType: sanitizeText(notification.entityType || ""),
        entityId: sanitizeText(notification.entityId || ""),
      },
    };

    return this.sendToUser(notification.userId, payload, { category, dedupeKey });
  }
}

module.exports = {
  DEFAULT_PREFERENCES,
  PushNotificationService,
};
