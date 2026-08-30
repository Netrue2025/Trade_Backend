const { EMA, RSI } = require("technicalindicators");

function toFixedNumber(value, precision = 8) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Number(amount.toFixed(precision));
}

function pluckSeries(candles, key) {
  return candles.map((candle) => Number(candle?.[key] || 0)).filter((value) => Number.isFinite(value) && value > 0);
}

function alignIndicatorValues(candles, values) {
  const emptySlots = Math.max(candles.length - values.length, 0);
  return Array.from({ length: emptySlots }).fill(null).concat(values.map((value) => toFixedNumber(value)));
}

function calculateEmaSeries(candles, period = 50) {
  const closes = pluckSeries(candles, "close");
  if (closes.length < period) {
    return Array.from({ length: candles.length }).fill(null);
  }
  return alignIndicatorValues(candles, EMA.calculate({ period, values: closes }));
}

function calculateRsiSeries(candles, period = 14) {
  const closes = pluckSeries(candles, "close");
  if (closes.length <= period) {
    return Array.from({ length: candles.length }).fill(null);
  }
  return alignIndicatorValues(candles, RSI.calculate({ period, values: closes }));
}

function getAverageVolume(candles, window = 20) {
  const items = candles.slice(-window);
  if (!items.length) {
    return 0;
  }
  const total = items.reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  return total / items.length;
}

function getRollingLevels(candles, lookback = 80) {
  const sample = candles.slice(-(lookback + 1), -1);
  if (!sample.length) {
    return {
      support: 0,
      resistance: 0,
    };
  }

  return sample.reduce(
    (acc, candle) => ({
      support: acc.support === 0 ? Number(candle.low || 0) : Math.min(acc.support, Number(candle.low || 0)),
      resistance: Math.max(acc.resistance, Number(candle.high || 0)),
    }),
    { support: 0, resistance: 0 }
  );
}

module.exports = {
  calculateEmaSeries,
  calculateRsiSeries,
  getAverageVolume,
  getRollingLevels,
  toFixedNumber,
};
