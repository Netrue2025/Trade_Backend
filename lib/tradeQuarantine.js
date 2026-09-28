"use strict";

// These records are forensic exclusions, not configurable trading state.
const HISTORICAL_EXCLUDED_TRADE_IDS = new Set([
  "89eaf6636270d40f995fde20",
  "b0002ec3b525ec6de7d69a12",
]);

function getQuarantinedTradeIds(db) {
  const ids = db?.systemSettings?.trading?.quarantinedTradeIds;
  return new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
}

function isHistoricalTradeExcluded(tradeOrId) {
  const tradeId = String(typeof tradeOrId === "object" ? tradeOrId?.id : tradeOrId || "");
  return !!tradeId && HISTORICAL_EXCLUDED_TRADE_IDS.has(tradeId);
}

function isTradeQuarantined(db, tradeOrId) {
  const tradeId = String(typeof tradeOrId === "object" ? tradeOrId?.id : tradeOrId || "");
  return !!tradeId && (isHistoricalTradeExcluded(tradeId) || getQuarantinedTradeIds(db).has(tradeId));
}

module.exports = { HISTORICAL_EXCLUDED_TRADE_IDS, getQuarantinedTradeIds, isHistoricalTradeExcluded, isTradeQuarantined };
