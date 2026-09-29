"use strict";

const { isCurrentGenerationTrade } = require("./tradeGeneration");

function hasVerifiedExchangeCloseEvidence(trade) {
  const evidence = trade?.authoritativeCloseEvidence;
  if (!evidence || evidence.source !== "BYBIT_KNOWN_ORDER_EXECUTION_HISTORY_AND_BALANCE") return false;
  if (String(evidence.tradeId || "") !== String(trade?.id || "")) return false;
  if (String(evidence.entryOrderId || "") !== String(trade?.adminExecution?.orderId || "")) return false;
  if (!Array.isArray(evidence.exitOrderIds) || evidence.exitOrderIds.length === 0) return false;

  const recordedExitIds = new Set((trade?.exitOrders || []).map((item) => String(item?.adminExecution?.orderId || "")).filter(Boolean));
  if (evidence.exitOrderIds.some((orderId) => !recordedExitIds.has(String(orderId)))) return false;

  const entryQuantity = Number(evidence.entryQuantity || 0);
  const entryBaseFee = Number(evidence.entryBaseFee || 0);
  const exitQuantity = Number(evidence.exitQuantity || 0);
  const exitBaseFee = Number(evidence.exitBaseFee || 0);
  const remainingBalance = Number(evidence.remainingBaseBalance || 0);
  const recordedExitQuantity = (trade?.exitOrders || []).reduce((sum, item) => (
    evidence.exitOrderIds.includes(String(item?.adminExecution?.orderId || ""))
      ? sum + Number(item?.adminExecution?.executedQty || 0)
      : sum
  ), 0);
  return [entryQuantity, entryBaseFee, exitQuantity, exitBaseFee, remainingBalance, recordedExitQuantity].every(Number.isFinite)
    && entryQuantity > 0
    && exitQuantity > 0
    && Math.abs(entryQuantity - Number(trade.adminExecution.executedQty || 0)) <= 1e-8
    && Math.abs(exitQuantity - recordedExitQuantity) <= 1e-8
    && Math.abs((entryQuantity - entryBaseFee) - (exitQuantity + exitBaseFee + remainingBalance)) <= 1e-8;
}

function deriveTradeLifecycle(trade, getRemainingTradeQuantity) {
  if (!isCurrentGenerationTrade(trade)) return "HISTORICAL";

  const exitStatuses = (trade?.exitOrders || [])
    .map((exitOrder) => String(exitOrder?.adminExecution?.status || "").trim().toUpperCase())
    .filter(Boolean);
  const adminStatus = String(trade?.adminExecution?.status || "").trim().toUpperCase();
  const entryQuantity = Number(trade?.adminExecution?.executedQty || 0);
  const remainingQuantity = typeof getRemainingTradeQuantity === "function"
    ? getRemainingTradeQuantity(trade)
    : 0;

  if (entryQuantity > 0 && hasVerifiedExchangeCloseEvidence(trade)) return "CLOSED";
  if (exitStatuses.includes("FILLED") && entryQuantity > 0 && remainingQuantity <= 1e-8) {
    return "CLOSED";
  }
  if (!trade?.adminExecution || !adminStatus) {
    return "CANCELED";
  }
  if (adminStatus === "NEW" || adminStatus === "PARTIALLY_FILLED") {
    return "PENDING";
  }
  if (adminStatus === "FILLED" && trade.side === "BUY") {
    if (!(entryQuantity > 0) || !(remainingQuantity > 1e-8)) return "UNVERIFIED";
    return "OPEN";
  }
  if (adminStatus === "FILLED" && trade.side === "SELL") {
    return "CLOSED";
  }
  if (adminStatus === "CANCELED") {
    return "CANCELED";
  }
  if (adminStatus === "ERROR") {
    return "ERROR";
  }
  return "CANCELED";
}

module.exports = { deriveTradeLifecycle, hasVerifiedExchangeCloseEvidence };
