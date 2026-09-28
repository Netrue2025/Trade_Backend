"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { reconstructExternalClose } = require("../lib/externalCloseRecovery");

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

test("reconciliation cannot create a zero-price synthetic close", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(server, /function createExternalCloseExecution/);
  assert.match(server, /authoritative_exit_not_proven/);
  assert.match(server, /price: authoritativeExecution\.price/);
  assert.match(server, /await settleTradeInvestment/);
  assert.match(server, /`trade-settlement:\$\{currentInvestment\.id\}`/);
});
