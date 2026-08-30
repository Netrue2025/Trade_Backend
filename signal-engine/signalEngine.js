const axios = require("axios");

const { evaluateSupportStrategy } = require("./strategies/supportStrategy");
const { evaluateBreakoutStrategy } = require("./strategies/breakoutStrategy");
const { evaluateEmaRsiStrategy } = require("./strategies/emaRsiStrategy");
const { evaluateProStrategy } = require("./strategies/proStrategy");
const { normalizeCandles } = require("./strategies/helpers");

const SUPPORTED_TIMEFRAMES = ["15m", "1h", "1d"];
const DEFAULT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "TRXUSDT",
  "TONUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SHIBUSDT",
  "DOTUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "UNIUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "APTUSDT",
  "PEPEUSDT",
];

const STRATEGY_EVALUATORS = [
  evaluateSupportStrategy,
  evaluateBreakoutStrategy,
  evaluateEmaRsiStrategy,
  evaluateProStrategy,
];

function parseNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseInteger(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCsvList(value, fallback = []) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function parseTimeframes(value) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => SUPPORTED_TIMEFRAMES.includes(item));
  return items.length ? [...new Set(items)] : SUPPORTED_TIMEFRAMES;
}

function normalizeSignal(signal = {}) {
  return {
    symbol: String(signal.symbol || "").trim().toUpperCase(),
    type: "BUY",
    strategy: String(signal.strategy || "").trim().toUpperCase(),
    confidence: Number(signal.confidence || 0),
    entry: Number(Number(signal.entry || 0).toFixed(6)),
    stopLoss: Number(Number(signal.stopLoss || 0).toFixed(6)),
    takeProfit: Number(Number(signal.takeProfit || 0).toFixed(6)),
    timeframe: String(signal.timeframe || "").trim(),
    createdAt: signal.createdAt || new Date().toISOString(),
    supportLevel: signal.supportLevel ?? null,
    resistanceLevel: signal.resistanceLevel ?? null,
    reason: String(signal.reason || "").trim(),
    details: signal.details && typeof signal.details === "object" && !Array.isArray(signal.details)
      ? signal.details
      : {},
  };
}

function createConfig() {
  return {
    backendUrl: String(process.env.SIGNAL_ENGINE_BACKEND_URL || "http://localhost:3000").replace(/\/+$/, ""),
    ingestPath: String(process.env.SIGNAL_ENGINE_INGEST_PATH || "/api/signals").trim() || "/api/signals",
    ingestSecret: String(process.env.SIGNAL_INGEST_SECRET || "").trim(),
    symbols: parseCsvList(process.env.SIGNAL_ENGINE_SYMBOLS, DEFAULT_SYMBOLS),
    timeframes: parseTimeframes(process.env.SIGNAL_ENGINE_TIMEFRAMES),
    historyLimit: clamp(parseInteger(process.env.SIGNAL_ENGINE_HISTORY_LIMIT, 240), 80, 300),
    intervalMs: clamp(parseInteger(process.env.SIGNAL_ENGINE_INTERVAL_MS, 45_000), 30_000, 60_000),
    minConfidence: clamp(parseNumber(process.env.SIGNAL_ENGINE_MIN_CONFIDENCE, 0.6), 0.5, 1),
    cooldownMs: Math.max(60_000, parseInteger(process.env.SIGNAL_ENGINE_COOLDOWN_MS, 15 * 60 * 1000)),
    marketRequestTimeoutMs: Math.max(10_000, parseInteger(process.env.SIGNAL_ENGINE_MARKET_TIMEOUT_MS, 30_000)),
    postRequestTimeoutMs: Math.max(5_000, parseInteger(process.env.SIGNAL_ENGINE_POST_TIMEOUT_MS, 15_000)),
    providerRetryCount: clamp(parseInteger(process.env.SIGNAL_ENGINE_PROVIDER_RETRIES, 2), 1, 4),
    batchPauseMs: clamp(parseInteger(process.env.SIGNAL_ENGINE_BATCH_PAUSE_MS, 350), 0, 3_000),
    maxConcurrency: clamp(parseInteger(process.env.SIGNAL_ENGINE_MAX_CONCURRENCY, 2), 1, 8),
    exchangePreference: String(process.env.SIGNAL_ENGINE_EXCHANGE || "bybit").trim().toLowerCase() === "binance"
      ? "binance"
      : "bybit",
    enableSound: String(process.env.SIGNAL_ENGINE_ENABLE_SOUND || "true").trim().toLowerCase() !== "false",
  };
}

function timeframeToBybitInterval(timeframe) {
  return {
    "15m": "15",
    "1h": "60",
    "1d": "D",
  }[timeframe] || "15";
}

async function fetchBybitCandles(symbol, timeframe, limit, timeoutMs) {
  const response = await axios.get("https://api.bybit.com/v5/market/kline", {
    params: {
      category: "spot",
      symbol,
      interval: timeframeToBybitInterval(timeframe),
      limit,
    },
    timeout: timeoutMs,
    proxy: false,
  });

  return normalizeCandles((response.data?.result?.list || []).map((item) => ({
    openTime: Number(item[0] || 0),
    open: Number(item[1] || 0),
    high: Number(item[2] || 0),
    low: Number(item[3] || 0),
    close: Number(item[4] || 0),
    volume: Number(item[5] || 0),
  })));
}

async function fetchBinanceCandles(symbol, timeframe, limit, timeoutMs) {
  const response = await axios.get("https://api.binance.com/api/v3/klines", {
    params: {
      symbol,
      interval: timeframe,
      limit,
    },
    timeout: timeoutMs,
    proxy: false,
  });

  return normalizeCandles((Array.isArray(response.data) ? response.data : []).map((item) => ({
    openTime: Number(item[0] || 0),
    open: Number(item[1] || 0),
    high: Number(item[2] || 0),
    low: Number(item[3] || 0),
    close: Number(item[4] || 0),
    volume: Number(item[5] || 0),
  })));
}

class SignalEngine {
  constructor(config = createConfig()) {
    this.config = config;
    this.running = false;
    this.lastSentAt = new Map();
    this.currentCycleStartedAt = null;
  }

  log(level, message, extra = null) {
    const timestamp = new Date().toISOString();
    if (extra !== null && extra !== undefined) {
      console[level](`[signal-engine] ${timestamp} ${message}`, extra);
      return;
    }
    console[level](`[signal-engine] ${timestamp} ${message}`);
  }

  getIngestUrl() {
    return `${this.config.backendUrl}${this.config.ingestPath}`;
  }

  buildHeaders() {
    const headers = {
      "Content-Type": "application/json",
      "X-Signal-Source": "local-signal-engine",
    };
    if (this.config.ingestSecret) {
      headers["X-Signal-Secret"] = this.config.ingestSecret;
      headers.Authorization = `Bearer ${this.config.ingestSecret}`;
    }
    return headers;
  }

  async fetchCandles(symbol, timeframe) {
    const providers = this.config.exchangePreference === "binance"
      ? [
          { name: "binance", fn: fetchBinanceCandles },
          { name: "bybit", fn: fetchBybitCandles },
        ]
      : [
          { name: "bybit", fn: fetchBybitCandles },
          { name: "binance", fn: fetchBinanceCandles },
        ];

    let lastError = null;
    for (const provider of providers) {
      for (let attempt = 1; attempt <= this.config.providerRetryCount; attempt += 1) {
        try {
          const candles = await provider.fn(
            symbol,
            timeframe,
            this.config.historyLimit,
            this.config.marketRequestTimeoutMs
          );
          if (candles.length) {
            if (attempt > 1) {
              this.log("info", `Recovered ${symbol} ${timeframe} market fetch via ${provider.name} on retry ${attempt}.`);
            }
            return candles;
          }
          lastError = new Error(`${provider.name} returned no candles for ${symbol} ${timeframe}.`);
        } catch (error) {
          lastError = error;
          this.log(
            "warn",
            `Market data fetch failed for ${symbol} ${timeframe} via ${provider.name} on attempt ${attempt}/${this.config.providerRetryCount}: ${error.message || error}`
          );
          if (attempt < this.config.providerRetryCount) {
            await sleep(750 * attempt);
          }
        }
      }
    }

    throw lastError || new Error(`No candles returned for ${symbol} ${timeframe}.`);
  }

  logEvaluation(symbol, timeframe, evaluation) {
    const confidence = Number(evaluation?.confidence || 0).toFixed(2);
    if (!evaluation?.matched) {
      this.log("info", `Skipped ${symbol} ${timeframe} ${evaluation.strategy}: ${evaluation.reason}`);
      return;
    }

    this.log("info", `Candidate ${symbol} ${timeframe} ${evaluation.strategy} at confidence ${confidence}`);
  }

  createSignalFromEvaluation(symbol, timeframe, evaluation) {
    return normalizeSignal({
      symbol,
      strategy: evaluation.strategy,
      confidence: evaluation.confidence,
      entry: evaluation.entry,
      stopLoss: evaluation.stopLoss,
      takeProfit: evaluation.takeProfit,
      timeframe,
      createdAt: new Date().toISOString(),
      supportLevel: evaluation.supportLevel,
      resistanceLevel: evaluation.resistanceLevel,
      reason: evaluation.reason,
      details: evaluation.details,
    });
  }

  shouldSkipForCooldown(signal) {
    const cooldownKey = `${signal.symbol}:${signal.timeframe}`;
    const lastSentAt = this.lastSentAt.get(cooldownKey) || 0;
    if (Date.now() - lastSentAt < this.config.cooldownMs) {
      this.log("info", `Skipped ${signal.symbol} ${signal.timeframe} ${signal.strategy}: cooldown active.`);
      return true;
    }
    return false;
  }

  filterSignals(candidates = []) {
    const seen = new Set();
    const accepted = [];
    const acceptedPairTimeframes = new Set();

    for (const signal of [...candidates].sort((left, right) => right.confidence - left.confidence)) {
      if (signal.confidence < this.config.minConfidence) {
        this.log("info", `Skipped ${signal.symbol} ${signal.timeframe} ${signal.strategy}: confidence ${signal.confidence.toFixed(2)} below ${this.config.minConfidence.toFixed(2)}.`);
        continue;
      }

      const duplicateKey = [
        signal.symbol,
        signal.timeframe,
        signal.type,
        Math.round(signal.entry * 1000),
        Math.round(signal.stopLoss * 1000),
        Math.round(signal.takeProfit * 1000),
      ].join(":");

      if (seen.has(duplicateKey)) {
        this.log("info", `Skipped ${signal.symbol} ${signal.timeframe} ${signal.strategy}: duplicate candidate.`);
        continue;
      }

      if (acceptedPairTimeframes.has(`${signal.symbol}:${signal.timeframe}`)) {
        this.log("info", `Skipped ${signal.symbol} ${signal.timeframe} ${signal.strategy}: higher-confidence signal already selected this cycle.`);
        continue;
      }

      if (this.shouldSkipForCooldown(signal)) {
        continue;
      }

      seen.add(duplicateKey);
      acceptedPairTimeframes.add(`${signal.symbol}:${signal.timeframe}`);
      accepted.push(signal);
    }

    return accepted;
  }

  async postSignal(signal) {
    const payload = {
      symbol: signal.symbol,
      type: signal.type,
      strategy: signal.strategy,
      confidence: signal.confidence,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      timeframe: signal.timeframe,
      createdAt: signal.createdAt,
      supportLevel: signal.supportLevel,
      resistanceLevel: signal.resistanceLevel,
      reason: signal.reason,
      details: signal.details,
      meta: {
        reason: signal.reason,
        details: signal.details,
        supportLevel: signal.supportLevel,
        resistanceLevel: signal.resistanceLevel,
      },
    };

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await axios.post(this.getIngestUrl(), payload, {
          headers: this.buildHeaders(),
          timeout: this.config.postRequestTimeoutMs,
          proxy: false,
        });
        return response.data;
      } catch (error) {
        lastError = error;
        this.log("error", `Signal POST failed for ${signal.symbol} ${signal.timeframe} on attempt ${attempt}: ${error.message || error}`);
        if (attempt < 2) {
          await sleep(1500);
        }
      }
    }

    throw lastError || new Error("Signal POST failed.");
  }

  playAlert() {
    if (!this.config.enableSound) {
      return;
    }
    process.stdout.write("\u0007");
  }

  async evaluateSymbol(symbol, timeframe) {
    const candles = await this.fetchCandles(symbol, timeframe);
    const evaluations = STRATEGY_EVALUATORS.map((evaluate) => evaluate({
      symbol,
      timeframe,
      candles,
      config: this.config,
    }));

    const candidates = [];
    for (const evaluation of evaluations) {
      this.logEvaluation(symbol, timeframe, evaluation);
      if (evaluation.matched) {
        candidates.push(this.createSignalFromEvaluation(symbol, timeframe, evaluation));
      }
    }

    return candidates;
  }

  async processBatch(tasks = []) {
    return Promise.all(tasks.map(async ({ symbol, timeframe }) => {
      try {
        return await this.evaluateSymbol(symbol, timeframe);
      } catch (error) {
        this.log("error", `Market evaluation failed for ${symbol} ${timeframe}: ${error.message || error}`);
        return [];
      }
    }));
  }

  async runCycle() {
    this.currentCycleStartedAt = Date.now();
    this.log("info", `Cycle started for ${this.config.symbols.length} pairs across ${this.config.timeframes.join(", ")}.`);

    const tasks = [];
    for (const timeframe of this.config.timeframes) {
      for (const symbol of this.config.symbols) {
        tasks.push({ symbol, timeframe });
      }
    }

    const candidates = [];
    for (let index = 0; index < tasks.length; index += this.config.maxConcurrency) {
      const batch = tasks.slice(index, index + this.config.maxConcurrency);
      const results = await this.processBatch(batch);
      for (const items of results) {
        candidates.push(...items);
      }
      if (this.config.batchPauseMs > 0 && index + this.config.maxConcurrency < tasks.length) {
        await sleep(this.config.batchPauseMs);
      }
    }

    const acceptedSignals = this.filterSignals(candidates);
    for (const signal of acceptedSignals) {
      try {
        const response = await this.postSignal(signal);
        this.lastSentAt.set(`${signal.symbol}:${signal.timeframe}`, Date.now());
        this.playAlert();
        this.log("info", `Signal sent ${signal.symbol} ${signal.timeframe} ${signal.strategy}.`, response);
      } catch (error) {
        this.log("error", `Failed to deliver ${signal.symbol} ${signal.timeframe} ${signal.strategy}: ${error.message || error}`);
      }
    }

    this.log("info", `Cycle finished. Candidates=${candidates.length}, sent=${acceptedSignals.length}.`);
  }

  async start() {
    this.running = true;
    this.log(
      "info",
      `Engine started. Posting to ${this.getIngestUrl()} every ${this.config.intervalMs}ms with market timeout ${this.config.marketRequestTimeoutMs}ms, post timeout ${this.config.postRequestTimeoutMs}ms, concurrency ${this.config.maxConcurrency}.`
    );

    while (this.running) {
      const cycleStartedAt = Date.now();
      try {
        await this.runCycle();
      } catch (error) {
        this.log("error", `Cycle crashed: ${error.message || error}`);
      }

      const elapsedMs = Date.now() - cycleStartedAt;
      const waitMs = Math.max(this.config.intervalMs - elapsedMs, 0);
      await sleep(waitMs);
    }
  }

  stop() {
    this.running = false;
  }
}

function attachProcessGuards() {
  process.on("unhandledRejection", (error) => {
    console.error("[signal-engine] Unhandled rejection:", error);
  });

  process.on("uncaughtException", (error) => {
    console.error("[signal-engine] Uncaught exception:", error);
  });
}

async function main() {
  attachProcessGuards();
  const engine = new SignalEngine(createConfig());
  process.on("SIGINT", () => {
    engine.stop();
  });
  process.on("SIGTERM", () => {
    engine.stop();
  });
  await engine.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[signal-engine] Fatal startup error:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  SignalEngine,
  createConfig,
};
