"use strict";

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function reconstructKnownExitExecution({ execution, executions = [] } = {}) {
  const orderId = String(execution?.orderId || "");
  const side = String(execution?.side || "").trim().toUpperCase();
  if (!orderId || !["BUY", "SELL"].includes(side)) return null;

  const fills = executions.filter((item) => (
    String(item?.orderId || "") === orderId
    && String(item?.side || "").trim().toUpperCase() === side
    && toFiniteNumber(item?.execQty) > 0
    && toFiniteNumber(item?.execPrice) > 0
  ));
  if (!fills.length) return null;

  const executedQty = fills.reduce((sum, item) => sum + toFiniteNumber(item.execQty), 0);
  const quoteQty = fills.reduce((sum, item) => sum + toFiniteNumber(item.execQty) * toFiniteNumber(item.execPrice), 0);
  const previousQty = toFiniteNumber(execution.executedQty);
  if (executedQty <= 0 || quoteQty <= 0 || executedQty + 1e-8 < previousQty) return null;

  const originalQty = toFiniteNumber(execution.origQty);
  const complete = originalQty > 0 && executedQty + Math.max(1e-8, originalQty * 1e-10) >= originalQty;
  const fees = fills.reduce((result, item) => {
    const currency = String(item.feeCurrency || "").trim().toUpperCase();
    const amount = toFiniteNumber(item.execFee);
    if (!currency || amount <= 0) return result;
    const existing = result.find((fee) => fee.currency === currency);
    if (existing) existing.amount += amount;
    else result.push({ currency, amount });
    return result;
  }, []);

  return {
    ...execution,
    status: complete ? "FILLED" : "PARTIALLY_FILLED",
    executedQty: String(executedQty),
    cummulativeQuoteQty: String(quoteQty),
    price: String(quoteQty / executedQty),
    rawPrice: String(quoteQty / executedQty),
    transactTime: Math.max(...fills.map((item) => toFiniteNumber(item.execTime))),
    fees,
    authoritativeHistory: true,
  };
}

function diagnoseKnownExitClosure({ tradeId, entryExecution, exitExecutions = [], executions = [], baseAsset, currentBaseBalance, tolerance = 1e-8 } = {}) {
  const entryOrderId = String(entryExecution?.orderId || "");
  const normalizedBaseAsset = String(baseAsset || "").trim().toUpperCase();
  const entryTime = toFiniteNumber(entryExecution?.transactTime);
  const allowedExitOrderIds = new Set(exitExecutions.map((item) => String(item?.orderId || "")).filter(Boolean));
  const metrics = {
    historyRowCount: executions.length,
    entryFillCount: 0,
    knownExitOrderCount: allowedExitOrderIds.size,
    matchingExitFillCount: 0,
    entryQuantity: null,
    recordedEntryQuantity: toFiniteNumber(entryExecution?.executedQty),
    entryBaseFee: null,
    exitQuantity: null,
    exitBaseFee: null,
    remainingBaseBalance: toFiniteNumber(currentBaseBalance),
    tolerance: Math.max(toFiniteNumber(tolerance), 1e-8),
    accountingDelta: null,
  };
  const reject = (reason) => ({ evidence: null, reason, metrics });
  if (!tradeId || !entryOrderId || !entryTime || !normalizedBaseAsset || !allowedExitOrderIds.size) {
    return reject("TRADE_OR_ORDER_REFERENCE_MISSING");
  }

  const relevant = executions;
  const entryFills = relevant.filter((item) => (
    String(item?.orderId || "") === entryOrderId
    && String(item?.side || "").trim().toUpperCase() === "BUY"
    && toFiniteNumber(item?.execQty) > 0
    && toFiniteNumber(item?.execPrice) > 0
  ));
  metrics.entryFillCount = entryFills.length;
  const entryQuantity = entryFills.reduce((sum, item) => sum + toFiniteNumber(item.execQty), 0);
  const recordedEntryQuantity = toFiniteNumber(entryExecution.executedQty);
  metrics.entryQuantity = entryQuantity;
  const entryBaseFee = entryFills.reduce((sum, item) => (
    String(item.feeCurrency || "").trim().toUpperCase() === normalizedBaseAsset
      ? sum + toFiniteNumber(item.execFee)
      : sum
  ), 0);
  const exitFills = relevant.filter((item) => (
    allowedExitOrderIds.has(String(item?.orderId || ""))
    && String(item?.side || "").trim().toUpperCase() === "SELL"
    && toFiniteNumber(item?.execQty) > 0
    && toFiniteNumber(item?.execPrice) > 0
  ));
  metrics.matchingExitFillCount = exitFills.length;
  if (!exitFills.length) return reject("KNOWN_EXIT_FILLS_NOT_FOUND");

  const exitQuantity = exitFills.reduce((sum, item) => sum + toFiniteNumber(item.execQty), 0);
  const exitBaseFee = exitFills.reduce((sum, item) => (
    String(item.feeCurrency || "").trim().toUpperCase() === normalizedBaseAsset
      ? sum + toFiniteNumber(item.execFee)
      : sum
  ), 0);
  metrics.entryBaseFee = entryBaseFee;
  metrics.exitQuantity = exitQuantity;
  metrics.exitBaseFee = exitBaseFee;
  if (!entryFills.length) return reject("ENTRY_FILLS_NOT_FOUND");
  if (Math.abs(entryQuantity - recordedEntryQuantity) > metrics.tolerance) return reject("ENTRY_FILL_QUANTITY_MISMATCH");
  const availableAfterEntryFee = entryQuantity - entryBaseFee;
  const accountedAfterExit = exitQuantity + exitBaseFee + toFiniteNumber(currentBaseBalance);
  metrics.accountingDelta = availableAfterEntryFee - accountedAfterExit;
  if (exitQuantity <= 0) return reject("EXIT_QUANTITY_NOT_POSITIVE");
  if (Math.abs(metrics.accountingDelta) > metrics.tolerance) return reject("EXIT_QUANTITY_BALANCE_MISMATCH");

  return { reason: "VERIFIED", metrics, evidence: {
    source: "BYBIT_KNOWN_ORDER_EXECUTION_HISTORY_AND_BALANCE",
    tradeId: String(tradeId),
    entryOrderId,
    exitOrderIds: [...new Set(exitFills.map((item) => String(item.orderId)))],
    entryQuantity: String(entryQuantity),
    entryBaseFee: String(entryBaseFee),
    exitQuantity: String(exitQuantity),
    exitBaseFee: String(exitBaseFee),
    remainingBaseBalance: String(toFiniteNumber(currentBaseBalance)),
    tolerance: String(metrics.tolerance),
    verifiedAt: new Date().toISOString(),
  } };
}

function reconstructKnownExitClosure(input = {}) {
  return diagnoseKnownExitClosure(input).evidence;
}

function buildFilledTakeProfitCloseEvidence({ tradeId, entryExecution, exitOrders = [], diagnosis, verifiedAt = new Date().toISOString() } = {}) {
  if (!tradeId || !entryExecution?.orderId || diagnosis?.reason !== "EXIT_QUANTITY_BALANCE_MISMATCH") return null;
  const metrics = diagnosis.metrics || {};
  const tolerance = Math.max(toFiniteNumber(metrics.tolerance), 1e-8);
  const entryQuantity = toFiniteNumber(metrics.entryQuantity);
  const recordedEntryQuantity = toFiniteNumber(entryExecution.executedQty);
  const entryBaseFee = toFiniteNumber(metrics.entryBaseFee);
  const exitQuantity = toFiniteNumber(metrics.exitQuantity);
  const exitBaseFee = toFiniteNumber(metrics.exitBaseFee);
  if (!metrics.entryFillCount || Math.abs(entryQuantity - recordedEntryQuantity) > tolerance
    || entryQuantity <= 0 || entryBaseFee < 0 || exitQuantity <= 0 || exitBaseFee < 0) return null;

  const filledTakeProfits = exitOrders.filter((exitOrder) => {
    const execution = exitOrder?.adminExecution;
    return String(exitOrder?.kind || "").toUpperCase() === "TAKE_PROFIT"
      && String(execution?.status || "").toUpperCase() === "FILLED"
      && execution?.authoritativeHistory === true
      && String(execution?.orderId || "")
      && toFiniteNumber(execution?.origQty) > 0
      && Math.abs(toFiniteNumber(execution.executedQty) - toFiniteNumber(execution.origQty)) <= 1e-8;
  });
  if (!filledTakeProfits.length) return null;

  const exitOrderIds = [...new Set(filledTakeProfits.map((item) => String(item.adminExecution.orderId)))];
  const verifiedExitQuantity = filledTakeProfits.reduce((sum, item) => sum + toFiniteNumber(item.adminExecution.executedQty), 0);
  if (Math.abs(verifiedExitQuantity - exitQuantity) > tolerance) return null;

  return {
    source: "BYBIT_KNOWN_FILLED_TAKE_PROFIT_EXECUTION_HISTORY",
    tradeId: String(tradeId),
    entryOrderId: String(entryExecution.orderId),
    exitOrderIds,
    entryQuantity: String(entryQuantity),
    entryBaseFee: String(entryBaseFee),
    exitQuantity: String(exitQuantity),
    exitBaseFee: String(exitBaseFee),
    remainingBaseBalance: String(toFiniteNumber(metrics.remainingBaseBalance)),
    accountingDelta: String(toFiniteNumber(metrics.accountingDelta)),
    tolerance: String(tolerance),
    balanceReconciled: false,
    verifiedAt,
  };
}

module.exports = { buildFilledTakeProfitCloseEvidence, diagnoseKnownExitClosure, reconstructKnownExitClosure, reconstructKnownExitExecution };
