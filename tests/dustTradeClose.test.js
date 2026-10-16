"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DUST_TRADE_CLOSE_SOURCE, buildDustTradeCloseEvidence, hasVerifiedDustTradeCloseEvidence } = require("../lib/dustTradeClose");
const { deriveTradeLifecycle, hasVerifiedExchangeCloseEvidence } = require("../lib/tradeLifecycle");
const { CURRENT_TRADE_FEE_MODEL } = require("../lib/tradingFee");

function tradeFixture() {
  return {
    id: "25d85206cb7b1c8f87268fbc",
    settlementFeeModel: CURRENT_TRADE_FEE_MODEL,
    symbol: "MINAUSDT",
    side: "BUY",
    adminExecution: { orderId: "entry-1", status: "FILLED", executedQty: "100", cummulativeQuoteQty: "50" },
    exitOrders: [],
  };
}

function build(overrides = {}) {
  return buildDustTradeCloseEvidence({
    trade: tradeFixture(),
    balanceQuantity: 0.00154875,
    markPrice: 0.5,
    verifiedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  });
}

test("MINA dust evidence closes only a below-$10 residual with a fresh isolated snapshot", () => {
  const { evidence, reason } = build();
  assert.equal(reason, undefined);
  assert.equal(evidence.source, DUST_TRADE_CLOSE_SOURCE);
  assert.equal(Number(evidence.exchangeBalanceValueUsd), 0.000774375);
  assert.equal(Number(evidence.effectiveExitPrice), 0.5);
  assert.equal(hasVerifiedDustTradeCloseEvidence(tradeFixture(), evidence), true);
  const trade = { ...tradeFixture(), authoritativeCloseEvidence: evidence };
  assert.equal(hasVerifiedExchangeCloseEvidence(trade), true);
  assert.equal(deriveTradeLifecycle(trade), "CLOSED");
});

test("dust evidence rejects a residual at the threshold and any live symbol order", () => {
  assert.equal(build({ balanceQuantity: 20, markPrice: 0.5 }).reason, "BALANCE_NOT_DUST");
  assert.equal(build({ balanceQuantity: 0.001, markPrice: 10000 }).reason, "BALANCE_NOT_DUST");
  assert.equal(build({ openOrders: [{ symbol: "MINAUSDT", status: "NEW" }] }).reason, "OPEN_SYMBOL_ORDER");
  assert.equal(build({ hasOtherOpenTrade: true }).reason, "OVERLAPPING_TRADE");
});

test("dust evidence rejects mismatched trade balances and malformed exit accounting", () => {
  assert.equal(build({ balanceQuantity: 101, markPrice: 0.5 }).reason, "BALANCE_EXCEEDS_TRADE_REMAINDER");
  const trade = tradeFixture();
  trade.exitOrders = [{ adminExecution: { status: "NEW", orderId: "tp-1", executedQty: "0" } }];
  assert.equal(build({ trade }).reason, "ACTIVE_EXIT_ORDER");
});

test("dust close evidence is bound to the recorded trade and exit fills", () => {
  const { evidence } = build();
  const changedTrade = tradeFixture();
  changedTrade.adminExecution.orderId = "different-entry";
  assert.equal(hasVerifiedDustTradeCloseEvidence(changedTrade, evidence), false);
  const exitedTrade = tradeFixture();
  exitedTrade.exitOrders = [{ adminExecution: {
    orderId: "exit-1", status: "FILLED", executedQty: "1", price: "0.6", cummulativeQuoteQty: "0.6",
  } }];
  assert.equal(hasVerifiedDustTradeCloseEvidence(exitedTrade, evidence), false);
});

test("the MINA recovery route is admin-only, exact-trade scoped, and execution-confirmed", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = server.indexOf('url.pathname === "/api/admin/recovery/mina-dust-trade"');
  const end = server.indexOf('const hideTradeMatch', start);
  const route = server.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(route, /requireAuth\(req, res, "admin"\)/);
  assert.match(route, /25d85206cb7b1c8f87268fbc/);
  assert.match(route, /mode === "dry-run" \|\| blocker/);
  assert.match(route, /CLOSE_MINA_DUST_TRADE_25d85206cb7b1c8f87268fbc/);
  assert.doesNotMatch(route, /No active user investments remain/);
  assert.match(route, /persist\(\{ required: true, fields: \["tradeIntents"\] \}\)/);
  assert.match(route, /settleClosedTradeInvestments\(trade/);
});
