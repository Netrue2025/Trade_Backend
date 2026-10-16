"use strict";

const DUST_TRADE_CLOSE_SOURCE = "BYBIT_DUST_BALANCE_MARK_TO_MARKET";

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function collectExitAccounting(trade) {
  let quantity = 0;
  let quote = 0;
  const orderIds = [];
  for (const exit of trade?.exitOrders || []) {
    const execution = exit?.adminExecution;
    const status = String(execution?.status || "").toUpperCase();
    if (["NEW", "PARTIALLY_FILLED", "PENDING_NEW"].includes(status)) return { error: "ACTIVE_EXIT_ORDER" };
    const executed = Number(execution?.executedQty || 0);
    if (!Number.isFinite(executed) || executed < 0) return { error: "INVALID_EXIT_QUANTITY" };
    if (executed === 0) continue;
    const price = positive(execution.price || execution.rawPrice)
      || (positive(execution.cummulativeQuoteQty) / executed);
    if (!["FILLED", "CANCELED"].includes(status) || !execution.orderId || !price) return { error: "UNVERIFIED_EXIT_EXECUTION" };
    quantity += executed;
    quote += positive(execution.cummulativeQuoteQty) || executed * price;
    orderIds.push(String(execution.orderId));
  }
  return { quantity, quote, orderIds };
}

function executionAveragePrice(execution) {
  const direct = positive(execution?.price || execution?.rawPrice);
  if (direct) return direct;
  const quantity = positive(execution?.executedQty);
  return quantity ? positive(execution?.cummulativeQuoteQty) / quantity : 0;
}

function buildDustTradeCloseEvidence({
  trade,
  balanceQuantity,
  markPrice,
  thresholdUsd = 10,
  openOrders = [],
  hasOtherOpenTrade = false,
  verifiedAt = new Date().toISOString(),
} = {}) {
  const entryQuantity = positive(trade?.adminExecution?.executedQty);
  const entryPrice = executionAveragePrice(trade?.adminExecution) || positive(trade?.price);
  const balance = Number(balanceQuantity);
  const price = positive(markPrice);
  const threshold = positive(thresholdUsd);
  if (!trade?.id || !trade?.adminExecution?.orderId || !entryQuantity || !entryPrice || !price
    || !Number.isFinite(balance) || balance < 0 || !threshold) return { evidence: null, reason: "MISSING_OR_INVALID_SNAPSHOT" };
  if (hasOtherOpenTrade) return { evidence: null, reason: "OVERLAPPING_TRADE" };
  if ((openOrders || []).some((order) => String(order?.symbol || "").toUpperCase() === String(trade.symbol || "").toUpperCase())) {
    return { evidence: null, reason: "OPEN_SYMBOL_ORDER" };
  }
  const exits = collectExitAccounting(trade);
  if (exits.error) return { evidence: null, reason: exits.error };
  const remainingQuantity = entryQuantity - exits.quantity;
  if (remainingQuantity <= 0) return { evidence: null, reason: "FULL_EXIT_SHOULD_USE_NORMAL_CLOSE" };
  if (balance > remainingQuantity + Math.max(entryQuantity * 1e-8, 1e-8)) return { evidence: null, reason: "BALANCE_EXCEEDS_TRADE_REMAINDER" };
  const balanceValue = balance * price;
  if (balanceValue >= threshold) return { evidence: null, reason: "BALANCE_NOT_DUST" };
  const effectiveExitPrice = (exits.quote + remainingQuantity * price) / entryQuantity;
  if (!Number.isFinite(effectiveExitPrice) || effectiveExitPrice <= 0) return { evidence: null, reason: "EFFECTIVE_PRICE_INVALID" };
  return { evidence: {
    source: DUST_TRADE_CLOSE_SOURCE,
    tradeId: String(trade.id),
    entryOrderId: String(trade.adminExecution.orderId),
    exitOrderIds: exits.orderIds,
    entryQuantity: String(entryQuantity),
    entryPrice: String(entryPrice),
    exitQuantity: String(exits.quantity),
    exitQuoteQuantity: String(exits.quote),
    remainingQuantity: String(remainingQuantity),
    markPrice: String(price),
    effectiveExitPrice: String(effectiveExitPrice),
    exchangeBalanceQuantity: String(balance),
    exchangeBalanceValueUsd: String(balanceValue),
    thresholdUsd: String(threshold),
    closeReason: "DUST_BALANCE_MARK_TO_MARKET",
    verifiedAt,
  } };
}

function hasVerifiedDustTradeCloseEvidence(trade, evidence = trade?.authoritativeCloseEvidence) {
  if (!evidence || evidence.source !== DUST_TRADE_CLOSE_SOURCE
    || String(evidence.tradeId || "") !== String(trade?.id || "")
    || String(evidence.entryOrderId || "") !== String(trade?.adminExecution?.orderId || "")) return false;
  const rebuilt = buildDustTradeCloseEvidence({
    trade,
    balanceQuantity: evidence.exchangeBalanceQuantity,
    markPrice: evidence.markPrice,
    thresholdUsd: evidence.thresholdUsd,
    openOrders: [],
    hasOtherOpenTrade: false,
    verifiedAt: evidence.verifiedAt,
  }).evidence;
  if (!rebuilt) return false;
  return JSON.stringify(rebuilt.exitOrderIds) === JSON.stringify(evidence.exitOrderIds)
    && ["entryQuantity", "entryPrice", "exitQuantity", "exitQuoteQuantity", "remainingQuantity", "markPrice", "effectiveExitPrice", "exchangeBalanceQuantity", "exchangeBalanceValueUsd", "thresholdUsd"]
      .every((key) => Math.abs(Number(rebuilt[key]) - Number(evidence[key])) <= 1e-8);
}

module.exports = { DUST_TRADE_CLOSE_SOURCE, buildDustTradeCloseEvidence, hasVerifiedDustTradeCloseEvidence };
