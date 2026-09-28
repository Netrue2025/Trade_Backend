"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveTradeLifecycle } = require("../lib/tradeLifecycle");

const remaining = (trade) => Number(trade.adminExecution?.executedQty || 0)
  - (trade.exitOrders || []).reduce((sum, row) => sum + Number(row.adminExecution?.executedQty || 0), 0);

test("filled entry without a valid positive remaining quantity is never reported open", () => {
  assert.equal(deriveTradeLifecycle({ side: "BUY", adminExecution: { status: "FILLED" } }, remaining), "UNVERIFIED");
  assert.equal(deriveTradeLifecycle({ side: "BUY", adminExecution: { status: "FILLED", executedQty: "0" } }, remaining), "UNVERIFIED");
  assert.equal(deriveTradeLifecycle({ side: "BUY", adminExecution: { status: "FILLED", executedQty: "1" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "1" } }] }, remaining), "CLOSED");
});

test("filled entry with positive remaining quantity remains open and joinable", () => {
  const trade = { side: "BUY", adminExecution: { status: "FILLED", executedQty: "2" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "0.5" } }] };
  assert.equal(deriveTradeLifecycle(trade, remaining), "OPEN");
});

test("existing queued and canceled classifications remain intact", () => {
  assert.equal(deriveTradeLifecycle({ side: "BUY", adminExecution: { status: "NEW" } }, remaining), "PENDING");
  assert.equal(deriveTradeLifecycle({ side: "BUY", adminExecution: { status: "CANCELED" } }, remaining), "CANCELED");
});
