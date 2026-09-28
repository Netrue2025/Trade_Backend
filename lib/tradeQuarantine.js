"use strict";

function getQuarantinedTradeIds(db) {
  const ids = db?.systemSettings?.trading?.quarantinedTradeIds;
  return new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
}

function isTradeQuarantined(db, tradeOrId) {
  const tradeId = String(typeof tradeOrId === "object" ? tradeOrId?.id : tradeOrId || "");
  return !!tradeId && getQuarantinedTradeIds(db).has(tradeId);
}

module.exports = { getQuarantinedTradeIds, isTradeQuarantined };
