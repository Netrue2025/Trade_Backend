const {
  average,
  getBodySize,
  getLastCandle,
  getLowerWick,
  normalizeCandles,
  toNumber,
} = require("./helpers");

const STRATEGY = "SUPPORT";

function buildMiss(reason, details = {}) {
  return {
    matched: false,
    strategy: STRATEGY,
    confidence: 0,
    reason,
    details,
  };
}

function evaluateSupportTouches(candles = []) {
  const lows = candles.map((candle) => toNumber(candle.low)).filter((value) => value > 0);
  const candidates = lows.map((low) => ({
    level: low,
    touches: lows.filter((value) => Math.abs(value - low) / low <= 0.0035).length,
  }));
  return candidates.sort((left, right) => right.touches - left.touches)[0] || null;
}

function evaluateSupportStrategy({ symbol, timeframe, candles = [] }) {
  const normalizedCandles = normalizeCandles(candles).slice(-180);
  if (normalizedCandles.length < 60) {
    return buildMiss("Not enough candle history.", { symbol, timeframe });
  }

  const supportCandidate = evaluateSupportTouches(normalizedCandles);
  if (!supportCandidate || supportCandidate.touches < 10) {
    return buildMiss("Support zone did not reach the 10-touch threshold.", {
      touches: supportCandidate?.touches || 0,
    });
  }

  const lastCandle = getLastCandle(normalizedCandles);
  const lowerWick = getLowerWick(lastCandle);
  const body = getBodySize(lastCandle);
  const distanceFromSupport = Math.abs(toNumber(lastCandle.close) - supportCandidate.level) / supportCandidate.level;
  if (distanceFromSupport > 0.0075) {
    return buildMiss("Price is not close enough to the support zone.", {
      distanceFromSupport,
      supportLevel: supportCandidate.level,
    });
  }

  if (lowerWick <= body * 1.2 || toNumber(lastCandle.close) <= toNumber(lastCandle.open)) {
    return buildMiss("Support touch did not reject strongly enough.", {
      lowerWick,
      body,
    });
  }

  const recentRange = average(normalizedCandles.slice(-14).map((candle) => candle.high - candle.low));
  const entry = toNumber(lastCandle.close);
  const stopLoss = Number((supportCandidate.level - (recentRange * 0.35)).toFixed(6));
  const takeProfit = Number((entry + ((entry - stopLoss) * 1.8)).toFixed(6));
  const confidence = Math.min(0.85, 0.58 + (supportCandidate.touches * 0.015) + ((lowerWick / Math.max(body || 1, 1)) * 0.02));

  return {
    matched: true,
    strategy: STRATEGY,
    confidence: Number(confidence.toFixed(2)),
    entry: Number(entry.toFixed(6)),
    stopLoss,
    takeProfit,
    supportLevel: Number(supportCandidate.level.toFixed(6)),
    reason: `Support held with ${supportCandidate.touches} touches and a strong rejection wick.`,
    details: {
      touches: supportCandidate.touches,
      distanceFromSupport,
      lowerWick,
      body,
    },
  };
}

module.exports = {
  STRATEGY,
  evaluateSupportStrategy,
};
