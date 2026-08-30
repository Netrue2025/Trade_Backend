const { MongoClient } = require("mongodb");

const { getMongoCollectionByName } = require("../lib/db");
const { assertValidMongoConnectionString, getEnvValue, getMongoDbNameFromUri, isMongoConnectionString } = require("../lib/env");

const DEFAULT_COLLECTION_NAME = "trade_learning_trades";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_SAMPLE_SIZE = 8;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(values = []) {
  const numbers = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!numbers.length) {
    return 0;
  }
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function percentile(values = [], percentileValue = 0.5) {
  const numbers = values.map((value) => Number(value)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) {
    return 0;
  }
  if (numbers.length === 1) {
    return numbers[0];
  }

  const boundedPercentile = clamp(Number(percentileValue || 0), 0, 1);
  const position = (numbers.length - 1) * boundedPercentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return numbers[lowerIndex];
  }

  const weight = position - lowerIndex;
  return numbers[lowerIndex] + ((numbers[upperIndex] - numbers[lowerIndex]) * weight);
}

function roundNumber(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
}

function getMongoUri() {
  return assertValidMongoConnectionString(
    getEnvValue("MONGODB_URI", "MONGO_URI"),
    "Trade learning MongoDB connection string"
  );
}

function getAppMongoUri() {
  const mongoUri = getEnvValue("MONGODB_URI");
  return isMongoConnectionString(mongoUri) ? mongoUri : "";
}

function getMongoDbName(uri) {
  return getEnvValue("MONGODB_DB_NAME", "MONGO_DB_NAME")
    || getMongoDbNameFromUri(uri, "trade_mvp")
    || "trade_mvp";
}

function getMongoClientOptions() {
  return {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 30000,
    maxPoolSize: 5,
  };
}

function buildRsiRangeStats(trades = []) {
  const ranges = [];
  for (let start = 20; start < 85; start += 5) {
    const end = start + 4;
    const inRange = trades.filter((trade) => {
      const value = Number(trade?.indicators?.rsiEntry ?? trade?.indicators?.rsi14 ?? NaN);
      return Number.isFinite(value) && value >= start && value <= end;
    });
    if (!inRange.length) {
      continue;
    }

    const wins = inRange.filter((trade) => trade.result === "win").length;
    const avgProfitLoss = average(inRange.map((trade) => trade.profitPercent));
    ranges.push({
      range: `${start}-${end}`,
      trades: inRange.length,
      winRate: roundNumber((wins / inRange.length) * 100, 2),
      averageProfitLoss: roundNumber(avgProfitLoss, 4),
    });
  }
  return ranges;
}

class TradeLearningService {
  constructor({ collectionName, logger = console, ttlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    this.collectionName = String(collectionName || getEnvValue("TRADE_LEARNING_COLLECTION") || DEFAULT_COLLECTION_NAME).trim()
      || DEFAULT_COLLECTION_NAME;
    this.logger = logger;
    this.ttlMs = ttlMs;
    this.mongoUri = getMongoUri();
    this.clientPromise = null;
    this.collectionPromise = null;
    this.cache = new Map();
  }

  isEnabled() {
    return !!this.mongoUri;
  }

  shouldUseSharedAppMongo() {
    return !!this.mongoUri && this.mongoUri === getAppMongoUri();
  }

  invalidateCache(strategyType = "") {
    const normalizedStrategy = String(strategyType || "").trim().toUpperCase();
    if (normalizedStrategy) {
      this.cache.delete(`analysis:${normalizedStrategy}`);
      return;
    }
    this.cache.clear();
  }

  async getCollection() {
    if (!this.isEnabled()) {
      return null;
    }

    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        if (this.shouldUseSharedAppMongo()) {
          const sharedCollection = await getMongoCollectionByName(this.collectionName);
          if (sharedCollection) {
            return sharedCollection;
          }
        }

        if (!this.clientPromise) {
          this.clientPromise = MongoClient.connect(this.mongoUri, getMongoClientOptions());
        }
        const client = await this.clientPromise;
        return client.db(getMongoDbName(this.mongoUri)).collection(this.collectionName);
      })();
    }

    return this.collectionPromise;
  }

  async ensureIndexes() {
    const collection = await this.getCollection();
    if (!collection) {
      return false;
    }

    await collection.createIndex({ tradeKey: 1 }, { unique: true, name: "tradeKey_unique" });
    await collection.createIndex({ strategyType: 1, timestamp: -1 }, { name: "strategy_timestamp_idx" });
    await collection.createIndex({ result: 1, timestamp: -1 }, { name: "result_timestamp_idx" });
    return true;
  }

  async init() {
    if (!this.isEnabled()) {
      this.logger.warn("Trade learning service disabled: MongoDB is not configured.");
      return this;
    }

    await this.ensureIndexes();
    this.logger.log("Trade learning service started.");
    return this;
  }

  async recordTrade(tradeRecord = {}) {
    const collection = await this.getCollection();
    if (!collection) {
      return { ok: false, skipped: true, reason: "mongo_disabled" };
    }

    const tradeKey = String(tradeRecord.tradeKey || tradeRecord.tradeId || "").trim();
    if (!tradeKey) {
      return { ok: false, skipped: true, reason: "missing_trade_key" };
    }

    const document = {
      ...tradeRecord,
      tradeKey,
      strategyType: String(tradeRecord.strategyType || "").trim().toUpperCase() || "UNKNOWN",
      result: String(tradeRecord.result || "").trim().toLowerCase() || "loss",
      timestamp: tradeRecord.timestamp || new Date().toISOString(),
      updatedAt: new Date(),
    };

    await collection.updateOne(
      { tradeKey },
      {
        $set: document,
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    this.invalidateCache(document.strategyType);
    return { ok: true, tradeKey };
  }

  async listTrades({ strategyType } = {}) {
    const collection = await this.getCollection();
    if (!collection) {
      return [];
    }

    const filter = {};
    const normalizedStrategy = String(strategyType || "").trim().toUpperCase();
    if (normalizedStrategy) {
      filter.strategyType = normalizedStrategy;
    }

    return collection.find(filter).sort({ timestamp: -1 }).limit(500).toArray();
  }

  async analyzePerformance({ strategyType = "QUALITY_ERS", forceRefresh = false } = {}) {
    const normalizedStrategy = String(strategyType || "").trim().toUpperCase() || "QUALITY_ERS";
    const cacheKey = `analysis:${normalizedStrategy}`;
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.updatedAt < this.ttlMs) {
      return cached.value;
    }

    const trades = (await this.listTrades({ strategyType: normalizedStrategy }))
      .filter((trade) => Number.isFinite(Number(trade.entryPrice)) && Number.isFinite(Number(trade.exitPrice)));
    const wins = trades.filter((trade) => trade.result === "win");
    const losses = trades.filter((trade) => trade.result !== "win");
    const analysis = {
      strategyType: normalizedStrategy,
      sampleSize: trades.length,
      winRate: trades.length ? roundNumber((wins.length / trades.length) * 100, 2) : 0,
      averageProfitLoss: roundNumber(average(trades.map((trade) => trade.profitPercent)), 4),
      averageWinPercent: roundNumber(average(wins.map((trade) => trade.profitPercent)), 4),
      averageLossPercent: roundNumber(average(losses.map((trade) => trade.profitPercent)), 4),
      indicatorEffectiveness: {
        rsiRanges: buildRsiRangeStats(trades),
        averageWinningRsi: roundNumber(average(wins.map((trade) => trade?.indicators?.rsiEntry ?? trade?.indicators?.rsi14)), 4),
        averageWinningEmaGapPercent: roundNumber(average(wins.map((trade) => trade?.indicators?.emaGapPercent)), 6),
        averageWinningSupportDistancePercent: roundNumber(average(wins.map((trade) => trade?.indicators?.supportDistancePercent)), 6),
      },
      generatedAt: new Date().toISOString(),
    };

    this.cache.set(cacheKey, {
      value: analysis,
      updatedAt: Date.now(),
    });

    return analysis;
  }

  async getAdaptiveParameters({ strategyType = "QUALITY_ERS", defaults = {}, enabled } = {}) {
    const baseParameters = {
      ...defaults,
    };

    const adaptiveEnabled = enabled === undefined
      ? parseBoolean(process.env.USE_ADAPTIVE_STRATEGY, false)
      : !!enabled;

    if (!adaptiveEnabled) {
      return {
        ...baseParameters,
        adaptiveStrategyEnabled: false,
        adaptiveSource: enabled === undefined ? "disabled" : "settings_disabled",
      };
    }

    const analysis = await this.analyzePerformance({ strategyType });
    if (analysis.sampleSize < DEFAULT_MIN_SAMPLE_SIZE) {
      return {
        ...baseParameters,
        adaptiveStrategyEnabled: false,
        adaptiveSource: "insufficient_history",
        adaptiveSampleSize: analysis.sampleSize,
      };
    }

    const trades = await this.listTrades({ strategyType });
    const wins = trades.filter((trade) => trade.result === "win");
    const winRsiValues = wins
      .map((trade) => Number(trade?.indicators?.rsiEntry ?? trade?.indicators?.rsi14 ?? NaN))
      .filter((value) => Number.isFinite(value));
    const winEmaGapValues = wins
      .map((trade) => Number(trade?.indicators?.emaGapPercent ?? NaN))
      .filter((value) => Number.isFinite(value) && value > 0);
    const winSupportDistanceValues = wins
      .map((trade) => Number(trade?.indicators?.supportDistancePercent ?? NaN))
      .filter((value) => Number.isFinite(value) && value >= 0);

    let rsiOversold = Number(baseParameters.rsiOversold || 48);
    let rsiOverbought = Number(baseParameters.rsiOverbought || 66);
    if (winRsiValues.length >= 4) {
      rsiOversold = clamp(Math.round(percentile(winRsiValues, 0.25) - 2), 30, 60);
      rsiOverbought = clamp(
        Math.round(percentile(winRsiValues, 0.8) + 4),
        Math.max(rsiOversold + 8, 55),
        80
      );
    }

    let emaCrossoverSensitivityPercent = Number(baseParameters.emaCrossoverSensitivityPercent || 0.1);
    if (winEmaGapValues.length >= 4) {
      emaCrossoverSensitivityPercent = roundNumber(
        clamp(percentile(winEmaGapValues, 0.35), 0.02, 2),
        6
      );
    }

    let supportResistanceTolerancePercent = Number(baseParameters.supportResistanceTolerancePercent || 0.35);
    if (winSupportDistanceValues.length >= 4) {
      supportResistanceTolerancePercent = roundNumber(
        clamp(percentile(winSupportDistanceValues, 0.75) * 1.15, 0.1, 2),
        6
      );
    }

    const minimumConfidenceScore = roundNumber(
      clamp(
        Number(baseParameters.minimumConfidenceScore || 0.6)
          + (analysis.winRate >= 60 && analysis.averageProfitLoss > 0 ? -0.02 : 0.04),
        0.55,
        0.85
      ),
      4
    );

    return {
      ...baseParameters,
      rsiOversold,
      rsiOverbought,
      emaCrossoverSensitivityPercent,
      supportResistanceTolerancePercent,
      minimumConfidenceScore,
      adaptiveStrategyEnabled: true,
      adaptiveSource: "trade_learning",
      adaptiveSampleSize: analysis.sampleSize,
      adaptiveWinRate: analysis.winRate,
      analysisGeneratedAt: analysis.generatedAt,
    };
  }
}

module.exports = {
  TradeLearningService,
};
