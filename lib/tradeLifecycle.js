"use strict";

const { isCurrentGenerationTrade } = require("./tradeGeneration");

function hasVerifiedExchangeCloseEvidence(trade) {
  const evidence = trade?.authoritativeCloseEvidence;
  if (!evidence || ![
    "BYBIT_KNOWN_ORDER_EXECUTION_HISTORY_AND_BALANCE",
    "BYBIT_KNOWN_FILLED_TAKE_PROFIT_EXECUTION_HISTORY",
    "BYBIT_TRADE_SCOPED_EXECUTION_HISTORY",
  ].includes(evidence.source)) return false;
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
  const balanceTolerance = Math.max(Number(evidence.tolerance || 0), 1e-8);
  const recordedExitQuantity = (trade?.exitOrders || []).reduce((sum, item) => (
    evidence.exitOrderIds.includes(String(item?.adminExecution?.orderId || ""))
      ? sum + Number(item?.adminExecution?.executedQty || 0)
      : sum
  ), 0);
  const completeEvidence = [entryQuantity, entryBaseFee, exitQuantity, exitBaseFee, remainingBalance, recordedExitQuantity, balanceTolerance].every(Number.isFinite)
    && entryQuantity > 0
    && exitQuantity > 0
    && Math.abs(entryQuantity - Number(trade.adminExecution.executedQty || 0)) <= 1e-8
    && Math.abs(exitQuantity - recordedExitQuantity) <= 1e-8;
  if (!completeEvidence) return false;
  if (evidence.source === "BYBIT_TRADE_SCOPED_EXECUTION_HISTORY") {
    const remainingTradeQuantity = Number(evidence.remainingTradeQuantity);
    return Number.isFinite(remainingTradeQuantity)
      && remainingTradeQuantity <= balanceTolerance
      && Math.abs((entryQuantity - entryBaseFee) - (exitQuantity + exitBaseFee + remainingTradeQuantity)) <= balanceTolerance;
  }
  if (evidence.source === "BYBIT_KNOWN_FILLED_TAKE_PROFIT_EXECUTION_HISTORY") {
    const accountingDelta = Number(evidence.accountingDelta);
    const computedDelta = (entryQuantity - entryBaseFee) - (exitQuantity + exitBaseFee + remainingBalance);
    if (evidence.balanceReconciled !== false
      || !Number.isFinite(accountingDelta)
      || Math.abs(computedDelta - accountingDelta) > 1e-8
      || remainingBalance > balanceTolerance
      || Math.abs(accountingDelta) <= balanceTolerance) return false;
    const filledTakeProfitOrders = (trade?.exitOrders || []).filter((item) => (
      evidence.exitOrderIds.includes(String(item?.adminExecution?.orderId || ""))
      && String(item?.kind || "").toUpperCase() === "TAKE_PROFIT"
      && String(item?.adminExecution?.status || "").toUpperCase() === "FILLED"
      && item?.adminExecution?.authoritativeHistory === true
      && Number(item?.adminExecution?.origQty || 0) > 0
      && Math.abs(Number(item.adminExecution.executedQty || 0) - Number(item.adminExecution.origQty || 0)) <= 1e-8
    ));
    const verifiedTpQty = filledTakeProfitOrders.reduce((sum, item) => sum + Number(item.adminExecution.executedQty || 0), 0);
    return filledTakeProfitOrders.length > 0
      && filledTakeProfitOrders.length === evidence.exitOrderIds.length
      && Math.abs(exitQuantity - verifiedTpQty) <= 1e-8;
  }
  return Math.abs((entryQuantity - entryBaseFee) - (exitQuantity + exitBaseFee + remainingBalance)) <= balanceTolerance;
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
