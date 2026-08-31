const { getCandles: getBinanceCandles } = require("../../lib/binance");
const { getCandles: getBybitCandles } = require("../../lib/bybit");
const {
  buildLineSeries,
  calculateEmaSeries,
  normalizeCandles,
} = require("../utils/candleMath");

class MarketDataService {
  constructor({ logger = console, primaryExchange = "binance" } = {}) {
    this.logger = logger;
    this.primaryExchange = primaryExchange;
    this.lastWorkingProvider = primaryExchange;
  }

  getProviderCandidates() {
    const providers = {
      bybit: () => getBybitCandles,
      binance: () => getBinanceCandles,
    };
    const preferred = this.lastWorkingProvider === "bybit" ? "bybit" : this.primaryExchange;
    const ordered = preferred === "bybit"
      ? ["bybit", "binance"]
      : ["binance", "bybit"];
    return [...new Set(ordered)].map((name) => ({
      name,
      fetchCandles: providers[name](),
    }));
  }

  async tryProvider(name, fetchCandles, symbol, timeframe, limit) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const candles = normalizeCandles(await fetchCandles(symbol, timeframe, limit, false));
        if (candles.length) {
          this.lastWorkingProvider = name;
          return candles;
        }
        lastError = new Error(`${name} returned no candles for ${symbol} ${timeframe}.`);
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    throw lastError || new Error(`${name} failed to provide candles for ${symbol} ${timeframe}.`);
  }

  async getCandles(symbol, timeframe, limit = 240) {
    const providerErrors = [];
    for (const provider of this.getProviderCandidates()) {
      try {
        return await this.tryProvider(provider.name, provider.fetchCandles, symbol, timeframe, limit);
      } catch (error) {
        providerErrors.push(`${provider.name}: ${error.message || error}`);
      }
    }

    throw new Error(
      `No candles available for ${symbol} ${timeframe}. ${providerErrors.join(" | ")}`
    );
  }

  async buildChart(symbol, timeframe, signal = null) {
    const candles = await this.getCandles(symbol, timeframe, 180);
    const ema50Series = calculateEmaSeries(candles, 50);
    const ema200Series = calculateEmaSeries(candles, 200);
    return {
      symbol,
      timeframe,
      updatedAt: new Date().toISOString(),
      candles: candles.map((candle) => ({
        time: Math.floor(Number(candle.openTime || 0) / 1000),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
      ema50: buildLineSeries(candles, ema50Series),
      ema200: buildLineSeries(candles, ema200Series),
      entry: signal?.entry || null,
      entryPrice: signal?.entry || null,
      stopLoss: signal?.stopLoss || null,
      takeProfit: signal?.takeProfit || null,
      supportLevel: signal?.meta?.supportLevel || null,
      resistanceLevel: signal?.meta?.resistanceLevel || null,
      signal,
    };
  }
}

module.exports = {
  MarketDataService,
};
