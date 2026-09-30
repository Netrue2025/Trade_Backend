"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { reconstructExternalClose } = require("../lib/externalCloseRecovery");
const { deriveTradeLifecycle } = require("../lib/tradeLifecycle");
const { CURRENT_TRADE_FEE_MODEL, calculateFixedRoundTripSettlement } = require("../lib/tradingFee");

const ARX_ENTRY = {
  orderId: "2312905779113716224",
  status: "FILLED",
  executedQty: "11970.5",
  price: "0.2256",
  transactTime: 1790461362588,
};

function arxExecutions() {
  return [
    { orderId: ARX_ENTRY.orderId, side: "BUY", execQty: "11970.5", execPrice: "0.2256", execFee: "11.9705", feeCurrency: "ARX", execTime: 1790461362588 },
    { orderId: "2313249160373299712", side: "SELL", execQty: "795", execPrice: "0.2262", execFee: "0.179829", feeCurrency: "USDT", execTime: 1790497122954 },
    { orderId: "2313249160373299712", side: "SELL", execQty: "11163.5", execPrice: "0.2262", execFee: "2.5251837", feeCurrency: "USDT", execTime: 1790497169440 },
  ];
}

test("ARX authoritative exit reconstructs filled quantity price fee and fee dust", () => {
  const result = reconstructExternalClose({
    entryExecution: ARX_ENTRY,
    executions: arxExecutions(),
    baseAsset: "ARX",
    remainingQuantity: "11970.5",
    currentBaseBalance: "0.0295",
    tolerance: 0.1,
  });
  assert.ok(result);
  assert.equal(result.orderId, "2313249160373299712");
  assert.equal(result.executedQty, "11958.5");
  assert.equal(Number(result.price), 0.2262);
  assert.equal(result.transactTime, 1790497169440);
  assert.deepEqual(result.fees, [{ currency: "USDT", amount: 2.7050127 }]);
});

test("unknown or zero-priced exit fails closed", () => {
  assert.equal(reconstructExternalClose({
    entryExecution: ARX_ENTRY,
    executions: [],
    baseAsset: "ARX",
    remainingQuantity: "11970.5",
  }), null);
  assert.equal(reconstructExternalClose({
    entryExecution: ARX_ENTRY,
    executions: [{ orderId: "exit", side: "SELL", execQty: "11958.5", execPrice: "0", execTime: 1790497169440 }],
    baseAsset: "ARX",
    remainingQuantity: "11970.5",
    currentBaseBalance: "0.0295",
  }), null);
});

test("partial TP remains open until remainder fills and aggregate exit price uses every fill", () => {
  const entryExecution = { orderId: "entry", status: "FILLED", executedQty: "100", price: "10", transactTime: 10 };
  const takeProfitExecution = { orderId: "tp", status: "PARTIALLY_FILLED", executedQty: "60", origQty: "100", price: "11" };
  const trade = {
    id: "fast-trade",
    settlementFeeModel: CURRENT_TRADE_FEE_MODEL,
    side: "BUY",
    adminExecution: entryExecution,
    exitOrders: [{ kind: "TAKE_PROFIT", adminExecution: takeProfitExecution }],
  };
  const remaining = (candidate) => Number(candidate.adminExecution.executedQty)
    - candidate.exitOrders.reduce((sum, exit) => sum + Number(exit.adminExecution.executedQty), 0);
  assert.equal(deriveTradeLifecycle(trade, remaining), "OPEN");

  const manualRemainder = reconstructExternalClose({
    entryExecution,
    knownExitOrderIds: ["tp"],
    executions: [
      { orderId: "exit-b", side: "SELL", execQty: "20", execPrice: "9", execTime: 30 },
      { orderId: "exit-c", side: "SELL", execQty: "20", execPrice: "10", execTime: 40 },
    ],
    baseAsset: "FAST",
    remainingQuantity: 40,
    currentBaseBalance: 0,
    tolerance: 0.000001,
  });
  assert.equal(manualRemainder.executedQty, "40");
  assert.equal(Number(manualRemainder.price), 9.5);

  trade.exitOrders.push({ kind: "EXTERNAL_CLOSE", adminExecution: manualRemainder });
  assert.equal(deriveTradeLifecycle(trade, remaining), "CLOSED");
  const aggregateExitPrice = (60 * 11 + 40 * Number(manualRemainder.price)) / 100;
  assert.equal(aggregateExitPrice, 10.4);
  const settlement = calculateFixedRoundTripSettlement("10000", "4");
  assert.equal(settlement.tradingFee, "20");
  assert.equal(settlement.settlementAmount, "10380");
});

test("reconciliation cannot create a zero-price synthetic close", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(server, /function createExternalCloseExecution/);
  assert.match(server, /authoritative_exit_not_proven/);
  assert.match(server, /price: authoritativeExecution\.price/);
  assert.match(server, /await settleTradeInvestment/);
  assert.match(server, /`trade-settlement:\$\{currentInvestment\.id\}`/);
});
