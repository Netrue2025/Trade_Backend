const crypto = require("node:crypto");

const { decryptSecret } = require("./security");

const serverTimeOffsetMs = {
  mainnet: 0,
  testnet: 0,
};

const serverTimeSynced = {
  mainnet: false,
  testnet: false,
};

const PUBLIC_CACHE_TTLS_MS = {
  exchangeInfo: 10 * 60 * 1000,
  tickerPrices: 10 * 1000,
  ticker24hr: 10 * 1000,
  candles: 20 * 1000,
};

const publicCache = new Map();
const publicCacheInflight = new Map();

function getBaseUrl(testnet) {
  if (testnet) {
    return process.env.BINANCE_TESTNET_URL || "https://testnet.binance.vision";
  }
  return process.env.BINANCE_BASE_URL || "https://api.binance.com";
}

function buildQuery(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ).toString();
}

function isTimestampError(payload) {
  const message = String(payload?.msg || "").toLowerCase();
  return payload?.code === -1021 || message.includes("timestamp");
}

function normalizeErrorMessage(payload, fallback) {
  return payload?.msg || fallback;
}

function mapBinanceStatus(status) {
  const value = String(status || "").toUpperCase();
  const statusMap = {
    NEW: "NEW",
    PARTIALLY_FILLED: "PARTIALLY_FILLED",
    FILLED: "FILLED",
    CANCELED: "CANCELED",
    CANCELLED: "CANCELED",
    PENDING_CANCEL: "PENDING_CANCEL",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
  };
  return statusMap[value] || value || "UNKNOWN";
}

function normalizeOrder(order) {
  if (!order) {
    return null;
  }

  const avgPrice = Number(order.price || 0);
  const executedValue = String(order.cummulativeQuoteQty || "0");
  return {
    orderId: String(order.orderId || ""),
    clientOrderId: String(order.clientOrderId || ""),
    symbol: order.symbol,
    side: String(order.side || "").toUpperCase(),
    type: String(order.type || "").toUpperCase(),
    status: mapBinanceStatus(order.status),
    price: avgPrice > 0 ? String(order.price || "0") : "0",
    origQty: String(order.origQty || "0"),
    executedQty: String(order.executedQty || "0"),
    cummulativeQuoteQty: executedValue,
    transactTime: Number(order.updateTime || order.transactTime || order.time || Date.now()),
    timeInForce: String(order.timeInForce || "").toUpperCase(),
    rawPrice: String(order.price || "0"),
  };
}

function getPublicCacheKey(namespace, params = []) {
  return `${namespace}:${params.join(":")}`;
}

async function withPublicCache(cacheKey, ttlMs, resolver) {
  const cached = publicCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < ttlMs) {
    return cached.value;
  }

  if (publicCacheInflight.has(cacheKey)) {
    return publicCacheInflight.get(cacheKey);
  }

  const pending = Promise.resolve()
    .then(resolver)
    .then((value) => {
      publicCache.set(cacheKey, {
        value,
        updatedAt: Date.now(),
      });
      return value;
    })
    .finally(() => {
      publicCacheInflight.delete(cacheKey);
    });

  publicCacheInflight.set(cacheKey, pending);
  return pending;
}

async function publicRequest(path, params = {}, testnet = false) {
  const query = buildQuery(params);
  const url = `${getBaseUrl(testnet)}${path}${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(normalizeErrorMessage(payload, `Unable to reach Binance. HTTP ${response.status}.`));
  }
  return payload;
}

async function getServerTime(testnet) {
  return publicRequest("/api/v3/time", {}, testnet);
}

async function syncServerTimeOffset(testnet) {
  const startedAt = Date.now();
  const payload = await getServerTime(testnet);
  const finishedAt = Date.now();
  const midpoint = startedAt + Math.round((finishedAt - startedAt) / 2);
  const offset = Number(payload.serverTime || 0) - midpoint;
  const key = testnet ? "testnet" : "mainnet";
  serverTimeOffsetMs[key] = offset;
  serverTimeSynced[key] = true;
  return offset;
}

async function signedRequest(account, path, method = "GET", params = {}, allowRetry = true) {
  const key = account.testnet ? "testnet" : "mainnet";
  if (!serverTimeSynced[key]) {
    await syncServerTimeOffset(account.testnet);
  }

  const secret = decryptSecret(account.secretEncrypted);
  const signedParams = {
    ...params,
    recvWindow: 10000,
    timestamp: Math.round(Date.now() + serverTimeOffsetMs[key]),
  };
  const queryString = buildQuery(signedParams);
  const signature = crypto.createHmac("sha256", secret).update(queryString).digest("hex");
  const finalQuery = `${queryString}&signature=${signature}`;
  const url = `${getBaseUrl(account.testnet)}${path}?${finalQuery}`;
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      "X-MBX-APIKEY": account.apiKey,
      "Content-Type": "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (isTimestampError(payload) && allowRetry) {
      await syncServerTimeOffset(account.testnet);
      return signedRequest(account, path, method, params, false);
    }
    throw new Error(normalizeErrorMessage(payload, `Signed Binance request failed with HTTP ${response.status}.`));
  }
  return payload;
}

function normalizeWalletResponse(result) {
  return {
    balances: (result.balances || []).map((coin) => ({
      asset: coin.asset,
      free: String(coin.free || "0"),
      locked: String(coin.locked || "0"),
    })),
  };
}

function extractPermissions(accountInfo) {
  return {
    canTrade: !!accountInfo.canTrade,
    canWithdraw: !!accountInfo.canWithdraw,
    canDeposit: !!accountInfo.canDeposit,
    readOnly: !accountInfo.canTrade,
  };
}

async function validateCredentials(apiKey, secretEncrypted, testnet) {
  const account = { apiKey, secretEncrypted, testnet };
  await syncServerTimeOffset(testnet);
  const accountInfo = await signedRequest(account, "/api/v3/account", "GET");
  return {
    ...normalizeWalletResponse(accountInfo),
    apiInfo: accountInfo,
    ...extractPermissions(accountInfo),
  };
}

async function getAccountInfo(account) {
  const result = await signedRequest(account, "/api/v3/account", "GET");
  return normalizeWalletResponse(result);
}

async function getOpenOrders(account) {
  const result = await signedRequest(account, "/api/v3/openOrders", "GET");
  return (result || []).map(normalizeOrder);
}

async function getOrder(account, symbol, orderId) {
  const result = await signedRequest(account, "/api/v3/order", "GET", {
    symbol,
    orderId: String(orderId),
  });
  return normalizeOrder(result);
}

async function waitForOrder(account, symbol, orderId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const order = await getOrder(account, symbol, orderId).catch(() => null);
    if (order) {
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    orderId: String(orderId),
    clientOrderId: "",
    symbol,
    side: "",
    type: "",
    status: "PENDING_NEW",
    price: "0",
    origQty: "0",
    executedQty: "0",
    cummulativeQuoteQty: "0",
    transactTime: Date.now(),
  };
}

async function cancelOrder(account, symbol, orderId) {
  const result = await signedRequest(account, "/api/v3/order", "DELETE", {
    symbol,
    orderId: String(orderId),
  });
  return normalizeOrder(result) || waitForOrder(account, symbol, orderId);
}

async function getExchangeInfo(symbol, testnet) {
  const result = await withPublicCache(
    getPublicCacheKey("exchangeInfo", [testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.exchangeInfo,
    () => publicRequest("/api/v3/exchangeInfo", {}, testnet)
  );
  const symbols = symbol
    ? (result.symbols || []).filter((item) => item.symbol === symbol)
    : (result.symbols || []);
  return {
    symbols: symbols.map((item) => ({
      symbol: item.symbol,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
      filters: item.filters || [],
    })),
  };
}

function normalizeTicker(item) {
  return {
    symbol: item.symbol,
    price: String(item.lastPrice || item.price || "0"),
    priceChangePercent: String(item.priceChangePercent || "0"),
    volume24h: String(item.volume || item.volume24h || "0"),
    turnover24h: String(item.quoteVolume || item.turnover24h || "0"),
  };
}

async function getTickerPrices(testnet) {
  const result = await withPublicCache(
    getPublicCacheKey("tickerPrices", [testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.tickerPrices,
    () => publicRequest("/api/v3/ticker/price", {}, testnet)
  );
  return (Array.isArray(result) ? result : [result]).map((item) => ({
    symbol: item.symbol,
    price: String(item.price || "0"),
    volume24h: "0",
    turnover24h: "0",
  }));
}

async function getTickerPrice(symbol, testnet) {
  const [price, stats] = await Promise.all([
    getTickerPrices(testnet),
    getTicker24hr([symbol], testnet),
  ]);
  const priceRow = (Array.isArray(price) ? price : []).find((item) => item.symbol === symbol) || { price: "0" };
  const statsRow = (Array.isArray(stats) ? stats : [stats])[0] || {};
  return normalizeTicker({
    symbol,
    price: priceRow.price,
    lastPrice: priceRow.price,
    priceChangePercent: statsRow.priceChangePercent,
    volume: statsRow.volume24h,
    quoteVolume: statsRow.turnover24h,
  });
}

async function getTicker24hr(symbolsOrTestnet = false, maybeTestnet = false) {
  let symbols = null;
  let testnet = maybeTestnet;

  if (Array.isArray(symbolsOrTestnet)) {
    symbols = new Set(symbolsOrTestnet);
  } else {
    testnet = symbolsOrTestnet;
  }

  const result = await withPublicCache(
    getPublicCacheKey("ticker24hr", [testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.ticker24hr,
    () => publicRequest("/api/v3/ticker/24hr", {}, testnet)
  );
  const items = (Array.isArray(result) ? result : [result]).map(normalizeTicker);
  return symbols ? items.filter((item) => symbols.has(item.symbol)) : items;
}

function normalizeInterval(interval) {
  const value = String(interval || "15m").trim().toLowerCase();
  const map = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
  };
  return map[value] || "15m";
}

async function getCandles(symbol, interval = "15m", limit = 48, testnet = false) {
  const normalizedInterval = normalizeInterval(interval);
  const normalizedLimit = Math.min(Math.max(Number(limit || 48), 12), 300);
  const result = await withPublicCache(
    getPublicCacheKey("candles", [symbol, normalizedInterval, normalizedLimit, testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.candles,
    () => publicRequest("/api/v3/klines", {
      symbol,
      interval: normalizedInterval,
      limit: normalizedLimit,
    }, testnet)
  );

  return (Array.isArray(result) ? result : []).map((item) => ({
    openTime: Number(item[0] || 0),
    open: Number(item[1] || 0),
    high: Number(item[2] || 0),
    low: Number(item[3] || 0),
    close: Number(item[4] || 0),
    volume: Number(item[5] || 0),
  }));
}

async function placeSpotOrder(account, orderInput) {
  const params = {
    symbol: orderInput.symbol,
    side: orderInput.side,
    type: orderInput.type,
    quantity:
      orderInput.quoteOrderQty && orderInput.type === "MARKET" && orderInput.side === "BUY"
        ? undefined
        : String(orderInput.quantity || "0"),
    quoteOrderQty:
      orderInput.quoteOrderQty && orderInput.type === "MARKET" && orderInput.side === "BUY"
        ? String(orderInput.quoteOrderQty)
        : undefined,
    price: orderInput.type === "LIMIT" ? String(orderInput.price) : undefined,
    timeInForce: orderInput.type === "LIMIT" ? orderInput.timeInForce || "GTC" : undefined,
    newOrderRespType: "ACK",
  };

  const result = await signedRequest(account, "/api/v3/order", "POST", params);
  return waitForOrder(account, orderInput.symbol, result.orderId);
}

async function getConnectivityStatus(testnet) {
  const startedAt = Date.now();
  const payload = await getServerTime(testnet);
  return {
    ok: true,
    baseUrl: getBaseUrl(testnet),
    latencyMs: Date.now() - startedAt,
    serverTimeOffsetMs: serverTimeOffsetMs[testnet ? "testnet" : "mainnet"],
    payload,
  };
}

module.exports = {
  cancelOrder,
  getAccountInfo,
  getConnectivityStatus,
  getExchangeInfo,
  getOpenOrders,
  getOrder,
  getServerTime,
  getTicker24hr,
  getTickerPrice,
  getTickerPrices,
  getCandles,
  placeSpotOrder,
  syncServerTimeOffset,
  validateCredentials,
};
