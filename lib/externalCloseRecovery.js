"use strict";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function reconstructExternalClose({
  entryExecution,
  knownExitOrderIds = [],
  executions = [],
  baseAsset,
  remainingQuantity,
  currentBaseBalance = 0,
  tolerance = 1e-8,
} = {}) {
  const entryOrderId = String(entryExecution?.orderId || "");
  const entryTime = toNumber(entryExecution?.transactTime);
  const normalizedBaseAsset = String(baseAsset || "").trim().toUpperCase();
  const knownOrders = new Set(knownExitOrderIds.map(String).filter(Boolean));
  if (!entryOrderId || !entryTime || !normalizedBaseAsset || toNumber(remainingQuantity) <= 0) return null;

  const relevant = executions.filter((execution) => toNumber(execution.execTime) >= entryTime);
  const entryBaseFee = relevant
    .filter((execution) => String(execution.orderId) === entryOrderId
      && String(execution.side || "").toUpperCase() === "BUY"
      && String(execution.feeCurrency || "").toUpperCase() === normalizedBaseAsset)
    .reduce((total, execution) => total + toNumber(execution.execFee), 0);
  const exitFills = relevant.filter((execution) => (
    String(execution.side || "").toUpperCase() === "SELL"
    && !knownOrders.has(String(execution.orderId || ""))
    && toNumber(execution.execQty) > 0
    && toNumber(execution.execPrice) > 0
    && toNumber(execution.execTime) > 0
    && String(execution.orderId || "")
  ));
  if (!exitFills.length) return null;

  const executedQty = exitFills.reduce((total, execution) => total + toNumber(execution.execQty), 0);
  const quoteQty = exitFills.reduce(
    (total, execution) => total + (toNumber(execution.execQty) * toNumber(execution.execPrice)),
    0
  );
  const expectedRemainder = entryBaseFee + Math.max(0, toNumber(currentBaseBalance));
  const actualRemainder = toNumber(remainingQuantity) - executedQty;
  if (executedQty <= 0 || quoteQty <= 0 || Math.abs(actualRemainder - expectedRemainder) > Math.max(tolerance, 1e-8)) {
    return null;
  }

  const orderIds = [...new Set(exitFills.map((execution) => String(execution.orderId)))];
  const fees = exitFills.reduce((items, execution) => {
    const currency = String(execution.feeCurrency || "").trim().toUpperCase();
    const amount = toNumber(execution.execFee);
    if (!currency || amount <= 0) return items;
    const current = items.find((item) => item.currency === currency);
    if (current) current.amount = Number((current.amount + amount).toFixed(12));
    else items.push({ currency, amount });
    return items;
  }, []);

  return {
    orderId: orderIds.length === 1 ? orderIds[0] : `external:${orderIds.join(",")}`,
    orderIds,
    status: "FILLED",
    type: "EXTERNAL_HISTORY",
    side: "SELL",
    price: String(quoteQty / executedQty),
    rawPrice: String(quoteQty / executedQty),
    origQty: String(executedQty),
    executedQty: String(executedQty),
    cummulativeQuoteQty: String(quoteQty),
    transactTime: Math.max(...exitFills.map((execution) => toNumber(execution.execTime))),
    external: true,
    authoritativeHistory: true,
    fees,
  };
}

module.exports = { reconstructExternalClose };
