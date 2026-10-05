"use strict";

const PARTIAL_EXIT_CLOSE_SOURCE = "BYBIT_PARTIAL_EXIT_MARK_TO_MARKET";
const AUTO_CLOSE_FILL_RATIO = 0.8;
const ACTIVE_STATUSES = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW"]);
const TERMINAL_FILL_STATUSES = new Set(["FILLED", "CANCELED"]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function executionPrice(execution) {
  const direct = finitePositive(execution?.price || execution?.rawPrice);
  if (direct) return direct;
  const quantity = finitePositive(execution?.executedQty);
  const quote = finitePositive(execution?.cummulativeQuoteQty);
  return quantity && quote ? quote / quantity : 0;
}

function summarizeExitOrders(exitOrders = []) {
  let quantity = 0;
  let quote = 0;
  const orderIds = [];
  for (const exitOrder of exitOrders) {
    const execution = exitOrder?.adminExecution;
    const status = String(execution?.status || "").trim().toUpperCase();
    if (ACTIVE_STATUSES.has(status)) return { valid: false, reason: "EXIT_ORDER_STILL_ACTIVE" };
    const executedQty = Number(execution?.executedQty || 0);
    if (!Number.isFinite(executedQty) || executedQty < 0) return { valid: false, reason: "EXIT_QUANTITY_INVALID" };
    if (executedQty === 0) continue;
    if (!TERMINAL_FILL_STATUSES.has(status) || !execution?.orderId) return { valid: false, reason: "EXIT_FILL_NOT_TERMINAL_OR_IDENTIFIED" };
    const price = executionPrice(execution);
    if (!price) return { valid: false, reason: "EXIT_FILL_PRICE_MISSING" };
    quantity += executedQty;
    quote += Number(execution.cummulativeQuoteQty) > 0
      ? Number(execution.cummulativeQuoteQty)
      : executedQty * price;
    orderIds.push(String(execution.orderId));
  }
  return { valid: quantity > 0, quantity, quote, orderIds, reason: quantity > 0 ? null : "NO_FILLED_EXIT" };
}

function buildPartialTradeExitEvidence({ trade, markPrice, reason, verifiedAt = new Date().toISOString() } = {}) {
  const entryQuantity = finitePositive(trade?.adminExecution?.executedQty);
  const entryPrice = executionPrice(trade?.adminExecution);
  const marketPrice = finitePositive(markPrice);
  if (!trade?.id || !trade?.adminExecution?.orderId || !entryQuantity || !entryPrice || !marketPrice) return { evidence: null, reason: "ENTRY_OR_MARKET_SNAPSHOT_MISSING" };
  const exits = summarizeExitOrders(trade.exitOrders || []);
  if (!exits.valid) return { evidence: null, reason: exits.reason };
  if (exits.quantity >= entryQuantity) return { evidence: null, reason: "FULL_EXIT_SHOULD_USE_NORMAL_CLOSE" };
  const fillRatio = exits.quantity / entryQuantity;
  const manualStop = (trade.exitOrders || []).some((item) => (
    ["MANUAL_SELL", "MANUAL_STOP", "ADMIN_STOP"].includes(String(item?.kind || "").trim().toUpperCase())
    && item?.closeTradeOnFill === true
    && Number(item?.adminExecution?.executedQty || 0) > 0
    && TERMINAL_FILL_STATUSES.has(String(item?.adminExecution?.status || "").trim().toUpperCase())
  ));
  if (reason === "MANUAL_STOP" && !manualStop) return { evidence: null, reason: "MANUAL_STOP_FILL_NOT_CONFIRMED" };
  if (reason !== "MANUAL_STOP" && fillRatio + 1e-12 < AUTO_CLOSE_FILL_RATIO) return { evidence: null, reason: "AUTO_CLOSE_FILL_THRESHOLD_NOT_MET" };

  const remainingQuantity = entryQuantity - exits.quantity;
  const effectiveExitPrice = (exits.quote + remainingQuantity * marketPrice) / entryQuantity;
  if (!Number.isFinite(effectiveExitPrice) || effectiveExitPrice <= 0) return { evidence: null, reason: "EFFECTIVE_EXIT_PRICE_INVALID" };
  return {
    reason: "VERIFIED_PARTIAL_EXIT_MARK_TO_MARKET",
    evidence: {
      source: PARTIAL_EXIT_CLOSE_SOURCE,
      tradeId: String(trade.id),
      entryOrderId: String(trade.adminExecution.orderId),
      exitOrderIds: exits.orderIds,
      entryQuantity: String(entryQuantity),
      entryPrice: String(entryPrice),
      exitQuantity: String(exits.quantity),
      exitQuoteQuantity: String(exits.quote),
      remainingQuantity: String(remainingQuantity),
      markPrice: String(marketPrice),
      effectiveExitPrice: String(effectiveExitPrice),
      fillRatio: String(fillRatio),
      closeReason: manualStop ? "MANUAL_STOP" : "AUTO_FILL_THRESHOLD",
      verifiedAt,
    },
  };
}

function hasVerifiedPartialTradeExitEvidence(trade, evidence = trade?.authoritativeCloseEvidence) {
  if (!evidence || evidence.source !== PARTIAL_EXIT_CLOSE_SOURCE
    || String(evidence.tradeId || "") !== String(trade?.id || "")
    || String(evidence.entryOrderId || "") !== String(trade?.adminExecution?.orderId || "")) return false;
  const rebuilt = buildPartialTradeExitEvidence({
    trade,
    markPrice: evidence.markPrice,
    reason: evidence.closeReason,
    verifiedAt: evidence.verifiedAt,
  });
  if (!rebuilt.evidence) return false;
  const candidate = rebuilt.evidence;
  return JSON.stringify(candidate.exitOrderIds) === JSON.stringify(evidence.exitOrderIds)
    && candidate.closeReason === evidence.closeReason
    && ["entryQuantity", "entryPrice", "exitQuantity", "exitQuoteQuantity", "remainingQuantity", "effectiveExitPrice", "fillRatio"]
      .every((key) => Math.abs(Number(candidate[key]) - Number(evidence[key])) <= 1e-8);
}

module.exports = {
  AUTO_CLOSE_FILL_RATIO,
  PARTIAL_EXIT_CLOSE_SOURCE,
  buildPartialTradeExitEvidence,
  hasVerifiedPartialTradeExitEvidence,
};
