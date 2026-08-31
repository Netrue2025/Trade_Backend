const bybit = require("./bybit");
const binance = require("./binance");

const EXCHANGES = {
  bybit: {
    id: "bybit",
    label: "Bybit",
    ...bybit,
  },
  binance: {
    id: "binance",
    label: "Binance",
    ...binance,
  },
};

function normalizeExchange(value, fallback = "bybit") {
  const key = String(value || "").trim().toLowerCase();
  return EXCHANGES[key] ? key : fallback;
}

function getExchangeClient(value) {
  return EXCHANGES[normalizeExchange(value)];
}

function listExchanges() {
  return Object.values(EXCHANGES).map((item) => ({ id: item.id, label: item.label }));
}

module.exports = {
  EXCHANGES,
  getExchangeClient,
  listExchanges,
  normalizeExchange,
};
