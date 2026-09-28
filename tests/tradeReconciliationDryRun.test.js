"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildTradeReconciliationDryRun } = require("../lib/tradeReconciliationDryRun");
const { isHistoricalTradeExcluded, isTradeQuarantined } = require("../lib/tradeQuarantine");
const { assessClosedTradeInvestmentRecovery } = require("../lib/tradeInvestmentRecovery");

function lifecycle(trade) {
  if ((trade.exitOrders || []).some((exit) => exit.adminExecution?.status === "FILLED")) return "CLOSED";
  return trade.adminExecution?.status === "FILLED" ? "OPEN" : "PENDING";
}

function fixture() {
  const closed = { id: "closed", symbol: "BTCUSDT", exchange: "bybit", adminExecution: { status: "FILLED", avgPrice: "10" }, exitOrders: [{ adminExecution: { status: "FILLED", avgPrice: "11", executedQty: "1", transactTime: Date.now() } }] };
  return {
    systemSettings: { trading: { quarantinedTradeIds: [] } },
    tradeIntents: [closed, { id: "open", symbol: "ETHUSDT", exchange: "bybit", adminExecution: { status: "FILLED" }, exitOrders: [] }, { id: "89eaf6636270d40f995fde20", symbol: "ARXUSDT", adminExecution: { status: "FILLED" }, exitOrders: [] }],
    tradeInvestments: [{ id: "active", userId: "user", tradeId: "closed", status: "ACTIVE", joinedAt: new Date(Date.now() - 1000).toISOString(), amountUsdt: "1", baselinePnlPercent: "0", fundingSources: [{ currency: "USDT", amount: "1" }] }, { id: "open-active", userId: "user", tradeId: "open", status: "ACTIVE", amountUsdt: "1", fundingSources: [{ currency: "USDT", amount: "1" }] }, { id: "xrp", userId: "user", tradeId: "b0002ec3b525ec6de7d69a12", status: "ACTIVE", amountUsdt: "1", fundingSources: [{ currency: "USDT", amount: "1" }] }],
    users: [{ id: "user", role: "user" }],
    wallets: [{ userId: "user", currency: "USDT", availableBalance: "0", lockedBalance: "2" }],
    transactions: [{ id: "lock", userId: "user", type: "TRADE_INVESTMENT_LOCK", status: "APPROVED", currency: "USDT", amount: "-1", reference: "active" }],
  };
}

function run(db) {
  return buildTradeReconciliationDryRun({ db, deriveTradeLifecycle: lifecycle, isTradeQuarantined, isHistoricalTradeExcluded, assessClosedTradeInvestmentRecovery });
}

test("dry-run planning is read-only and excludes ARX and XRP", () => {
  const db = fixture();
  const before = structuredClone(db);
  const result = run(db);
  assert.deepEqual(db, before);
  assert.equal(result.candidates.find((item) => item.tradeId === "89eaf6636270d40f995fde20").classification, "HISTORICAL_EXCLUSION");
  assert.equal(result.candidates.find((item) => item.investmentIds.includes("xrp")).classification, "HISTORICAL_EXCLUSION");
  assert.equal(result.candidates.find((item) => item.tradeId === "open").classification, "SAFE_TO_MONITOR");
});

test("missing parent record is conservatively classified without a mutation path", () => {
  const db = fixture();
  db.tradeInvestments.push({ id: "missing", userId: "user", tradeId: "missing-trade", status: "ACTIVE", fundingSources: [{ currency: "USDT", amount: "1" }] });
  const result = run(db);
  const missing = result.candidates.find((item) => item.investmentIds.includes("missing"));
  assert.equal(missing.classification, "INSUFFICIENT_EVIDENCE");
  assert.equal(missing.unexpectedHistoricalRecord, true);
});

test("admin dry-run endpoint is authenticated and delegates only to the pure planner", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf('url.pathname === "/api/admin/trading/reconciliation/dry-run"');
  const route = source.slice(start, source.indexOf("if (!startupState.ready)", start));
  assert.match(route, /requireAuth\(req, res, "admin"\)/);
  assert.match(route, /AUTHORITATIVE_STATE_REQUIRED/);
  assert.match(route, /buildTradeReconciliationDryRun/);
  assert.doesNotMatch(route, /persist\(|settleTradeInvestment|placeSpotOrder|cancel/);
});
