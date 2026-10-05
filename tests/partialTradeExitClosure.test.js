"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveTradeLifecycle } = require("../lib/tradeLifecycle");
const { CURRENT_TRADE_FEE_MODEL } = require("../lib/tradingFee");
const {
  AUTO_CLOSE_FILL_RATIO,
  buildPartialTradeExitEvidence,
  hasVerifiedPartialTradeExitEvidence,
} = require("../lib/partialTradeExitClosure");

function tradeWithExit({ status = "CANCELED", quantity = "8", kind = "TAKE_PROFIT" } = {}) {
  return {
    id: "trade-1",
    side: "BUY",
    adminExecution: { orderId: "entry-1", status: "FILLED", executedQty: "10", price: "100" },
    exitOrders: [{
      kind,
      closeTradeOnFill: kind === "MANUAL_SELL",
      adminExecution: { orderId: "exit-1", status, executedQty: quantity, price: "110", cummulativeQuoteQty: String(Number(quantity) * 110) },
    }],
  };
}

test("automatic partial close requires at least 80 percent filled and values remainder at closure mark", () => {
  const trade = tradeWithExit({ quantity: String(10 * AUTO_CLOSE_FILL_RATIO) });
  const result = buildPartialTradeExitEvidence({ trade, markPrice: "105", reason: "AUTO_FILL_THRESHOLD" });
  assert.ok(result.evidence);
  assert.equal(Number(result.evidence.fillRatio), 0.8);
  assert.equal(Number(result.evidence.remainingQuantity), 2);
  assert.equal(Number(result.evidence.effectiveExitPrice), 109);
  assert.equal(hasVerifiedPartialTradeExitEvidence({ ...trade, authoritativeCloseEvidence: result.evidence }), true);
  const closedTrade = { ...trade, settlementFeeModel: CURRENT_TRADE_FEE_MODEL, authoritativeCloseEvidence: result.evidence };
  assert.equal(deriveTradeLifecycle(closedTrade, () => 2), "CLOSED");
});

test("automatic partial close below 80 percent is rejected", () => {
  const result = buildPartialTradeExitEvidence({ trade: tradeWithExit({ quantity: "7.99" }), markPrice: "105", reason: "AUTO_FILL_THRESHOLD" });
  assert.equal(result.evidence, null);
  assert.equal(result.reason, "AUTO_CLOSE_FILL_THRESHOLD_NOT_MET");
});

test("manual stop may close below 80 percent only after a terminal positive fill", () => {
  const trade = tradeWithExit({ quantity: "2", kind: "MANUAL_SELL" });
  const result = buildPartialTradeExitEvidence({ trade, markPrice: "90", reason: "MANUAL_STOP" });
  assert.ok(result.evidence);
  assert.equal(Number(result.evidence.fillRatio), 0.2);
  assert.equal(Number(result.evidence.effectiveExitPrice), 94);
  assert.equal(hasVerifiedPartialTradeExitEvidence({ ...trade, authoritativeCloseEvidence: result.evidence }), true);
});

test("legacy full-size manual stop orders without close metadata remain recognizable", () => {
  const trade = tradeWithExit({ quantity: "2", kind: "MANUAL_SELL" });
  delete trade.exitOrders[0].closeTradeOnFill;
  trade.exitOrders[0].quantity = "10";
  const result = buildPartialTradeExitEvidence({ trade, markPrice: "90", reason: "MANUAL_STOP" });
  assert.ok(result.evidence);
  assert.equal(result.evidence.closeReason, "MANUAL_STOP");
});

test("partial active exit cannot be treated as a completed close", () => {
  const trade = tradeWithExit({ status: "PARTIALLY_FILLED", quantity: "8" });
  const result = buildPartialTradeExitEvidence({ trade, markPrice: "105", reason: "AUTO_FILL_THRESHOLD" });
  assert.equal(result.evidence, null);
  assert.equal(result.reason, "EXIT_ORDER_STILL_ACTIVE");
});

test("canceled exit with zero or missing execution price cannot prove closure", () => {
  const noFill = tradeWithExit({ quantity: "0" });
  assert.equal(buildPartialTradeExitEvidence({ trade: noFill, markPrice: "105", reason: "MANUAL_STOP" }).evidence, null);

  const noPrice = tradeWithExit();
  delete noPrice.exitOrders[0].adminExecution.price;
  delete noPrice.exitOrders[0].adminExecution.cummulativeQuoteQty;
  assert.equal(buildPartialTradeExitEvidence({ trade: noPrice, markPrice: "105", reason: "AUTO_FILL_THRESHOLD" }).evidence, null);
});

test("partial close evidence is invalidated if recorded exit executions change", () => {
  const trade = tradeWithExit();
  const { evidence } = buildPartialTradeExitEvidence({ trade, markPrice: "105", reason: "AUTO_FILL_THRESHOLD" });
  assert.ok(evidence);
  trade.authoritativeCloseEvidence = evidence;
  trade.exitOrders[0].adminExecution.executedQty = "7";
  assert.equal(hasVerifiedPartialTradeExitEvidence(trade), false);
});
