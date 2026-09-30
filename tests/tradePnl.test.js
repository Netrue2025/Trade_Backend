"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { calculateTradePnlPercent } = require("../lib/tradePnl");

test("user stop mark-to-market P&L handles BUY and SELL sides", () => {
  assert.equal(calculateTradePnlPercent("100", "110", "BUY"), 10);
  assert.equal(calculateTradePnlPercent("100", "90", "BUY"), -10);
  assert.equal(calculateTradePnlPercent("100", "90", "SELL"), 10);
  assert.equal(calculateTradePnlPercent("100", "110", "SELL"), -10);
});

test("user stop P&L rejects missing, zero, invalid prices and unsupported side", () => {
  for (const [entry, current, side] of [[0, 10, "BUY"], [10, 0, "BUY"], ["bad", 10, "BUY"], [10, "bad", "BUY"], [10, 11, "MIXED"]]) {
    assert.throws(() => calculateTradePnlPercent(entry, current, side));
  }
});

test("stop endpoint settles only the authenticated user's active investment without closing the shared trade", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const stopRoute = server.slice(server.indexOf("const stopTradeMatch"), server.indexOf('if (req.method === "POST" && url.pathname === "/api/admin/bonus-reversals")'));
  const settlement = server.slice(server.indexOf("async function settleTradeInvestment"), server.indexOf("async function settleInactiveTradeInvestmentsForUsers"));
  assert.match(stopRoute, /requireAuth\(req, res, "user"\)/);
  assert.match(stopRoute, /getUserTradeInvestment\(trade\.id, user\.id\)/);
  assert.match(stopRoute, /reason: "USER_STOPPED"/);
  assert.match(stopRoute, /INVESTMENT_ALREADY_SETTLED/);
  assert.doesNotMatch(stopRoute, /executeTradeExit|trade\.status\s*=|trade\.closedAt\s*=/);
  assert.match(settlement, /withUserFinancialLock\(user\.id/);
  assert.match(settlement, /trade-settlement:\$\{currentInvestment\.id\}/);
  assert.match(settlement, /fields: \["meta", "tradeInvestments", "wallets", "transactions"\]/);
  assert.match(settlement, /settlementBasis: stopMarkPrice \? "USER_STOP_MARKET_SNAPSHOT"/);
});
