const { EMA, RSI, SMA } = require("technicalindicators");

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function average(values = []) {
  const numbers = values.map((value) => toNumber(value, NaN)).filter((value) => Number.isFinite(value));
  if (!numbers.length) {
    return 0;
  }
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function standardDeviation(values = []) {
  const numbers = values.map((value) => toNumber(value, NaN)).filter((value) => Number.isFinite(value));
  if (numbers.length < 2) {
    return 0;
  }

  const mean = average(numbers);
  const variance = numbers.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / numbers.length;
  return Math.sqrt(variance);
}

function seriesFromIndicator(values = [], period, indicator) {
  if (values.length < period) {
    return [];
  }

  const calculated = indicator.calculate({ period, values });
  const padding = new Array(values.length - calculated.length).fill(null);
  return [...padding, ...calculated];
}

function calculateEmaSeries(candles = [], period) {
  return seriesFromIndicator(candles.map((candle) => toNumber(candle.close)), period, EMA);
}

function calculateSmaSeries(candles = [], period) {
  return seriesFromIndicator(candles.map((candle) => toNumber(candle.close)), period, SMA);
}

function calculateRsiSeries(candles = [], period = 14) {
  return seriesFromIndicator(candles.map((candle) => toNumber(candle.close)), period, RSI);
}

function lastDefined(values = []) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(Number(values[index]))) {
      return Number(values[index]);
    }
  }
  return null;
}

function getLastCandle(candles = []) {
  return candles.length ? candles[candles.length - 1] : null;
}

function getCandleRange(candle = {}) {
  return Math.max(toNumber(candle.high) - toNumber(candle.low), 0);
}

function getBodySize(candle = {}) {
  return Math.abs(toNumber(candle.close) - toNumber(candle.open));
}

function getLowerWick(candle = {}) {
  return Math.max(Math.min(toNumber(candle.open), toNumber(candle.close)) - toNumber(candle.low), 0);
}

function getUpperWick(candle = {}) {
  return Math.max(toNumber(candle.high) - Math.max(toNumber(candle.open), toNumber(candle.close)), 0);
}

function buildLineSeries(candles = [], values = []) {
  return candles
    .map((candle, index) => {
      const value = Number(values[index]);
      if (!Number.isFinite(value)) {
        return null;
      }
      return {
        time: Math.floor(Number(candle.openTime || 0) / 1000),
        value,
      };
    })
    .filter(Boolean);
}

function normalizeCandles(candles = []) {
  return candles
    .map((candle) => ({
      openTime: Number(candle.openTime || 0),
      closeTime: Number(candle.closeTime || candle.openTime || 0),
      open: toNumber(candle.open),
      high: toNumber(candle.high),
      low: toNumber(candle.low),
      close: toNumber(candle.close),
      volume: toNumber(candle.volume),
    }))
    .filter((candle) => candle.openTime > 0 && candle.high >= candle.low && candle.close > 0);
}

module.exports = {
  average,
  buildLineSeries,
  calculateEmaSeries,
  calculateRsiSeries,
  calculateSmaSeries,
  getBodySize,
  getCandleRange,
  getLastCandle,
  getLowerWick,
  getUpperWick,
  lastDefined,
  normalizeCandles,
  standardDeviation,
  toNumber,
};
