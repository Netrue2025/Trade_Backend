"use strict";

function deriveTradeLifecycle(trade, getRemainingTradeQuantity) {
  const exitStatuses = (trade?.exitOrders || [])
    .map((exitOrder) => String(exitOrder?.adminExecution?.status || "").trim().toUpperCase())
    .filter(Boolean);
  const adminStatus = String(trade?.adminExecution?.status || "").trim().toUpperCase();
  const entryQuantity = Number(trade?.adminExecution?.executedQty || 0);
  const remainingQuantity = typeof getRemainingTradeQuantity === "function"
    ? getRemainingTradeQuantity(trade)
    : 0;

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

module.exports = { deriveTradeLifecycle };
