"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildFilledTakeProfitCloseEvidence, diagnoseKnownExitClosure, reconstructKnownExitClosure, reconstructKnownExitExecution, reconstructTradeScopedClose } = require("../lib/knownExitExecutionRecovery");
const { deriveTradeLifecycle, hasOverlappingCurrentGenerationTrade, hasVerifiedExchangeCloseEvidence } = require("../lib/tradeLifecycle");
const { CURRENT_TRADE_FEE_MODEL, calculateFixedRoundTripSettlement } = require("../lib/tradingFee");

const exitOrder = { orderId: "tp-order", side: "SELL", status: "NEW", origQty: "10", executedQty: "0" };

test("reconstructs a known fully filled exit from exact order execution history", () => {
  const recovered = reconstructKnownExitExecution({
    execution: exitOrder,
    executions: [
      { orderId: "other-order", side: "SELL", execQty: "10", execPrice: "12" },
      { orderId: "tp-order", side: "SELL", execQty: "4", execPrice: "12", execFee: "0.01", feeCurrency: "USDT", execTime: 20 },
      { orderId: "tp-order", side: "SELL", execQty: "6", execPrice: "14", execFee: "0.02", feeCurrency: "USDT", execTime: 30 },
    ],
  });

  assert.equal(recovered.status, "FILLED");
  assert.equal(recovered.executedQty, "10");
  assert.equal(recovered.cummulativeQuoteQty, "132");
  assert.equal(recovered.price, "13.2");
  assert.equal(recovered.transactTime, 30);
  assert.equal(recovered.authoritativeHistory, true);
  assert.deepEqual(recovered.fees, [{ currency: "USDT", amount: 0.03 }]);
});

test("incomplete history stays partial and cannot certify the order as filled", () => {
  const recovered = reconstructKnownExitExecution({
    execution: exitOrder,
    executions: [{ orderId: "tp-order", side: "SELL", execQty: "4", execPrice: "12" }],
  });
  assert.equal(recovered.status, "PARTIALLY_FILLED");
  assert.equal(recovered.executedQty, "4");
});

test("wrong side, wrong order, invalid price, or insufficient history fails closed", () => {
  assert.equal(reconstructKnownExitExecution({
    execution: exitOrder,
    executions: [{ orderId: "tp-order", side: "BUY", execQty: "10", execPrice: "12" }],
  }), null);
  assert.equal(reconstructKnownExitExecution({
    execution: exitOrder,
    executions: [{ orderId: "unknown", side: "SELL", execQty: "10", execPrice: "12" }],
  }), null);
  assert.equal(reconstructKnownExitExecution({
    execution: exitOrder,
    executions: [{ orderId: "tp-order", side: "SELL", execQty: "10", execPrice: "0" }],
  }), null);
  assert.equal(reconstructKnownExitExecution({
    execution: { ...exitOrder, executedQty: "5" },
    executions: [{ orderId: "tp-order", side: "SELL", execQty: "4", execPrice: "12" }],
  }), null);
});

test("fee-adjusted exit closes only when exact entry/TP executions reconcile to exchange balance", () => {
  const evidence = reconstructKnownExitClosure({
    tradeId: "trade-1",
    entryExecution: { orderId: "entry-order", transactTime: 10, executedQty: "10" },
    exitExecutions: [{ orderId: "tp-order" }],
    baseAsset: "FLOCK",
    currentBaseBalance: "0.0002",
    tolerance: 0.001,
    executions: [
      { orderId: "entry-order", side: "BUY", execQty: "10", execPrice: "2", execFee: "0.0002", feeCurrency: "FLOCK", execTime: 11 },
      { orderId: "tp-order", side: "SELL", execQty: "9.9994", execPrice: "2.1", execFee: "0.0002", feeCurrency: "FLOCK", execTime: 20 },
    ],
  });
  assert.equal(evidence.source, "BYBIT_KNOWN_ORDER_EXECUTION_HISTORY_AND_BALANCE");
  assert.equal(evidence.entryBaseFee, "0.0002");
  assert.equal(evidence.exitQuantity, "9.9994");
  assert.equal(evidence.exitBaseFee, "0.0002");
  assert.deepEqual(evidence.exitOrderIds, ["tp-order"]);
});

test("fee-adjusted close evidence rejects unknown TP ids and quantity/balance mismatch", () => {
  const input = {
    tradeId: "trade-1",
    entryExecution: { orderId: "entry-order", transactTime: 10, executedQty: "10" },
    exitExecutions: [{ orderId: "tp-order" }],
    baseAsset: "FLOCK",
    currentBaseBalance: "0",
    executions: [
      { orderId: "entry-order", side: "BUY", execQty: "10", execPrice: "2", execTime: 11 },
      { orderId: "other-order", side: "SELL", execQty: "10", execPrice: "2.1", execTime: 20 },
    ],
  };
  assert.equal(reconstructKnownExitClosure(input), null);
  assert.equal(reconstructKnownExitClosure({
    ...input,
    executions: [
      input.executions[0],
      { orderId: "tp-order", side: "SELL", execQty: "9", execPrice: "2.1", execTime: 20 },
    ],
  }), null);
});

test("close diagnostic reports the exact missing-evidence category and aggregate metrics", () => {
  const diagnosis = diagnoseKnownExitClosure({
    tradeId: "trade-1",
    entryExecution: { orderId: "entry-order", transactTime: 10, executedQty: "10" },
    exitExecutions: [{ orderId: "tp-order" }],
    baseAsset: "FLOCK",
    currentBaseBalance: "0.5",
    tolerance: 0.001,
    executions: [
      { orderId: "entry-order", side: "BUY", execQty: "10", execPrice: "2", execTime: 11 },
      { orderId: "tp-order", side: "SELL", execQty: "9", execPrice: "2.1", execTime: 20 },
    ],
  });
  assert.equal(diagnosis.evidence, null);
  assert.equal(diagnosis.reason, "EXIT_QUANTITY_BALANCE_MISMATCH");
  assert.equal(diagnosis.metrics.historyRowCount, 2);
  assert.equal(diagnosis.metrics.entryFillCount, 1);
  assert.equal(diagnosis.metrics.matchingExitFillCount, 1);
  assert.equal(diagnosis.metrics.accountingDelta, 0.5);
});

test("entry mismatch diagnostics still report the independent exit quantity and fees", () => {
  const diagnosis = diagnoseKnownExitClosure({
    tradeId: "trade-1",
    entryExecution: { orderId: "entry-order", transactTime: 10, executedQty: "10" },
    exitExecutions: [{ orderId: "tp-order" }],
    baseAsset: "FLOCK",
    currentBaseBalance: "0",
    executions: [
      { orderId: "entry-order", side: "BUY", execQty: "9", execPrice: "2", execFee: "0.01", feeCurrency: "FLOCK", execTime: 11 },
      { orderId: "tp-order", side: "SELL", execQty: "8.98", execPrice: "2.1", execFee: "0.01", feeCurrency: "FLOCK", execTime: 20 },
    ],
  });
  assert.equal(diagnosis.reason, "ENTRY_FILL_QUANTITY_MISMATCH");
  assert.equal(diagnosis.metrics.entryBaseFee, 0.01);
  assert.equal(diagnosis.metrics.exitQuantity, 8.98);
  assert.equal(diagnosis.metrics.exitBaseFee, 0.01);
});

test("a fully-filled registered TP provides auditable close evidence when only account dust differs", () => {
  const executions = [
    { orderId: "entry-order", side: "BUY", execQty: "16910.87", execPrice: "1", execFee: "16.91087", feeCurrency: "FLOCK", execTime: 11 },
    { orderId: "tp-order", side: "SELL", execQty: "16893.97", execPrice: "1.01", execFee: "0", feeCurrency: "USDT", execTime: 20 },
  ];
  const entryExecution = { orderId: "entry-order", transactTime: 10, executedQty: "16910.87" };
  const exitOrders = [{
    kind: "TAKE_PROFIT",
    adminExecution: { orderId: "tp-order", status: "FILLED", origQty: "16893.97", executedQty: "16893.97", authoritativeHistory: true },
  }];
  const diagnosis = diagnoseKnownExitClosure({
    tradeId: "trade-1",
    entryExecution,
    exitExecutions: exitOrders.map((item) => item.adminExecution),
    executions,
    baseAsset: "FLOCK",
    currentBaseBalance: 0,
    tolerance: 0.01,
  });
  assert.equal(diagnosis.reason, "EXIT_QUANTITY_BALANCE_MISMATCH");
  assert.ok(Math.abs(diagnosis.metrics.accountingDelta + 0.01087) < 1e-9);
  const evidence = buildFilledTakeProfitCloseEvidence({ tradeId: "trade-1", entryExecution, exitOrders, diagnosis });
  assert.equal(evidence.source, "BYBIT_KNOWN_FILLED_TAKE_PROFIT_EXECUTION_HISTORY");
  assert.equal(evidence.balanceReconciled, false);
  assert.ok(Math.abs(Number(evidence.accountingDelta) + 0.01087) < 1e-9);

  const trade = {
    id: "trade-1",
    settlementFeeModel: CURRENT_TRADE_FEE_MODEL,
    side: "BUY",
    adminExecution: { ...entryExecution, status: "FILLED", price: "1" },
    exitOrders,
    authoritativeCloseEvidence: evidence,
  };
  assert.equal(hasVerifiedExchangeCloseEvidence(trade), true);
  assert.equal(deriveTradeLifecycle(trade), "CLOSED");
  const settlement = calculateFixedRoundTripSettlement("100000", "1");
  assert.equal(settlement.tradingFee, "200");
  assert.equal(settlement.netPnl, "800");
  assert.equal(settlement.settlementAmount, "100800");
  const losingSettlement = calculateFixedRoundTripSettlement("100000", "-1");
  assert.equal(losingSettlement.tradingFee, "200");
  assert.equal(losingSettlement.netPnl, "-1200");
  assert.equal(losingSettlement.settlementAmount, "98800");
});

test("filled TP close evidence refuses manual exits, partial fills, and unrelated trades", () => {
  const entryExecution = { orderId: "entry-order", executedQty: "10" };
  const diagnosis = {
    reason: "EXIT_QUANTITY_BALANCE_MISMATCH",
    metrics: { tolerance: 0.01, entryFillCount: 1, entryQuantity: 10, entryBaseFee: 0, exitQuantity: 9.99, exitBaseFee: 0, remainingBaseBalance: 0, accountingDelta: 0.01 },
  };
  const baseExit = { adminExecution: { orderId: "tp-order", status: "FILLED", origQty: "9.99", executedQty: "9.99", authoritativeHistory: true } };
  assert.equal(buildFilledTakeProfitCloseEvidence({ tradeId: "trade-1", entryExecution, exitOrders: [{ ...baseExit, kind: "MANUAL_SELL" }], diagnosis }), null);
  assert.equal(buildFilledTakeProfitCloseEvidence({ tradeId: "trade-1", entryExecution, exitOrders: [{ ...baseExit, kind: "TAKE_PROFIT", adminExecution: { ...baseExit.adminExecution, status: "PARTIALLY_FILLED" } }], diagnosis }), null);
});

test("a fully-filled TP cannot close the trade while meaningful base quantity remains exposed", () => {
  const entryExecution = { orderId: "entry-order", status: "FILLED", executedQty: "100" };
  const exitOrders = [{
    kind: "TAKE_PROFIT",
    adminExecution: { orderId: "tp-order", status: "FILLED", origQty: "60", executedQty: "60", authoritativeHistory: true },
  }];
  const diagnosis = {
    reason: "EXIT_QUANTITY_BALANCE_MISMATCH",
    metrics: { tolerance: 0.01, entryFillCount: 1, entryQuantity: 100, entryBaseFee: 0, exitQuantity: 60, exitBaseFee: 0, remainingBaseBalance: 40, accountingDelta: 40 },
  };
  const evidence = buildFilledTakeProfitCloseEvidence({ tradeId: "trade-1", entryExecution, exitOrders, diagnosis });
  assert.equal(evidence, null);

  const trade = {
    id: "trade-1",
    settlementFeeModel: CURRENT_TRADE_FEE_MODEL,
    side: "BUY",
    adminExecution: entryExecution,
    exitOrders,
    authoritativeCloseEvidence: {
      source: "BYBIT_KNOWN_FILLED_TAKE_PROFIT_EXECUTION_HISTORY",
      tradeId: "trade-1",
      entryOrderId: "entry-order",
      exitOrderIds: ["tp-order"],
      entryQuantity: "100",
      entryBaseFee: "0",
      exitQuantity: "60",
      exitBaseFee: "0",
      remainingBaseBalance: "40",
      accountingDelta: "40",
      tolerance: "0.01",
      balanceReconciled: false,
    },
  };
  assert.equal(hasVerifiedExchangeCloseEvidence(trade), false);
  assert.equal(deriveTradeLifecycle(trade, () => 40), "OPEN");
});

test("current trade-scoped evidence aggregates a partial TP and manual/replacement exits despite unrelated account holdings", () => {
  const entryExecution = { orderId: "entry", status: "FILLED", executedQty: "100", transactTime: 10 };
  const executions = [
    { execId: "e1", orderId: "entry", side: "BUY", execQty: "100", execPrice: "10", execTime: 11, feeCurrency: "USDT", execFee: "1" },
    { execId: "tp1", orderId: "tp", side: "SELL", execQty: "60", execPrice: "11", execTime: 20, feeCurrency: "USDT", execFee: "0.66" },
    { execId: "manual1", orderId: "manual", side: "SELL", execQty: "40", execPrice: "9", execTime: 30, feeCurrency: "USDT", execFee: "0.36" },
  ];
  const recovered = reconstructTradeScopedClose({
    tradeId: "current-trade",
    entryExecution,
    executions,
    baseAsset: "FAST",
    tolerance: 0.001,
  });
  assert.equal(recovered.reason, "VERIFIED_TRADE_SCOPED_EXIT");
  assert.deepEqual(recovered.evidence.exitOrderIds.sort(), ["manual", "tp"]);
  assert.equal(recovered.evidence.remainingTradeQuantity, "0");
  assert.equal(recovered.externalExits.find((item) => item.orderId === "manual").price, "9");

  const trade = {
    id: "current-trade",
    settlementFeeModel: CURRENT_TRADE_FEE_MODEL,
    side: "BUY",
    adminExecution: { ...entryExecution, price: "10" },
    exitOrders: [
      { kind: "TAKE_PROFIT", adminExecution: { orderId: "tp", status: "PARTIALLY_FILLED", executedQty: "60", origQty: "100", authoritativeHistory: true } },
      { kind: "EXTERNAL_CLOSE", adminExecution: { orderId: "manual", status: "FILLED", executedQty: "40", origQty: "40", authoritativeHistory: true } },
    ],
    authoritativeCloseEvidence: recovered.evidence,
  };
  assert.equal(hasVerifiedExchangeCloseEvidence(trade), true);
  assert.equal(deriveTradeLifecycle(trade), "CLOSED");
  assert.equal((60 * 11 + 40 * 9) / 100, 10.2);
  const settlement = calculateFixedRoundTripSettlement("10000", "2");
  assert.equal(settlement.tradingFee, "20");
  assert.equal(settlement.netPnl, "180");
});

test("trade-scoped closure rejects meaningful exposure, oversells, missing entry, and deduplicates repeated execution rows", () => {
  const entryExecution = { orderId: "entry", executedQty: "100" };
  const entry = { execId: "entry-fill", orderId: "entry", side: "BUY", execQty: "100", execPrice: "10", execTime: 10 };
  const sell = { execId: "exit-fill", orderId: "exit", side: "SELL", execQty: "99", execPrice: "11", execTime: 20 };
  const partial = reconstructTradeScopedClose({ tradeId: "current", entryExecution, executions: [entry, sell], baseAsset: "FAST", tolerance: 0.01 });
  assert.equal(partial.evidence, null);
  assert.equal(partial.reason, "MEANINGFUL_TRADE_QUANTITY_REMAINS");
  assert.equal(reconstructTradeScopedClose({ tradeId: "current", entryExecution, executions: [entry, { ...sell, execQty: "101" }], baseAsset: "FAST", tolerance: 0.01 }).reason, "NO_QUANTITY_MATCHING_EXIT_SUBSET");
  assert.equal(reconstructTradeScopedClose({ tradeId: "current", entryExecution, executions: [entry, { ...sell, execQty: "100.005" }], baseAsset: "FAST", tolerance: 0.01 }).reason, "EXIT_QUANTITY_EXCEEDS_ENTRY");
  assert.equal(reconstructTradeScopedClose({ tradeId: "current", entryExecution, executions: [sell], baseAsset: "FAST" }).reason, "ENTRY_FILLS_NOT_FOUND");

  const complete = reconstructTradeScopedClose({ tradeId: "current", entryExecution, executions: [entry, { ...sell, execQty: "100" }, { ...sell, execQty: "100" }], baseAsset: "FAST", tolerance: 0.01 });
  assert.equal(complete.evidence.exitQuantity, "100");
});

test("missing exit reference recovery attributes only a unique quantity-bounded subset", () => {
  const entryExecution = { orderId: "lit-entry", executedQty: "376.95" };
  const executions = [
    { execId: "entry", orderId: "lit-entry", side: "BUY", execQty: "376.95", execPrice: "0.8", execTime: 100 },
    ...[100, 100, 100, 76.95, 3, 5, 7, 11].map((qty, index) => ({
      execId: `sell-${index}`,
      orderId: `sell-order-${index}`,
      orderLinkId: `link-${index}`,
      side: "SELL",
      execQty: String(qty),
      execPrice: "0.81",
      execTime: 200 + index,
    })),
  ];
  const recovered = reconstructTradeScopedClose({
    tradeId: "lit-current",
    entryExecution,
    executions,
    baseAsset: "LIT",
    tolerance: 0.01,
  });
  assert.equal(recovered.reason, "VERIFIED_TRADE_SCOPED_EXIT");
  assert.equal(recovered.metrics.candidateSellExecutionCount, 8);
  assert.equal(recovered.metrics.attributableSellExecutionCount, 4);
  assert.equal(recovered.evidence.exitQuantity, "376.95");
  assert.equal(recovered.evidence.remainingTradeQuantity, "0");

  const ambiguous = reconstructTradeScopedClose({
    tradeId: "lit-current",
    entryExecution,
    executions: [executions[0],
      { execId: "sell-a", orderId: "sell-a", side: "SELL", execQty: "376.95", execPrice: "0.81", execTime: 200 },
      { execId: "sell-b", orderId: "sell-b", side: "SELL", execQty: "376.95", execPrice: "0.82", execTime: 201 }],
    baseAsset: "LIT",
    tolerance: 0.01,
  });
  assert.equal(ambiguous.evidence, null);
  assert.equal(ambiguous.reason, "MULTIPLE_QUANTITY_MATCHING_EXIT_SUBSETS");

  const incomplete = reconstructTradeScopedClose({
    tradeId: "lit-current",
    entryExecution,
    executions: [executions[0], { execId: "sell-300", orderId: "sell-300", side: "SELL", execQty: "300", execPrice: "0.81", execTime: 200 }],
    baseAsset: "LIT",
    tolerance: 0.01,
  });
  assert.equal(incomplete.evidence, null);
  assert.equal(incomplete.reason, "MEANINGFUL_TRADE_QUANTITY_REMAINS");
});

test("registered order IDs and orderLinkIds are mandatory; overlapping same-owner current trades block attribution", () => {
  const entryExecution = { orderId: "entry", executedQty: "100" };
  const executions = [
    { execId: "e", orderId: "entry", side: "BUY", execQty: "100", execPrice: "1", execTime: 10 },
    { execId: "tp", orderId: "real-tp", orderLinkId: "tp-link", side: "SELL", execQty: "60", execPrice: "1.1", execTime: 20 },
    { execId: "other", orderId: "external", side: "SELL", execQty: "40", execPrice: "1.2", execTime: 30 },
    { execId: "unrelated", orderId: "unrelated", side: "SELL", execQty: "7", execPrice: "1.2", execTime: 31 },
  ];
  const recovered = reconstructTradeScopedClose({
    tradeId: "trade-a",
    entryExecution,
    exitOrders: [{ adminExecution: { clientOrderId: "tp-link" } }],
    executions,
    baseAsset: "FAST",
    tolerance: 0.001,
  });
  assert.equal(recovered.evidence.exitQuantity, "100");
  assert.equal(recovered.metrics.attributableSellExecutionCount, 2);

  const currentTrade = { id: "a", createdByUserId: "admin", symbol: "LITUSDT", exchange: "bybit", side: "BUY", settlementFeeModel: CURRENT_TRADE_FEE_MODEL, adminExecution: { status: "FILLED", transactTime: 10, executedQty: "100" } };
  const overlappingTrade = { id: "b", createdByUserId: "admin", symbol: "LITUSDT", exchange: "bybit", side: "BUY", settlementFeeModel: CURRENT_TRADE_FEE_MODEL, adminExecution: { status: "FILLED", transactTime: 15, executedQty: "25" } };
  assert.equal(hasOverlappingCurrentGenerationTrade(currentTrade, [currentTrade, overlappingTrade], 30, (item) => item.exchange), true);
  assert.equal(hasOverlappingCurrentGenerationTrade(currentTrade, [currentTrade, overlappingTrade], 14, (item) => item.exchange), false);
  assert.equal(hasOverlappingCurrentGenerationTrade(currentTrade, [currentTrade, { ...overlappingTrade, settlementFeeModel: "historical" }], 30, (item) => item.exchange), false);
});

test("trade reconciliation consults exact Bybit execution history for unresolved exits", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const exitReconciler = server.slice(server.indexOf("async function reconcileExitExecution"), server.indexOf("function shouldReconcileTrade"));
  const tradeReconciler = server.slice(server.indexOf("async function reconcileTradeStatuses"), server.indexOf("function startTradeReconciliation"));
  assert.match(exitReconciler, /normalizeExchange\(exchange\) !== "bybit"/);
  assert.match(exitReconciler, /getExecutionHistory/);
  assert.match(exitReconciler, /reconstructKnownExitExecution/);
  assert.match(exitReconciler, /EXIT_HISTORY_FALLBACK_COOLDOWN_MS/);
  assert.match(tradeReconciler, /reconcileExitExecution\(adminAccount/);
  assert.match(tradeReconciler, /reconcileExitExecution\(\s*mirrorAccount/);
});

test("validated Bybit close evidence runs before external-close synthesis and is used by settlement pricing", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(__dirname, "..", "lib", "tradeLifecycle.js"), "utf8");
  const externalRecovery = server.slice(server.indexOf("async function reconcileExternalClosuresForOwner"), server.indexOf("function sameExecution"));
  const pnl = server.slice(server.indexOf("function getAuthoritativeClosedTradePnlPercent"), server.indexOf("async function buildUserTradeInvestmentSummary"));
  assert.match(externalRecovery, /diagnoseKnownExitClosure/);
  assert.match(externalRecovery, /supplementKnownOrderExecutionHistory/);
  assert.match(server, /historyReader\(account, symbol, \{ orderId, limit: 100 \}\)/);
  assert.match(externalRecovery, /trade\.authoritativeCloseEvidence = closeEvidence/);
  assert.match(externalRecovery, /reconstructTradeScopedClose/);
  assert.match(externalRecovery, /overlapping_current_generation_trade_prevents_exit_attribution/);
  assert.match(externalRecovery, /!isCurrentGenerationTrade\(trade\)/);
  assert.doesNotMatch(externalRecovery, /normalizedBalance\s*>\s*0\s*&&\s*\(!minQty/);
  assert.ok(externalRecovery.indexOf("trade.authoritativeCloseEvidence = closeEvidence") < externalRecovery.indexOf("reconstructExternalClose"));
  assert.match(lifecycle, /hasVerifiedExchangeCloseEvidence\(trade\)/);
  assert.match(pnl, /closeEvidenceVerified/);
});
