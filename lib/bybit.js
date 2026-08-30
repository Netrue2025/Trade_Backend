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

const preferredBaseUrl = {
  mainnet: null,
  testnet: null,
};

function getBaseUrl(testnet) {
  if (testnet) {
    return process.env.BYBIT_TESTNET_URL || "https://api-testnet.bybit.com";
  }
  return process.env.BYBIT_BASE_URL || "https://api.bybit.com";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getBaseUrls(testnet) {
  const key = testnet ? "testnet" : "mainnet";
  if (testnet) {
    return unique([preferredBaseUrl[key], getBaseUrl(true), "https://api-testnet.bybit.com"]);
  }

  return unique([
    preferredBaseUrl[key],
    getBaseUrl(false),
    "https://api.bybit.com",
    "https://api.bytick.com",
  ]);
}

function rememberWorkingBaseUrl(testnet, baseUrl) {
  preferredBaseUrl[testnet ? "testnet" : "mainnet"] = baseUrl;
}

function buildQuery(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ).toString();
}

function normalizeErrorMessage(payload, fallback) {
  return payload?.retMsg || payload?.retExtInfo?.list?.[0]?.msg || fallback;
}

function isNetworkFallbackCandidate(error) {
  const detail = String(error?.cause?.code || error?.cause?.message || error?.message || "");
  return ["UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"].some((token) =>
    detail.includes(token)
  );
}

function isTimestampError(payload) {
  const message = String(payload?.retMsg || "").toLowerCase();
  return payload?.retCode === 10002 || payload?.retCode === -1 || message.includes("req_timestamp invalid");
}

function isRetryableHttpStatus(status) {
  return [403, 429, 500, 502, 503, 504].includes(Number(status || 0));
}

function formatHttpFailure(url, response, payload, signed = false) {
  const fallback = signed
    ? `Signed Bybit request failed with HTTP ${response.status}.`
    : `Unable to reach Bybit. HTTP ${response.status}.`;
  const message = normalizeErrorMessage(payload, fallback);

  if (Number(response.status) === 403 && !payload?.retMsg) {
    return `Bybit returned HTTP 403 for ${url}. This usually means the server IP or hosting region is blocked by Bybit or falls under a restricted jurisdiction, so the request is being denied before normal API validation.`;
  }

  return message;
}

async function publicRequest(path, params = {}, testnet = false) {
  const query = buildQuery(params);
  let lastError = null;
  let lastHttpFailure = null;

  for (const baseUrl of getBaseUrls(testnet)) {
    const url = `${baseUrl}${path}${query ? `?${query}` : ""}`;
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      lastError = error;
      if (isNetworkFallbackCandidate(error)) {
        continue;
      }
      const detail = error.cause?.code || error.cause?.message || error.message;
      throw new Error(
        `Network error reaching Bybit at ${url}: ${detail}. Check internet access, DNS, firewall/VPN, or region-based access to Bybit.`
      );
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastHttpFailure = new Error(formatHttpFailure(url, response, payload, false));
      if (isRetryableHttpStatus(response.status)) {
        continue;
      }
      throw lastHttpFailure;
    }

    if (payload.retCode !== 0) {
      throw new Error(normalizeErrorMessage(payload, `Unable to reach Bybit. HTTP ${response.status}.`));
    }

    rememberWorkingBaseUrl(testnet, baseUrl);
    return payload.result;
  }

  if (lastHttpFailure) {
    throw lastHttpFailure;
  }

  const fallbackUrl = `${getBaseUrls(testnet)[0]}${path}${query ? `?${query}` : ""}`;
  const detail = lastError?.cause?.code || lastError?.cause?.message || lastError?.message || "Unknown network error";
  throw new Error(
    `Network error reaching Bybit at ${fallbackUrl}: ${detail}. Check internet access, DNS, firewall/VPN, or region-based access to Bybit.`
  );
}

async function getServerTime(testnet) {
  return publicRequest("/v5/market/time", {}, testnet);
}

async function syncServerTimeOffset(testnet) {
  const startedAt = Date.now();
  const payload = await getServerTime(testnet);
  const finishedAt = Date.now();
  const midpoint = startedAt + Math.round((finishedAt - startedAt) / 2);
  const serverTimeMs = Math.round(Number(payload.timeNano || 0) / 1_000_000) || Number(payload.timeSecond || 0) * 1000;
  const offset = serverTimeMs - midpoint;
  const key = testnet ? "testnet" : "mainnet";
  serverTimeOffsetMs[key] = offset;
  serverTimeSynced[key] = true;
  return offset;
}

function toCanonicalValue(value, upperCase = false) {
  const text = String(value || "");
  return upperCase ? text.toUpperCase() : text;
}

function mapBybitStatus(status) {
  const value = String(status || "").toUpperCase();
  const statusMap = {
    NEW: "NEW",
    PARTIALLYFILLED: "PARTIALLY_FILLED",
    FILLED: "FILLED",
    CANCELLED: "CANCELED",
    REJECTED: "REJECTED",
    DEACTIVATED: "CANCELED",
    UNTRIGGERED: "PENDING_NEW",
    TRIGGERED: "NEW",
  };
  return statusMap[value] || value || "UNKNOWN";
}

function normalizeOrder(order) {
  if (!order) {
    return null;
  }

  const avgPrice = Number(order.avgPrice || 0);
  const limitPrice = Number(order.price || 0);
  const executedValue = String(order.cumExecValue || order.cumExecQty || "0");
  return {
    orderId: order.orderId,
    clientOrderId: order.orderLinkId || "",
    symbol: order.symbol,
    side: toCanonicalValue(order.side, true),
    type: toCanonicalValue(order.orderType, true),
    status: mapBybitStatus(order.orderStatus),
    price: avgPrice > 0 ? String(order.avgPrice) : String(order.price || "0"),
    origQty: String(order.qty || "0"),
    executedQty: String(order.cumExecQty || "0"),
    cummulativeQuoteQty: executedValue,
    transactTime: Number(order.updatedTime || order.createdTime || Date.now()),
    timeInForce: toCanonicalValue(order.timeInForce, true) || "",
    rawPrice: limitPrice > 0 ? String(order.price) : "",
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

async function signedRequest(account, path, method = "GET", params = {}, allowRetry = true) {
  const key = account.testnet ? "testnet" : "mainnet";
  if (!serverTimeSynced[key]) {
    await syncServerTimeOffset(account.testnet);
  }

  const timestamp = String(Math.round(Date.now() + serverTimeOffsetMs[key]));
  const recvWindow = "10000";
  const secret = decryptSecret(account.secretEncrypted);
  const queryString = method === "GET" ? buildQuery(params) : "";
  const bodyString = method === "GET" ? "" : JSON.stringify(params);
  const payloadToSign = `${timestamp}${account.apiKey}${recvWindow}${method === "GET" ? queryString : bodyString}`;
  const signature = crypto.createHmac("sha256", secret).update(payloadToSign).digest("hex");
  let lastError = null;
  let lastHttpFailure = null;

  for (const baseUrl of getBaseUrls(account.testnet)) {
    const url = `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "X-BAPI-API-KEY": account.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "X-BAPI-SIGN": signature,
        },
        body: method === "GET" ? undefined : bodyString,
      });
    } catch (error) {
      lastError = error;
      if (isNetworkFallbackCandidate(error)) {
        continue;
      }
      const detail = error.cause?.code || error.cause?.message || error.message;
      throw new Error(
        `Network error reaching Bybit at ${url}: ${detail}. Check internet access, DNS, firewall/VPN, or region-based access to Bybit.`
      );
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastHttpFailure = new Error(formatHttpFailure(url, response, payload, true));
      if (isRetryableHttpStatus(response.status)) {
        continue;
      }
      throw lastHttpFailure;
    }

    if (payload.retCode !== 0) {
      if (isTimestampError(payload) && allowRetry) {
        await syncServerTimeOffset(account.testnet);
        return signedRequest(account, path, method, params, false);
      }
      throw new Error(normalizeErrorMessage(payload, `Signed Bybit request failed with HTTP ${response.status}.`));
    }

    rememberWorkingBaseUrl(account.testnet, baseUrl);
    return payload.result;
  }

  if (lastHttpFailure) {
    throw lastHttpFailure;
  }

  const fallbackUrl = `${getBaseUrls(account.testnet)[0]}${path}${queryString ? `?${queryString}` : ""}`;
  const detail = lastError?.cause?.code || lastError?.cause?.message || lastError?.message || "Unknown network error";
  throw new Error(
    `Network error reaching Bybit at ${fallbackUrl}: ${detail}. Check internet access, DNS, firewall/VPN, or region-based access to Bybit.`
  );
}

async function getConnectivityStatus(testnet) {
  const baseUrl = getBaseUrl(testnet);
  const startedAt = Date.now();
  const payload = await getServerTime(testnet);
  return {
    ok: true,
    baseUrl,
    latencyMs: Date.now() - startedAt,
    serverTimeOffsetMs: serverTimeOffsetMs[testnet ? "testnet" : "mainnet"],
    payload,
  };
}

async function getApiKeyInformation(account) {
  return signedRequest(account, "/v5/user/query-api", "GET");
}

async function getRawWalletBalance(account, coin = "") {
  return signedRequest(account, "/v5/account/wallet-balance", "GET", {
    accountType: "UNIFIED",
    coin,
  });
}

function normalizeWalletResponse(result) {
  const account = Array.isArray(result?.list) ? result.list[0] : null;
  const coins = Array.isArray(account?.coin) ? account.coin : [];

  return {
    balances: coins.map((coin) => {
      const walletBalance = Number(coin.walletBalance || 0);
      const locked = Number(coin.locked || 0);
      const free = Math.max(walletBalance - locked, 0);
      return {
        asset: coin.coin,
        free: String(free),
        locked: String(locked),
      };
    }),
  };
}

function extractPermissions(apiInfo) {
  const permissions = apiInfo?.permissions || {};
  return {
    canTrade: Array.isArray(permissions.Spot) && permissions.Spot.includes("SpotTrade") && Number(apiInfo?.readOnly) === 0,
    canWithdraw: Array.isArray(permissions.Wallet) && permissions.Wallet.includes("Withdraw"),
    canDeposit: Array.isArray(permissions.Wallet) && permissions.Wallet.length > 0,
    readOnly: Number(apiInfo?.readOnly) === 1,
    raw: permissions,
  };
}

async function validateCredentials(apiKey, secretEncrypted, testnet) {
  const account = {
    apiKey,
    secretEncrypted,
    testnet,
  };

  await syncServerTimeOffset(testnet);
  const [apiInfo, walletResult] = await Promise.all([getApiKeyInformation(account), getRawWalletBalance(account)]);
  return {
    ...normalizeWalletResponse(walletResult),
    apiInfo,
    ...extractPermissions(apiInfo),
  };
}

async function getAccountInfo(account) {
  const walletResult = await getRawWalletBalance(account);
  return normalizeWalletResponse(walletResult);
}

async function getOpenOrders(account) {
  const result = await signedRequest(account, "/v5/order/realtime", "GET", {
    category: "spot",
    openOnly: 0,
    limit: 50,
  });
  return (result.list || []).map(normalizeOrder);
}

async function getOrder(account, symbol, orderId) {
  const result = await signedRequest(account, "/v5/order/realtime", "GET", {
    category: "spot",
    symbol,
    orderId,
  });
  const match = (result.list || []).find((item) => item.orderId === String(orderId) || item.orderId === orderId);
  return normalizeOrder(match || null);
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
    orderId,
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
  const result = await signedRequest(account, "/v5/order/cancel", "POST", {
    category: "spot",
    symbol,
    orderId: String(orderId),
    orderFilter: "Order",
  });
  return waitForOrder(account, symbol, result.orderId || orderId);
}

async function getExchangeInfo(symbol, testnet) {
  const result = await withPublicCache(
    getPublicCacheKey("exchangeInfo", [testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.exchangeInfo,
    () => publicRequest("/v5/market/instruments-info", { category: "spot" }, testnet)
  );
  const normalizedSymbols = (result.list || [])
    .filter((item) => !symbol || item.symbol === symbol)
    .map((item) => ({
      symbol: item.symbol,
      baseAsset: item.baseCoin,
      quoteAsset: item.quoteCoin,
    filters: [
      {
        filterType: "PRICE_FILTER",
        minPrice: item.priceFilter?.minPrice || "0",
        maxPrice: item.priceFilter?.maxPrice || "0",
        tickSize: item.priceFilter?.tickSize || "0",
      },
      {
        filterType: "LOT_SIZE",
        minQty: item.lotSizeFilter?.minOrderQty || "0",
        maxQty: item.lotSizeFilter?.maxLimitOrderQty || item.lotSizeFilter?.maxOrderQty || "0",
        stepSize:
          Number(item.lotSizeFilter?.qtyStep || 0) > 0
            ? item.lotSizeFilter.qtyStep
            : item.lotSizeFilter?.basePrecision || item.lotSizeFilter?.minOrderQty || "0",
      },
      {
        filterType: "MARKET_LOT_SIZE",
        minQty: item.lotSizeFilter?.minOrderQty || "0",
        maxQty:
          item.lotSizeFilter?.maxMarketOrderQty ||
          item.lotSizeFilter?.maxMktOrderQty ||
          item.lotSizeFilter?.maxOrderQty ||
          "0",
        stepSize:
          Number(item.lotSizeFilter?.qtyStep || 0) > 0
            ? item.lotSizeFilter.qtyStep
            : item.lotSizeFilter?.basePrecision || item.lotSizeFilter?.minOrderQty || "0",
      },
      {
        filterType: "NOTIONAL",
        minNotional: item.lotSizeFilter?.minOrderAmt || item.lotSizeFilter?.minNotionalValue || "0",
        maxNotional: "0",
      },
    ],
  }));

  return {
    symbols: normalizedSymbols,
  };
}

function normalizeTicker(item) {
  return {
    symbol: item.symbol,
    price: String(item.lastPrice || "0"),
    priceChangePercent: String(Number(item.price24hPcnt || 0) * 100),
    volume24h: String(item.volume24h || "0"),
    turnover24h: String(item.turnover24h || "0"),
  };
}

async function getTickerPrices(testnet) {
  const result = await withPublicCache(
    getPublicCacheKey("tickerPrices", [testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.tickerPrices,
    () => publicRequest("/v5/market/tickers", { category: "spot" }, testnet)
  );
  return (result.list || []).map((item) => ({
    symbol: item.symbol,
    price: String(item.lastPrice || "0"),
    volume24h: String(item.volume24h || "0"),
    turnover24h: String(item.turnover24h || "0"),
  }));
}

async function getTickerPrice(symbol, testnet) {
  const [prices, stats] = await Promise.all([
    getTickerPrices(testnet),
    getTicker24hr([symbol], testnet),
  ]);
  const priceRow = (Array.isArray(prices) ? prices : []).find((item) => item.symbol === symbol) || { price: "0" };
  const statsRow = (Array.isArray(stats) ? stats : [stats])[0] || {};
  return normalizeTicker({
    symbol,
    lastPrice: priceRow.price,
    price24hPcnt: Number(statsRow.priceChangePercent || 0) / 100,
    volume24h: statsRow.volume24h,
    turnover24h: statsRow.turnover24h,
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
    () => publicRequest("/v5/market/tickers", { category: "spot" }, testnet)
  );
  const items = (result.list || []).map(normalizeTicker);
  return symbols ? items.filter((item) => symbols.has(item.symbol)) : items;
}

function normalizeInterval(interval) {
  const value = String(interval || "15m").trim().toLowerCase();
  const map = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };
  return map[value] || "15";
}

async function getCandles(symbol, interval = "15m", limit = 48, testnet = false) {
  const normalizedInterval = normalizeInterval(interval);
  const normalizedLimit = Math.min(Math.max(Number(limit || 48), 12), 300);
  const result = await withPublicCache(
    getPublicCacheKey("candles", [symbol, normalizedInterval, normalizedLimit, testnet ? "testnet" : "mainnet"]),
    PUBLIC_CACHE_TTLS_MS.candles,
    () => publicRequest("/v5/market/kline", {
      category: "spot",
      symbol,
      interval: normalizedInterval,
      limit: normalizedLimit,
    }, testnet)
  );

  return (result.list || [])
    .map((item) => ({
      openTime: Number(item[0] || 0),
      open: Number(item[1] || 0),
      high: Number(item[2] || 0),
      low: Number(item[3] || 0),
      close: Number(item[4] || 0),
      volume: Number(item[5] || 0),
    }))
    .sort((a, b) => a.openTime - b.openTime);
}

async function placeSpotOrder(account, orderInput) {
  const params = {
    category: "spot",
    symbol: orderInput.symbol,
    side: orderInput.side === "BUY" ? "Buy" : "Sell",
    orderType: orderInput.type === "LIMIT" ? "Limit" : "Market",
    qty: orderInput.quoteOrderQty && orderInput.type === "MARKET" && orderInput.side === "BUY"
      ? String(orderInput.quoteOrderQty)
      : String(orderInput.quantity || "0"),
    price: orderInput.type === "LIMIT" ? String(orderInput.price) : undefined,
    timeInForce: orderInput.type === "LIMIT" ? orderInput.timeInForce || "GTC" : "IOC",
    orderFilter: "Order",
  };

  if (orderInput.quoteOrderQty && orderInput.type === "MARKET" && orderInput.side === "BUY") {
    params.marketUnit = "quoteCoin";
  } else if (orderInput.type === "MARKET") {
    params.marketUnit = "baseCoin";
  }

  const result = await signedRequest(account, "/v5/order/create", "POST", params);
  return waitForOrder(account, orderInput.symbol, result.orderId);
}

module.exports = {
  getConnectivityStatus,
  getAccountInfo,
  cancelOrder,
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
