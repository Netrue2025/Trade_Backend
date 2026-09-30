"use strict";

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function reconstructKnownExitExecution({ execution, executions = [] } = {}) {
  const orderId = String(execution?.orderId || "");
  const clientOrderId = String(execution?.clientOrderId || execution?.orderLinkId || "");
  const side = String(execution?.side || "").trim().toUpperCase();
  if ((!orderId && !clientOrderId) || !["BUY", "SELL"].includes(side)) return null;

  const fills = executions.filter((item) => (
    (orderId
      ? String(item?.orderId || "") === orderId
      : String(item?.orderLinkId || "") === clientOrderId)
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
    orderId: orderId || String(fills[0]?.orderId || ""),
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

function reconstructTradeScopedClose({ tradeId, entryExecution, exitOrders = [], executions = [], baseAsset, tolerance = 1e-8 } = {}) {
  const entryOrderId = String(entryExecution?.orderId || "");
  const normalizedBaseAsset = String(baseAsset || "").trim().toUpperCase();
  const allowedDelta = Math.max(toFiniteNumber(tolerance), 1e-8);
  const reject = (reason) => ({ evidence: null, externalExits: [], reason });
  if (!tradeId || !entryOrderId || !normalizedBaseAsset) return reject("TRADE_OR_ENTRY_REFERENCE_MISSING");

  const uniqueExecutions = new Map();
  for (const row of executions) {
    const side = String(row?.side || "").trim().toUpperCase();
    const isRelevantFill = ["BUY", "SELL"].includes(side)
      && toFiniteNumber(row?.execQty) > 0
      && toFiniteNumber(row?.execPrice) > 0;
    const key = String(row?.execId || "");
    if (isRelevantFill && !key) return reject("EXECUTION_ID_MISSING");
    if (!key) continue;
    if (uniqueExecutions.has(key) && JSON.stringify(uniqueExecutions.get(key)) !== JSON.stringify(row)) {
      return reject("CONFLICTING_DUPLICATE_EXECUTION_ID");
    }
    if (!uniqueExecutions.has(key)) uniqueExecutions.set(key, row);
  }
  const rows = [...uniqueExecutions.values()];
  const entryFills = rows.filter((row) => (
    String(row?.orderId || "") === entryOrderId
    && String(row?.side || "").trim().toUpperCase() === "BUY"
    && toFiniteNumber(row?.execQty) > 0
    && toFiniteNumber(row?.execPrice) > 0
    && toFiniteNumber(row?.execTime) > 0
  ));
  const entryQuantity = entryFills.reduce((sum, row) => sum + toFiniteNumber(row.execQty), 0);
  const recordedEntryQuantity = toFiniteNumber(entryExecution.executedQty);
  if (!entryFills.length) return reject("ENTRY_FILLS_NOT_FOUND");
  if (entryQuantity <= 0 || Math.abs(entryQuantity - recordedEntryQuantity) > allowedDelta) {
    return reject("ENTRY_FILL_QUANTITY_MISMATCH");
  }
  const entryTime = Math.min(...entryFills.map((row) => toFiniteNumber(row.execTime)));
  const entryBaseFee = entryFills.reduce((sum, row) => (
    String(row.feeCurrency || "").trim().toUpperCase() === normalizedBaseAsset
      ? sum + toFiniteNumber(row.execFee)
      : sum
  ), 0);
  const exitFills = rows.filter((row) => (
    String(row?.side || "").trim().toUpperCase() === "SELL"
    && toFiniteNumber(row?.execTime) >= entryTime
    && toFiniteNumber(row?.execTime) > 0
    && String(row?.orderId || "") !== entryOrderId
    && toFiniteNumber(row?.execQty) > 0
    && toFiniteNumber(row?.execPrice) > 0
  ));
  if (!exitFills.length) return reject("EXIT_FILLS_NOT_FOUND");
  const groupRowsByOrder = (fills) => {
    const groups = new Map();
    for (const row of fills) {
      const orderId = String(row.orderId || "");
      if (!orderId) return null;
      if (!groups.has(orderId)) groups.set(orderId, []);
      groups.get(orderId).push(row);
    }
    return groups;
  };
  const allGroups = groupRowsByOrder(exitFills);
  if (!allGroups) return reject("EXIT_ORDER_REFERENCE_MISSING");
  const knownOrderIds = new Set();
  const knownClientOrderIds = new Set();
  for (const exitOrder of exitOrders) {
    const execution = exitOrder?.adminExecution || {};
    if (execution.orderId) knownOrderIds.add(String(execution.orderId));
    if (execution.clientOrderId) knownClientOrderIds.add(String(execution.clientOrderId));
    if (execution.orderLinkId) knownClientOrderIds.add(String(execution.orderLinkId));
  }
  const knownGroups = new Map();
  const candidateGroups = new Map();
  for (const [orderId, fills] of allGroups) {
    const registered = knownOrderIds.has(orderId)
      || fills.some((row) => knownClientOrderIds.has(String(row.orderLinkId || "")));
    (registered ? knownGroups : candidateGroups).set(orderId, fills);
  }
  const summarizeGroup = (orderId, fills) => {
    const quantity = fills.reduce((sum, row) => sum + toFiniteNumber(row.execQty), 0);
    const baseFee = fills.reduce((sum, row) => (
      String(row.feeCurrency || "").trim().toUpperCase() === normalizedBaseAsset
        ? sum + toFiniteNumber(row.execFee)
        : sum
    ), 0);
    const quoteQuantity = fills.reduce((sum, row) => sum + toFiniteNumber(row.execQty) * toFiniteNumber(row.execPrice), 0);
    return { orderId, fills, quantity, baseFee, quoteQuantity, effectiveQuantity: quantity + baseFee };
  };
  const mandatory = [...knownGroups].map(([orderId, fills]) => summarizeGroup(orderId, fills));
  const candidates = [...candidateGroups].map(([orderId, fills]) => summarizeGroup(orderId, fills));
  const targetQuantity = entryQuantity - entryBaseFee;
  const mandatoryQuantity = mandatory.reduce((sum, group) => sum + group.effectiveQuantity, 0);
  const oversellTolerance = Math.max(1e-10, entryQuantity * 1e-12);
  if (mandatoryQuantity - targetQuantity > oversellTolerance) return reject("EXIT_QUANTITY_EXCEEDS_ENTRY");
  const quantityNeeded = targetQuantity - mandatoryQuantity;
  let selectedCandidates = [];
  if (quantityNeeded > oversellTolerance) {
    if (candidates.length > 24) return reject("TOO_MANY_UNREGISTERED_EXIT_ORDERS");
    const sorted = candidates.slice().sort((left, right) => right.effectiveQuantity - left.effectiveQuantity);
    let visited = 0;
    const solutions = [];
    const findSubsets = (index, sum, chosen) => {
      if (solutions.length > 1 || ++visited > 100_000) return;
      if (Math.abs(quantityNeeded - sum) <= allowedDelta) {
        solutions.push(chosen.slice());
        return;
      }
      if (sum > quantityNeeded + oversellTolerance || index >= sorted.length) return;
      let available = sum;
      for (let cursor = index; cursor < sorted.length; cursor += 1) available += sorted[cursor].effectiveQuantity;
      if (available < quantityNeeded - allowedDelta) return;
      chosen.push(sorted[index]);
      findSubsets(index + 1, sum + sorted[index].effectiveQuantity, chosen);
      chosen.pop();
      findSubsets(index + 1, sum, chosen);
    };
    findSubsets(0, 0, []);
    if (visited > 100_000) return reject("EXIT_ATTRIBUTION_SEARCH_LIMIT");
    if (solutions.length === 0) {
      const maximumAvailable = candidates.reduce((sum, group) => sum + group.effectiveQuantity, mandatoryQuantity);
      return reject(maximumAvailable < targetQuantity - allowedDelta
        ? "MEANINGFUL_TRADE_QUANTITY_REMAINS"
        : "NO_QUANTITY_MATCHING_EXIT_SUBSET");
    }
    if (solutions.length > 1) return reject("MULTIPLE_QUANTITY_MATCHING_EXIT_SUBSETS");
    selectedCandidates = solutions[0];
  }
  const selectedGroups = [...mandatory, ...selectedCandidates];
  const exitQuantity = selectedGroups.reduce((sum, group) => sum + group.quantity, 0);
  const exitBaseFee = selectedGroups.reduce((sum, group) => sum + group.baseFee, 0);
  const remainingTradeQuantity = entryQuantity - entryBaseFee - exitQuantity - exitBaseFee;
  if (remainingTradeQuantity < -oversellTolerance) return reject("EXIT_QUANTITY_EXCEEDS_ENTRY");
  if (remainingTradeQuantity > allowedDelta) return reject("MEANINGFUL_TRADE_QUANTITY_REMAINS");

  const externalExits = selectedGroups.map(({ orderId, fills, quantity, quoteQuantity }) => {
    const fees = fills.reduce((items, row) => {
      const currency = String(row.feeCurrency || "").trim().toUpperCase();
      const amount = toFiniteNumber(row.execFee);
      if (!currency || amount <= 0) return items;
      const found = items.find((item) => item.currency === currency);
      if (found) found.amount += amount;
      else items.push({ currency, amount });
      return items;
    }, []);
    return {
      orderId,
      orderLinkId: String(fills.find((row) => row.orderLinkId)?.orderLinkId || ""),
      status: "FILLED",
      type: "EXTERNAL_HISTORY",
      side: "SELL",
      origQty: String(quantity),
      executedQty: String(quantity),
      price: String(quoteQuantity / quantity),
      rawPrice: String(quoteQuantity / quantity),
      cummulativeQuoteQty: String(quoteQuantity),
      transactTime: Math.max(...fills.map((row) => toFiniteNumber(row.execTime))),
      fees,
      external: true,
      authoritativeHistory: true,
    };
  });
  const exitOrderIds = selectedGroups.map((group) => group.orderId);
  return {
    reason: "VERIFIED_TRADE_SCOPED_EXIT",
    externalExits,
    metrics: {
      candidateSellOrderCount: candidates.length,
      attributableSellOrderCount: selectedGroups.length,
      candidateSellExecutionCount: exitFills.length,
      attributableSellExecutionCount: selectedGroups.reduce((sum, group) => sum + group.fills.length, 0),
    },
    evidence: {
      source: "BYBIT_TRADE_SCOPED_EXECUTION_HISTORY",
      tradeId: String(tradeId),
      entryOrderId,
      exitOrderIds,
      entryQuantity: String(entryQuantity),
      entryBaseFee: String(entryBaseFee),
      exitQuantity: String(exitQuantity),
      exitBaseFee: String(exitBaseFee),
      remainingTradeQuantity: String(Math.max(0, remainingTradeQuantity)),
      tolerance: String(allowedDelta),
      verifiedAt: new Date().toISOString(),
    },
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
  const remainingBaseBalance = toFiniteNumber(metrics.remainingBaseBalance);
  const balanceTolerance = Math.max(tolerance, 1e-8);
  const remainingTradeQuantity = entryQuantity - entryBaseFee - exitQuantity - exitBaseFee;
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

  const tradeScoped = remainingTradeQuantity >= -balanceTolerance && remainingTradeQuantity <= balanceTolerance;
  const legacyBalanceReconciled = !tradeScoped
    && remainingTradeQuantity >= -2 * balanceTolerance
    && remainingBaseBalance <= balanceTolerance;
  if (!tradeScoped && !legacyBalanceReconciled) return null;

  return {
    source: tradeScoped
      ? "BYBIT_TRADE_SCOPED_FILLED_TAKE_PROFIT_EXECUTION_HISTORY"
      : "BYBIT_KNOWN_FILLED_TAKE_PROFIT_EXECUTION_HISTORY",
    tradeId: String(tradeId),
    entryOrderId: String(entryExecution.orderId),
    exitOrderIds,
    entryQuantity: String(entryQuantity),
    entryBaseFee: String(entryBaseFee),
    exitQuantity: String(exitQuantity),
    exitBaseFee: String(exitBaseFee),
    remainingTradeQuantity: String(Math.max(0, remainingTradeQuantity)),
    remainingBaseBalance: String(remainingBaseBalance),
    accountingDelta: String(toFiniteNumber(metrics.accountingDelta)),
    tolerance: String(tolerance),
    balanceReconciled: false,
    verifiedAt,
  };
}

module.exports = { buildFilledTakeProfitCloseEvidence, diagnoseKnownExitClosure, reconstructKnownExitClosure, reconstructKnownExitExecution, reconstructTradeScopedClose };
