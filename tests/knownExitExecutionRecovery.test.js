"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { reconstructKnownExitExecution } = require("../lib/knownExitExecutionRecovery");

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
