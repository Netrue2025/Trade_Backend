const {
  calculateEmaSeries,
  calculateRsiSeries,
  lastDefined,
  normalizeCandles,
  toNumber,
} = require("./helpers");

const STRATEGY = "EMA_RSI";

function buildMiss(reason, details = {}) {
  return {
    matched: false,
    strategy: STRATEGY,
    confidence: 0,
    reason,
    details,
  };
}

function evaluateEmaRsiStrategy({ candles = [] }) {
  const normalizedCandles = normalizeCandles(candles).slice(-120);
  if (normalizedCandles.length < 60) {
    return buildMiss("Not enough candle history for EMA and RSI.");
  }

  const ema50Series = calculateEmaSeries(normalizedCandles, 50);
  const rsiSeries = calculateRsiSeries(normalizedCandles, 14);
  const lastIndex = normalizedCandles.length - 1;
  const previousIndex = lastIndex - 1;
  const lastCandle = normalizedCandles[lastIndex];
  const previousCandle = normalizedCandles[previousIndex];
  const currentEma50 = toNumber(ema50Series[lastIndex], NaN);
  const previousEma50 = toNumber(ema50Series[previousIndex], NaN);
  const currentRsi = toNumber(lastDefined(rsiSeries), NaN);

  if (!Number.isFinite(currentEma50) || !Number.isFinite(previousEma50) || !Number.isFinite(currentRsi)) {
    return buildMiss("EMA50 or RSI values are not ready yet.");
  }

  const crossedUp = previousCandle.close <= previousEma50 && lastCandle.close > currentEma50;
  if (!crossedUp) {
    return buildMiss("Price did not cross above EMA50.", {
      previousClose: previousCandle.close,
      previousEma50,
      close: lastCandle.close,
      currentEma50,
    });
  }

  if (currentRsi < 40 || currentRsi > 50) {
    return buildMiss("RSI is outside the 40-50 build-up range.", {
      currentRsi,
    });
  }

  const entry = toNumber(lastCandle.close);
  const stopLoss = Number((Math.min(lastCandle.low, currentEma50) * 0.992).toFixed(6));
  const takeProfit = Number((entry + ((entry - stopLoss) * 2)).toFixed(6));
  const confidence = Math.min(0.8, 0.6 + ((50 - Math.abs(45 - currentRsi)) * 0.004));

  return {
    matched: true,
    strategy: STRATEGY,
    confidence: Number(confidence.toFixed(2)),
    entry: Number(entry.toFixed(6)),
    stopLoss,
    takeProfit,
    reason: `Price reclaimed EMA50 while RSI held at ${currentRsi.toFixed(2)}.`,
    details: {
      ema50: Number(currentEma50.toFixed(6)),
      rsi: Number(currentRsi.toFixed(2)),
    },
  };
}

module.exports = {
  STRATEGY,
  evaluateEmaRsiStrategy,
};
