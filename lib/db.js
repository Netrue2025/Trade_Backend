const fs = require("node:fs");
const path = require("node:path");

const { MongoClient } = require("mongodb");

const { assertValidMongoConnectionString, getEnvValue, getMongoDbNameFromUri } = require("./env");
const { hashPassword, randomId } = require("./security");
const { normalizeExchange } = require("./exchanges");
const { createSignalConfig, SUPPORTED_TIMEFRAMES } = require("../src/config/signalConfig");

const dataDir = path.join(__dirname, "..", "data");
const dataFile = path.join(dataDir, "app-db.json");
const appStateId = "trade-mvp-state";
const defaultSignalConfig = createSignalConfig();
const mongoUriEnvKeys = ["MONGODB_URI", "MONGO_URI", "MONGO_URL", "DATABASE_URL"];

let mongoClientPromise = null;
let mongoCollectionPromise = null;
let selectedMongoUri = "";
let selectedMongoEnvKey = "";
let saveQueue = Promise.resolve();

function getAppStateFields() {
  return Object.keys(defaultDb());
}

function getMongoClientOptions() {
  return {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 30000,
    maxPoolSize: 10,
  };
}

function defaultDb() {
  return {
    meta: {
      version: 1,
      createdAt: new Date().toISOString(),
    },
    users: [],
    sessions: [],
    tradeIntents: [],
    tradeInvestments: [],
    signals: [],
    strategyLogs: [],
    wallets: [],
    transactions: [],
    deposits: [],
    withdrawals: [],
    vtuTransactions: [],
    referrals: [],
    giftCards: [],
    quests: [],
    questSessions: [],
    userQuestProgress: [],
    webhookEvents: [],
    pushSubscriptions: [],
    pushNotificationEvents: [],
    dailyPerformances: [],
    auditLogs: [],
    idempotencyKeys: [],
    systemSettings: null,
  };
}

function cloneDb(db) {
  return JSON.parse(JSON.stringify(db));
}

function toBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function getAppStateReadTimeoutMs() {
  const configured = getEnvValue("MONGODB_APP_STATE_READ_TIMEOUT_MS");
  return configured ? toBoundedNumber(configured, 8000, 1000, 60000) : 8000;
}

function getAppStateProjectionConcurrency() {
  const configured = getEnvValue("MONGODB_APP_STATE_PROJECTION_CONCURRENCY");
  return Math.round(configured ? toBoundedNumber(configured, 4, 1, 8) : 4);
}

function shouldUseFullAppStateOperations() {
  return ["1", "true", "yes", "full"].includes(
    String(getEnvValue("MONGODB_APP_STATE_FULL_OPERATIONS") || "").trim().toLowerCase()
  );
}

function withTimeout(promise, label, timeoutMs) {
  let timer = null;
  const guardedPromise = Promise.resolve(promise);
  return Promise.race([
    guardedPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

async function mapWithConcurrency(items, limit, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iterator(items[currentIndex], currentIndex);
    }
  }));
  return results;
}

function normalizeDb(raw = {}) {
  const base = {
    ...defaultDb(),
    ...cloneDb(raw || {}),
  };
  const defaultAutoTrade = defaultSignalConfig.autoTrade || {};
  const rawAutoTrade = base.meta?.signalAutoTrade && typeof base.meta.signalAutoTrade === "object"
    ? base.meta.signalAutoTrade
    : {};

  base.meta = {
    version: Number(base.meta?.version || 1),
    createdAt: base.meta?.createdAt || new Date().toISOString(),
    signalTimeframe: SUPPORTED_TIMEFRAMES.includes(String(base.meta?.signalTimeframe || "").trim())
      ? String(base.meta.signalTimeframe).trim()
      : defaultSignalConfig.defaultTimeframe,
    signalAutoTrade: {
      enabled: !!(
        rawAutoTrade.enabled !== undefined
          ? rawAutoTrade.enabled
          : defaultAutoTrade.enabled
      ),
      firstTradeBalancePercent: toBoundedNumber(
        rawAutoTrade.firstTradeBalancePercent,
        Number(defaultAutoTrade.firstTradeBalancePercent || 50),
        1,
        100
      ),
      secondTradeBalancePercent: toBoundedNumber(
        rawAutoTrade.secondTradeBalancePercent,
        Number(defaultAutoTrade.secondTradeBalancePercent || 100),
        1,
        100
      ),
      maxSimultaneousTrades: Math.round(
        toBoundedNumber(
          rawAutoTrade.maxSimultaneousTrades,
          Number(defaultAutoTrade.maxSimultaneousTrades || 2),
          1,
          10
        )
      ),
    },
    updatedAt: new Date().toISOString(),
  };
  base.users = (base.users || []).map((user) => ({
    ...user,
    preferredExchange: normalizeExchange(user.preferredExchange, "bybit"),
    mirrorEnabled: user.role === "user" ? user.mirrorEnabled !== false : !!user.mirrorEnabled,
    bybit: user.bybit === undefined ? null : user.bybit,
    binance: user.binance === undefined ? null : user.binance,
  }));
  base.sessions = Array.isArray(base.sessions) ? base.sessions : [];
  base.tradeIntents = Array.isArray(base.tradeIntents) ? base.tradeIntents : [];
  base.tradeInvestments = Array.isArray(base.tradeInvestments) ? base.tradeInvestments : [];
  base.wallets = Array.isArray(base.wallets) ? base.wallets : [];
  base.transactions = Array.isArray(base.transactions) ? base.transactions : [];
  base.deposits = Array.isArray(base.deposits) ? base.deposits : [];
  base.withdrawals = Array.isArray(base.withdrawals) ? base.withdrawals : [];
  base.vtuTransactions = Array.isArray(base.vtuTransactions) ? base.vtuTransactions : [];
  base.referrals = Array.isArray(base.referrals) ? base.referrals : [];
  base.giftCards = Array.isArray(base.giftCards) ? base.giftCards : [];
  base.quests = Array.isArray(base.quests) ? base.quests : [];
  base.questSessions = Array.isArray(base.questSessions) ? base.questSessions : [];
  base.userQuestProgress = Array.isArray(base.userQuestProgress) ? base.userQuestProgress : [];
  base.webhookEvents = Array.isArray(base.webhookEvents) ? base.webhookEvents : [];
  base.pushSubscriptions = Array.isArray(base.pushSubscriptions) ? base.pushSubscriptions : [];
  base.pushNotificationEvents = Array.isArray(base.pushNotificationEvents) ? base.pushNotificationEvents : [];
  base.dailyPerformances = Array.isArray(base.dailyPerformances) ? base.dailyPerformances : [];
  base.auditLogs = Array.isArray(base.auditLogs) ? base.auditLogs : [];
  base.idempotencyKeys = Array.isArray(base.idempotencyKeys) ? base.idempotencyKeys : [];
  base.systemSettings = base.systemSettings && typeof base.systemSettings === "object" && !Array.isArray(base.systemSettings)
    ? base.systemSettings
    : null;
  base.signals = Array.isArray(base.signals)
    ? base.signals
        .map((signal) => ({
          id: String(signal?.id || "").trim(),
          pair: String(signal?.pair || "").trim().toUpperCase(),
          strategyType: String(signal?.strategyType || "").trim().toUpperCase(),
          entryPrice: Number(signal?.entryPrice || 0),
          stopLoss: Number(signal?.stopLoss || 0),
          takeProfit: Number(signal?.takeProfit || 0),
          timestamp: Number(signal?.timestamp || 0),
          confidence: signal?.confidence ?? null,
          supportLevel: Number(signal?.supportLevel || 0) || null,
          resistanceLevel: Number(signal?.resistanceLevel || 0) || null,
          meta: signal?.meta && typeof signal.meta === "object" && !Array.isArray(signal.meta)
            ? cloneDb(signal.meta)
            : {},
          status: ["active", "deleted", "expired"].includes(String(signal?.status || "").trim().toLowerCase())
            ? String(signal.status).trim().toLowerCase()
            : "active",
        }))
        .filter((signal) => signal.id && signal.pair && signal.strategyType && signal.timestamp > 0)
    : [];
  base.strategyLogs = Array.isArray(base.strategyLogs) ? base.strategyLogs : [];
  return base;
}

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(defaultDb(), null, 2));
  }
}

function loadFileDb() {
  ensureStore();
  return normalizeDb(JSON.parse(fs.readFileSync(dataFile, "utf8")));
}

function saveFileDb(db) {
  ensureStore();
  const snapshot = normalizeDb(db);
  fs.writeFileSync(dataFile, JSON.stringify(snapshot, null, 2));
}

function shouldUseMongo() {
  return getMongoUriCandidates().length > 0;
}

function getMongoUri() {
  if (selectedMongoUri) {
    return selectedMongoUri;
  }
  return getMongoUriCandidates()[0]?.value || "";
}

function getMongoUriCandidates() {
  const seen = new Set();
  const candidates = [];
  for (const key of mongoUriEnvKeys) {
    if (process.env[key] === undefined) {
      continue;
    }
    const value = assertValidMongoConnectionString(process.env[key], key);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    candidates.push({ key, value });
  }
  return candidates;
}

function getMongoDbName() {
  return getEnvValue("MONGODB_DB_NAME", "MONGO_DB_NAME", "DATABASE_NAME");
}

function getMongoCollectionName() {
  return getEnvValue("MONGODB_COLLECTION") || "app_state";
}

async function getMongoClient() {
  if (mongoClientPromise) {
    return mongoClientPromise;
  }

  const candidates = getMongoUriCandidates();
  if (!candidates.length) {
    return null;
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      mongoClientPromise = MongoClient.connect(candidate.value, getMongoClientOptions());
      const client = await mongoClientPromise;
      selectedMongoUri = candidate.value;
      selectedMongoEnvKey = candidate.key;
      return client;
    } catch (error) {
      lastError = { key: candidate.key, error };
      mongoClientPromise = null;
      mongoCollectionPromise = null;
    }
  }

  const configuredKeys = candidates.map((candidate) => candidate.key).join(", ");
  const lastMessage = lastError?.error?.message || "Unknown MongoDB connection error.";
  throw new Error(`Unable to connect to MongoDB using configured env keys (${configuredKeys}). Last error from ${lastError?.key || "MongoDB"}: ${lastMessage}`);
}

async function getMongoCollection() {
  if (!shouldUseMongo()) {
    return null;
  }

  if (!mongoCollectionPromise) {
    mongoCollectionPromise = (async () => {
      const client = await getMongoClient();
      const mongoUri = getMongoUri();
      const mongoDbName = getMongoDbName();
      const mongoCollectionName = getMongoCollectionName();
      const dbName = mongoDbName || getMongoDbNameFromUri(mongoUri, "trade_mvp");
      return client.db(dbName).collection(mongoCollectionName);
    })().catch((error) => {
      mongoCollectionPromise = null;
      throw error;
    });
  }

  return mongoCollectionPromise;
}

async function getMongoDb() {
  if (!shouldUseMongo()) {
    return null;
  }

  const client = await getMongoClient();
  const mongoUri = getMongoUri();
  const mongoDbName = getMongoDbName();
  const dbName = mongoDbName || getMongoDbNameFromUri(mongoUri, "trade_mvp");
  return client.db(dbName);
}

async function getMongoCollectionByName(collectionName) {
  const db = await getMongoDb();
  if (!db) {
    return null;
  }

  return db.collection(String(collectionName || "").trim());
}

async function loadDb() {
  if (!shouldUseMongo()) {
    return loadFileDb();
  }

  const collection = await getMongoCollection();
  const snapshot = await loadMongoSnapshot(collection);
  if (!snapshot) {
    let initial = normalizeDb(defaultDb());
    if (fs.existsSync(dataFile)) {
      initial = loadFileDb();
    }
    await collection.insertOne({
      _id: appStateId,
      ...initial,
    });
    return initial;
  }

  const { _id, ...rest } = snapshot;
  return normalizeDb(rest);
}

async function loadMongoSnapshot(collection) {
  if (!shouldUseFullAppStateOperations()) {
    return loadMongoSnapshotByFields(collection);
  }

  try {
    return await withTimeout(
      collection.findOne({ _id: appStateId }),
      "MongoDB app-state full snapshot read",
      getAppStateReadTimeoutMs()
    );
  } catch (error) {
    console.warn(`MongoDB app-state full snapshot read failed: ${error.message}. Retrying with projected field reads.`);
    return loadMongoSnapshotByFields(collection);
  }
}

async function loadMongoSnapshotByFields(collection) {
  const fields = getAppStateFields();
  const partials = await mapWithConcurrency(fields, getAppStateProjectionConcurrency(), async (field) => {
    const partial = await collection.findOne(
      { _id: appStateId },
      { projection: { [field]: 1 } }
    );
    if (!partial) {
      return null;
    }
    return {
      field,
      id: partial._id,
      hasField: Object.prototype.hasOwnProperty.call(partial, field),
      value: partial[field],
    };
  });

  if (partials.some((partial) => !partial)) {
    return null;
  }

  const snapshot = { _id: partials[0]?.id || appStateId };
  for (const partial of partials) {
    if (partial.hasField) {
      snapshot[partial.field] = partial.value;
    }
  }

  return snapshot;
}

async function saveMongoSnapshot(collection, snapshot) {
  if (shouldUseFullAppStateOperations()) {
    await collection.updateOne(
      { _id: appStateId },
      {
        $set: {
          ...snapshot,
        },
      },
      { upsert: true }
    );
    return;
  }

  await collection.updateOne(
    { _id: appStateId },
    { $setOnInsert: { _id: appStateId } },
    { upsert: true }
  );

  for (const field of getAppStateFields()) {
    await collection.updateOne(
      { _id: appStateId },
      {
        $set: {
          [field]: snapshot[field],
        },
      }
    );
  }
}

function saveDb(db) {
  if (!shouldUseMongo()) {
    saveFileDb(db);
    return Promise.resolve();
  }

  const snapshot = normalizeDb(db);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    const collection = await getMongoCollection();
    await saveMongoSnapshot(collection, snapshot);
  });

  return saveQueue;
}

function getActiveExchange(user) {
  const preferredExchange = normalizeExchange(user.preferredExchange, "bybit");
  if (user?.[preferredExchange]) {
    return preferredExchange;
  }
  if (user?.bybit) {
    return "bybit";
  }
  if (user?.binance) {
    return "binance";
  }
  return preferredExchange;
}

function sanitizeUser(user) {
  const preferredExchange = normalizeExchange(user.preferredExchange, "bybit");
  const activeExchange = getActiveExchange(user);

  function summarize(account) {
    return account
      ? {
          testnet: !!account.testnet,
          canTrade: !!account.permissions?.canTrade,
          lastValidatedAt: account.lastValidatedAt,
          connectedAt: account.connectedAt,
        }
      : null;
  }

  function summarizeSnapshot(snapshot, fallbackExchange = preferredExchange) {
    return snapshot
      ? {
          exchange: normalizeExchange(snapshot.exchange, fallbackExchange),
          totalUsdt: Number(snapshot.totalUsdt || 0),
          previousTotalUsdt: Number(snapshot.previousTotalUsdt || 0),
          totalNgn: Number(snapshot.totalNgn || 0),
          usdtNgnRate: Number(snapshot.usdtNgnRate || 0),
          estimatedPnlValue: Number(snapshot.estimatedPnlValue || 0),
          estimatedPnlPercent: Number(snapshot.estimatedPnlPercent || 0),
          todayPnlValue: Number(snapshot.todayPnlValue || 0),
          todayPnlPercent: Number(snapshot.todayPnlPercent || 0),
          todayCapitalBase: Number(snapshot.todayCapitalBase || 0),
          todayOpeningUsdt: Number(snapshot.todayOpeningUsdt || 0),
          todayClosingUsdt: Number(snapshot.todayClosingUsdt || 0),
          todayLabel: String(snapshot.todayLabel || ""),
          todayTimeZone: String(snapshot.todayTimeZone || ""),
          todayAssetPnl: Array.isArray(snapshot.todayAssetPnl) ? snapshot.todayAssetPnl : [],
          monthPnlValue: Number(snapshot.monthPnlValue || 0),
          monthPnlPercent: Number(snapshot.monthPnlPercent || 0),
          monthOpeningUsdt: Number(snapshot.monthOpeningUsdt || 0),
          monthLabel: String(snapshot.monthLabel || ""),
          cachedAt: snapshot.cachedAt || snapshot.updatedAt || null,
          stale: !!snapshot.stale,
        }
      : null;
  }

  const cachedAccountSnapshots = {
    bybit: summarizeSnapshot(user.bybit?.lastSnapshot, "bybit"),
    binance: summarizeSnapshot(user.binance?.lastSnapshot, "binance"),
  };

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    role: user.role,
    fraudReview: user.fraudReview || null,
    mirrorEnabled: !!user.mirrorEnabled,
    preferredExchange,
    activeExchange,
    referralCode: user.referralCode || "",
    referredByUserId: user.referredByUserId || "",
    exchangeConnected: !!user[activeExchange],
    exchangeSummary: summarize(user[activeExchange]),
    cachedAccountSnapshot: cachedAccountSnapshots[activeExchange],
    cachedAccountSnapshots,
    binanceConnected: !!user.binance,
    bybitConnected: !!user.bybit,
    bybitSummary: summarize(user.bybit),
    binanceSummary: summarize(user.binance),
    exchangeAccounts: {
      bybit: summarize(user.bybit),
      binance: summarize(user.binance),
    },
    createdAt: user.createdAt,
  };
}

function ensureAdminUser(db) {
  const adminEmail = (getEnvValue("ADMIN_EMAIL") || "admin@trade.local").toLowerCase().trim();
  const adminPassword = getEnvValue("ADMIN_PASSWORD") || "Admin123!";
  const existing = db.users.find((user) => user.role === "admin" && user.email === adminEmail);
  const { salt, hash } = hashPassword(adminPassword);

  if (!existing) {
    db.users.push({
      id: randomId(12),
      email: adminEmail,
      name: "Admin",
      role: "admin",
      mirrorEnabled: false,
      passwordSalt: salt,
      passwordHash: hash,
      preferredExchange: "bybit",
      binance: null,
      bybit: null,
      createdAt: new Date().toISOString(),
    });
    return;
  }

  if (!existing.preferredExchange) {
    existing.preferredExchange = "bybit";
  }
  if (existing.binance === undefined) {
    existing.binance = null;
  }
  if (existing.bybit === undefined) {
    existing.bybit = null;
  }
  existing.passwordSalt = salt;
  existing.passwordHash = hash;
}

module.exports = {
  dataFile,
  ensureAdminUser,
  getMongoCollectionByName,
  getMongoUri,
  loadDb,
  sanitizeUser,
  saveDb,
  shouldUseMongo,
};
