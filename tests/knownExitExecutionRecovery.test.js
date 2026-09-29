"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildFilledTakeProfitCloseEvidence, diagnoseKnownExitClosure, reconstructKnownExitClosure, reconstructKnownExitExecution } = require("../lib/knownExitExecutionRecovery");
const { deriveTradeLifecycle, hasVerifiedExchangeCloseEvidence } = require("../lib/tradeLifecycle");
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
  assert.ok(externalRecovery.indexOf("trade.authoritativeCloseEvidence = closeEvidence") < externalRecovery.indexOf("reconstructExternalClose"));
  assert.match(lifecycle, /hasVerifiedExchangeCloseEvidence\(trade\)/);
  assert.match(pnl, /closeEvidenceVerified/);
});
