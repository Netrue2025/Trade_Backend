const { EMA, RSI } = require("technicalindicators");

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeCandles(candles = []) {
  return [...(Array.isArray(candles) ? candles : [])]
    .map((candle) => ({
      openTime: toNumber(candle.openTime, 0),
      open: toNumber(candle.open, 0),
      high: toNumber(candle.high, 0),
      low: toNumber(candle.low, 0),
      close: toNumber(candle.close, 0),
      volume: toNumber(candle.volume, 0),
    }))
    .filter((candle) => candle.openTime > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0)
    .sort((left, right) => left.openTime - right.openTime);
}

function average(values = []) {
  const numericValues = values.map((value) => toNumber(value, NaN)).filter(Number.isFinite);
  if (!numericValues.length) {
    return 0;
  }
  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}

function standardDeviation(values = []) {
  const mean = average(values);
  if (!mean && mean !== 0) {
    return 0;
  }
  const numericValues = values.map((value) => toNumber(value, NaN)).filter(Number.isFinite);
  if (!numericValues.length) {
    return 0;
  }
  const variance = average(numericValues.map((value) => (value - mean) ** 2));
  return Math.sqrt(Math.max(variance, 0));
}

function calculateEmaSeries(candles = [], period = 50) {
  const normalized = normalizeCandles(candles);
  const closes = normalized.map((candle) => candle.close);
  const rawSeries = EMA.calculate({ period, values: closes });
  const padding = Array(Math.max(normalized.length - rawSeries.length, 0)).fill(null);
  return [...padding, ...rawSeries];
}

function calculateRsiSeries(candles = [], period = 14) {
  const normalized = normalizeCandles(candles);
  const closes = normalized.map((candle) => candle.close);
  const rawSeries = RSI.calculate({ period, values: closes });
  const padding = Array(Math.max(normalized.length - rawSeries.length, 0)).fill(null);
  return [...padding, ...rawSeries];
}

function lastDefined(values = []) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null && values[index] !== undefined && Number.isFinite(Number(values[index]))) {
      return Number(values[index]);
    }
  }
  return NaN;
}

function getLastCandle(candles = []) {
  return normalizeCandles(candles).slice(-1)[0] || null;
}

function getBodySize(candle = {}) {
  return Math.abs(toNumber(candle.close) - toNumber(candle.open));
}

function getLowerWick(candle = {}) {
  const open = toNumber(candle.open);
  const close = toNumber(candle.close);
  const low = toNumber(candle.low);
  return Math.max(Math.min(open, close) - low, 0);
}

module.exports = {
  average,
  calculateEmaSeries,
  calculateRsiSeries,
  getBodySize,
  getLastCandle,
  getLowerWick,
  lastDefined,
  normalizeCandles,
  standardDeviation,
  toNumber,
};
