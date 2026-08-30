const { getMongoCollectionByName, shouldUseMongo } = require("../../lib/db");

class TradeLearning {
  constructor({ collectionName = "signal_trade_learning", logger = console } = {}) {
    this.collectionName = collectionName;
    this.logger = logger;
    this.memoryTrades = [];
    this.analysisCache = null;
  }

  async init() {
    if (!shouldUseMongo()) {
      this.logger.warn("Signal ML storage running in memory because MongoDB is not configured.");
      return this;
    }

    const collection = await getMongoCollectionByName(this.collectionName);
    await collection.createIndex({ closedAt: -1 }, { name: "signal_learning_closed_idx" });
    await collection.createIndex({ strategy: 1, timeframe: 1 }, { name: "signal_learning_strategy_idx" });
    return this;
  }

  async getCollection() {
    if (!shouldUseMongo()) {
      return null;
    }
    return getMongoCollectionByName(this.collectionName);
  }

  async recordTrade(trade = {}) {
    const document = {
      strategy: String(trade.strategy || "").trim().toUpperCase(),
      timeframe: String(trade.timeframe || "").trim(),
      entry: Number(trade.entry || 0),
      exit: Number(trade.exit || 0),
      result: String(trade.result || "").trim().toLowerCase() || "loss",
      rsi: Number(trade.rsi || 0) || null,
      createdAt: trade.createdAt || new Date().toISOString(),
      closedAt: trade.closedAt || new Date().toISOString(),
    };

    const collection = await this.getCollection();
    if (!collection) {
      this.memoryTrades.push(document);
      this.analysisCache = null;
      return document;
    }

    await collection.insertOne(document);
    this.analysisCache = null;
    return document;
  }

  async listTrades() {
    const collection = await this.getCollection();
    if (!collection) {
      return [...this.memoryTrades];
    }
    return collection.find({}).sort({ closedAt: -1 }).limit(500).toArray();
  }

  async analyze() {
    if (this.analysisCache) {
      return this.analysisCache;
    }

    const trades = await this.listTrades();
    if (trades.length < 100) {
      return {
        sampleSize: trades.length,
        ready: false,
        message: "Adaptive learning becomes active after 100 closed trades.",
      };
    }

    const byStrategy = new Map();
    const byTimeframe = new Map();
    const rsiBuckets = new Map();

    for (const trade of trades) {
      const strategyKey = trade.strategy || "UNKNOWN";
      const timeframeKey = trade.timeframe || "unknown";
      const rsiBucket = Number.isFinite(Number(trade.rsi)) ? `${Math.floor(Number(trade.rsi) / 5) * 5}-${Math.floor(Number(trade.rsi) / 5) * 5 + 4}` : "unknown";
      for (const [map, key] of [[byStrategy, strategyKey], [byTimeframe, timeframeKey], [rsiBuckets, rsiBucket]]) {
        const current = map.get(key) || { wins: 0, total: 0 };
        current.total += 1;
        if (trade.result === "win") {
          current.wins += 1;
        }
        map.set(key, current);
      }
    }

    const toRows = (map) =>
      [...map.entries()]
        .map(([key, value]) => ({
          key,
          sampleSize: value.total,
          winRate: value.total ? Number(((value.wins / value.total) * 100).toFixed(2)) : 0,
        }))
        .sort((left, right) => right.winRate - left.winRate);

    const analysis = {
      sampleSize: trades.length,
      ready: true,
      winRatePerStrategy: toRows(byStrategy),
      bestTimeframes: toRows(byTimeframe),
      bestRsiRanges: toRows(rsiBuckets).filter((item) => item.key !== "unknown"),
      adaptiveParameters: {
        preferredStrategies: toRows(byStrategy).slice(0, 2).map((item) => item.key),
        preferredTimeframes: toRows(byTimeframe).slice(0, 2).map((item) => item.key),
        preferredRsiRanges: toRows(rsiBuckets).filter((item) => item.key !== "unknown").slice(0, 2).map((item) => item.key),
      },
    };

    this.analysisCache = analysis;
    return analysis;
  }
}

module.exports = {
  TradeLearning,
};
