"use strict";

const { CURRENT_TRADE_FEE_MODEL } = require("./tradingFee");

// settlementFeeModel is the server-assigned current-generation marker on trade records.
function isCurrentGenerationTrade(trade) {
  return trade?.settlementFeeModel === CURRENT_TRADE_FEE_MODEL;
}

function requireCurrentGenerationTrade(trade) {
  if (isCurrentGenerationTrade(trade)) return;
  const error = new Error("Historical trades are read-only and cannot join or enter the trading lifecycle.");
  error.statusCode = 409;
  error.code = "HISTORICAL_TRADE_READ_ONLY";
  throw error;
}

function selectCurrentGenerationTrades(trades) {
  return (Array.isArray(trades) ? trades : []).filter(isCurrentGenerationTrade);
}

function selectCurrentGenerationInvestments(investments, trades) {
  const tradesById = new Map(selectCurrentGenerationTrades(trades).map((trade) => [trade.id, trade]));
  return (Array.isArray(investments) ? investments : []).filter((investment) => (
    isCurrentGenerationTrade(tradesById.get(investment.tradeId))
  ));
}

module.exports = {
  isCurrentGenerationTrade,
  requireCurrentGenerationTrade,
  selectCurrentGenerationInvestments,
  selectCurrentGenerationTrades,
};
