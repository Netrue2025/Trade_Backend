const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { getEnvValue, parseEnvFileValue } = require("./lib/env");

const workspaceRootDir = path.resolve(__dirname, "..");
const rootDir = fs.existsSync(path.join(workspaceRootDir, ".env")) && !fs.existsSync(path.join(__dirname, ".env"))
  ? workspaceRootDir
  : __dirname;
const frontendDir = fs.existsSync(path.join(workspaceRootDir, "frontend", "public", "index.html"))
  ? path.join(workspaceRootDir, "frontend", "public")
  : path.join(rootDir, "public");
const DEFAULT_FRONTEND_ORIGIN = "https://trade-frontend-jwu2.onrender.com";

function loadEnvFile() {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = parseEnvFileValue(line.slice(index + 1));
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const { loadDb, saveDb, ensureAdminUser, sanitizeUser, shouldUseMongo } = require("./lib/db");
const { encryptSecret, randomId, hashPassword, verifyPassword } = require("./lib/security");
const { getExchangeClient, listExchanges, normalizeExchange } = require("./lib/exchanges");
const { SubscriberModel } = require("./models/subscriberModel");
const { emitOrderExecuted, orderEvents } = require("./services/orderEvents");
const { FinancialService } = require("./services/financialService");
const { TelegramService } = require("./services/telegramService");
const { TradeLearningService } = require("./services/tradeLearning");
const { TradeListener } = require("./services/tradeListener");
const { createSignalConfig } = require("./src/config/signalConfig");
const { SIGNAL_EVENTS, signalBus } = require("./src/events/signalBus");
const { createLogger } = require("./src/utils/logger");
const { SignalModel } = require("./src/models/Signal");
const { MarketDataService } = require("./src/services/marketDataService");
const { SignalTelegramService } = require("./src/services/telegramService");
const { AutoTradeService } = require("./src/services/autoTradeService");
const { SocketSignalService } = require("./src/services/socketSignalService");
const { SignalEngine } = require("./src/services/signalEngine");
const { SignalController } = require("./src/controllers/signalController");
const {
  cancelFuturesOrder: cancelBinanceFuturesOrder,
  closeFuturesPosition: closeBinanceFuturesPosition,
  getFuturesAccount: getBinanceFuturesAccount,
} = require("./lib/binance");

const DEFAULT_PORT = 3000;
const MAX_PORT_RETRIES = 10;

function getConfiguredPort() {
  const rawPort = getEnvValue("PORT");
  const parsedPort = Number(rawPort || DEFAULT_PORT);

  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    return parsedPort;
  }

  console.warn(`Invalid PORT value "${rawPort}". Falling back to ${DEFAULT_PORT}.`);
  return DEFAULT_PORT;
}

const port = getConfiguredPort();
const BYBIT_USDT_NGN_URL = getEnvValue("BYBIT_USDT_NGN_URL") || "https://www.bybit.com/en/convert/usdt-to-ngn/";
const FIAT_RATE_CACHE_TTL_MS = 1000 * 60 * 15;
const MARKET_WATCHLIST_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "PEPEUSDT"];
const WATCHLIST_CACHE_TTL_MS = 1000 * 10;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const SESSION_TTL_SECONDS = Math.round(SESSION_TTL_MS / 1000);
const SIGNAL_STREAM_KEEPALIVE_MS = 20_000;
const SIGNAL_EXPIRY_SWEEP_MS = 60_000;
const ACCOUNT_SNAPSHOT_CACHE_TTL_MS = 1000 * 60;
const TRADE_RECONCILE_BACKGROUND_INTERVAL_MS = 15_000;
const SERVICE_RETRY_INTERVAL_MS = 60_000;
const SETTINGS_USERS_WS_REFRESH_MS = 20_000;
const SETTINGS_USERS_WS_PATH = "/ws/settings-users";
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const SIGNAL_AUTO_TRADE_DEFAULT_FIRST_BALANCE_PERCENT = 50;
const SIGNAL_AUTO_TRADE_DEFAULT_SECOND_BALANCE_PERCENT = 100;
const SIGNAL_AUTO_TRADE_DEFAULT_MAX_SIMULTANEOUS_TRADES = 2;
const SIGNAL_AUTO_TRADE_STRATEGY_TYPE = "SIGNAL_AUTO";
const SIGNAL_INGEST_SECRET = String(getEnvValue("SIGNAL_INGEST_SECRET") || "").trim();
const PERFORMANCE_TIME_ZONE = "Africa/Lagos";
const PERFORMANCE_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: PERFORMANCE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

let db = null;
let financialService = null;
const loginAttemptBuckets = new Map();
const tradeLearningService = new TradeLearningService();
const subscriberModel = new SubscriberModel();
const telegramTradeService = new TelegramService({
  subscriberModel,
});
const tradeListener = new TradeListener({
  telegramService: telegramTradeService,
  subscriberModel,
});
const signalConfig = createSignalConfig();
const signalLogger = createLogger("signals");
const signalModel = new SignalModel({
  collectionName: signalConfig.storage.signalCollection,
  logger: signalLogger,
});
const marketDataService = new MarketDataService({
  logger: signalLogger,
  primaryExchange: "bybit",
});
const signalTelegramService = new SignalTelegramService({
  config: signalConfig,
  logger: signalLogger,
  subscriberModel,
});
const autoTradeService = new AutoTradeService({
  eventBus: signalBus,
  logger: signalLogger,
  config: signalConfig.autoTrade,
});
const signalEngine = new SignalEngine({
  config: signalConfig,
  marketDataService,
  signalModel,
  eventBus: signalBus,
  telegramService: signalTelegramService,
  autoTradeService,
  logger: signalLogger,
});
const signalController = new SignalController({
  signalEngine,
  logger: signalLogger,
});
const socketSignalService = new SocketSignalService({
  eventBus: signalBus,
  logger: signalLogger,
});
orderEvents.on("orderExecuted", (orderEvent) => {
  signalBus.emit(SIGNAL_EVENTS.TRADE_EXECUTED, {
    execution: orderEvent,
    executedAt: new Date().toISOString(),
  });
  void tradeListener.handleOrderExecuted(orderEvent).catch((error) => {
    console.error("Order executed Telegram listener failed:", error.message || error);
  });
});
signalEngine.on("snapshot", () => {
  persistSignalState();
});

const fiatRateCache = {
  usdtNgnRate: null,
  updatedAt: 0,
};

const watchlistCache = new Map();
let signalEngineStartPromise = null;
let tradeListenerStartPromise = null;

function getSignalBotDiagnostics() {
  const token = String(signalConfig?.telegram?.token || "").trim();
  return {
    tokenLoaded: !!token,
    chatIdLoaded: !!signalConfig?.telegram?.chatId,
    tokenPreview: token ? `${token.slice(0, 6)}...${token.slice(-4)}` : "",
    queueDepth: signalTelegramService.queue.length,
  };
}

async function sendTelegramText(text) {
  if (!signalTelegramService.isEnabled() || !signalConfig?.telegram?.chatId) {
    throw new Error("Telegram signal bot is not configured.");
  }

  await signalTelegramService.sendWithRetry(signalConfig.telegram.chatId, String(text || "").trim() || "Signal bot test");
  return { ok: true };
}

function isAuthorizedSignalIngestRequest(req) {
  if (!SIGNAL_INGEST_SECRET) {
    return true;
  }

  const headerSecret = String(req.headers["x-signal-secret"] || "").trim();
  if (headerSecret && headerSecret === SIGNAL_INGEST_SECRET) {
    return true;
  }

  const authorizationHeader = String(req.headers.authorization || "").trim();
  if (authorizationHeader.toLowerCase().startsWith("bearer ")) {
    return authorizationHeader.slice(7).trim() === SIGNAL_INGEST_SECRET;
  }

  return false;
}

function persist() {
  if (!db) {
    return;
  }

  saveDb(db).catch((error) => {
    console.error("Failed to persist application state:", error.message);
  });
}

function persistSignalState() {
  if (!db) {
    return;
  }

  db.signals = signalEngine.getStoredSignals();
  db.meta = {
    ...(db.meta || {}),
    signalTimeframe: signalEngine.getTimeframe(),
    signalAutoTrade: autoTradeService.getConfig(),
  };
  persist();
}

function toBoundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeSignalAutoTradeConfig(config = {}) {
  const current = autoTradeService.getConfig();
  return {
    enabled: parseBooleanFlag(config.enabled, current.enabled),
    firstTradeBalancePercent: toBoundedNumber(
      config.firstTradeBalancePercent,
      Number(current.firstTradeBalancePercent || SIGNAL_AUTO_TRADE_DEFAULT_FIRST_BALANCE_PERCENT),
      1,
      100
    ),
    secondTradeBalancePercent: toBoundedNumber(
      config.secondTradeBalancePercent,
      Number(current.secondTradeBalancePercent || SIGNAL_AUTO_TRADE_DEFAULT_SECOND_BALANCE_PERCENT),
      1,
      100
    ),
    maxSimultaneousTrades: Math.round(
      toBoundedNumber(
        config.maxSimultaneousTrades,
        Number(current.maxSimultaneousTrades || SIGNAL_AUTO_TRADE_DEFAULT_MAX_SIMULTANEOUS_TRADES),
        1,
        10
      )
    ),
  };
}

function getSignalAutoTradeAdminUser() {
  return db?.users?.find((user) => user.role === "admin") || null;
}

function isSignalAutoTradeIntent(trade) {
  return String(trade?.strategyContext?.type || "").trim().toUpperCase() === SIGNAL_AUTO_TRADE_STRATEGY_TYPE;
}

function listActiveSignalAutoTrades({ exchange } = {}) {
  const targetExchange = exchange ? normalizeExchange(exchange, "bybit") : null;
  return (db?.tradeIntents || []).filter((trade) => {
    if (!isSignalAutoTradeIntent(trade)) {
      return false;
    }

    if (targetExchange && getTradeExchange(trade) !== targetExchange) {
      return false;
    }

    const lifecycle = deriveTradeLifecycle(trade);
    return lifecycle === "OPEN" || lifecycle === "PENDING";
  });
}

function getSignalAutoTradeSettingsSnapshot() {
  const settings = autoTradeService.getConfig();
  const admin = getSignalAutoTradeAdminUser();
  const exchange = admin ? getConnectedExchange(admin, getPreferredExchange(admin)) : "bybit";
  const activeTrades = listActiveSignalAutoTrades({ exchange });
  const remainingSlots = Math.max(0, Number(settings.maxSimultaneousTrades || 0) - activeTrades.length);
  return {
    settings,
    runtime: {
      exchange,
      activeTrades: activeTrades.length,
      remainingSlots,
      nextAllocationPercent: remainingSlots
        ? (activeTrades.length === 0 ? settings.firstTradeBalancePercent : settings.secondTradeBalancePercent)
        : 0,
    },
  };
}

async function sweepExpiredSignals() {
  const expiredSignals = await signalEngine.expireSignals();
  if (expiredSignals.length) {
    console.log(`Expired ${expiredSignals.length} signal${expiredSignals.length === 1 ? "" : "s"} after 24 hours.`);
  }
  return expiredSignals;
}

async function ensureSignalEngineRunning(force = false, options = {}) {
  if (signalEngine.started && !force) {
    return true;
  }

  if (signalEngineStartPromise) {
    return signalEngineStartPromise;
  }

  signalEngineStartPromise = signalEngine.start(options)
    .then(() => {
      console.log(`Signal receiver is ready on ${signalEngine.getTimeframe()}.`);
      return true;
    })
    .catch((error) => {
      console.error("Signal receiver startup failed:", error.message);
      return false;
    })
    .finally(() => {
      signalEngineStartPromise = null;
    });

  return signalEngineStartPromise;
}

async function ensureTradeListenerRunning(force = false) {
  if (tradeListener.started && !force && (!telegramTradeService?.isHealthy || telegramTradeService.isHealthy())) {
    return true;
  }

  if (tradeListenerStartPromise) {
    return tradeListenerStartPromise;
  }

  tradeListenerStartPromise = tradeListener.start()
    .then(() => {
      console.log("Telegram trade listener is running.");
      return true;
    })
    .catch((error) => {
      console.error("Telegram trade listener startup failed:", error.message);
      return false;
    })
    .finally(() => {
      tradeListenerStartPromise = null;
    });

  return tradeListenerStartPromise;
}

function getPreferredExchange(user) {
  return normalizeExchange(user?.preferredExchange, "bybit");
}

function getConnectedExchange(user, preferred = getPreferredExchange(user)) {
  if (user?.[preferred]) {
    return preferred;
  }
  if (user?.bybit) {
    return "bybit";
  }
  if (user?.binance) {
    return "binance";
  }
  return preferred;
}

function getUserExchange(user, preferred = getPreferredExchange(user)) {
  return user?.[getConnectedExchange(user, preferred)] || null;
}

function getExchangeAccount(user, exchange = getPreferredExchange(user)) {
  return user?.[normalizeExchange(exchange)] || null;
}

function getUserMarketExchange(user) {
  return getConnectedExchange(user, getPreferredExchange(user));
}

function getExchangeLabel(exchange) {
  return getExchangeClient(exchange).label;
}

function setUserPreferredExchange(user, exchange) {
  user.preferredExchange = normalizeExchange(exchange, "bybit");
}

function getWatchlistCacheKey(testnet, exchange) {
  return `${normalizeExchange(exchange, "bybit")}:${testnet ? "testnet" : "mainnet"}`;
}

function normalizeWatchlistItem(item) {
  return {
    symbol: String(item?.symbol || "").toUpperCase(),
    price: Number(item?.price || 0),
    changePercent: Number(item?.changePercent ?? item?.priceChangePercent ?? 0),
    volume24h: Number(item?.volume24h || 0),
    turnover24h: Number(item?.turnover24h || 0),
  };
}

function getTradeExchange(trade) {
  return normalizeExchange(trade?.exchange, "bybit");
}

function getAccountExchange(account, fallback = "bybit") {
  return normalizeExchange(account?.exchange, fallback);
}

async function getAccountInfo(account, exchange = getAccountExchange(account)) {
  return getExchangeClient(exchange).getAccountInfo(account);
}

async function cancelOrder(account, symbol, orderId, exchange = getAccountExchange(account)) {
  return getExchangeClient(exchange).cancelOrder(account, symbol, orderId);
}

async function getConnectivityStatus(exchange, testnet) {
  return getExchangeClient(exchange).getConnectivityStatus(testnet);
}

async function getExchangeInfo(symbol, testnet, exchange = "bybit") {
  return getExchangeClient(exchange).getExchangeInfo(symbol, testnet);
}

async function getOpenOrders(account, exchange = getAccountExchange(account)) {
  return getExchangeClient(exchange).getOpenOrders(account);
}

async function getOrder(account, symbol, orderId, exchange = getAccountExchange(account)) {
  return getExchangeClient(exchange).getOrder(account, symbol, orderId);
}

async function getTicker24hr(symbolsOrTestnet = false, maybeTestnet = false, exchange = "bybit") {
  return getExchangeClient(exchange).getTicker24hr(symbolsOrTestnet, maybeTestnet);
}

async function getTickerPrice(symbol, testnet, exchange = "bybit") {
  return getExchangeClient(exchange).getTickerPrice(symbol, testnet);
}

async function getTickerPrices(testnet, exchange = "bybit") {
  return getExchangeClient(exchange).getTickerPrices(testnet);
}

async function getCandles(symbol, interval, limit, testnet, exchange = "bybit") {
  return getExchangeClient(exchange).getCandles(symbol, interval, limit, testnet);
}

async function placeSpotOrder(account, orderInput, exchange = getAccountExchange(account)) {
  return getExchangeClient(exchange).placeSpotOrder(account, orderInput);
}

async function validateCredentials(apiKey, secretEncrypted, testnet, exchange = "bybit") {
  return getExchangeClient(exchange).validateCredentials(apiKey, secretEncrypted, testnet);
}

function nowIso() {
  return new Date().toISOString();
}

function cloneSerializable(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sanitizeStoredAccountSnapshot(snapshot, fallbackExchange = "bybit") {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const cloned = cloneSerializable(snapshot) || {};
  return {
    exchange: normalizeExchange(cloned.exchange, fallbackExchange),
    balances: Array.isArray(cloned.balances) ? cloned.balances : [],
    openOrders: Array.isArray(cloned.openOrders) ? cloned.openOrders : [],
    totalUsdt: Number(cloned.totalUsdt || 0),
    previousTotalUsdt: Number(cloned.previousTotalUsdt || 0),
    totalNgn: Number(cloned.totalNgn || 0),
    usdtNgnRate: Number(cloned.usdtNgnRate || 0),
    estimatedPnlValue: Number(cloned.estimatedPnlValue || 0),
    estimatedPnlPercent: Number(cloned.estimatedPnlPercent || 0),
    todayPnlValue: Number(cloned.todayPnlValue || 0),
    todayPnlPercent: Number(cloned.todayPnlPercent || 0),
    todayCapitalBase: Number(cloned.todayCapitalBase || 0),
    todayOpeningUsdt: Number(cloned.todayOpeningUsdt || 0),
    todayClosingUsdt: Number(cloned.todayClosingUsdt || 0),
    todayLabel: String(cloned.todayLabel || ""),
    todayTimeZone: String(cloned.todayTimeZone || ""),
    todayAssetPnl: Array.isArray(cloned.todayAssetPnl) ? cloned.todayAssetPnl : [],
    monthPnlValue: Number(cloned.monthPnlValue || 0),
    monthPnlPercent: Number(cloned.monthPnlPercent || 0),
    monthOpeningUsdt: Number(cloned.monthOpeningUsdt || 0),
    monthLabel: String(cloned.monthLabel || ""),
    permissions: cloned.permissions
      ? {
          canTrade: !!cloned.permissions.canTrade,
          canWithdraw: !!cloned.permissions.canWithdraw,
          canDeposit: !!cloned.permissions.canDeposit,
          readOnly: !!cloned.permissions.readOnly,
        }
      : undefined,
    updatedAt: cloned.updatedAt || null,
    cachedAt: cloned.cachedAt || cloned.updatedAt || null,
    stale: !!cloned.stale,
  };
}

function cacheAccountSnapshot(account, snapshot, exchange = getAccountExchange(account)) {
  const cachedSnapshot = sanitizeStoredAccountSnapshot(
    {
      ...snapshot,
      exchange,
      cachedAt: nowIso(),
    },
    exchange
  );
  if (cachedSnapshot) {
    account.lastSnapshot = cachedSnapshot;
  }
  return cachedSnapshot;
}

function getCachedAccountSnapshot(account, exchange = getAccountExchange(account)) {
  return sanitizeStoredAccountSnapshot(account?.lastSnapshot, exchange);
}

function isCachedAccountSnapshotFresh(snapshot, ttlMs = ACCOUNT_SNAPSHOT_CACHE_TTL_MS) {
  if (!snapshot?.cachedAt) {
    return false;
  }

  const cachedAt = Date.parse(snapshot.cachedAt);
  if (!Number.isFinite(cachedAt)) {
    return false;
  }

  return Date.now() - cachedAt < ttlMs;
}

function summarizeWalletDetailsFromSnapshot(snapshot, exchange, label, fallbackRate = 0) {
  if (!snapshot) {
    return null;
  }

  const balances = Array.isArray(snapshot.balances) ? snapshot.balances : [];
  const derivedRate = Number(snapshot.usdtNgnRate || fallbackRate || 0);
  const summary = summarizeWalletBalances(balances, derivedRate);
  return {
    exchange,
    label,
    connected: true,
    lastValidatedAt: snapshot.updatedAt || snapshot.cachedAt || null,
    error: null,
    stale: !!snapshot.stale,
    ...summary,
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, chunk) => {
    const [key, ...rest] = chunk.trim().split("=");
    if (!key) {
      return acc;
    }
    acc[key] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...buildSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { ...buildSecurityHeaders(), "Content-Type": contentType });
  res.end(payload);
}

function buildSecurityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return "";
  }

  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function getAllowedCorsOrigins() {
  const origins = [
    DEFAULT_FRONTEND_ORIGIN,
    ...getEnvValue("FRONTEND_ORIGIN", "FRONTEND_URL", "CORS_ORIGIN", "CORS_ORIGINS", "ALLOWED_ORIGINS").split(","),
  ]
    .map(normalizeOrigin)
    .filter(Boolean);

  return [...new Set(origins)];
}

function getRequestOrigin(req) {
  return normalizeOrigin(req.headers.origin);
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return false;
  }

  return getAllowedCorsOrigins().includes(origin);
}

function buildCorsHeaders(req) {
  const origin = getRequestOrigin(req);
  if (!isAllowedCorsOrigin(origin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function applyCorsHeaders(req, res) {
  for (const [key, value] of Object.entries(buildCorsHeaders(req))) {
    res.setHeader(key, value);
  }
}

function handleCorsPreflight(req, res) {
  if (req.method !== "OPTIONS") {
    return false;
  }

  res.writeHead(204, {
    ...buildSecurityHeaders(),
    ...buildCorsHeaders(req),
  });
  res.end();
  return true;
}

function getRequestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function getRequestMeta(req) {
  return {
    idempotencyKey: String(req.headers["idempotency-key"] || "").trim(),
    ipAddress: getRequestIp(req),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
  };
}

function getLoginAttemptKey(req, email) {
  return `${getRequestIp(req)}:${String(email || "").trim().toLowerCase()}`;
}

function isLoginRateLimited(req, email) {
  const key = getLoginAttemptKey(req, email);
  const bucket = loginAttemptBuckets.get(key);
  if (!bucket || Date.now() - bucket.startedAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    return false;
  }
  return bucket.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
}

function recordFailedLogin(req, email) {
  const key = getLoginAttemptKey(req, email);
  const existing = loginAttemptBuckets.get(key);
  if (!existing || Date.now() - existing.startedAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginAttemptBuckets.set(key, { count: 1, startedAt: Date.now() });
    return;
  }
  existing.count += 1;
}

function clearFailedLogins(req, email) {
  loginAttemptBuckets.delete(getLoginAttemptKey(req, email));
}

function normalizeAuthRole(value, fallback = "user") {
  const role = String(value || fallback).trim().toLowerCase();
  return ["admin", "user"].includes(role) ? role : fallback;
}

function slugifyUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 48);
}

function getSignupEmail(name, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (normalizedEmail) {
    return normalizedEmail;
  }
  const username = slugifyUsername(name);
  if (!username) {
    throw new Error("Name is required.");
  }
  return `${username}@netrue.local`;
}

function findUserByLogin(login) {
  const normalized = String(login || "").trim().toLowerCase();
  return db.users.find(
    (item) =>
      String(item.email || "").trim().toLowerCase() === normalized ||
      String(item.name || "").trim().toLowerCase() === normalized
  );
}

function isAdminSelfSignupEnabled() {
  return ["1", "true", "yes", "on"].includes(String(getEnvValue("ADMIN_SELF_SIGNUP_ENABLED") || "").trim().toLowerCase());
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getSession(req) {
  const cookies = parseCookies(req);
  if (!cookies.sid) {
    return null;
  }
  const session = db.sessions.find((item) => item.id === cookies.sid);
  if (!session) {
    return null;
  }
  if (Date.parse(session.expiresAt) < Date.now()) {
    db.sessions = db.sessions.filter((item) => item.id !== session.id);
    persist();
    return null;
  }
  return session;
}

function getCurrentUser(req) {
  const session = getSession(req);
  if (!session) {
    return null;
  }
  return db.users.find((user) => user.id === session.userId) || null;
}

function createSession(userId) {
  const session = {
    id: randomId(18),
    userId,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  db.sessions = db.sessions.filter((item) => item.userId !== userId);
  db.sessions.push(session);
  persist();
  return session;
}

function clearSession(req) {
  const session = getSession(req);
  if (!session) {
    return;
  }
  db.sessions = db.sessions.filter((item) => item.id !== session.id);
  persist();
}

function requireAuth(req, res, role) {
  const user = getCurrentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Authentication required." });
    return null;
  }
  if (role && user.role !== role) {
    sendJson(res, 403, { error: "You do not have access to this action." });
    return null;
  }
  return user;
}

function toSafeBalances(accountInfo) {
  return (accountInfo.balances || [])
    .map((asset) => ({
      asset: asset.asset,
      free: Number(asset.free),
      locked: Number(asset.locked),
    }))
    .filter((asset) => asset.free > 0 || asset.locked > 0)
    .sort((a, b) => b.free + b.locked - (a.free + a.locked));
}

function enrichBalancesWithUsdtValue(balances, tickers) {
  const priceMap = new Map((tickers || []).map((item) => [item.symbol, Number(item.price)]));
  return balances
    .map((asset) => {
      const total = Number(asset.free || 0) + Number(asset.locked || 0);
      let usdtValue = 0;
      if (asset.asset === "USDT") {
        usdtValue = total;
      } else if (["FDUSD", "USDC", "BUSD"].includes(asset.asset)) {
        usdtValue = total;
      } else {
        usdtValue = total * Number(priceMap.get(`${asset.asset}USDT`) || 0);
      }
      return {
        ...asset,
        total,
        usdtValue,
      };
    })
    .sort((a, b) => b.usdtValue - a.usdtValue);
}

function addBalanceMarketStats(balances, stats24h) {
  const statsMap = new Map(
    (Array.isArray(stats24h) ? stats24h : []).map((item) => [item.symbol, Number(item.priceChangePercent || 0)])
  );

  return balances.map((asset) => {
    const symbol = `${asset.asset}USDT`;
    const changePercent = asset.asset === "USDT" ? 0 : Number(statsMap.get(symbol) || 0);
    const currentUsdtValue = Number(asset.usdtValue || 0);
    const ratio = 1 + changePercent / 100;
    const previousUsdtValue = asset.asset === "USDT" || ratio <= 0 ? currentUsdtValue : currentUsdtValue / ratio;
    const estimatedPnlValue = currentUsdtValue - previousUsdtValue;
    return {
      ...asset,
      changePercent,
      previousUsdtValue,
      estimatedPnlValue,
    };
  });
}

function calculatePortfolioPnl(balances) {
  const totalUsdt = balances.reduce((sum, item) => sum + Number(item.usdtValue || 0), 0);
  const previousTotalUsdt = balances.reduce((sum, item) => sum + Number(item.previousUsdtValue || item.usdtValue || 0), 0);
  const estimatedPnlValue = balances.reduce((sum, item) => sum + Number(item.estimatedPnlValue || 0), 0);
  const estimatedPnlPercent = previousTotalUsdt ? (estimatedPnlValue / previousTotalUsdt) * 100 : 0;
  return {
    totalUsdt,
    previousTotalUsdt,
    estimatedPnlValue,
    estimatedPnlPercent,
  };
}

function parseNumberText(value) {
  const normalized = String(value || "").replace(/[^0-9.]/g, "");
  return Number(normalized || 0);
}

function addBalanceFiatValue(balances, usdtNgnRate) {
  const rate = Number(usdtNgnRate || 0);
  return balances.map((asset) => ({
    ...asset,
    ngnValue: rate > 0 ? Number(asset.usdtValue || 0) * rate : 0,
  }));
}

function getPerformanceDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return PERFORMANCE_DATE_FORMATTER.formatToParts(date).reduce((parts, part) => {
    if (["year", "month", "day"].includes(part.type)) {
      parts[part.type] = part.value;
    }
    return parts;
  }, {});
}

function getPerformanceDateKey(value = new Date()) {
  const parts = getPerformanceDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getPerformanceMonthKey(value = new Date()) {
  const parts = getPerformanceDateParts(value);
  return `${parts.year}-${parts.month}`;
}

function ensureAccountPerformance(account) {
  if (!account.performance || typeof account.performance !== "object") {
    account.performance = {
      dailyLedger: [],
    };
  }
  if (!Array.isArray(account.performance.dailyLedger)) {
    account.performance.dailyLedger = [];
  }
  return account.performance;
}

function getBalanceQuantityMap(balances = []) {
  return new Map(
    (Array.isArray(balances) ? balances : [])
      .filter((asset) => asset?.asset)
      .map((asset) => [
        String(asset.asset || "").toUpperCase(),
        {
          total: Number((asset.total ?? (Number(asset.free || 0) + Number(asset.locked || 0))) || 0),
          price: getApproxUsdtPriceForBalance(asset),
        },
      ])
  );
}

function getAssetValueMap(balances = [], fallbackTotalUsdt = 0) {
  const values = new Map(
    (Array.isArray(balances) ? balances : [])
      .filter((asset) => asset?.asset)
      .map((asset) => [String(asset.asset || "").toUpperCase(), Number(asset.usdtValue || 0)])
  );

  if (!values.size && Number(fallbackTotalUsdt || 0) > 0) {
    values.set("PORTFOLIO", Number(fallbackTotalUsdt || 0));
  }

  return values;
}

function mapToNumberObject(map) {
  return Object.fromEntries(
    [...map.entries()]
      .filter(([, value]) => Math.abs(Number(value || 0)) >= 0.000001)
      .map(([key, value]) => [key, Number(value || 0)])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function sumNumberObject(values = {}) {
  return Object.values(values || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function getComparableAssetPrice(previousAsset, currentAsset) {
  const previousPrice = Number(previousAsset?.price || 0);
  const currentPrice = Number(currentAsset?.price || 0);
  if (previousPrice > 0 && currentPrice > 0) {
    return (previousPrice + currentPrice) / 2;
  }
  return currentPrice || previousPrice || 0;
}

function estimateAssetNetExternalFlowsUsdt(previousBalances = [], currentBalances = []) {
  const previousMap = getBalanceQuantityMap(previousBalances);
  const currentMap = getBalanceQuantityMap(currentBalances);
  const assetKeys = new Set([...previousMap.keys(), ...currentMap.keys()]);
  const estimatedFlows = new Map();

  for (const assetKey of assetKeys) {
    const previousAsset = previousMap.get(assetKey);
    const currentAsset = currentMap.get(assetKey);
    const previousTotal = Number(previousAsset?.total || 0);
    const currentTotal = Number(currentAsset?.total || 0);
    const quantityDelta = currentTotal - previousTotal;
    if (Math.abs(quantityDelta) < 1e-10) {
      continue;
    }

    const price = getComparableAssetPrice(previousAsset, currentAsset);
    const flow = quantityDelta * price;
    if (Math.abs(flow) >= 0.000001) {
      estimatedFlows.set(assetKey, flow);
    }
  }

  return estimatedFlows;
}

function estimateNetExternalFlowUsdt(previousBalances = [], currentBalances = []) {
  return [...estimateAssetNetExternalFlowsUsdt(previousBalances, currentBalances).values()]
    .reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildPerformanceSnapshot(performance, now, totalUsdt) {
  const timestamp = now instanceof Date ? now : new Date(now);
  const todayKey = getPerformanceDateKey(timestamp);
  const currentMonthKey = getPerformanceMonthKey(timestamp);
  const ledger = (performance?.dailyLedger || [])
    .filter((entry) => entry && entry.dayKey)
    .sort((a, b) => String(a.dayKey).localeCompare(String(b.dayKey)));
  const todayEntry = ledger.find((entry) => entry.dayKey === todayKey) || {
    openingUsdt: Number(totalUsdt || 0),
    closingUsdt: Number(totalUsdt || 0),
    pnlValue: 0,
    netFlowUsdt: 0,
  };
  const monthEntries = ledger.filter((entry) => String(entry.dayKey || "").startsWith(currentMonthKey));
  const monthOpeningEntry = monthEntries[0] || todayEntry;
  const monthOpeningUsdt = Number(monthOpeningEntry?.openingUsdt ?? totalUsdt);
  const monthPnlValue = monthEntries.reduce((sum, entry) => sum + Number(entry.pnlValue || 0), 0);
  const monthNetFlowUsdt = monthEntries.reduce((sum, entry) => sum + Number(entry.netFlowUsdt || 0), 0);
  const todayCapitalBase = Number(todayEntry.openingUsdt || 0) + Number(todayEntry.netFlowUsdt || 0);
  const monthCapitalBase = monthOpeningUsdt + monthNetFlowUsdt;

  return {
    todayLabel: todayKey,
    todayTimeZone: PERFORMANCE_TIME_ZONE,
    todayPnlValue: Number(todayEntry.pnlValue || 0),
    todayPnlPercent: todayCapitalBase
      ? (Number(todayEntry.pnlValue || 0) / todayCapitalBase) * 100
      : 0,
    todayCapitalBase,
    todayOpeningUsdt: Number(todayEntry.openingUsdt || 0),
    todayClosingUsdt: Number(todayEntry.closingUsdt || totalUsdt || 0),
    todayAssetPnl: Object.entries(todayEntry.assetPnlValues || {})
      .map(([asset, pnlValue]) => ({ asset, pnlValue: Number(pnlValue || 0) }))
      .sort((a, b) => Math.abs(b.pnlValue) - Math.abs(a.pnlValue)),
    monthLabel: currentMonthKey,
    monthPnlValue,
    monthPnlPercent: monthCapitalBase ? (monthPnlValue / monthCapitalBase) * 100 : 0,
    monthOpeningUsdt,
  };
}

function updateAccountPerformance(
  account,
  totalUsdt,
  netExternalFlowUsdt = 0,
  currentBalances = [],
  assetExternalFlows = new Map(),
  openingBalanceBaseline = []
) {
  const performance = ensureAccountPerformance(account);
  const now = new Date();
  const todayKey = getPerformanceDateKey(now);
  const currentAssetValues = getAssetValueMap(currentBalances, totalUsdt);
  const ledger = performance.dailyLedger
    .filter((entry) => entry && entry.dayKey)
    .sort((a, b) => String(a.dayKey).localeCompare(String(b.dayKey)));
  let todayEntry = ledger.find((entry) => entry.dayKey === todayKey) || null;

  if (!todayEntry) {
    const currentValueObject = mapToNumberObject(currentAssetValues);
    todayEntry = {
      dayKey: todayKey,
      timeZone: PERFORMANCE_TIME_ZONE,
      openingUsdt: Number(totalUsdt || 0),
      closingUsdt: Number(totalUsdt || 0),
      pnlValue: 0,
      netFlowUsdt: 0,
      assetOpeningValues: currentValueObject,
      assetClosingValues: currentValueObject,
      assetNetFlowUsdt: {},
      assetPnlValues: {},
      updatedAt: now.toISOString(),
    };
    ledger.push(todayEntry);
  }

  if (!todayEntry.assetOpeningValues || !Object.keys(todayEntry.assetOpeningValues).length) {
    const baselineValues = getAssetValueMap(
      Array.isArray(openingBalanceBaseline) && openingBalanceBaseline.length ? openingBalanceBaseline : currentBalances,
      totalUsdt
    );
    const baselineObject = mapToNumberObject(baselineValues);
    todayEntry.assetOpeningValues = baselineObject;
    todayEntry.openingUsdt = sumNumberObject(baselineObject);
  }
  if (!todayEntry.assetNetFlowUsdt || typeof todayEntry.assetNetFlowUsdt !== "object") {
    todayEntry.assetNetFlowUsdt = {};
  }

  const closingValues = mapToNumberObject(currentAssetValues);
  const assetNetFlowUsdt = {
    ...(todayEntry.assetNetFlowUsdt || {}),
  };
  for (const [asset, flow] of assetExternalFlows.entries()) {
    assetNetFlowUsdt[asset] = Number(assetNetFlowUsdt[asset] || 0) + Number(flow || 0);
  }

  const assetKeys = new Set([
    ...Object.keys(todayEntry.assetOpeningValues || {}),
    ...Object.keys(closingValues),
    ...Object.keys(assetNetFlowUsdt),
  ]);
  const assetPnlValues = {};
  for (const asset of assetKeys) {
    const closingValue = Number(closingValues[asset] || 0);
    const openingValue = Number(todayEntry.assetOpeningValues?.[asset] || 0);
    const flowValue = Number(assetNetFlowUsdt[asset] || 0);
    const pnlValue = closingValue - openingValue - flowValue;
    if (Math.abs(pnlValue) >= 0.000001) {
      assetPnlValues[asset] = pnlValue;
    }
  }

  todayEntry.timeZone = PERFORMANCE_TIME_ZONE;
  todayEntry.netFlowUsdt = Object.keys(assetNetFlowUsdt).length
    ? sumNumberObject(assetNetFlowUsdt)
    : Number(todayEntry.netFlowUsdt || 0) + Number(netExternalFlowUsdt || 0);
  todayEntry.closingUsdt = Number(totalUsdt || 0);
  todayEntry.assetClosingValues = closingValues;
  todayEntry.assetNetFlowUsdt = mapToNumberObject(new Map(Object.entries(assetNetFlowUsdt)));
  todayEntry.assetPnlValues = assetPnlValues;
  todayEntry.pnlValue = sumNumberObject(assetPnlValues);
  todayEntry.updatedAt = now.toISOString();

  performance.dailyLedger = ledger.slice(-400);
  return buildPerformanceSnapshot(performance, now, totalUsdt);
}

function getApproxUsdtPriceForBalance(asset) {
  const name = String(asset?.asset || "").toUpperCase();
  if (["USDT", "USDC", "FDUSD", "BUSD"].includes(name)) {
    return 1;
  }

  const total = Number(asset?.total || 0);
  if (!total) {
    return 0;
  }

  return Number(asset?.usdtValue || 0) / total;
}

function addBalanceTradability(balances, exchangeInfo) {
  const symbolMap = new Map((exchangeInfo?.symbols || []).map((item) => [item.symbol, item]));

  return balances.map((asset) => {
    const balanceSymbol = `${String(asset.asset || "").toUpperCase()}USDT`;
    const details = symbolMap.get(balanceSymbol);
    const filters = details?.filters || [];
    const quantityFilter = getEffectiveQuantityFilter(filters, "MARKET") || getEffectiveQuantityFilter(filters, "LIMIT");
    const notionalFilter = getFilter(filters, "NOTIONAL") || getFilter(filters, "MIN_NOTIONAL");
    const availableQuantity = Number(asset.free || 0);
    const totalQuantity = Number(asset.total || 0);
    const currentPrice = getApproxUsdtPriceForBalance(asset);
    const normalizedTradableQuantity = quantityFilter?.stepSize
      ? Number(normalizeQuantityToStep(availableQuantity, quantityFilter.stepSize))
      : availableQuantity;
    const minQty = Number(quantityFilter?.minQty || 0);
    const minNotional = Number(notionalFilter?.minNotional || 0);
    const tradableNotional = normalizedTradableQuantity * currentPrice;
    const hasTradableQuantity = normalizedTradableQuantity > 0;
    const meetsMinQty = !minQty || normalizedTradableQuantity >= minQty;
    const meetsMinNotional = !minNotional || tradableNotional >= minNotional;
    const spotSellTradable = !details
      ? totalQuantity > 0
      : hasTradableQuantity && meetsMinQty && meetsMinNotional;

    return {
      ...asset,
      balanceSymbol,
      unitPriceUsdt: currentPrice,
      spotTradableQuantity: normalizedTradableQuantity,
      spotTradableMinQty: minQty,
      spotTradableMinNotional: minNotional,
      spotTradableNotional: tradableNotional,
      spotSellTradable,
    };
  });
}

function summarizeWalletBalances(balances, usdtNgnRate) {
  const rate = Number(usdtNgnRate || 0);
  const totalUsdt = balances.reduce((sum, item) => sum + Number(item.usdtValue || 0), 0);

  return {
    totalUsdt,
    totalNgn: rate > 0 ? totalUsdt * rate : 0,
    assetCount: balances.length,
    topAssets: balances.slice(0, 3).map((asset) => ({
      asset: asset.asset,
      total: Number(asset.total || 0),
      usdtValue: Number(asset.usdtValue || 0),
    })),
  };
}

function formatSignedPercent(value) {
  const amount = Number(value || 0);
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(2)}%`;
}

function calculateCandleMove(candles) {
  const first = Array.isArray(candles) ? candles[0] : null;
  const last = Array.isArray(candles) ? candles[candles.length - 1] : null;
  const startPrice = Number(first?.open || first?.close || 0);
  const endPrice = Number(last?.close || last?.open || 0);
  if (!startPrice || !endPrice) {
    return 0;
  }
  return ((endPrice - startPrice) / startPrice) * 100;
}

async function buildBybitAiInsight(item, mode) {
  try {
    const [candles15m, candles1h, candles1d] = await Promise.all([
      getCandles(item.symbol, "15m", 8, false, "bybit"),
      getCandles(item.symbol, "1h", 8, false, "bybit"),
      getCandles(item.symbol, "1d", 5, false, "bybit"),
    ]);
    const move15m = calculateCandleMove(candles15m);
    const move1h = calculateCandleMove(candles1h);
    const move1d = calculateCandleMove(candles1d);
    const turnoverText = Number(item.turnover24h || 0) > 0 ? `${Math.round(Number(item.turnover24h || 0)).toLocaleString()} USDT turnover` : "lighter turnover";

    if (mode === "pump") {
      const alignedUptrend = move15m >= 0 && move1h >= 0 && move1d >= 0;
      return alignedUptrend
        ? `Bybit live read: 15m ${formatSignedPercent(move15m)}, 1h ${formatSignedPercent(move1h)}, 1D ${formatSignedPercent(move1d)}. Momentum is aligned higher with ${turnoverText}.`
        : `Bybit live read: 15m ${formatSignedPercent(move15m)}, 1h ${formatSignedPercent(move1h)}, 1D ${formatSignedPercent(move1d)}. The pump is live, but shorter-term momentum is starting to cool.`;
    }

    const alignedDowntrend = move15m <= 0 && move1h <= 0 && move1d <= 0;
    return alignedDowntrend
      ? `Bybit live read: 15m ${formatSignedPercent(move15m)}, 1h ${formatSignedPercent(move1h)}, 1D ${formatSignedPercent(move1d)}. Selling pressure is still dominant with ${turnoverText}.`
      : `Bybit live read: 15m ${formatSignedPercent(move15m)}, 1h ${formatSignedPercent(move1h)}, 1D ${formatSignedPercent(move1d)}. The dump remains active, but buyers are starting to test the bounce.`;
  } catch {
    return mode === "pump"
      ? "Bybit live read is syncing. Momentum is still being inferred from the latest live move."
      : "Bybit live read is syncing. Downside pressure is still being inferred from the latest live move.";
  }
}

async function getAccountSnapshot(account, exchange) {
  const previousSnapshot = getCachedAccountSnapshot(account, exchange);
  const [accountInfo, openOrders, tickers, stats24h, usdtNgnRate, exchangeInfo] = await Promise.all([
    getAccountInfo(account, exchange),
    getOpenOrders(account, exchange),
    getTickerPrices(account.testnet, exchange),
    getTicker24hr(account.testnet, false, exchange),
    getUsdtToNgnRateFromBybitPage().catch(() => null),
    getExchangeInfo("", account.testnet, exchange).catch(() => ({ symbols: [] })),
  ]);
  const enrichedBalances = enrichBalancesWithUsdtValue(toSafeBalances(accountInfo), tickers);
  const balances = addBalanceTradability(
    addBalanceFiatValue(addBalanceMarketStats(enrichedBalances, stats24h), usdtNgnRate),
    exchangeInfo
  );
  const pnl = calculatePortfolioPnl(balances);
  const previousSnapshotDay = previousSnapshot?.updatedAt || previousSnapshot?.cachedAt
    ? getPerformanceDateKey(previousSnapshot.updatedAt || previousSnapshot.cachedAt)
    : "";
  const currentDay = getPerformanceDateKey();
  const canComparePreviousSnapshot =
    previousSnapshotDay === currentDay &&
    Array.isArray(previousSnapshot?.balances) &&
    previousSnapshot.balances.length > 0;
  const assetExternalFlows = canComparePreviousSnapshot
    ? estimateAssetNetExternalFlowsUsdt(previousSnapshot.balances, balances)
    : new Map();
  const netExternalFlowUsdt = [...assetExternalFlows.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  const performance = updateAccountPerformance(
    account,
    pnl.totalUsdt,
    netExternalFlowUsdt,
    balances,
    assetExternalFlows,
    canComparePreviousSnapshot ? previousSnapshot.balances : []
  );
  const snapshot = {
    exchange,
    balances,
    totalUsdt: pnl.totalUsdt,
    previousTotalUsdt: pnl.previousTotalUsdt,
    totalNgn: Number(usdtNgnRate || 0) > 0 ? pnl.totalUsdt * Number(usdtNgnRate) : 0,
    usdtNgnRate: Number(usdtNgnRate || 0),
    estimatedPnlValue: pnl.estimatedPnlValue,
    estimatedPnlPercent: pnl.estimatedPnlPercent,
    todayPnlValue: performance.todayPnlValue,
    todayPnlPercent: performance.todayPnlPercent,
    todayCapitalBase: performance.todayCapitalBase,
    todayOpeningUsdt: performance.todayOpeningUsdt,
    todayClosingUsdt: performance.todayClosingUsdt,
    todayLabel: performance.todayLabel,
    todayTimeZone: performance.todayTimeZone,
    todayAssetPnl: performance.todayAssetPnl,
    monthPnlValue: performance.monthPnlValue,
    monthPnlPercent: performance.monthPnlPercent,
    monthOpeningUsdt: performance.monthOpeningUsdt,
    monthLabel: performance.monthLabel,
    permissions: account.permissions,
    openOrders,
    updatedAt: nowIso(),
  };
  cacheAccountSnapshot(account, snapshot, exchange);
  return snapshot;
}

async function getConnectedWalletDetails(user, usdtNgnRate) {
  const connectedExchanges = listExchanges().filter((exchange) => !!getExchangeAccount(user, exchange.id));

  return Promise.all(
    connectedExchanges.map(async (exchange) => {
      const account = getExchangeAccount(user, exchange.id);
      if (!account) {
        return null;
      }

      const cachedSnapshot = getCachedAccountSnapshot(account, exchange.id);
      const cachedSummary = summarizeWalletDetailsFromSnapshot(cachedSnapshot, exchange.id, exchange.label, usdtNgnRate);
      if (cachedSummary) {
        return cachedSummary;
      }

      return {
        exchange: exchange.id,
        label: exchange.label,
        connected: true,
        lastValidatedAt: account.lastValidatedAt || null,
        error: "Wallet snapshot has not been loaded yet.",
        totalUsdt: 0,
        totalNgn: 0,
        assetCount: 0,
        topAssets: [],
        stale: true,
      };
    })
  ).then((items) => items.filter(Boolean));
}

async function getConnectedWalletDetailsLive(user, usdtNgnRate) {
  const connectedExchanges = listExchanges().filter((exchange) => !!getExchangeAccount(user, exchange.id));

  return Promise.all(
    connectedExchanges.map(async (exchange) => {
      const account = getExchangeAccount(user, exchange.id);
      if (!account) {
        return null;
      }

      const liveSnapshot = await getAccountSnapshot(account, exchange.id).catch(() => null);
      const liveSummary = summarizeWalletDetailsFromSnapshot(liveSnapshot, exchange.id, exchange.label, usdtNgnRate);
      if (liveSummary) {
        return liveSummary;
      }

      const cachedSnapshot = getCachedAccountSnapshot(account, exchange.id);
      const cachedSummary = summarizeWalletDetailsFromSnapshot(cachedSnapshot, exchange.id, exchange.label, usdtNgnRate);
      if (cachedSummary) {
        return {
          ...cachedSummary,
          stale: true,
        };
      }

      return {
        exchange: exchange.id,
        label: exchange.label,
        connected: true,
        lastValidatedAt: account.lastValidatedAt || null,
        error: "Live wallet sync is still loading.",
        totalUsdt: 0,
        totalNgn: 0,
        assetCount: 0,
        topAssets: [],
        stale: true,
      };
    })
  ).then((items) => items.filter(Boolean));
}

async function buildManagedUserSummary(user, usdtNgnRate, { refreshWallets = false } = {}) {
  const financeProfile = financialService.getUserFinanceProfile(user.id);
  return {
    ...sanitizeUser(user),
    mirrorStatus: user.mirrorEnabled ? "ACTIVE" : "OFF",
    connectedExchanges: listExchanges().filter((exchange) => !!user[exchange.id]),
    passwordStoredSecurely: true,
    ledgerWallets: financeProfile.wallets,
    recentTransactions: financeProfile.recentTransactions,
    walletDetails: refreshWallets
      ? await getConnectedWalletDetailsLive(user, usdtNgnRate)
      : await getConnectedWalletDetails(user, usdtNgnRate),
  };
}

async function buildSettingsUsersPayload(user, { refreshWallets = true } = {}) {
  const usdtNgnRate = await getUsdtToNgnRateFromBybitPage().catch(() => null);

  if (user.role === "admin") {
    const users = await Promise.all(
      db.users
        .filter((item) => item.role === "user")
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
        .map((item) => buildManagedUserSummary(item, usdtNgnRate, { refreshWallets }))
    );

    return {
      scope: "admin",
      users,
      signalAutoTrade: getSignalAutoTradeSettingsSnapshot(),
      generatedAt: nowIso(),
    };
  }

  const exchange = getPreferredExchange(user);
  const account = getExchangeAccount(user, exchange);
  const accountSnapshot = account
    ? await getAccountSnapshot(account, exchange).catch(() => getCachedAccountSnapshot(account, exchange))
    : null;

  return {
    scope: "user",
    user: sanitizeUser(user),
    accountSnapshot,
    generatedAt: nowIso(),
  };
}

async function getAdminBybitMirrorPnl() {
  const admin = db.users.find((item) => item.role === "admin" && item.bybit);
  if (!admin?.bybit) {
    return null;
  }

  const cachedSnapshot = getCachedAccountSnapshot(admin.bybit, "bybit");
  try {
    const snapshot = cachedSnapshot && isCachedAccountSnapshotFresh(cachedSnapshot, 15_000)
      ? cachedSnapshot
      : await getAccountSnapshot(admin.bybit, "bybit");
    admin.bybit.lastValidatedAt = nowIso();
    persist();
    return {
      source: "ADMIN_BYBIT",
      todayPnlPercent: Number(snapshot.todayPnlPercent || 0),
      todayPnlValue: Number(snapshot.todayPnlValue || 0),
      todayCapitalBase: Number(snapshot.todayCapitalBase || 0),
      todayOpeningUsdt: Number(snapshot.todayOpeningUsdt || 0),
      todayClosingUsdt: Number(snapshot.todayClosingUsdt || 0),
      todayAssetPnl: Array.isArray(snapshot.todayAssetPnl) ? snapshot.todayAssetPnl : [],
      updatedAt: snapshot.updatedAt || snapshot.cachedAt || nowIso(),
      stale: !!snapshot.stale,
    };
  } catch {
    if (!cachedSnapshot) {
      return null;
    }
    return {
      source: "ADMIN_BYBIT",
      todayPnlPercent: Number(cachedSnapshot.todayPnlPercent || 0),
      todayPnlValue: Number(cachedSnapshot.todayPnlValue || 0),
      todayCapitalBase: Number(cachedSnapshot.todayCapitalBase || 0),
      todayOpeningUsdt: Number(cachedSnapshot.todayOpeningUsdt || 0),
      todayClosingUsdt: Number(cachedSnapshot.todayClosingUsdt || 0),
      todayAssetPnl: Array.isArray(cachedSnapshot.todayAssetPnl) ? cachedSnapshot.todayAssetPnl : [],
      updatedAt: cachedSnapshot.updatedAt || cachedSnapshot.cachedAt || null,
      stale: true,
    };
  }
}

async function getUsdtToNgnRate() {
  if (Number(process.env.BYBIT_USDT_NGN_RATE || 0) > 0) {
    return Number(process.env.BYBIT_USDT_NGN_RATE);
  }

  if (
    fiatRateCache.usdtNgnRate &&
    Date.now() - fiatRateCache.updatedAt < FIAT_RATE_CACHE_TTL_MS
  ) {
    return fiatRateCache.usdtNgnRate;
  }

  const response = await fetch(BYBIT_USDT_NGN_URL, {
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "trade-mvp/1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load Bybit fiat rate. HTTP ${response.status}.`);
  }

  const html = await response.text();
  const compact = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const ratePatterns = [
    /1\s*USDT\s*(?:=|to)?\s*₦?\s*([\d,]+(?:\.\d+)?)/i,
    /exchange rate of Tether USD\s*\(USDT\)\s*to Nigerian Naira\s*\(NGN\)\s*stands at\s*₦?\s*([\d,]+(?:\.\d+)?)/i,
    /USDT\/NGN[\s\S]{0,80}?₦\s*([\d,]+(?:\.\d+)?)/i,
  ];

  for (const pattern of ratePatterns) {
    const match = compact.match(pattern);
    const rate = parseNumberText(match?.[1]);
    if (rate > 0) {
      fiatRateCache.usdtNgnRate = rate;
      fiatRateCache.updatedAt = Date.now();
      return rate;
    }
  }

  throw new Error("Unable to parse the Bybit USDT/NGN fiat rate.");
}

async function getUsdtToNgnRateFromBybitPage() {
  if (Number(process.env.BYBIT_USDT_NGN_RATE || 0) > 0) {
    return Number(process.env.BYBIT_USDT_NGN_RATE);
  }

  if (
    fiatRateCache.usdtNgnRate &&
    Date.now() - fiatRateCache.updatedAt < FIAT_RATE_CACHE_TTL_MS
  ) {
    return fiatRateCache.usdtNgnRate;
  }

  const response = await fetch(BYBIT_USDT_NGN_URL, {
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "trade-mvp/1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load Bybit fiat rate. HTTP ${response.status}.`);
  }

  const html = await response.text();
  const compact = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const ratePatterns = [
    /1\s*USDT\s*(?:=|to)?\s*(?:NGN|[^0-9\s]{0,3})?\s*([\d,]+(?:\.\d+)?)/i,
    /exchange rate of Tether USD\s*\(USDT\)\s*to Nigerian Naira\s*\(NGN\)\s*stands at\s*(?:NGN|[^0-9\s]{0,3})?\s*([\d,]+(?:\.\d+)?)/i,
    /USDT\/NGN[\s\S]{0,80}?(?:NGN|[^0-9\s]{0,3})?\s*([\d,]+(?:\.\d+)?)/i,
  ];

  for (const pattern of ratePatterns) {
    const match = compact.match(pattern);
    const rate = parseNumberText(match?.[1]);
    if (rate > 0) {
      fiatRateCache.usdtNgnRate = rate;
      fiatRateCache.updatedAt = Date.now();
      return rate;
    }
  }

  throw new Error("Unable to parse the Bybit USDT/NGN fiat rate.");
}

async function getMarketWatchlist(testnet = false, exchange = "bybit") {
  const cacheKey = getWatchlistCacheKey(testnet, exchange);
  const cached = watchlistCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < WATCHLIST_CACHE_TTL_MS) {
    return cached.items;
  }

  let items = [];
  try {
    const allTickers = await getTicker24hr(testnet, false, exchange);
    const liquidUsdtPairs = (Array.isArray(allTickers) ? allTickers : [])
      .filter((item) => item.symbol?.endsWith("USDT") && Number(item.turnover24h || 0) > 0)
      .sort((a, b) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0));

    const liquidUniverse = liquidUsdtPairs.slice(0, 80);
    const topPump = [...liquidUniverse]
      .sort((a, b) => {
        const changeDiff = Number(b.priceChangePercent || 0) - Number(a.priceChangePercent || 0);
        return changeDiff || Number(b.turnover24h || 0) - Number(a.turnover24h || 0);
      })
      .slice(0, 4);
    const topDip = [...liquidUniverse]
      .sort((a, b) => {
        const changeDiff = Number(a.priceChangePercent || 0) - Number(b.priceChangePercent || 0);
        return changeDiff || Number(b.turnover24h || 0) - Number(a.turnover24h || 0);
      })
      .slice(0, 4);
    const anchors = MARKET_WATCHLIST_SYMBOLS
      .map((symbol) => liquidUsdtPairs.find((item) => item.symbol === symbol))
      .filter(Boolean);

    items = [...new Map([...topPump, ...topDip, ...anchors].map((item) => [item.symbol, item])).values()]
      .map(normalizeWatchlistItem)
      .filter((item) => item.symbol)
      .slice(0, 12);
  } catch {
    items = [];
  }

  if (!items.length) {
    items = await Promise.all(
      MARKET_WATCHLIST_SYMBOLS.map((symbol) =>
        getTickerPrice(symbol, testnet, exchange).catch(() => ({
          symbol,
          price: "0",
          priceChangePercent: "0",
          volume24h: "0",
          turnover24h: "0",
        }))
      )
    );
    items = items.map(normalizeWatchlistItem);
  }

  const topPump = [...items].sort((a, b) => Number(b.changePercent || 0) - Number(a.changePercent || 0))[0] || null;
  const topDip = [...items].sort((a, b) => Number(a.changePercent || 0) - Number(b.changePercent || 0))[0] || null;
  const watchModes = new Map();
  if (topPump?.symbol) {
    watchModes.set(topPump.symbol, "pump");
  }
  if (topDip?.symbol && !watchModes.has(topDip.symbol)) {
    watchModes.set(topDip.symbol, "dip");
  }

  if (watchModes.size) {
    const insightMap = new Map(
      await Promise.all(
        [...watchModes.entries()].map(async ([symbol, mode]) => [
          symbol,
          await buildBybitAiInsight(items.find((item) => item.symbol === symbol) || { symbol }, mode),
        ])
      )
    );

    items = items.map((item) =>
      insightMap.has(item.symbol)
        ? {
            ...item,
            bybitAiInsight: insightMap.get(item.symbol),
            bybitAiSource: "Bybit live spot analysis",
          }
        : item
    );
  }

  watchlistCache.set(cacheKey, {
    items,
    updatedAt: Date.now(),
  });

  return items;
}

function shouldPersistLoginExchange(user, exchange) {
  const normalizedExchange = normalizeExchange(exchange, "bybit");
  return !user?.bybit && !user?.binance ? true : !!user?.[normalizedExchange];
}

function getAdminManagedUser(userId) {
  return db.users.find((user) => user.id === userId && user.role === "user") || null;
}

function detachUserFromMirroring(userId) {
  let changed = false;

  for (const trade of db.tradeIntents) {
    const nextMirrors = (trade.mirroredExecutions || []).filter((mirror) => mirror.userId !== userId);
    if (nextMirrors.length !== (trade.mirroredExecutions || []).length) {
      trade.mirroredExecutions = nextMirrors;
      changed = true;
    }

    for (const exitOrder of trade.exitOrders || []) {
      const nextExitMirrors = (exitOrder.mirroredExecutions || []).filter((mirror) => mirror.userId !== userId);
      if (nextExitMirrors.length !== (exitOrder.mirroredExecutions || []).length) {
        exitOrder.mirroredExecutions = nextExitMirrors;
        changed = true;
      }
    }
  }

  return changed;
}

function sanitizeExecution(order, error) {
  if (error) {
    return {
      status: "ERROR",
      error,
    };
  }
  if (!order) {
    return null;
  }
  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    price: order.price,
    origQty: order.origQty,
    executedQty: order.executedQty,
    cummulativeQuoteQty: order.cummulativeQuoteQty,
    transactTime: order.transactTime,
  };
}

const ACTIVE_ORDER_STATUSES = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW"]);
const FILLED_OR_PARTIAL_ORDER_STATUSES = new Set(["FILLED", "PARTIALLY_FILLED"]);
const KNOWN_QUOTE_ASSETS = ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH", "EUR", "BRL", "TRY"];
const TRADE_RECONCILE_COOLDOWN_MS = 5000;
const TRADE_RECONCILE_WAIT_MS = 1200;

let tradeReconcilePromise = null;
let lastTradeReconcileStartedAt = 0;

function isExecutionActive(execution) {
  return !!(execution?.orderId && ACTIVE_ORDER_STATUSES.has(execution.status));
}

function hasActiveMirroredExecution(executions = []) {
  return executions.some((execution) => isExecutionActive(execution?.order));
}

function hasActiveExitExecution(exitOrders = []) {
  return exitOrders.some(
    (exitOrder) => isExecutionActive(exitOrder?.adminExecution) || hasActiveMirroredExecution(exitOrder?.mirroredExecutions)
  );
}

function getExecutionFilledQty(execution) {
  return Number(execution?.executedQty || 0);
}

function getExecutionAveragePrice(execution) {
  const directPrice = Number(execution?.price || execution?.rawPrice || 0);
  if (directPrice > 0) {
    return directPrice;
  }

  const qty = getExecutionFilledQty(execution);
  const notional = Number(execution?.cummulativeQuoteQty || 0);
  if (qty > 0 && notional > 0) {
    return notional / qty;
  }

  return 0;
}

function getMirroredExecutionForTrade(trade, userId) {
  return (trade.mirroredExecutions || []).find((item) => item.userId === userId)?.order || null;
}

function getExitExecutionForTrade(trade, exitOrder, userId) {
  if (!userId) {
    return exitOrder.adminExecution || null;
  }
  return (exitOrder.mirroredExecutions || []).find((item) => item.userId === userId)?.order || null;
}

function getTradeFilledEntryQuantity(trade, userId = null) {
  const entryExecution = userId ? getMirroredExecutionForTrade(trade, userId) : trade.adminExecution;
  return getExecutionFilledQty(entryExecution);
}

function getTradeExitedQuantity(trade, userId = null) {
  return (trade.exitOrders || []).reduce((sum, exitOrder) => {
    const execution = getExitExecutionForTrade(trade, exitOrder, userId);
    if (!execution || !FILLED_OR_PARTIAL_ORDER_STATUSES.has(execution.status)) {
      return sum;
    }
    return sum + getExecutionFilledQty(execution);
  }, 0);
}

function getRemainingTradeQuantity(trade, userId = null) {
  const remaining = getTradeFilledEntryQuantity(trade, userId) - getTradeExitedQuantity(trade, userId);
  return remaining > 0 ? remaining : 0;
}

function getActiveTakeProfitOrders(trade) {
  return (trade.exitOrders || []).filter((exitOrder) => exitOrder.kind === "TAKE_PROFIT" && isExecutionActive(exitOrder.adminExecution));
}

function hasAnyTakeProfitHistory(trade) {
  return (trade.exitOrders || []).some(
    (exitOrder) =>
      exitOrder.kind === "TAKE_PROFIT"
      && !["ERROR", "CANCELED"].includes(String(exitOrder.adminExecution?.status || "").toUpperCase())
  );
}

function getActiveOpenOrdersForSymbol(openOrders, symbol) {
  return (openOrders || []).filter(
    (order) => order.symbol === symbol && ACTIVE_ORDER_STATUSES.has(String(order.status || "").toUpperCase())
  );
}

async function cancelTradeExitOrder(executionOwner, symbol, execution, exchange = getPreferredExchange(executionOwner)) {
  const account = getExchangeAccount(executionOwner, exchange);
  if (!account || !symbol || !execution?.orderId || !isExecutionActive(execution)) {
    return execution;
  }

  try {
    const canceled = await cancelOrder(account, symbol, execution.orderId, exchange);
    return sanitizeExecution(canceled);
  } catch (error) {
    return {
      ...execution,
      status: execution.status || "ERROR",
      cancelError: error.message,
    };
  }
}

async function cancelActiveTakeProfitOrders(trade) {
  const admin = db.users.find((user) => user.id === trade.createdByUserId);
  const exchange = getTradeExchange(trade);
  let changed = false;

  for (const exitOrder of trade.exitOrders || []) {
    if (exitOrder.kind !== "TAKE_PROFIT") {
      continue;
    }

    const nextAdminExecution = await cancelTradeExitOrder(admin, trade.symbol, exitOrder.adminExecution, exchange);
    if (!sameExecution(nextAdminExecution, exitOrder.adminExecution)) {
      exitOrder.adminExecution = nextAdminExecution;
      changed = true;
    }

    for (const mirror of exitOrder.mirroredExecutions || []) {
      const user = db.users.find((item) => item.id === mirror.userId);
      const nextMirrorExecution = await cancelTradeExitOrder(user, trade.symbol, mirror.order, exchange);
      if (!sameExecution(nextMirrorExecution, mirror.order)) {
        mirror.order = nextMirrorExecution;
        mirror.status = nextMirrorExecution?.status || mirror.status;
        mirror.error = nextMirrorExecution?.cancelError || null;
        changed = true;
      }
    }
  }

  if (changed) {
    persist();
  }
}

async function cancelMirroredExecutionOrders(executions, symbol) {
  let changed = false;

  for (const mirror of executions || []) {
    const user = db.users.find((item) => item.id === mirror.userId);
    const exchange = normalizeExchange(mirror.exchange, getPreferredExchange(user));
    const nextExecution = await cancelTradeExitOrder(user, symbol, mirror.order, exchange);
    if (!sameExecution(nextExecution, mirror.order)) {
      mirror.order = nextExecution;
      mirror.status = nextExecution?.status || mirror.status;
      mirror.error = nextExecution?.cancelError || null;
      changed = true;
    }
  }

  return changed;
}

async function syncCanceledOrderInTrades(user, canceledOrder, symbol) {
  if (!canceledOrder?.orderId) {
    return false;
  }

  const sanitizedOrder = sanitizeExecution(canceledOrder);
  let changed = false;

  for (const trade of db.tradeIntents) {
    if (
      user.role === "admin" &&
      trade.createdByUserId === user.id &&
      trade.adminExecution?.orderId === canceledOrder.orderId
    ) {
      if (!sameExecution(trade.adminExecution, sanitizedOrder)) {
        trade.adminExecution = sanitizedOrder;
        changed = true;
      }
      if (await cancelMirroredExecutionOrders(trade.mirroredExecutions, trade.symbol || symbol)) {
        changed = true;
      }
      continue;
    }

    for (const mirror of trade.mirroredExecutions || []) {
      if (mirror.userId === user.id && mirror.order?.orderId === canceledOrder.orderId) {
        if (!sameExecution(mirror.order, sanitizedOrder)) {
          mirror.order = sanitizedOrder;
          mirror.status = sanitizedOrder?.status || mirror.status;
          mirror.error = sanitizedOrder?.cancelError || null;
          changed = true;
        }
      }
    }

    for (const exitOrder of trade.exitOrders || []) {
      if (
        user.role === "admin" &&
        trade.createdByUserId === user.id &&
        exitOrder.adminExecution?.orderId === canceledOrder.orderId
      ) {
        if (!sameExecution(exitOrder.adminExecution, sanitizedOrder)) {
          exitOrder.adminExecution = sanitizedOrder;
          changed = true;
        }
        if (await cancelMirroredExecutionOrders(exitOrder.mirroredExecutions, trade.symbol || symbol)) {
          changed = true;
        }
        continue;
      }

      for (const mirror of exitOrder.mirroredExecutions || []) {
        if (mirror.userId === user.id && mirror.order?.orderId === canceledOrder.orderId) {
          if (!sameExecution(mirror.order, sanitizedOrder)) {
            mirror.order = sanitizedOrder;
            mirror.status = sanitizedOrder?.status || mirror.status;
            mirror.error = sanitizedOrder?.cancelError || null;
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    persist();
  }

  return changed;
}

function createExternalCloseExecution(quantity) {
  return {
    status: "FILLED",
    type: "MARKET",
    side: "SELL",
    price: "0",
    origQty: String(quantity),
    executedQty: String(quantity),
    cummulativeQuoteQty: "0",
    transactTime: Date.now(),
    external: true,
  };
}

function inferBaseAssetFromSymbol(symbol) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const quoteAsset = KNOWN_QUOTE_ASSETS.find(
    (item) => normalizedSymbol.endsWith(item) && normalizedSymbol.length > item.length
  );
  return quoteAsset ? normalizedSymbol.slice(0, -quoteAsset.length) : normalizedSymbol;
}

async function reconcileExternalClosuresForOwner(trade, ownerUser, accountInfo, openOrders, exchangeInfoOverride = null, userId = null) {
  const exchange = getTradeExchange(trade);
  const account = getExchangeAccount(ownerUser, exchange);
  if (!account || trade.side !== "BUY") {
    return false;
  }

  const remainingQty = getRemainingTradeQuantity(trade, userId);
  if (!remainingQty) {
    return false;
  }

  const hasOpenOrderForSymbol = getActiveOpenOrdersForSymbol(openOrders, trade.symbol).length > 0;
  if (hasOpenOrderForSymbol) {
    return false;
  }

  let baseAsset = inferBaseAssetFromSymbol(trade.symbol);
  let normalizedBalance = 0;
  let minQty = 0;
  let exchangeInfo;
  try {
    exchangeInfo = exchangeInfoOverride || (await getExchangeInfo(trade.symbol, account.testnet, exchange));
  } catch {
    exchangeInfo = null;
  }

  if (exchangeInfo) {
    try {
      const { filters } = getSymbolFilters(exchangeInfo, trade.symbol);
      baseAsset = getBaseAssetForSymbol(exchangeInfo, trade.symbol);
      const quantityFilter = getEffectiveQuantityFilter(filters, "MARKET");
      const balance = (accountInfo.balances || []).find((item) => item.asset === baseAsset);
      const totalBalance = Number(balance?.free || 0) + Number(balance?.locked || 0);
      normalizedBalance = quantityFilter
        ? Number(normalizeQuantityToStep(totalBalance, quantityFilter.stepSize))
        : totalBalance;
      minQty = Number(quantityFilter?.minQty || 0);
    } catch {
      exchangeInfo = null;
    }
  }

  if (!exchangeInfo) {
    const balance = (accountInfo.balances || []).find((item) => item.asset === baseAsset);
    normalizedBalance = Number(balance?.free || 0) + Number(balance?.locked || 0);
  }

  // Strict rule: if the connected exchange no longer shows a live order for the symbol and no
  // remaining base-asset balance is left in the account, the app must not continue showing the trade as open.
  if ((normalizedBalance || 0) > 0 && (!minQty || normalizedBalance >= minQty)) {
    return false;
  }

  const externalExit = {
    id: randomId(10),
    kind: "EXTERNAL_CLOSE",
    createdAt: nowIso(),
    side: "SELL",
    type: "MARKET",
    price: null,
    quantity: String(remainingQty),
    adminExecution: userId ? null : createExternalCloseExecution(remainingQty),
    mirroredExecutions: userId
      ? [
          {
            userId,
            userName: ownerUser.name,
            purpose: "EXTERNAL_CLOSE",
            status: "FILLED",
            error: null,
            order: createExternalCloseExecution(remainingQty),
          },
        ]
      : [],
  };

  trade.exitOrders.push(externalExit);
  return true;
}

function sameExecution(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

async function reconcileExecution(account, symbol, execution, exchange = getAccountExchange(account)) {
  if (!account || !symbol || !isExecutionActive(execution)) {
    return execution;
  }

  try {
    const latest = await getOrder(account, symbol, execution.orderId, exchange);
    return sanitizeExecution(latest);
  } catch {
    return execution;
  }
}

function shouldReconcileTrade(trade) {
  if (!trade) {
    return false;
  }

  if (isExecutionActive(trade.adminExecution)) {
    return true;
  }

  if (hasActiveMirroredExecution(trade.mirroredExecutions)) {
    return true;
  }

  if (hasActiveExitExecution(trade.exitOrders)) {
    return true;
  }

  return trade.side === "BUY" && trade.adminExecution?.status === "FILLED" && deriveTradeLifecycle(trade) === "OPEN";
}

async function reconcileTradeStatuses() {
  let changed = false;
  const ownerSnapshotCache = new Map();

  async function getOwnerSnapshot(user, exchange) {
    const account = getExchangeAccount(user, exchange);
    if (!account) {
      return null;
    }
    const key = `${user.id}:${exchange}`;
    if (ownerSnapshotCache.has(key)) {
      return ownerSnapshotCache.get(key);
    }
    try {
      const [accountInfo, openOrders] = await Promise.all([
        getAccountInfo(account, exchange),
        getOpenOrders(account, exchange),
      ]);
      const snapshot = { accountInfo, openOrders };
      ownerSnapshotCache.set(key, snapshot);
      return snapshot;
    } catch {
      const snapshot = null;
      ownerSnapshotCache.set(key, snapshot);
      return snapshot;
    }
  }

  for (const trade of db.tradeIntents) {
    if (!shouldReconcileTrade(trade)) {
      continue;
    }

    const previousTrade = cloneSerializable(trade);
    try {
      const admin = db.users.find((user) => user.id === trade.createdByUserId);
      const exchange = getTradeExchange(trade);
      const adminAccount = getExchangeAccount(admin, exchange);
      const nextAdminExecution = await reconcileExecution(adminAccount, trade.symbol, trade.adminExecution, exchange);
      if (!sameExecution(nextAdminExecution, trade.adminExecution)) {
        trade.adminExecution = nextAdminExecution;
        changed = true;
      }

      for (const mirror of trade.mirroredExecutions || []) {
        const user = db.users.find((item) => item.id === mirror.userId);
        const mirrorAccount = getExchangeAccount(user, normalizeExchange(mirror.exchange, exchange));
        const nextMirrorExecution = await reconcileExecution(
          mirrorAccount,
          trade.symbol,
          mirror.order,
          normalizeExchange(mirror.exchange, exchange)
        );
        if (!sameExecution(nextMirrorExecution, mirror.order)) {
          mirror.order = nextMirrorExecution;
          mirror.status = nextMirrorExecution?.status || mirror.status;
          mirror.error = nextMirrorExecution ? null : mirror.error;
          changed = true;
        }
      }

      for (const exitOrder of trade.exitOrders || []) {
        const nextExitAdminExecution = await reconcileExecution(adminAccount, trade.symbol, exitOrder.adminExecution, exchange);
        if (!sameExecution(nextExitAdminExecution, exitOrder.adminExecution)) {
          exitOrder.adminExecution = nextExitAdminExecution;
          changed = true;
        }

        for (const mirror of exitOrder.mirroredExecutions || []) {
          const user = db.users.find((item) => item.id === mirror.userId);
          const mirrorAccount = getExchangeAccount(user, normalizeExchange(mirror.exchange, exchange));
          const nextMirrorExecution = await reconcileExecution(
            mirrorAccount,
            trade.symbol,
            mirror.order,
            normalizeExchange(mirror.exchange, exchange)
          );
          if (!sameExecution(nextMirrorExecution, mirror.order)) {
            mirror.order = nextMirrorExecution;
            mirror.status = nextMirrorExecution?.status || mirror.status;
            mirror.error = nextMirrorExecution ? null : mirror.error;
            changed = true;
          }
        }
      }

      const adminSnapshot = await getOwnerSnapshot(admin, exchange);
      if (
        trade.adminExecution?.status === "FILLED" &&
        deriveTradeLifecycle(trade) === "OPEN" &&
        adminSnapshot
      ) {
        const exchangeInfo = await getExchangeInfo(trade.symbol, adminAccount?.testnet, exchange).catch(() => null);
        if (exchangeInfo) {
          const adminExternallyClosed = await reconcileExternalClosuresForOwner(
            trade,
            admin,
            adminSnapshot.accountInfo,
            adminSnapshot.openOrders,
            exchangeInfo
          );
          if (adminExternallyClosed) {
            changed = true;
          }

          for (const mirror of trade.mirroredExecutions || []) {
            const user = db.users.find((item) => item.id === mirror.userId);
            if (!user || mirror.order?.status !== "FILLED") {
              continue;
            }
            const mirrorExchange = normalizeExchange(mirror.exchange, exchange);
            const userSnapshot = await getOwnerSnapshot(user, mirrorExchange);
            if (!userSnapshot) {
              continue;
            }
            const userExternallyClosed = await reconcileExternalClosuresForOwner(
              trade,
              user,
              userSnapshot.accountInfo,
              userSnapshot.openOrders,
              exchangeInfo,
              mirror.userId
            );
            if (userExternallyClosed) {
              changed = true;
            }
          }
        }
      }

      if (
        trade.side === "BUY" &&
        trade.adminExecution?.status === "FILLED" &&
        trade.takeProfitTargetPrice &&
        getRemainingTradeQuantity(trade) > 0 &&
        !hasAnyTakeProfitHistory(trade)
      ) {
        await autoPlaceTakeProfit(trade);
        changed = true;
      }

      if (
        String(previousTrade?.adminExecution?.status || "").trim().toUpperCase() !== "FILLED"
        && String(trade?.adminExecution?.status || "").trim().toUpperCase() === "FILLED"
      ) {
        emitOrderExecuted({
          eventKey: `${trade.id}:${trade.adminExecution?.orderId || trade.adminExecution?.clientOrderId || trade.adminExecution?.transactTime || "entry"}`,
          exchange,
          trade,
          execution: trade.adminExecution,
          kind: "ENTRY",
        });
      }

      if (JSON.stringify(previousTrade || null) !== JSON.stringify(trade)) {
        await tradeListener.handleTradeUpdated(previousTrade, trade).catch((error) => {
          console.error(`Trade listener update failed for trade ${trade.id}:`, error.message);
        });
        if (deriveTradeLifecycle(previousTrade) !== "CLOSED" && deriveTradeLifecycle(trade) === "CLOSED") {
          await recordTradeForLearning(trade);
        }
      }
    } catch (error) {
      console.error(`Failed to reconcile trade ${trade.id}:`, error.message);
    }
  }

  if (changed) {
    persist();
  }
}

function startTradeReconciliation(force = false) {
  const now = Date.now();

  if (tradeReconcilePromise) {
    return tradeReconcilePromise;
  }

  if (!force && now - lastTradeReconcileStartedAt < TRADE_RECONCILE_COOLDOWN_MS) {
    return null;
  }

  lastTradeReconcileStartedAt = now;
  tradeReconcilePromise = reconcileTradeStatuses()
    .catch((error) => {
      console.error("Trade reconciliation failed:", error.message);
    })
    .finally(() => {
      tradeReconcilePromise = null;
    });

  return tradeReconcilePromise;
}

async function waitForTradeReconciliation(timeoutMs = TRADE_RECONCILE_WAIT_MS) {
  const promise = startTradeReconciliation();
  if (!promise) {
    return;
  }

  await Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

function deriveTradeLifecycle(trade) {
  const exitStatuses = (trade.exitOrders || []).map((exitOrder) => exitOrder.adminExecution?.status).filter(Boolean);
  if (exitStatuses.includes("FILLED")) {
    return "CLOSED";
  }
  if (trade.adminExecution?.status === "NEW" || trade.adminExecution?.status === "PARTIALLY_FILLED") {
    return "PENDING";
  }
  if (trade.adminExecution?.status === "FILLED" && trade.side === "BUY") {
    return "OPEN";
  }
  if (trade.adminExecution?.status === "FILLED" && trade.side === "SELL") {
    return "CLOSED";
  }
  if (trade.adminExecution?.status === "CANCELED") {
    return "CANCELED";
  }
  if (trade.adminExecution?.status === "ERROR") {
    return "ERROR";
  }
  return "OPEN";
}

function getStrategyReason(trade) {
  return String(trade?.strategyContext?.reason || "").trim() || "Trend Pullback Breakout";
}

function getFilledExitExecutions(trade) {
  return (trade?.exitOrders || [])
    .map((exitOrder) => exitOrder?.adminExecution || null)
    .filter((execution) => execution && ["FILLED", "PARTIALLY_FILLED"].includes(String(execution.status || "").toUpperCase()));
}

function getWeightedAverageExecutionPrice(executions = []) {
  const weighted = executions.reduce((summary, execution) => {
    const quantity = getExecutionFilledQty(execution);
    const price = getExecutionAveragePrice(execution);
    if (quantity <= 0 || price <= 0) {
      return summary;
    }

    return {
      quantity: summary.quantity + quantity,
      notional: summary.notional + (quantity * price),
    };
  }, { quantity: 0, notional: 0 });

  return weighted.quantity > 0 ? weighted.notional / weighted.quantity : 0;
}

function buildClosedTradeLearningRecord(trade) {
  if (!trade || trade.side !== "BUY") {
    return null;
  }

  const lifecycle = deriveTradeLifecycle(trade);
  if (lifecycle !== "CLOSED") {
    return null;
  }

  const entryPrice = getExecutionAveragePrice(trade.adminExecution) || Number(trade.price || 0);
  const exitExecutions = getFilledExitExecutions(trade);
  const exitPrice = getWeightedAverageExecutionPrice(exitExecutions);
  const quantity = Math.min(getTradeFilledEntryQuantity(trade), getTradeExitedQuantity(trade));
  if (entryPrice <= 0 || exitPrice <= 0 || quantity <= 0) {
    return null;
  }

  const profitValue = (exitPrice - entryPrice) * quantity;
  const profitPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
  const learningContext = trade?.strategyContext?.learningContext || {};

  return {
    tradeKey: String(trade.id),
    tradeId: String(trade.id),
    strategyType: String(trade?.strategyContext?.type || "MANUAL").trim().toUpperCase(),
    exchange: getTradeExchange(trade),
    symbol: String(trade.symbol || "").trim().toUpperCase(),
    entryPrice,
    exitPrice,
    side: String(trade.side || "").trim().toUpperCase(),
    indicators: {
      ...(learningContext.indicators || {}),
    },
    support: Number(learningContext.support || 0) || null,
    resistance: Number(learningContext.resistance || 0) || null,
    result: profitPercent >= 0 ? "win" : "loss",
    profitPercent: Number(profitPercent.toFixed(6)),
    profitValue: Number(profitValue.toFixed(6)),
    entryQuantity: Number(quantity.toFixed(8)),
    reason: getStrategyReason(trade),
    timestamp: trade.createdAt || nowIso(),
    closedAt: exitExecutions[exitExecutions.length - 1]?.transactTime
      ? new Date(Number(exitExecutions[exitExecutions.length - 1].transactTime)).toISOString()
      : nowIso(),
  };
}

async function recordTradeForLearning(trade) {
  const learningRecord = buildClosedTradeLearningRecord(trade);
  if (!learningRecord) {
    return { ok: false, skipped: true, reason: "trade_not_ready" };
  }

  return tradeLearningService.recordTrade(learningRecord).catch((error) => {
    console.error(`Trade learning record failed for ${learningRecord.tradeId}:`, error.message || error);
    return { ok: false, skipped: false, error: error.message || String(error) };
  });
}

async function syncTradeLearningHistory() {
  if (!tradeLearningService.isEnabled()) {
    return;
  }

  let syncedCount = 0;
  for (const trade of db.tradeIntents || []) {
    const result = await recordTradeForLearning(trade);
    if (result?.ok) {
      syncedCount += 1;
    }
  }

  console.log(`Trade learning history sync complete. ${syncedCount} closed trade${syncedCount === 1 ? "" : "s"} indexed.`);
}

function serializeTradeForAdmin(trade) {
  return {
    ...trade,
    exchange: getTradeExchange(trade),
    lifecycleStatus: deriveTradeLifecycle(trade),
  };
}

function serializeTradeForUser(trade, userId) {
  const mirror = (trade.mirroredExecutions || []).find((item) => item.userId === userId);
  const exits = (trade.exitOrders || []).map((item) => ({
    ...item,
    mirroredExecution: (item.mirroredExecutions || []).find((row) => row.userId === userId) || null,
  }));
  return {
    id: trade.id,
    createdAt: trade.createdAt,
    symbol: trade.symbol,
    side: trade.side,
    type: trade.type,
    quantity: trade.quantity,
    quoteOrderQty: trade.quoteOrderQty,
    price: trade.price,
    exchange: getTradeExchange(trade),
    takeProfitTargetPrice: trade.takeProfitTargetPrice,
    stopLossTargetPrice: trade.stopLossTargetPrice || null,
    strategyContext: trade.strategyContext || null,
    lifecycleStatus: deriveTradeLifecycle(trade),
    adminExecution: trade.adminExecution,
    mirroredExecution: mirror || null,
    exitOrders: exits,
  };
}

function normalizeOrderInput(body) {
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const side = String(body.side || "").trim().toUpperCase();
  const type = String(body.type || "").trim().toUpperCase();
  const timeInForce = String(body.timeInForce || "GTC").trim().toUpperCase();
  const quantity = body.quantity ? String(body.quantity).trim() : "";
  const quoteOrderQty = body.quoteOrderQty ? String(body.quoteOrderQty).trim() : "";
  const price = body.price ? String(body.price).trim() : "";
  const takeProfitPrice = body.takeProfitPrice ? String(body.takeProfitPrice).trim() : "";

  if (!symbol) {
    throw new Error("Symbol is required.");
  }
  if (!["BUY", "SELL"].includes(side)) {
    throw new Error("Side must be BUY or SELL.");
  }
  if (!["MARKET", "LIMIT"].includes(type)) {
    throw new Error("Type must be MARKET or LIMIT.");
  }
  if (type === "MARKET" && !quantity && !quoteOrderQty) {
    throw new Error("Provide quantity or quote order size for market orders.");
  }
  if (type === "LIMIT" && (!quantity || !price)) {
    throw new Error("Limit orders require both quantity and entry price.");
  }

  return {
    symbol,
    side,
    type,
    timeInForce: type === "LIMIT" ? timeInForce : undefined,
    quantity: quantity || undefined,
    quoteOrderQty: quoteOrderQty || undefined,
    price: price || undefined,
    takeProfitPrice: takeProfitPrice || undefined,
  };
}

function getSymbolFilters(exchangeInfo, symbol) {
  const details = exchangeInfo.symbols?.find((item) => item.symbol === symbol);
  if (!details) {
    throw new Error(`Symbol ${symbol} was not found on the selected exchange.`);
  }
  return {
    details,
    filters: details.filters || [],
  };
}

function getFilter(filters, type) {
  return filters.find((item) => item.filterType === type) || null;
}

function hasPositiveFilterValue(filter, key) {
  return Number(filter?.[key] || 0) > 0;
}

function getEffectiveQuantityFilter(filters, type = "LIMIT") {
  const marketFilter = getFilter(filters, "MARKET_LOT_SIZE");
  const lotSizeFilter = getFilter(filters, "LOT_SIZE");
  const marketFilterUsable =
    marketFilter && (hasPositiveFilterValue(marketFilter, "stepSize") || hasPositiveFilterValue(marketFilter, "minQty"));
  const lotSizeUsable =
    lotSizeFilter && (hasPositiveFilterValue(lotSizeFilter, "stepSize") || hasPositiveFilterValue(lotSizeFilter, "minQty"));

  if (type === "MARKET" && marketFilterUsable) {
    return marketFilter;
  }
  if (lotSizeUsable) {
    return lotSizeFilter;
  }
  if (marketFilterUsable) {
    return marketFilter;
  }
  return lotSizeFilter || marketFilter || null;
}

function getBaseAssetForSymbol(exchangeInfo, symbol) {
  const details = exchangeInfo.symbols?.find((item) => item.symbol === symbol);
  if (details?.baseAsset) {
    return details.baseAsset;
  }
  return inferBaseAssetFromSymbol(symbol);
}

function countDecimals(value) {
  const text = String(value || "").trim();
  if (!text.includes(".")) {
    return 0;
  }
  return text.split(".")[1].replace(/0+$/, "").length;
}

function formatStepNumber(value, stepSize) {
  const decimals = countDecimals(stepSize);
  if (!Number.isFinite(value)) {
    return "0";
  }
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function normalizeQuantityToStep(quantity, stepSize) {
  const qty = Number(quantity || 0);
  const step = Number(stepSize || 0);
  if (!qty || !step) {
    return "0";
  }

  const decimals = countDecimals(stepSize);
  const scale = 10 ** decimals;
  const stepUnits = Math.round(step * scale);
  const qtyUnits = Math.floor((qty + Number.EPSILON) * scale);
  const normalizedUnits = Math.floor(qtyUnits / stepUnits) * stepUnits;
  return formatStepNumber(normalizedUnits / scale, stepSize);
}

function normalizePriceToTick(price, tickSize) {
  const rawPrice = Number(price || 0);
  const tick = Number(tickSize || 0);
  if (!rawPrice || !tick) {
    return "0";
  }

  const decimals = countDecimals(tickSize);
  const scale = 10 ** decimals;
  const tickUnits = Math.round(tick * scale);
  const priceUnits = Math.round(rawPrice * scale);
  const normalizedUnits = Math.round(priceUnits / tickUnits) * tickUnits;
  return formatStepNumber(normalizedUnits / scale, tickSize);
}

async function normalizeOrderForExchange(account, orderInput, exchangeInfoOverride = null) {
  const exchange = getAccountExchange(account);
  const exchangeLabel = getExchangeLabel(exchange);
  const exchangeInfo = exchangeInfoOverride || (await getExchangeInfo(orderInput.symbol, account.testnet, exchange));
  const { filters } = getSymbolFilters(exchangeInfo, orderInput.symbol);
  const normalized = { ...orderInput };

  if (normalized.price) {
    const priceFilter = getFilter(filters, "PRICE_FILTER");
    if (priceFilter?.tickSize && Number(priceFilter.tickSize) > 0) {
      const normalizedPrice = normalizePriceToTick(normalized.price, priceFilter.tickSize);
      const minPrice = Number(priceFilter.minPrice || 0);
      const maxPrice = Number(priceFilter.maxPrice || 0);

      if (!Number(normalizedPrice)) {
        throw new Error(
          `Price is too small for ${normalized.symbol}. ${exchangeLabel} tick size for this market is ${priceFilter.tickSize}.`
        );
      }

      if (minPrice && Number(normalizedPrice) < minPrice) {
        throw new Error(
          `Price is too low for ${normalized.symbol}. ${exchangeLabel} requires at least ${priceFilter.minPrice} for this market.`
        );
      }

      if (maxPrice && Number(normalizedPrice) > maxPrice) {
        throw new Error(
          `Price is too high for ${normalized.symbol}. ${exchangeLabel} allows at most ${priceFilter.maxPrice} for this market.`
        );
      }

      normalized.price = normalizedPrice;
    }
  }

  if (!normalized.quantity) {
    return normalized;
  }

  const quantityFilter = getEffectiveQuantityFilter(filters, normalized.type);

  if (!quantityFilter) {
    return normalized;
  }

  const normalizedQuantity = normalizeQuantityToStep(normalized.quantity, quantityFilter.stepSize);
  const minQty = Number(quantityFilter.minQty || 0);
  const maxQty = Number(quantityFilter.maxQty || 0);

  if (!Number(normalizedQuantity)) {
    throw new Error(
      `Quantity is too small for ${normalized.symbol}. ${exchangeLabel} step size for this market is ${quantityFilter.stepSize}.`
    );
  }

  if (minQty && Number(normalizedQuantity) < minQty) {
    throw new Error(
      `Quantity is too small for ${normalized.symbol}. ${exchangeLabel} requires at least ${quantityFilter.minQty} units for this order type.`
    );
  }

  if (maxQty && Number(normalizedQuantity) > maxQty) {
    throw new Error(
      `Quantity is too large for ${normalized.symbol}. ${exchangeLabel} allows at most ${quantityFilter.maxQty} units for this order type.`
    );
  }

  normalized.quantity = normalizedQuantity;
  return normalized;
}

async function validateNotionalRule(account, orderInput, exchangeInfoOverride = null) {
  const exchange = getAccountExchange(account);
  const exchangeLabel = getExchangeLabel(exchange);
  const exchangeInfo = exchangeInfoOverride || (await getExchangeInfo(orderInput.symbol, account.testnet, exchange));
  const { filters } = getSymbolFilters(exchangeInfo, orderInput.symbol);
  const notionalFilter = getFilter(filters, "NOTIONAL") || getFilter(filters, "MIN_NOTIONAL");

  if (!notionalFilter) {
    return;
  }

  let estimatedNotional = 0;
  if (orderInput.quoteOrderQty) {
    estimatedNotional = Number(orderInput.quoteOrderQty);
  } else {
    const qty = Number(orderInput.quantity || 0);
    if (!qty) {
      return;
    }
    let price = Number(orderInput.price || 0);
    if (!price) {
      const ticker = await getTickerPrice(orderInput.symbol, account.testnet, exchange);
      price = Number(ticker.price || 0);
    }
    estimatedNotional = qty * price;
  }

  const minNotional = Number(notionalFilter.minNotional || 0);
  const maxNotional = Number(notionalFilter.maxNotional || 0);

  if (minNotional && estimatedNotional < minNotional) {
    throw new Error(
      `Order value is too small for ${orderInput.symbol}. Estimated notional is ${estimatedNotional.toFixed(
        8
      )} USDT, but ${exchangeLabel} requires at least ${minNotional} USDT for this market. Increase quantity or price before selling.`
    );
  }

  if (maxNotional && estimatedNotional > maxNotional) {
    throw new Error(
      `Order value is too large for ${orderInput.symbol}. Estimated notional is ${estimatedNotional.toFixed(
        8
      )} USDT, but ${exchangeLabel} allows at most ${maxNotional} USDT for this market.`
    );
  }
}

async function getMaxSellQuantityForAccount(
  account,
  symbol,
  exchangeInfoOverride = null,
  type = "MARKET",
  requestedQuantity = null
) {
  const exchange = getAccountExchange(account);
  const exchangeLabel = getExchangeLabel(exchange);
  const exchangeInfo = exchangeInfoOverride || (await getExchangeInfo(symbol, account.testnet, exchange));
  const { filters } = getSymbolFilters(exchangeInfo, symbol);
  const baseAsset = getBaseAssetForSymbol(exchangeInfo, symbol);
  const accountInfo = await getAccountInfo(account, exchange);
  const balance = (accountInfo.balances || []).find((item) => item.asset === baseAsset);
  const freeQuantity = Number(balance?.free || 0);
  const requested = Number(requestedQuantity || 0);
  const targetQuantity = requested > 0 ? Math.min(freeQuantity, requested) : freeQuantity;

  if (!freeQuantity) {
    throw new Error(`No free ${baseAsset} balance is available to sell on ${exchangeLabel} right now.`);
  }

  const quantityFilter = getEffectiveQuantityFilter(filters, type);

  if (!quantityFilter) {
    return String(targetQuantity);
  }

  const normalizedQuantity = normalizeQuantityToStep(targetQuantity, quantityFilter.stepSize);
  const minQty = Number(quantityFilter.minQty || 0);
  const maxQty = Number(quantityFilter.maxQty || 0);

  if (!Number(normalizedQuantity)) {
    throw new Error(
      `Your free ${baseAsset} balance is ${freeQuantity}, but ${exchangeLabel}'s ${type.toLowerCase()} sell step for ${symbol} is ${quantityFilter.stepSize} with a minimum quantity of ${quantityFilter.minQty}. This balance is too small for a ${exchangeLabel} spot sell order.`
    );
  }

  if (minQty && Number(normalizedQuantity) < minQty) {
    throw new Error(
      `Your free ${baseAsset} balance is ${freeQuantity}, but ${exchangeLabel} requires at least ${quantityFilter.minQty} ${baseAsset} for a ${type.toLowerCase()} sell on ${symbol}. This is below ${exchangeLabel}'s minimum spot order size.`
    );
  }

  if (maxQty && Number(normalizedQuantity) > maxQty) {
    throw new Error(
      `The available ${baseAsset} balance is above ${exchangeLabel}'s allowed maximum of ${quantityFilter.maxQty} ${baseAsset} for one order.`
    );
  }

  return normalizedQuantity;
}

async function resolveSellOrderInputForExchange(account, orderInput, exchangeInfoOverride = null) {
  if (orderInput.side !== "SELL") {
    return orderInput;
  }

  if (orderInput.type !== "MARKET" || !orderInput.quoteOrderQty || orderInput.quantity) {
    return {
      ...orderInput,
      quoteOrderQty: undefined,
    };
  }

  const exchange = getAccountExchange(account);
  const ticker = await getTickerPrice(orderInput.symbol, account.testnet, exchange);
  const price = Number(ticker.price || 0);
  const requestedQuoteValue = Number(orderInput.quoteOrderQty || 0);

  if (!price) {
    throw new Error(`Unable to determine a live price for ${orderInput.symbol} before selling.`);
  }
  if (!requestedQuoteValue) {
    throw new Error("Enter a sell amount before placing the order.");
  }

  const quantity = await getMaxSellQuantityForAccount(
    account,
    orderInput.symbol,
    exchangeInfoOverride,
    orderInput.type,
    requestedQuoteValue / price
  );

  return {
    ...orderInput,
    quantity,
    quoteOrderQty: undefined,
  };
}

async function executeOrderForUser(user, orderInput, purpose, exchange) {
  const normalizedExchange = normalizeExchange(exchange, getPreferredExchange(user));
  const account = getExchangeAccount(user, normalizedExchange);
  if (!account) {
    return {
      userId: user.id,
      userName: user.name,
      exchange: normalizedExchange,
      purpose,
      status: "SKIPPED",
      error: `No ${getExchangeLabel(normalizedExchange)} account connected.`,
      order: null,
    };
  }

  try {
    const exchangeInfo = await getExchangeInfo(orderInput.symbol, account.testnet, normalizedExchange);
    const resolvedOrderInput = await resolveSellOrderInputForExchange(
      { ...account, exchange: normalizedExchange },
      orderInput,
      exchangeInfo
    );
    const normalizedOrderInput = await normalizeOrderForExchange(
      { ...account, exchange: normalizedExchange },
      resolvedOrderInput,
      exchangeInfo
    );
    await validateNotionalRule({ ...account, exchange: normalizedExchange }, normalizedOrderInput, exchangeInfo);
    const order = await placeSpotOrder({ ...account, exchange: normalizedExchange }, normalizedOrderInput, normalizedExchange);
    account.lastValidatedAt = nowIso();
    persist();
    return {
      userId: user.id,
      userName: user.name,
      exchange: normalizedExchange,
      purpose,
      status: order.status,
      error: null,
      order: sanitizeExecution(order),
    };
  } catch (error) {
    return {
      userId: user.id,
      userName: user.name,
      exchange: normalizedExchange,
      purpose,
      status: "ERROR",
      error: error.message,
      order: null,
    };
  }
}

async function buildMirroredEntryOrderForUser(user, orderInput, exchange) {
  const normalizedExchange = normalizeExchange(exchange, getPreferredExchange(user));
  const account = getExchangeAccount(user, normalizedExchange);
  if (!account) {
    throw new Error(`No ${getExchangeLabel(normalizedExchange)} account connected.`);
  }

  const exchangeInfo = await getExchangeInfo(orderInput.symbol, account.testnet, normalizedExchange);
  const { details } = getSymbolFilters(exchangeInfo, orderInput.symbol);
  const quoteAsset = details.quoteAsset || "USDT";
  const ticker = await getTickerPrice(orderInput.symbol, account.testnet, normalizedExchange);
  const priceReference = Number(orderInput.price || ticker.price || 0);
  const accountInfo = await getAccountInfo({ ...account, exchange: normalizedExchange }, normalizedExchange);

  if (orderInput.side === "SELL") {
    const quantity = await getMaxSellQuantityForAccount(
      { ...account, exchange: normalizedExchange },
      orderInput.symbol,
      exchangeInfo,
      orderInput.type,
      orderInput.quantity
    );
    return {
      ...orderInput,
      quantity,
      quoteOrderQty: undefined,
    };
  }

  const quoteBalance = Number((accountInfo.balances || []).find((item) => item.asset === quoteAsset)?.free || 0);
  if (!quoteBalance) {
    throw new Error(`No free ${quoteAsset} balance is available for mirrored buy orders.`);
  }
  if (!priceReference) {
    throw new Error(`Unable to determine a live price for ${orderInput.symbol}.`);
  }

  const requestedSpend = orderInput.quoteOrderQty
    ? Number(orderInput.quoteOrderQty || 0)
    : Number(orderInput.quantity || 0) * priceReference;
  const spendAmount = requestedSpend > 0 ? Math.min(requestedSpend, quoteBalance) : quoteBalance;

  if (!spendAmount) {
    throw new Error(`No spendable ${quoteAsset} balance is available for mirrored buy orders.`);
  }

  if (orderInput.type === "MARKET" && orderInput.quoteOrderQty) {
    return {
      ...orderInput,
      quantity: undefined,
      quoteOrderQty: String(spendAmount),
    };
  }

  const requestedQuantity = Number(orderInput.quantity || 0);
  const affordableQuantity = spendAmount / priceReference;
  const mirroredQuantity = requestedQuantity > 0
    ? Math.min(requestedQuantity, affordableQuantity)
    : affordableQuantity;

  return {
    ...orderInput,
    quantity: String(mirroredQuantity),
    quoteOrderQty: undefined,
  };
}

function getMirroringUsers(exchange) {
  return db.users.filter(
    (user) =>
      user.role === "user" &&
      user.mirrorEnabled &&
      getExchangeAccount(user, exchange) &&
      getExchangeAccount(user, exchange).permissions?.canTrade
  );
}

async function createTradeIntent(admin, exchange, orderInput, options = {}) {
  const exchangeLabel = getExchangeLabel(exchange);
  const adminAccount = getExchangeAccount(admin, exchange);
  if (!adminAccount) {
    throw new Error(`Connect the admin ${exchangeLabel} account first.`);
  }

  const exchangeInfo = await getExchangeInfo(orderInput.symbol, adminAccount.testnet, exchange);
  const resolvedOrderInput = await resolveSellOrderInputForExchange({ ...adminAccount, exchange }, orderInput, exchangeInfo);
  const normalizedOrderInput = await normalizeOrderForExchange({ ...adminAccount, exchange }, resolvedOrderInput, exchangeInfo);
  await validateNotionalRule({ ...adminAccount, exchange }, normalizedOrderInput, exchangeInfo);
  const adminOrder = await placeSpotOrder({ ...adminAccount, exchange }, normalizedOrderInput, exchange);
  const trade = {
    id: randomId(12),
    createdAt: nowIso(),
    createdByUserId: admin.id,
    createdByName: admin.name,
    exchange,
    symbol: normalizedOrderInput.symbol,
    side: normalizedOrderInput.side,
    type: normalizedOrderInput.type,
    quantity: normalizedOrderInput.quantity || null,
    quoteOrderQty: normalizedOrderInput.quoteOrderQty || null,
    price: normalizedOrderInput.price || null,
    timeInForce: normalizedOrderInput.timeInForce || null,
    takeProfitTargetPrice: options.takeProfitTargetPrice || normalizedOrderInput.takeProfitPrice || null,
    stopLossTargetPrice: options.stopLossTargetPrice || null,
    adminExecution: sanitizeExecution(adminOrder),
    mirroredExecutions: [],
    exitOrders: [],
    strategyContext: options.strategyContext || null,
  };

  for (const follower of getMirroringUsers(exchange)) {
    const mirroredOrderInput = await buildMirroredEntryOrderForUser(follower, normalizedOrderInput, exchange)
      .catch((error) => ({
        __mirrorError: error.message,
      }));
    const child = mirroredOrderInput?.__mirrorError
      ? {
          userId: follower.id,
          userName: follower.name,
          exchange,
          purpose: "ENTRY",
          status: "SKIPPED",
          error: mirroredOrderInput.__mirrorError,
          order: null,
        }
      : await executeOrderForUser(follower, mirroredOrderInput, "ENTRY", exchange);
    trade.mirroredExecutions.push(child);
  }

  db.tradeIntents.unshift(trade);
  persist();
  await tradeListener.handleTradeCreated(trade).catch((error) => {
    console.error(`Trade listener create event failed for trade ${trade.id}:`, error.message);
  });
  if (String(trade.adminExecution?.status || "").trim().toUpperCase() === "FILLED") {
    emitOrderExecuted({
      eventKey: `${trade.id}:${trade.adminExecution?.orderId || trade.adminExecution?.clientOrderId || "entry"}`,
      exchange,
      trade,
      execution: trade.adminExecution,
      kind: "ENTRY",
    });
  }

  let tpOrder = null;
  if (trade.takeProfitTargetPrice && trade.side === "BUY") {
    tpOrder = await autoPlaceTakeProfit(trade, { force: true });
    if (tpOrder?.adminExecution?.status === "ERROR" && options.throwOnTpFailure !== false) {
      throw new Error(tpOrder.adminExecution.error || `Unable to place the take-profit order on ${exchangeLabel}.`);
    }
    if (tpOrder) {
      await tradeListener.handleExitOrderCreated(trade, tpOrder).catch((error) => {
        console.error(`Trade listener take-profit placement failed for trade ${trade.id}:`, error.message);
      });
    }
  }

  return {
    trade,
    tpOrder,
    normalizedOrderInput,
  };
}

async function executeSignalAutoTrade(signal, context = {}) {
  const settings = normalizeSignalAutoTradeConfig(context.config || autoTradeService.getConfig());
  const admin = getSignalAutoTradeAdminUser();
  if (!admin) {
    return { ok: false, skipped: true, reason: "admin_not_found" };
  }

  const exchange = getConnectedExchange(admin, getPreferredExchange(admin));
  const account = getExchangeAccount(admin, exchange);
  if (!account) {
    return { ok: false, skipped: true, reason: "admin_exchange_not_connected" };
  }
  if (!account.permissions?.canTrade) {
    return { ok: false, skipped: true, reason: "admin_exchange_trade_permission_missing" };
  }

  const activeAutoTrades = listActiveSignalAutoTrades({ exchange });
  if (activeAutoTrades.length >= Number(settings.maxSimultaneousTrades || SIGNAL_AUTO_TRADE_DEFAULT_MAX_SIMULTANEOUS_TRADES)) {
    return { ok: false, skipped: true, reason: "max_auto_trade_slots_reached" };
  }

  const exchangeInfo = await getExchangeInfo(signal.symbol, account.testnet, exchange);
  const { details } = getSymbolFilters(exchangeInfo, signal.symbol);
  const quoteAsset = String(details.quoteAsset || "USDT").toUpperCase();
  const accountInfo = await getAccountInfo({ ...account, exchange }, exchange);
  const freeQuoteBalance = Number(
    (accountInfo.balances || []).find((item) => String(item.asset || "").toUpperCase() === quoteAsset)?.free || 0
  );

  if (freeQuoteBalance <= 0) {
    return { ok: false, skipped: true, reason: "insufficient_quote_balance" };
  }

  const allocationPercent = activeAutoTrades.length === 0
    ? Number(settings.firstTradeBalancePercent || SIGNAL_AUTO_TRADE_DEFAULT_FIRST_BALANCE_PERCENT)
    : Number(settings.secondTradeBalancePercent || SIGNAL_AUTO_TRADE_DEFAULT_SECOND_BALANCE_PERCENT);
  const spendAmount = freeQuoteBalance * (allocationPercent / 100);

  if (spendAmount <= 0) {
    return { ok: false, skipped: true, reason: "calculated_spend_amount_invalid" };
  }

  const orderInput = {
    symbol: signal.symbol,
    side: "BUY",
    type: "MARKET",
    quoteOrderQty: String(spendAmount),
  };

  const { trade, normalizedOrderInput } = await createTradeIntent(admin, exchange, orderInput, {
    throwOnTpFailure: false,
    takeProfitTargetPrice: signal.takeProfit ? String(signal.takeProfit) : null,
    stopLossTargetPrice: signal.stopLoss ? String(signal.stopLoss) : null,
    strategyContext: {
      type: SIGNAL_AUTO_TRADE_STRATEGY_TYPE,
      reason: `${String(signal.strategy || "SIGNAL").replace(/_/g, " ")} auto signal`,
      signalReason: String(signal?.meta?.reason || "").trim() || "Signal engine qualified this setup.",
      source: "signal_engine",
      signalId: signal.id,
      signalSymbol: signal.symbol,
      signalStrategy: signal.strategy,
      signalTimeframe: signal.timeframe,
      signalConfidence: Number(signal.confidence || 0),
      autoTrade: {
        allocationPercent,
        activeTradesBefore: activeAutoTrades.length,
        maxSimultaneousTrades: Number(settings.maxSimultaneousTrades || SIGNAL_AUTO_TRADE_DEFAULT_MAX_SIMULTANEOUS_TRADES),
      },
      learningContext: {
        strategyType: String(signal.strategy || "SIGNAL").trim().toUpperCase(),
        timeframe: String(signal.timeframe || "").trim(),
        indicators: {
          confidence: Number(signal.confidence || 0),
        },
      },
    },
  });

  return {
    ok: true,
    tradeId: trade.id,
    exchange,
    symbol: signal.symbol,
    quoteAsset,
    allocationPercent,
    spendAmount: Number(spendAmount.toFixed(8)),
    orderInput: {
      symbol: normalizedOrderInput.symbol,
      side: normalizedOrderInput.side,
      type: normalizedOrderInput.type,
      quoteOrderQty: normalizedOrderInput.quoteOrderQty || null,
      quantity: normalizedOrderInput.quantity || null,
    },
  };
}

autoTradeService.setExecutor(executeSignalAutoTrade);

async function executeTradeExit(trade, admin, options = {}) {
  const exchange = getTradeExchange(trade);
  const adminAccount = getExchangeAccount(admin, exchange);
  if (!adminAccount) {
    throw new Error(`Connect the admin ${getExchangeLabel(exchange)} account first.`);
  }

  const type = String(options.type || "MARKET").trim().toUpperCase();
  const price = options.price ? String(options.price).trim() : undefined;
  const kind = String(options.kind || "MANUAL_SELL").trim().toUpperCase();
  if (type === "LIMIT" && !price) {
    throw new Error("Limit sell requires a price.");
  }

  const exchangeInfo = await getExchangeInfo(trade.symbol, adminAccount.testnet, exchange);
  if (options.cancelTakeProfits !== false) {
    await cancelActiveTakeProfitOrders(trade);
  }

  const quantity =
    type === "MARKET"
      ? await getMaxSellQuantityForAccount({ ...adminAccount, exchange }, trade.symbol, exchangeInfo, type, options.quantity)
      : String(options.quantity || getRemainingTradeQuantity(trade) || "").trim() || undefined;

  if (!quantity) {
    throw new Error("No remaining quantity is available to close this trade.");
  }

  const exitOrder = {
    id: randomId(10),
    kind,
    createdAt: nowIso(),
    side: "SELL",
    type,
    price: price || null,
    quantity,
    exchange,
    reason: options.reason || null,
    triggerPrice: options.triggerPrice ? String(options.triggerPrice) : null,
    adminExecution: null,
    mirroredExecutions: [],
  };

  const exitInput = {
    symbol: trade.symbol,
    side: "SELL",
    type,
    quantity,
    price,
    timeInForce: type === "LIMIT" ? "GTC" : undefined,
  };
  const normalizedExitInput = await normalizeOrderForExchange({ ...adminAccount, exchange }, exitInput, exchangeInfo);
  exitOrder.quantity = normalizedExitInput.quantity || exitOrder.quantity;
  await validateNotionalRule({ ...adminAccount, exchange }, normalizedExitInput, exchangeInfo);
  const adminOrder = await placeSpotOrder({ ...adminAccount, exchange }, normalizedExitInput, exchange);
  exitOrder.adminExecution = sanitizeExecution(adminOrder);

  for (const child of trade.mirroredExecutions || []) {
    const user = db.users.find((item) => item.id === child.userId);
    const childExchange = normalizeExchange(child.exchange, exchange);
    const childAccount = getExchangeAccount(user, childExchange);
    let childQty = "";

    if (childAccount && type === "MARKET") {
      try {
        childQty = await getMaxSellQuantityForAccount(
          { ...childAccount, exchange: childExchange },
          trade.symbol,
          null,
          type,
          options.quantity ? getRemainingTradeQuantity(trade, child.userId) : null
        );
      } catch (error) {
        exitOrder.mirroredExecutions.push({
          userId: child.userId,
          userName: child.userName,
          exchange: childExchange,
          purpose: kind,
          status: "SKIPPED",
          error: error.message,
          order: null,
        });
        continue;
      }
    } else {
      childQty = String(options.quantity || getRemainingTradeQuantity(trade, child.userId) || "").trim();
    }

    if (!user || !childQty) {
      exitOrder.mirroredExecutions.push({
        userId: child.userId,
        userName: child.userName,
        exchange: childExchange,
        purpose: kind,
        status: "SKIPPED",
        error: "No filled quantity available for mirrored sell.",
        order: null,
      });
      continue;
    }

    const childExecution = await executeOrderForUser(
      user,
      {
        symbol: trade.symbol,
        side: "SELL",
        type,
        quantity: childQty,
        price,
        timeInForce: type === "LIMIT" ? "GTC" : undefined,
      },
      kind,
      childExchange
    );
    exitOrder.mirroredExecutions.push(childExecution);
  }

  trade.exitOrders.push(exitOrder);
  persist();
  await tradeListener.handleExitOrderCreated(trade, exitOrder).catch((error) => {
    console.error(`Trade listener exit event failed for trade ${trade.id}:`, error.message);
  });
  return exitOrder;
}

async function autoPlaceTakeProfit(trade, options = {}) {
  const force = !!options.force;
  if (!trade.takeProfitTargetPrice || trade.side !== "BUY") {
    return;
  }

  if (getActiveTakeProfitOrders(trade).length) {
    return;
  }

  if (!force && hasAnyTakeProfitHistory(trade)) {
    return;
  }

  const qty = getRemainingTradeQuantity(trade);
  if (!qty) {
    return;
  }

  const admin = db.users.find((user) => user.id === trade.createdByUserId);
  const exchange = getTradeExchange(trade);
  const adminAccount = getExchangeAccount(admin, exchange);
  if (!adminAccount) {
    return;
  }

  const exitOrder = {
    id: randomId(10),
    kind: "TAKE_PROFIT",
    createdAt: nowIso(),
    side: "SELL",
    type: "LIMIT",
    price: trade.takeProfitTargetPrice,
    quantity: String(qty),
    exchange,
    adminExecution: null,
    mirroredExecutions: [],
  };

  try {
    const tpQuantity = await getMaxSellQuantityForAccount(
      { ...adminAccount, exchange },
      trade.symbol,
      null,
      "LIMIT",
      qty
    );
    const adminExitInput = {
      symbol: trade.symbol,
      side: "SELL",
      type: "LIMIT",
      quantity: tpQuantity,
      price: trade.takeProfitTargetPrice,
      timeInForce: "GTC",
    };
    const exchangeInfo = await getExchangeInfo(trade.symbol, adminAccount.testnet, exchange);
    const normalizedExitInput = await normalizeOrderForExchange({ ...adminAccount, exchange }, adminExitInput, exchangeInfo);
    exitOrder.quantity = normalizedExitInput.quantity;
    await validateNotionalRule({ ...adminAccount, exchange }, normalizedExitInput, exchangeInfo);
    const adminOrder = await placeSpotOrder({ ...adminAccount, exchange }, normalizedExitInput, exchange);
    exitOrder.adminExecution = sanitizeExecution(adminOrder);
  } catch (error) {
    exitOrder.adminExecution = sanitizeExecution(null, error.message);
  }

  for (const mirror of trade.mirroredExecutions || []) {
    const user = db.users.find((item) => item.id === mirror.userId);
    const childQty = getRemainingTradeQuantity(trade, mirror.userId);
    if (!user || !getExchangeAccount(user, exchange) || !childQty) {
      exitOrder.mirroredExecutions.push({
        userId: mirror.userId,
        userName: mirror.userName,
        exchange,
        purpose: "TAKE_PROFIT",
        status: "SKIPPED",
        error: "No filled quantity available for take profit.",
        order: null,
      });
      continue;
    }
    const childOrder = await executeOrderForUser(
      user,
      {
        symbol: trade.symbol,
        side: "SELL",
        type: "LIMIT",
        quantity: await getMaxSellQuantityForAccount(
          { ...getExchangeAccount(user, exchange), exchange },
          trade.symbol,
          null,
          "LIMIT",
          childQty
        ),
        price: trade.takeProfitTargetPrice,
        timeInForce: "GTC",
      },
      "TAKE_PROFIT",
      exchange
    );
    exitOrder.mirroredExecutions.push(childOrder);
  }

  trade.exitOrders.push(exitOrder);
  persist();
  return exitOrder;
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return forwardedProto.includes("https");
}

function shouldUseCrossSiteCookie(req) {
  const origin = getRequestOrigin(req);
  if (!origin || !isAllowedCorsOrigin(origin)) {
    return false;
  }

  const requestOrigin = normalizeOrigin(`${isSecureRequest(req) ? "https" : "http"}://${req.headers.host || ""}`);
  return origin !== requestOrigin && isSecureRequest(req);
}

function buildSessionCookie(req, value, maxAgeSeconds = 0) {
  const parts = [
    `sid=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    shouldUseCrossSiteCookie(req) ? "SameSite=None" : "SameSite=Lax",
  ];

  if (maxAgeSeconds > 0) {
    parts.push(`Max-Age=${maxAgeSeconds}`);
    parts.push(`Expires=${new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()}`);
  } else {
    parts.push("Max-Age=0");
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function sendSessionCookie(req, res, sessionId) {
  res.setHeader("Set-Cookie", buildSessionCookie(req, sessionId, SESSION_TTL_SECONDS));
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", buildSessionCookie(req, "", 0));
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      storage: shouldUseMongo() ? "mongodb" : "local-json",
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = getCurrentUser(req);
    sendJson(res, 200, { user: user ? sanitizeUser(user) : null, exchanges: listExchanges() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readBody(req);
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const role = normalizeAuthRole(body.role, "user");
    const exchange = normalizeExchange(body.exchange, "bybit");

    if (!password || !name) {
      sendJson(res, 400, { error: "Name and password are required." });
      return true;
    }
    const email = getSignupEmail(name, body.email);
    if (role === "admin" && !isAdminSelfSignupEnabled()) {
      sendJson(res, 403, { error: "Admin signup is disabled. Sign in with an existing admin account." });
      return true;
    }
    if (
      db.users.some(
        (user) =>
          String(user.email || "").trim().toLowerCase() === email ||
          String(user.name || "").trim().toLowerCase() === name.toLowerCase()
      )
    ) {
      sendJson(res, 409, { error: "That account name is already registered." });
      return true;
    }

    const { salt, hash } = hashPassword(password);
    const user = {
      id: randomId(12),
      email,
      name,
      role,
      mirrorEnabled: role === "user",
      passwordSalt: salt,
      passwordHash: hash,
      preferredExchange: exchange,
      binance: null,
      bybit: null,
      createdAt: nowIso(),
    };
    db.users.push(user);
    financialService.ensureState();
    financialService.audit(user, "USER_REGISTERED", "User", user.id, {}, getRequestMeta(req));
    const session = createSession(user.id);
    sendSessionCookie(req, res, session.id);
    sendJson(res, 201, { user: sanitizeUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const login = String(body.email || body.name || "").trim();
    const password = String(body.password || "");
    const requestedRole = normalizeAuthRole(body.role, "user");
    const exchange = normalizeExchange(body.exchange, "bybit");
    const user = findUserByLogin(login);

    if (isLoginRateLimited(req, login)) {
      sendJson(res, 429, { error: "Too many login attempts. Please try again later." });
      return true;
    }

    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      recordFailedLogin(req, login);
      sendJson(res, 401, { error: "Invalid email or password." });
      return true;
    }

    if (user.role !== requestedRole) {
      recordFailedLogin(req, login);
      sendJson(res, 403, { error: `This account is not registered as ${requestedRole}.` });
      return true;
    }

    clearFailedLogins(req, login);
    const session = createSession(user.id);
    if (shouldPersistLoginExchange(user, exchange)) {
      setUserPreferredExchange(user, exchange);
    }
    financialService.audit(user, user.role === "admin" ? "ADMIN_LOGIN" : "USER_LOGIN", "User", user.id, {}, getRequestMeta(req));
    persist();
    sendSessionCookie(req, res, session.id);
    sendJson(res, 200, { user: sanitizeUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSession(req);
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/user/dashboard") {
    const user = requireAuth(req, res, "user");
    if (!user) {
      return true;
    }
    const dashboard = financialService.getDashboard(user);
    const mirrorPnl = await getAdminBybitMirrorPnl();
    sendJson(res, 200, mirrorPnl ? financialService.applyMirroredPnlToDashboard(dashboard, mirrorPnl) : dashboard);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/user/wallet") {
    const user = requireAuth(req, res, "user");
    if (!user) {
      return true;
    }
    sendJson(res, 200, { wallets: financialService.getWallets(user.id) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/user/transactions") {
    const user = requireAuth(req, res, "user");
    if (!user) {
      return true;
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    sendJson(res, 200, { transactions: financialService.getTransactions(user.id, { limit, offset }) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    sendJson(res, 200, { notifications: financialService.listNotifications(user) });
    return true;
  }

  const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (req.method === "POST" && notificationReadMatch) {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    try {
      const notification = financialService.markNotificationRead(user, decodeURIComponent(notificationReadMatch[1] || "").trim());
      sendJson(res, 200, { notification });
    } catch (error) {
      sendJson(res, 404, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/deposits") {
    const user = requireAuth(req, res, "user");
    if (!user) {
      return true;
    }
    try {
      const deposit = financialService.createDeposit(user, await readBody(req), getRequestMeta(req));
      sendJson(res, 201, { deposit });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/deposits") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    sendJson(res, 200, { deposits: financialService.listDeposits(user, { status: url.searchParams.get("status") }) });
    return true;
  }

  const depositDetailMatch = url.pathname.match(/^\/api\/deposits\/([^/]+)$/);
  if (req.method === "GET" && depositDetailMatch) {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    try {
      const deposit = financialService.listDeposits(user).find((item) => item.id === decodeURIComponent(depositDetailMatch[1]));
      if (!deposit) {
        sendJson(res, 404, { error: "Deposit request not found." });
        return true;
      }
      sendJson(res, 200, { deposit });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/withdrawals") {
    const user = requireAuth(req, res, "user");
    if (!user) {
      return true;
    }
    try {
      const withdrawal = financialService.createWithdrawal(user, await readBody(req), getRequestMeta(req));
      sendJson(res, 201, { withdrawal });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/withdrawals") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    sendJson(res, 200, { withdrawals: financialService.listWithdrawals(user, { status: url.searchParams.get("status") }) });
    return true;
  }

  const withdrawalDetailMatch = url.pathname.match(/^\/api\/withdrawals\/([^/]+)$/);
  if (req.method === "GET" && withdrawalDetailMatch) {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const withdrawal = financialService.listWithdrawals(user).find((item) => item.id === decodeURIComponent(withdrawalDetailMatch[1]));
    if (!withdrawal) {
      sendJson(res, 404, { error: "Withdrawal request not found." });
      return true;
    }
    sendJson(res, 200, { withdrawal });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, financialService.getAdminDashboard());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/deposits") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, { deposits: financialService.listDeposits(admin, { status: url.searchParams.get("status") }) });
    return true;
  }

  const adminDepositApproveMatch = url.pathname.match(/^\/api\/admin\/deposits\/([^/]+)\/approve$/);
  if (req.method === "POST" && adminDepositApproveMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const deposit = financialService.approveDeposit(
        admin,
        decodeURIComponent(adminDepositApproveMatch[1]),
        await readBody(req),
        getRequestMeta(req)
      );
      sendJson(res, 200, { deposit });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminDepositRejectMatch = url.pathname.match(/^\/api\/admin\/deposits\/([^/]+)\/reject$/);
  if (req.method === "POST" && adminDepositRejectMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const deposit = financialService.rejectDeposit(
        admin,
        decodeURIComponent(adminDepositRejectMatch[1]),
        await readBody(req),
        getRequestMeta(req)
      );
      sendJson(res, 200, { deposit });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/withdrawals") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, { withdrawals: financialService.listWithdrawals(admin, { status: url.searchParams.get("status") }) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/transactions") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, { transactions: financialService.listTransactions(admin, { limit: 500 }) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/finance-history/delete") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const result = financialService.deleteFinanceHistory(admin, await readBody(req), getRequestMeta(req));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminWithdrawalProcessMatch = url.pathname.match(/^\/api\/admin\/withdrawals\/([^/]+)\/process$/);
  if (req.method === "POST" && adminWithdrawalProcessMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const withdrawal = financialService.processWithdrawal(
        admin,
        decodeURIComponent(adminWithdrawalProcessMatch[1]),
        await readBody(req),
        getRequestMeta(req)
      );
      sendJson(res, 200, { withdrawal });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminWithdrawalCompleteMatch = url.pathname.match(/^\/api\/admin\/withdrawals\/([^/]+)\/complete$/);
  if (req.method === "POST" && adminWithdrawalCompleteMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const withdrawal = financialService.completeWithdrawal(
        admin,
        decodeURIComponent(adminWithdrawalCompleteMatch[1]),
        await readBody(req),
        getRequestMeta(req)
      );
      sendJson(res, 200, { withdrawal });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminWithdrawalRejectMatch = url.pathname.match(/^\/api\/admin\/withdrawals\/([^/]+)\/reject$/);
  if (req.method === "POST" && adminWithdrawalRejectMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const withdrawal = financialService.rejectWithdrawal(
        admin,
        decodeURIComponent(adminWithdrawalRejectMatch[1]),
        await readBody(req),
        getRequestMeta(req)
      );
      sendJson(res, 200, { withdrawal });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/settings") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, { settings: financialService.getSettings() });
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/api/admin/settings") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const settings = financialService.updateSettings(admin, await readBody(req), getRequestMeta(req));
      sendJson(res, 200, { settings });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/audit-logs") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, { auditLogs: financialService.getAuditLogs() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/performance") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    sendJson(res, 200, { dailyPerformances: financialService.getDailyPerformances() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/performance") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const performance = financialService.createDailyPerformance(admin, await readBody(req), getRequestMeta(req));
      sendJson(res, 201, { performance });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminPerformanceApplyMatch = url.pathname.match(/^\/api\/admin\/performance\/([^/]+)\/apply$/);
  if (req.method === "POST" && adminPerformanceApplyMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const result = financialService.applyDailyPerformance(
        admin,
        decodeURIComponent(adminPerformanceApplyMatch[1]),
        getRequestMeta(req)
      );
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/market/watchlist") {
    try {
      const currentUser = getCurrentUser(req);
      const exchange = currentUser ? getUserMarketExchange(currentUser) : "bybit";
      const testnet = !!getExchangeAccount(currentUser, exchange)?.testnet;
      const watchlist = await getMarketWatchlist(testnet, exchange);
      sendJson(res, 200, { watchlist });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/market/prices") {
    const raw = url.searchParams.get("symbols") || "";
    const symbols = raw
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 25);

    if (!symbols.length) {
      sendJson(res, 200, { prices: [] });
      return true;
    }

    try {
      const currentUser = getCurrentUser(req);
      const exchange = currentUser ? getUserMarketExchange(currentUser) : "bybit";
      const testnet = !!getExchangeAccount(currentUser, exchange)?.testnet;
      const [prices, stats] = await Promise.all([
        getTickerPrices(testnet, exchange),
        getTicker24hr(symbols, testnet, exchange),
      ]);

      const priceArray = Array.isArray(prices) ? prices : [prices];
      const priceMap = new Map(priceArray.map((item) => [item.symbol, item]));
      const statsArray = Array.isArray(stats) ? stats : [stats];
      const statsMap = new Map(statsArray.map((item) => [item.symbol, item]));
      const payload = symbols.map((symbol) => ({
        symbol,
        price: Number(priceMap.get(symbol)?.price || 0),
        changePercent: Number(statsMap.get(symbol)?.priceChangePercent || 0),
        volume24h: Number(statsMap.get(symbol)?.volume24h || 0),
        turnover24h: Number(statsMap.get(symbol)?.turnover24h || 0),
      }));
      sendJson(res, 200, { prices: payload });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/signals") {
    if (!isAuthorizedSignalIngestRequest(req)) {
      sendJson(res, 401, { error: "Unauthorized signal ingest request." });
      return true;
    }

    const body = await readBody(req);
    try {
      const result = await signalController.receiveSignal(body);
      persistSignalState();
      sendJson(res, result.created ? 201 : 200, {
        ok: true,
        created: result.created,
        signal: result.signal,
      });
    } catch (error) {
      sendJson(res, 400, {
        error: error.message || "Signal payload could not be processed.",
      });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/signals") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    await sweepExpiredSignals();
    sendJson(res, 200, await signalController.getSnapshot());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/signals/chart") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const pair = String(url.searchParams.get("pair") || "").trim().toUpperCase();
    const signalId = String(url.searchParams.get("signalId") || "").trim();
    if (!pair) {
      sendJson(res, 400, { error: "Pair is required." });
      return true;
    }

    const snapshot = await signalController.getChart({ pair, signalId });
    if (!snapshot) {
      sendJson(res, 404, { error: "No signal chart data found for that pair." });
      return true;
    }

    sendJson(res, 200, snapshot);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/signals/stream") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    await sweepExpiredSignals();
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    writeSse(res, {
      type: "snapshot",
      payload: await signalController.getSnapshot(),
    });

    const onSignal = (signal) => {
      writeSse(res, {
        type: "signal",
        payload: signal,
      });
    };

    const onStatus = (status) => {
      writeSse(res, {
        type: "status",
        payload: status,
      });
    };

    const onSnapshot = (snapshot) => {
      writeSse(res, {
        type: "snapshot",
        payload: snapshot,
      });
    };

    signalEngine.on("signal", onSignal);
    signalEngine.on("status", onStatus);
    signalEngine.on("snapshot", onSnapshot);

    const keepAlive = setInterval(() => {
      writeSse(res, {
        type: "heartbeat",
        payload: { timestamp: Date.now() },
      });
    }, SIGNAL_STREAM_KEEPALIVE_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      signalEngine.off("signal", onSignal);
      signalEngine.off("status", onStatus);
      signalEngine.off("snapshot", onSnapshot);
      res.end();
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/signals/delete") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    const signalIds = Array.isArray(body.signalIds)
      ? [...new Set(body.signalIds.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];

    if (!signalIds.length) {
      sendJson(res, 400, { error: "Select at least one signal to delete." });
      return true;
    }

    const deleted = await signalController.deleteSignals(signalIds);
    if (!deleted?.deletedCount) {
      sendJson(res, 404, { error: "No matching active signals were found to delete." });
      return true;
    }

    sendJson(res, 200, {
      deletedCount: deleted.deletedCount,
      signals: signalEngine.getSnapshot().signals,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/signals/timeframe") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    const timeframe = String(body.timeframe || "").trim();
    if (!timeframe) {
      sendJson(res, 400, { error: "A signal timeframe is required." });
      return true;
    }

    try {
      const snapshot = await signalController.updateTimeframe(timeframe);
      persistSignalState();
      sendJson(res, 200, snapshot);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Signal timeframe could not be updated." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/signals/auto-trade") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    sendJson(res, 200, getSignalAutoTradeSettingsSnapshot());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/signals/auto-trade") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const body = await readBody(req);
    const nextConfig = normalizeSignalAutoTradeConfig({
      enabled: parseBooleanFlag(body.enabled, autoTradeService.getConfig().enabled),
    });
    autoTradeService.updateConfig(nextConfig);
    db.meta = {
      ...(db.meta || {}),
      signalAutoTrade: autoTradeService.getConfig(),
    };
    persist();
    scheduleSettingsUsersBroadcast("signal_auto_trade_updated");
    sendJson(res, 200, getSignalAutoTradeSettingsSnapshot());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/trade-learning/summary") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    try {
      const summary = await tradeLearningService.analyzePerformance({
        strategyType: String(url.searchParams.get("strategyType") || "QUALITY_ERS").trim().toUpperCase(),
      });
      const adaptiveParameters = await tradeLearningService.getAdaptiveParameters({
        strategyType: String(url.searchParams.get("strategyType") || "QUALITY_ERS").trim().toUpperCase(),
        defaults: {},
      });
      sendJson(res, 200, {
        summary,
        adaptiveParameters,
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Trade learning summary could not be loaded." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/test-telegram") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const scope = String(url.searchParams.get("scope") || "signal").trim().toLowerCase();
    const diagnostics = {
      signalBot: getSignalBotDiagnostics(),
      tradeBot: telegramTradeService.getDiagnostics ? telegramTradeService.getDiagnostics() : {},
      subscriberStoreEnabled: !!subscriberModel?.isEnabled?.(),
    };

    try {
      let result = null;
      if (scope === "trade") {
        await ensureTradeListenerRunning();
        result = await tradeListener.broadcast(
          `Telegram trade bot test\nTime: ${new Date().toISOString()}\nStatus: listener active`,
          "signal",
          {
            telegramOptions: {
              disable_web_page_preview: true,
            },
          }
        );
      } else {
        result = await sendTelegramText(`Telegram signal bot test\nTime: ${new Date().toISOString()}`);
      }

      sendJson(res, 200, {
        ok: true,
        scope,
        diagnostics,
        result,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        scope,
        diagnostics,
        error: error.message || "Telegram test failed.",
      });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/market/chart") {
    const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
    const interval = String(url.searchParams.get("interval") || "15m").trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 48), 12), 96);

    if (!symbol) {
      sendJson(res, 400, { error: "Symbol is required." });
      return true;
    }

    try {
      const currentUser = getCurrentUser(req);
      const exchange = currentUser ? getUserMarketExchange(currentUser) : "bybit";
      const testnet = !!getExchangeAccount(currentUser, exchange)?.testnet;
      const candles = await getCandles(symbol, interval, limit, testnet, exchange);
      sendJson(res, 200, { symbol, interval, exchange, candles });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/exchange/diagnostics") {
    const exchange = normalizeExchange(url.searchParams.get("exchange"), "bybit");
    const testnet = url.searchParams.get("testnet") === "true";
    try {
      const result = await getConnectivityStatus(exchange, testnet);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/exchange/connect") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    const exchange = normalizeExchange(body.exchange, getPreferredExchange(user));
    const exchangeLabel = getExchangeLabel(exchange);
    const apiKey = String(body.apiKey || "").trim();
    const apiSecret = String(body.apiSecret || "").trim();
    const testnet = !!body.testnet;

    if (!apiKey || !apiSecret) {
      sendJson(res, 400, { error: `${exchangeLabel} API key and secret are required.` });
      return true;
    }

    try {
      const secretEncrypted = encryptSecret(apiSecret);
      const accountInfo = await validateCredentials(apiKey, secretEncrypted, testnet, exchange);
      user[exchange] = {
        exchange,
        apiKey,
        secretEncrypted,
        testnet,
        permissions: {
          canTrade: !!accountInfo.canTrade,
          canWithdraw: !!accountInfo.canWithdraw,
          canDeposit: !!accountInfo.canDeposit,
          readOnly: !!accountInfo.readOnly,
        },
        connectedAt: nowIso(),
        lastValidatedAt: nowIso(),
      };
      setUserPreferredExchange(user, exchange);
      persist();
      scheduleSettingsUsersBroadcast("exchange_connected");
      sendJson(res, 200, {
        user: sanitizeUser(user),
        account: {
          balances: toSafeBalances(accountInfo),
          permissions: user[exchange].permissions,
        },
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/exchange/account") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const exchange = normalizeExchange(url.searchParams.get("exchange"), getPreferredExchange(user));
    const account = getExchangeAccount(user, exchange);
    if (!account) {
      sendJson(res, 404, { error: `No ${getExchangeLabel(exchange)} account connected yet.` });
      return true;
    }

    const cachedSnapshot = getCachedAccountSnapshot(account, exchange);
    const forceRefresh = String(url.searchParams.get("refresh") || "").trim() === "1";
    if (!forceRefresh && cachedSnapshot && isCachedAccountSnapshotFresh(cachedSnapshot)) {
      sendJson(res, 200, cachedSnapshot);
      return true;
    }

    try {
      const snapshot = await getAccountSnapshot(account, exchange);
      account.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, snapshot);
    } catch (error) {
      if (cachedSnapshot) {
        sendJson(res, 200, {
          ...cachedSnapshot,
          stale: true,
          warning: `${getExchangeLabel(exchange)} live refresh failed, so the last saved snapshot is being shown.`,
        });
        return true;
      }
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/exchange/settings") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const exchange = normalizeExchange(url.searchParams.get("exchange"), getPreferredExchange(user));
    const account = getExchangeAccount(user, exchange);

    if (!account) {
      sendJson(res, 200, {
        exchange,
        connected: false,
        apiKey: "",
        apiSecret: "",
        testnet: false,
      });
      return true;
    }

    sendJson(res, 200, {
      exchange,
      connected: true,
      apiKey: String(account.apiKey || ""),
      apiSecret: "",
      testnet: !!account.testnet,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/exchange/open-orders") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const exchange = normalizeExchange(url.searchParams.get("exchange"), getPreferredExchange(user));
    const account = getExchangeAccount(user, exchange);
    if (!account) {
      sendJson(res, 200, { openOrders: [] });
      return true;
    }

    try {
      const openOrders = await getOpenOrders(account, exchange);
      account.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, { openOrders, exchange });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const cancelExchangeOpenOrderMatch = url.pathname.match(/^\/api\/exchange\/open-orders\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelExchangeOpenOrderMatch) {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    const exchange = normalizeExchange(body.exchange, getPreferredExchange(user));
    const account = getExchangeAccount(user, exchange);
    if (!account) {
      sendJson(res, 400, { error: `No ${getExchangeLabel(exchange)} account connected yet.` });
      return true;
    }

    const symbol = String(body.symbol || "").trim().toUpperCase();
    const orderId = decodeURIComponent(cancelExchangeOpenOrderMatch[1] || "").trim();
    if (!symbol || !orderId) {
      sendJson(res, 400, { error: "Order symbol and order id are required." });
      return true;
    }

    try {
      const order = await cancelOrder(account, symbol, orderId, exchange);
      account.lastValidatedAt = nowIso();
      await syncCanceledOrderInTrades(user, order, symbol);
      persist();
      sendJson(res, 200, { order, exchange });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/binance/futures/account") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const account = getExchangeAccount(user, "binance");
    if (!account) {
      sendJson(res, 404, { error: "No Binance account connected yet." });
      return true;
    }

    try {
      const snapshot = await getBinanceFuturesAccount(account);
      account.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, snapshot);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const cancelFuturesOpenOrderMatch = url.pathname.match(/^\/api\/binance\/futures\/open-orders\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelFuturesOpenOrderMatch) {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const account = getExchangeAccount(user, "binance");
    if (!account) {
      sendJson(res, 400, { error: "No Binance account connected yet." });
      return true;
    }

    const body = await readBody(req);
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const orderId = decodeURIComponent(cancelFuturesOpenOrderMatch[1] || "").trim();
    if (!symbol || !orderId) {
      sendJson(res, 400, { error: "Futures order symbol and order id are required." });
      return true;
    }

    try {
      const order = await cancelBinanceFuturesOrder(account, symbol, orderId);
      account.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, { order, exchange: "binance", market: "futures" });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/binance/futures/positions/close") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const account = getExchangeAccount(user, "binance");
    if (!account) {
      sendJson(res, 400, { error: "No Binance account connected yet." });
      return true;
    }

    const body = await readBody(req);
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const positionSide = String(body.positionSide || "BOTH").trim().toUpperCase();
    const quantity = Number(body.quantity || 0);
    if (!symbol) {
      sendJson(res, 400, { error: "Futures position symbol is required." });
      return true;
    }

    try {
      const order = await closeBinanceFuturesPosition(account, symbol, positionSide, quantity);
      account.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, { order, exchange: "binance", market: "futures" });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bybit/diagnostics") {
    const testnet = url.searchParams.get("testnet") === "true";
    try {
      const result = await getConnectivityStatus(testnet);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bybit/connect") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    const apiKey = String(body.apiKey || "").trim();
    const apiSecret = String(body.apiSecret || "").trim();
    const testnet = !!body.testnet;

    if (!apiKey || !apiSecret) {
      sendJson(res, 400, { error: "Bybit API key and secret are required." });
      return true;
    }

    try {
      const secretEncrypted = encryptSecret(apiSecret);
      const accountInfo = await validateCredentials(apiKey, secretEncrypted, testnet);
      user.bybit = {
        apiKey,
        secretEncrypted,
        testnet,
        permissions: {
          canTrade: !!accountInfo.canTrade,
          canWithdraw: !!accountInfo.canWithdraw,
          canDeposit: !!accountInfo.canDeposit,
          readOnly: !!accountInfo.readOnly,
        },
        connectedAt: nowIso(),
        lastValidatedAt: nowIso(),
      };
      persist();
      sendJson(res, 200, {
        user: sanitizeUser(user),
        account: {
          balances: toSafeBalances(accountInfo),
          permissions: user.bybit.permissions,
        },
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/users/mirror") {
    const user = requireAuth(req, res, "user");
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    user.mirrorEnabled = !!body.enabled;
    persist();
    scheduleSettingsUsersBroadcast("user_mirror_updated");
    sendJson(res, 200, { user: sanitizeUser(user) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bybit/account") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    if (!user.bybit) {
      sendJson(res, 404, { error: "No Bybit account connected yet." });
      return true;
    }

    try {
      const snapshot = await getAccountSnapshot(user.bybit, "bybit");
      user.bybit.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, snapshot);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bybit/open-orders") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    if (!user.bybit) {
      sendJson(res, 200, { openOrders: [] });
      return true;
    }

    try {
      const openOrders = await getOpenOrders(user.bybit);
      user.bybit.lastValidatedAt = nowIso();
      persist();
      sendJson(res, 200, { openOrders });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/users/preferred-exchange") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }

    const body = await readBody(req);
    setUserPreferredExchange(user, body.exchange);
    persist();
    scheduleSettingsUsersBroadcast("preferred_exchange_updated");
    sendJson(res, 200, { user: sanitizeUser(user) });
    return true;
  }

  const cancelOpenOrderMatch = url.pathname.match(/^\/api\/bybit\/open-orders\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelOpenOrderMatch) {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    if (!user.bybit) {
      sendJson(res, 400, { error: "No Bybit account connected yet." });
      return true;
    }

    const body = await readBody(req);
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const orderId = decodeURIComponent(cancelOpenOrderMatch[1] || "").trim();

    if (!symbol || !orderId) {
      sendJson(res, 400, { error: "Order symbol and order id are required." });
      return true;
    }

    try {
      const order = await cancelOrder(user.bybit, symbol, orderId);
      user.bybit.lastValidatedAt = nowIso();
      await syncCanceledOrderInTrades(user, order, symbol);
      persist();
      sendJson(res, 200, { order });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    const usdtNgnRate = await getUsdtToNgnRateFromBybitPage().catch(() => null);
    const users = await Promise.all(
      db.users
        .filter((user) => user.role === "user")
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
        .map((user) => buildManagedUserSummary(user, usdtNgnRate))
    );
    sendJson(res, 200, { users });
    return true;
  }

  const adminUserFinanceMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/finance$/);
  if (req.method === "GET" && adminUserFinanceMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const profile = financialService.getUserFinanceProfile(decodeURIComponent(adminUserFinanceMatch[1] || "").trim());
      sendJson(res, 200, profile);
    } catch (error) {
      sendJson(res, 404, { error: error.message });
    }
    return true;
  }

  const adminUserBonusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/bonus$/);
  if (req.method === "POST" && adminUserBonusMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const result = financialService.addBonus(
        admin,
        decodeURIComponent(adminUserBonusMatch[1] || "").trim(),
        await readBody(req),
        getRequestMeta(req)
      );
      scheduleSettingsUsersBroadcast("admin_bonus_added");
      sendJson(res, 201, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminUserMessageMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/message$/);
  const adminUserBalanceMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/balance$/);
  if (req.method === "POST" && adminUserBalanceMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const result = financialService.setUserBalance(
        admin,
        decodeURIComponent(adminUserBalanceMatch[1] || "").trim(),
        await readBody(req),
        getRequestMeta(req)
      );
      scheduleSettingsUsersBroadcast("admin_balance_updated");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && adminUserMessageMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    try {
      const notification = financialService.sendAdminMessage(
        admin,
        decodeURIComponent(adminUserMessageMatch[1] || "").trim(),
        await readBody(req),
        getRequestMeta(req)
      );
      scheduleSettingsUsersBroadcast("admin_message_sent");
      sendJson(res, 201, { notification });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const adminPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if (req.method === "POST" && adminPasswordMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const targetUser = getAdminManagedUser(decodeURIComponent(adminPasswordMatch[1] || "").trim());
    if (!targetUser) {
      sendJson(res, 404, { error: "User not found." });
      return true;
    }

    const body = await readBody(req);
    const password = String(body.password || "").trim();
    if (password.length < 6) {
      sendJson(res, 400, { error: "New password must be at least 6 characters long." });
      return true;
    }

    const { salt, hash } = hashPassword(password);
    targetUser.passwordSalt = salt;
    targetUser.passwordHash = hash;
    persist();
    scheduleSettingsUsersBroadcast("admin_password_updated");
    sendJson(res, 200, {
      user: await buildManagedUserSummary(targetUser, await getUsdtToNgnRateFromBybitPage().catch(() => null)),
    });
    return true;
  }

  const adminMirrorMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/mirror$/);
  if (req.method === "POST" && adminMirrorMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const targetUser = getAdminManagedUser(decodeURIComponent(adminMirrorMatch[1] || "").trim());
    if (!targetUser) {
      sendJson(res, 404, { error: "User not found." });
      return true;
    }

    const body = await readBody(req);
    targetUser.mirrorEnabled = !!body.enabled;
    persist();
    scheduleSettingsUsersBroadcast("admin_mirror_updated");
    sendJson(res, 200, {
      user: await buildManagedUserSummary(targetUser, await getUsdtToNgnRateFromBybitPage().catch(() => null)),
    });
    return true;
  }

  const adminDeleteUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === "DELETE" && adminDeleteUserMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const userId = decodeURIComponent(adminDeleteUserMatch[1] || "").trim();
    const targetUser = getAdminManagedUser(userId);
    if (!targetUser) {
      sendJson(res, 404, { error: "User not found." });
      return true;
    }

    detachUserFromMirroring(targetUser.id);
    db.sessions = db.sessions.filter((session) => session.userId !== targetUser.id);
    db.users = db.users.filter((user) => user.id !== targetUser.id);
    persist();
    scheduleSettingsUsersBroadcast("admin_user_deleted");
    sendJson(res, 200, { deletedUserId: targetUser.id });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/trades") {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const exchange = normalizeExchange(url.searchParams.get("exchange"), getPreferredExchange(user));
    await waitForTradeReconciliation();
    const trades =
      user.role === "admin"
        ? db.tradeIntents.filter((trade) => getTradeExchange(trade) === exchange).map(serializeTradeForAdmin)
        : db.tradeIntents
            .filter(
              (trade) =>
                getTradeExchange(trade) === exchange &&
                trade.mirroredExecutions.some((row) => row.userId === user.id)
            )
            .map((trade) => serializeTradeForUser(trade, user.id));
    sendJson(res, 200, { trades });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/trades/history/clear") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const body = await readBody(req);
    const tradeIds = Array.isArray(body.tradeIds)
      ? [...new Set(body.tradeIds.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];

    if (!tradeIds.length) {
      sendJson(res, 400, { error: "Select at least one trade to clear." });
      return true;
    }

    const tradeIdSet = new Set(tradeIds);
    const protectedTrades = db.tradeIntents.filter((trade) => {
      if (!tradeIdSet.has(trade.id)) {
        return false;
      }
      const lifecycleStatus = deriveTradeLifecycle(trade);
      return lifecycleStatus === "OPEN" || lifecycleStatus === "PENDING";
    });

    if (protectedTrades.length) {
      sendJson(res, 400, { error: "Open or pending trades cannot be cleared from history." });
      return true;
    }

    const beforeCount = db.tradeIntents.length;
    db.tradeIntents = db.tradeIntents.filter((trade) => !tradeIdSet.has(trade.id));
    const clearedCount = beforeCount - db.tradeIntents.length;

    if (!clearedCount) {
      sendJson(res, 404, { error: "The selected trade history was not found." });
      return true;
    }

    persist();
    sendJson(res, 200, { clearedCount });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/trades") {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    const exchange = getPreferredExchange(admin);
    const exchangeLabel = getExchangeLabel(exchange);
    const adminAccount = getExchangeAccount(admin, exchange);
    if (!adminAccount) {
      sendJson(res, 400, { error: `Connect the admin ${exchangeLabel} account first.` });
      return true;
    }

    try {
      const body = await readBody(req);
      const orderInput = normalizeOrderInput(body);
      const { trade } = await createTradeIntent(admin, exchange, orderInput, {
        throwOnTpFailure: true,
      });
      sendJson(res, 201, { trade: serializeTradeForAdmin(trade) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const takeProfitMatch = url.pathname.match(/^\/api\/trades\/([^/]+)\/take-profit$/);
  if (req.method === "POST" && takeProfitMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    const trade = db.tradeIntents.find((item) => item.id === takeProfitMatch[1]);
    if (!trade) {
      sendJson(res, 404, { error: "Trade not found." });
      return true;
    }
    const exchange = getTradeExchange(trade);
    const adminAccount = getExchangeAccount(admin, exchange);
    if (!adminAccount) {
      sendJson(res, 400, { error: `Connect the admin ${getExchangeLabel(exchange)} account first.` });
      return true;
    }

    const body = await readBody(req);
    const price = String(body.price || "").trim();
    if (!price) {
      sendJson(res, 400, { error: "Take-profit price is required." });
      return true;
    }

    trade.takeProfitTargetPrice = price;
    persist();
    await cancelActiveTakeProfitOrders(trade);
    const tpOrder = await autoPlaceTakeProfit(trade, { force: true });
    if (tpOrder?.adminExecution?.status === "ERROR") {
      sendJson(res, 400, { error: tpOrder.adminExecution.error || `Unable to place the take-profit order on ${getExchangeLabel(exchange)}.` });
      return true;
    }
    if (tpOrder) {
      await tradeListener.handleExitOrderCreated(trade, tpOrder).catch((error) => {
        console.error(`Trade listener take-profit placement failed for trade ${trade.id}:`, error.message);
      });
    }
    sendJson(res, 200, { trade: serializeTradeForAdmin(trade) });
    return true;
  }

  const sellPreviewMatch = url.pathname.match(/^\/api\/trades\/([^/]+)\/sell-preview$/);
  if (req.method === "GET" && sellPreviewMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }

    const trade = db.tradeIntents.find((item) => item.id === sellPreviewMatch[1]);
    if (!trade) {
      sendJson(res, 404, { error: "Trade not found." });
      return true;
    }
    const exchange = getTradeExchange(trade);
    const adminAccount = getExchangeAccount(admin, exchange);
    if (!adminAccount) {
      sendJson(res, 400, { error: `Connect the admin ${getExchangeLabel(exchange)} account first.` });
      return true;
    }

    try {
      const exchangeInfo = await getExchangeInfo(trade.symbol, adminAccount.testnet, exchange);
      const { filters } = getSymbolFilters(exchangeInfo, trade.symbol);
      const previewStepSize = getEffectiveQuantityFilter(filters, "MARKET")?.stepSize || "1";
      const quantity = getActiveTakeProfitOrders(trade).length
        ? normalizeQuantityToStep(getRemainingTradeQuantity(trade), previewStepSize)
        : await getMaxSellQuantityForAccount({ ...adminAccount, exchange }, trade.symbol, exchangeInfo, "MARKET");
      const ticker = await getTickerPrice(trade.symbol, adminAccount.testnet, exchange);
      const currentPrice = Number(ticker.price || 0);
      const baseAsset = getBaseAssetForSymbol(exchangeInfo, trade.symbol);

      sendJson(res, 200, {
        preview: {
          symbol: trade.symbol,
          baseAsset,
          quantity,
          currentPrice,
          estimatedUsdt: Number(quantity || 0) * currentPrice,
        },
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const sellMatch = url.pathname.match(/^\/api\/trades\/([^/]+)\/sell$/);
  if (req.method === "POST" && sellMatch) {
    const admin = requireAuth(req, res, "admin");
    if (!admin) {
      return true;
    }
    const trade = db.tradeIntents.find((item) => item.id === sellMatch[1]);
    if (!trade) {
      sendJson(res, 404, { error: "Trade not found." });
      return true;
    }
    const exchange = getTradeExchange(trade);
    const adminAccount = getExchangeAccount(admin, exchange);
    if (!adminAccount) {
      sendJson(res, 400, { error: `Connect the admin ${getExchangeLabel(exchange)} account first.` });
      return true;
    }

    const body = await readBody(req);
    const type = String(body.type || "MARKET").trim().toUpperCase();
    const price = body.price ? String(body.price).trim() : undefined;
    if (type === "LIMIT" && !price) {
      sendJson(res, 400, { error: "Limit sell requires a price." });
      return true;
    }

    try {
      await executeTradeExit(trade, admin, {
        kind: "MANUAL_SELL",
        type,
        price,
        quantity: body.quantity ? String(body.quantity).trim() : undefined,
      });
      sendJson(res, 200, { trade: serializeTradeForAdmin(trade) });
      return true;
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return true;
    }
  }

  return false;
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(path.join(frontendDir, "index.html"))) {
    sendJson(res, 404, {
      error: "Frontend is not bundled with this backend deployment.",
    });
    return;
  }

  let target = path.join(frontendDir, url.pathname === "/" ? "index.html" : url.pathname);
  if (!target.startsWith(frontendDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(frontendDir, "index.html");
  }

  const ext = path.extname(target);
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".mp3": "audio/mpeg",
    }[ext] || "application/octet-stream";

  res.writeHead(200, { ...buildSecurityHeaders(), "Content-Type": contentType });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  applyCorsHeaders(req, res);

  if (handleCorsPreflight(req, res)) {
    return;
  }

  try {
    const handled = await handleApi(req, res, url);
    if (handled) {
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, {
      error: error.message || "Something unexpected happened.",
    });
  }
});

socketSignalService.attach(server, {
  authorize: (request) => {
    const session = getSession(request);
    if (!session || !db) {
      return null;
    }
    return db.users.find((item) => item.id === session.userId) || null;
  },
  snapshotProvider: () => signalController.getSnapshot(),
});

const settingsUsersWss = new WebSocketServer({ noServer: true });
const settingsUsersClients = new Set();

function sendWebSocketJson(socket, payload) {
  if (!socket || socket.readyState !== 1) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function getSettingsSocketUser(socket) {
  if (!socket?.sessionId) {
    return null;
  }

  const session = db.sessions.find((item) => item.id === socket.sessionId);
  if (!session || Date.parse(session.expiresAt) < Date.now()) {
    return null;
  }

  return db.users.find((user) => user.id === session.userId) || null;
}

async function pushSettingsUsersSnapshot(socket, reason = "refresh") {
  const user = getSettingsSocketUser(socket);
  if (!user) {
    socket.close();
    return;
  }

  try {
    const payload = await buildSettingsUsersPayload(user, { refreshWallets: true });
    sendWebSocketJson(socket, {
      type: "settings-users",
      reason,
      payload,
    });
  } catch (error) {
    sendWebSocketJson(socket, {
      type: "settings-users-error",
      reason,
      error: error.message || "Settings live update failed.",
    });
  }
}

function scheduleSettingsUsersBroadcast(reason = "update") {
  for (const socket of settingsUsersClients) {
    void pushSettingsUsersSnapshot(socket, reason);
  }
}

settingsUsersWss.on("connection", (socket, request, auth = {}) => {
  socket.sessionId = auth.sessionId || null;
  settingsUsersClients.add(socket);
  socket.refreshTimer = setInterval(() => {
    void pushSettingsUsersSnapshot(socket, "interval");
  }, SETTINGS_USERS_WS_REFRESH_MS);

  void pushSettingsUsersSnapshot(socket, "initial");

  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(String(raw || "{}"));
      if (payload?.type === "refresh") {
        void pushSettingsUsersSnapshot(socket, "manual");
      }
    } catch {
      // Ignore malformed client messages.
    }
  });

  socket.on("close", () => {
    clearInterval(socket.refreshTimer);
    settingsUsersClients.delete(socket);
  });

  socket.on("error", () => {
    clearInterval(socket.refreshTimer);
    settingsUsersClients.delete(socket);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== SETTINGS_USERS_WS_PATH) {
    return;
  }

  const session = getSession(req);
  const user = session ? db.users.find((item) => item.id === session.userId) || null : null;
  if (!session || !user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  settingsUsersWss.handleUpgrade(req, socket, head, (ws) => {
    settingsUsersWss.emit("connection", ws, req, {
      sessionId: session.id,
    });
  });
});

async function startServer() {
  db = await loadDb();
  ensureAdminUser(db);
  financialService = new FinancialService({ db, persist });
  financialService.ensureState();
  autoTradeService.updateConfig(normalizeSignalAutoTradeConfig(db.meta?.signalAutoTrade || {}));
  await tradeLearningService.init();
  await signalEngine.setTimeframe(db.meta?.signalTimeframe, { scan: false }).catch(async () => {
    await signalEngine.setTimeframe("15m", { scan: false });
  });
  await signalEngine.hydrateSignals(db.signals || []);
  await sweepExpiredSignals();
  db.meta = {
    ...(db.meta || {}),
    signalTimeframe: signalEngine.getTimeframe(),
    signalAutoTrade: autoTradeService.getConfig(),
  };
  await saveDb(db);
  await syncTradeLearningHistory();

  const listeningPort = await listenOnAvailablePort(server, port);
  const storageMode = shouldUseMongo() ? "MongoDB" : "local JSON file";

  if (listeningPort !== port) {
    console.warn(`Port ${port} is already in use. Trade MVP switched to http://localhost:${listeningPort}.`);
  }

  console.log(`Trade MVP running on http://localhost:${listeningPort} using ${storageMode} storage`);
  console.log(`Telegram signal bot diagnostics: ${JSON.stringify(getSignalBotDiagnostics())}`);

  void ensureTradeListenerRunning(true);
  void ensureSignalEngineRunning(true, { awaitInitialScan: false });
  void startTradeReconciliation(true);
  setInterval(() => {
    void startTradeReconciliation();
  }, TRADE_RECONCILE_BACKGROUND_INTERVAL_MS);
  setInterval(() => {
    void ensureTradeListenerRunning();
  }, SERVICE_RETRY_INTERVAL_MS);
  setInterval(() => {
    void sweepExpiredSignals();
  }, SIGNAL_EXPIRY_SWEEP_MS);
}

function listenOnce(targetServer, targetPort) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      targetServer.off("listening", handleListening);
      reject(error);
    };

    const handleListening = () => {
      targetServer.off("error", handleError);
      resolve();
    };

    targetServer.once("error", handleError);
    targetServer.once("listening", handleListening);
    targetServer.listen(targetPort);
  });
}

async function listenOnAvailablePort(targetServer, preferredPort) {
  for (let offset = 0; offset <= MAX_PORT_RETRIES; offset += 1) {
    const candidatePort = preferredPort + offset;

    try {
      await listenOnce(targetServer, candidatePort);
      return candidatePort;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || offset === MAX_PORT_RETRIES) {
        throw error;
      }
    }
  }

  throw new Error(`Unable to find a free port between ${preferredPort} and ${preferredPort + MAX_PORT_RETRIES}.`);
}

startServer().catch((error) => {
  console.error("Failed to start Trade MVP:", error.message);
  process.exit(1);
});
