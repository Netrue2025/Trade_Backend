const {
  average,
  calculateEmaSeries,
  normalizeCandles,
  standardDeviation,
  toNumber,
} = require("./helpers");

const STRATEGY = "PRO";

function buildMiss(reason, details = {}) {
  return {
    matched: false,
    strategy: STRATEGY,
    confidence: 0,
    reason,
    details,
  };
}

function evaluateMarketStructure(candles = []) {
  const window = candles.slice(-12);
  if (window.length < 12) {
    return false;
  }

  const highs = window.map((candle) => candle.high);
  const lows = window.map((candle) => candle.low);
  return highs[highs.length - 1] > highs[Math.floor(highs.length / 2)]
    && lows[lows.length - 1] > lows[Math.floor(lows.length / 2)];
}

function evaluateProStrategy({ candles = [] }) {
  const normalizedCandles = normalizeCandles(candles).slice(-220);
  if (normalizedCandles.length < 120) {
    return buildMiss("Not enough candle history for PRO strategy.");
  }

  const ema200Series = calculateEmaSeries(normalizedCandles, 200);
  const lastCandle = normalizedCandles[normalizedCandles.length - 1];
  const previousCandle = normalizedCandles[normalizedCandles.length - 2];
  const currentEma200 = toNumber(ema200Series[ema200Series.length - 1], NaN);
  if (!Number.isFinite(currentEma200)) {
    return buildMiss("EMA200 is not ready.");
  }

  if (!evaluateMarketStructure(normalizedCandles)) {
    return buildMiss("Market structure is not printing higher highs and higher lows.");
  }

  const localSupport = Math.min(...normalizedCandles.slice(-18, -2).map((candle) => candle.low));
  const liquiditySweep = previousCandle.low < localSupport && previousCandle.close > localSupport;
  if (!liquiditySweep) {
    return buildMiss("No bullish liquidity sweep was detected.", {
      previousLow: previousCandle.low,
      localSupport,
    });
  }

  const volumeBase = average(normalizedCandles.slice(-30, -2).map((candle) => candle.volume));
  const volumeConfirmed = volumeBase > 0 && lastCandle.volume >= volumeBase * 1.35;
  if (!volumeConfirmed) {
    return buildMiss("Liquidity sweep was not confirmed by volume.", {
      volume: lastCandle.volume,
      volumeBase,
    });
  }

  if (lastCandle.close <= currentEma200) {
    return buildMiss("Trend is not aligned above EMA200.", {
      close: lastCandle.close,
      ema200: currentEma200,
    });
  }

  const closes = normalizedCandles.slice(-40).map((candle) => candle.close);
  const volatility = standardDeviation(closes);
  const entry = toNumber(lastCandle.close);
  const stopLoss = Number((Math.min(previousCandle.low, localSupport) - (volatility * 1.2)).toFixed(6));
  const takeProfit = Number((entry + ((entry - stopLoss) * 2.4)).toFixed(6));
  const confidence = Math.max(0.7, Math.min(0.92, 0.72 + ((lastCandle.volume / volumeBase) * 0.05)));

  return {
    matched: true,
    strategy: STRATEGY,
    confidence: Number(confidence.toFixed(2)),
    entry: Number(entry.toFixed(6)),
    stopLoss,
    takeProfit,
    reason: "Higher-high structure, bullish liquidity sweep, and volume confirmation aligned above EMA200.",
    details: {
      ema200: Number(currentEma200.toFixed(6)),
      localSupport: Number(localSupport.toFixed(6)),
      volumeRatio: Number((lastCandle.volume / volumeBase).toFixed(2)),
    },
  };
}

module.exports = {
  STRATEGY,
  evaluateProStrategy,
};
