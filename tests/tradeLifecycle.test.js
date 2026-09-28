"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveTradeLifecycle } = require("../lib/tradeLifecycle");
const { CURRENT_TRADE_FEE_MODEL } = require("../lib/tradingFee");

const remaining = (trade) => Number(trade.adminExecution?.executedQty || 0)
  - (trade.exitOrders || []).reduce((sum, row) => sum + Number(row.adminExecution?.executedQty || 0), 0);

test("filled entry without a valid positive remaining quantity is never reported open", () => {
  assert.equal(deriveTradeLifecycle({ settlementFeeModel: CURRENT_TRADE_FEE_MODEL, side: "BUY", adminExecution: { status: "FILLED" } }, remaining), "UNVERIFIED");
  assert.equal(deriveTradeLifecycle({ settlementFeeModel: CURRENT_TRADE_FEE_MODEL, side: "BUY", adminExecution: { status: "FILLED", executedQty: "0" } }, remaining), "UNVERIFIED");
  assert.equal(deriveTradeLifecycle({ settlementFeeModel: CURRENT_TRADE_FEE_MODEL, side: "BUY", adminExecution: { status: "FILLED", executedQty: "1" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "1" } }] }, remaining), "CLOSED");
});

test("filled entry with positive remaining quantity remains open and joinable", () => {
  const trade = { settlementFeeModel: CURRENT_TRADE_FEE_MODEL, side: "BUY", adminExecution: { status: "FILLED", executedQty: "2" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "0.5" } }] };
  assert.equal(deriveTradeLifecycle(trade, remaining), "OPEN");
});

test("existing queued and canceled classifications remain intact", () => {
  assert.equal(deriveTradeLifecycle({ settlementFeeModel: CURRENT_TRADE_FEE_MODEL, side: "BUY", adminExecution: { status: "NEW" } }, remaining), "PENDING");
  assert.equal(deriveTradeLifecycle({ settlementFeeModel: CURRENT_TRADE_FEE_MODEL, side: "BUY", adminExecution: { status: "CANCELED" } }, remaining), "CANCELED");
});

test("missing and wrong generation markers classify as historical without interpreting exchange status", () => {
  for (const trade of [
    { side: "BUY", adminExecution: { status: "FILLED", executedQty: "5" } },
    { settlementFeeModel: "some-old-generation", side: "BUY", adminExecution: { status: "FILLED", executedQty: "5" } },
    { side: "BUY", adminExecution: { status: "FILLED", executedQty: "5" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "5" } }] },
  ]) {
    assert.equal(deriveTradeLifecycle(trade, remaining), "HISTORICAL");
  }
});
