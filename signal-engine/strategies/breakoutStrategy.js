const {
  average,
  getLastCandle,
  normalizeCandles,
  standardDeviation,
  toNumber,
} = require("./helpers");

const STRATEGY = "BREAKOUT";

function buildMiss(reason, details = {}) {
  return {
    matched: false,
    strategy: STRATEGY,
    confidence: 0,
    reason,
    details,
  };
}

function evaluateBreakoutStrategy({ candles = [] }) {
  const normalizedCandles = normalizeCandles(candles).slice(-80);
  if (normalizedCandles.length < 40) {
    return buildMiss("Not enough candle history for breakout detection.");
  }

  const consolidationWindow = normalizedCandles.slice(-21, -1);
  const lastCandle = getLastCandle(normalizedCandles);
  const highs = consolidationWindow.map((candle) => candle.high);
  const lows = consolidationWindow.map((candle) => candle.low);
  const closes = consolidationWindow.map((candle) => candle.close);
  const zoneHigh = Math.max(...highs);
  const zoneLow = Math.min(...lows);
  const midPrice = average(closes);
  const rangePercent = midPrice > 0 ? ((zoneHigh - zoneLow) / midPrice) * 100 : 100;
  if (rangePercent > 2.2) {
    return buildMiss("Consolidation zone is too wide to qualify.", { rangePercent });
  }

  const volumeBase = average(consolidationWindow.map((candle) => candle.volume));
  const volumeSpike = volumeBase > 0 ? lastCandle.volume / volumeBase : 0;
  if (toNumber(lastCandle.close) <= zoneHigh || volumeSpike < 1.6) {
    return buildMiss("Breakout candle did not close above resistance with enough volume.", {
      zoneHigh,
      close: lastCandle.close,
      volumeSpike,
    });
  }

  const volatility = standardDeviation(closes);
  const entry = toNumber(lastCandle.close);
  const stopLoss = Number((Math.max(zoneLow, entry - (volatility * 2.2))).toFixed(6));
  const takeProfit = Number((entry + Math.max((entry - stopLoss) * 2, volatility * 3)).toFixed(6));
  const confidence = Math.min(0.84, 0.6 + (volumeSpike * 0.08) - (rangePercent * 0.03));

  return {
    matched: true,
    strategy: STRATEGY,
    confidence: Number(confidence.toFixed(2)),
    entry: Number(entry.toFixed(6)),
    stopLoss,
    takeProfit,
    resistanceLevel: Number(zoneHigh.toFixed(6)),
    reason: `Consolidation broke upward with ${volumeSpike.toFixed(2)}x volume.`,
    details: {
      zoneHigh,
      zoneLow,
      rangePercent,
      volumeSpike,
    },
  };
}

module.exports = {
  STRATEGY,
  evaluateBreakoutStrategy,
};
