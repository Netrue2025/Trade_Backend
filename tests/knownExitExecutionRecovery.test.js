"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { diagnoseKnownExitClosure, reconstructKnownExitClosure, reconstructKnownExitExecution } = require("../lib/knownExitExecutionRecovery");

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
  assert.match(externalRecovery, /trade\.authoritativeCloseEvidence = closeEvidence/);
  assert.ok(externalRecovery.indexOf("trade.authoritativeCloseEvidence = closeEvidence") < externalRecovery.indexOf("reconstructExternalClose"));
  assert.match(lifecycle, /hasVerifiedExchangeCloseEvidence\(trade\)/);
  assert.match(pnl, /closeEvidenceVerified/);
});
