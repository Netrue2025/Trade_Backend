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

module.exports = { reconstructKnownExitExecution };
