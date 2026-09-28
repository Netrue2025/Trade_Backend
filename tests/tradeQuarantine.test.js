"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HISTORICAL_EXCLUDED_TRADE_IDS, isTradeQuarantined } = require("../lib/tradeQuarantine");

const ARX_TRADE_ID = "89eaf6636270d40f995fde20";
const XRP_HISTORICAL_TRADE_ID = "b0002ec3b525ec6de7d69a12";

test("quarantine is generic, trade-id scoped, and does not affect another ARX trade", () => {
  const db = { systemSettings: { trading: { quarantinedTradeIds: [ARX_TRADE_ID] } } };
  assert.equal(isTradeQuarantined(db, ARX_TRADE_ID), true);
  assert.equal(isTradeQuarantined(db, { id: ARX_TRADE_ID, symbol: "ARXUSDT" }), true);
  assert.equal(isTradeQuarantined(db, { id: "future-arx", symbol: "ARXUSDT" }), false);
  assert.equal(isTradeQuarantined(db, "f171417518d760bb741e348c"), false);
});

test("ARX and historical XRP are permanently excluded without changing financial state", () => {
  const emptySettings = { systemSettings: { trading: { quarantinedTradeIds: [] } } };
  assert.equal(HISTORICAL_EXCLUDED_TRADE_IDS.has(ARX_TRADE_ID), true);
  assert.equal(HISTORICAL_EXCLUDED_TRADE_IDS.has(XRP_HISTORICAL_TRADE_ID), true);
  assert.equal(isTradeQuarantined(emptySettings, ARX_TRADE_ID), true);
  assert.equal(isTradeQuarantined(emptySettings, XRP_HISTORICAL_TRADE_ID), true);
});

test("server skips quarantined trades in startup, periodic, and every automatic settlement path", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const shouldReconcile = server.slice(server.indexOf("function shouldReconcileTrade"), server.indexOf("async function reconcileTradeStatuses"));
  const directSettlement = server.slice(server.indexOf("async function settleTradeInvestment"), server.indexOf("async function settleInactiveTradeInvestmentsForUsers"));
  const inactiveSettlement = server.slice(server.indexOf("async function settleInactiveTradeInvestmentsForUsers"), server.indexOf("async function settleClosedTradeInvestments"));
  const closedSettlement = server.slice(server.indexOf("async function settleClosedTradeInvestments"), server.indexOf("const loggedInvestmentRecoveryReviews"));
  const orphanRecovery = server.slice(server.indexOf("async function reconcileOrphanedClosedTradeInvestments"), server.indexOf("async function settleStaleTradeInvestmentsForWithdrawal"));
  assert.match(shouldReconcile, /isTradeQuarantined\(db, trade\)/);
  assert.match(directSettlement, /isTradeQuarantined\(db, trade\)/);
  assert.match(inactiveSettlement, /isTradeQuarantined\(db, trade\)/);
  assert.match(closedSettlement, /isTradeQuarantined\(db, trade\)/);
  assert.match(orphanRecovery, /isTradeQuarantined\(db, trade\)/);
  assert.match(server, /startTradeReconciliation\(true\)/);
  assert.match(server, /setInterval\(\(\) => \{\s*void startTradeReconciliation\(\)/);
  assert.match(server, /!isTradeQuarantined\(db, trade\).*deriveTradeLifecycle\(trade\)/);
  assert.match(server, /code: "TRADE_QUARANTINED"/);
});

test("quarantine reports review status without mutating wallets investments or transactions", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const moduleSource = fs.readFileSync(path.join(__dirname, "..", "lib", "tradeQuarantine.js"), "utf8");
  assert.match(server, /\? "QUARANTINED" : deriveTradeLifecycle\(trade\)/);
  assert.doesNotMatch(moduleSource, /wallet|transaction|investment|persist|saveDb/i);
  assert.doesNotMatch(moduleSource, /financialIntegrity|freeze/i);
});

test("real persistence failures and unrelated financial flows retain their existing protections", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const financialTests = fs.readFileSync(path.join(__dirname, "financialService.test.js"), "utf8");
  const integrityTests = fs.readFileSync(path.join(__dirname, "financialIntegrity.test.js"), "utf8");
  assert.match(integrityTests, /global freeze blocks financial and unrelated durable mutations/);
  assert.match(financialTests, /deposit approval credits once/);
  assert.match(financialTests, /withdrawal/);
  assert.match(server, /await persist\(\{\s*required: true,/);
});
