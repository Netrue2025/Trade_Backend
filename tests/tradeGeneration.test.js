"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { deriveTradeLifecycle } = require("../lib/tradeLifecycle");
const { CURRENT_TRADE_FEE_MODEL } = require("../lib/tradingFee");
const {
  isCurrentGenerationTrade,
  requireCurrentGenerationTrade,
  selectCurrentGenerationInvestments,
  selectCurrentGenerationTrades,
} = require("../lib/tradeGeneration");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const remaining = (trade) => Number(trade.adminExecution?.executedQty || 0)
  - (trade.exitOrders || []).reduce((sum, exit) => sum + Number(exit.adminExecution?.executedQty || 0), 0);

function sourceBetween(start, end) {
  return server.slice(server.indexOf(start), server.indexOf(end, server.indexOf(start)));
}

test("only exact existing server-owned generation marker is eligible", () => {
  assert.equal(isCurrentGenerationTrade({ settlementFeeModel: CURRENT_TRADE_FEE_MODEL }), true);
  assert.equal(isCurrentGenerationTrade({}), false);
  assert.equal(isCurrentGenerationTrade({ settlementFeeModel: "some-old-generation" }), false);
  assert.throws(() => requireCurrentGenerationTrade({ settlementFeeModel: "some-old-generation" }), { code: "HISTORICAL_TRADE_READ_ONLY" });
});

test("ARX XRP TRUMP LIT and unknown historical trades of every lifecycle are excluded", () => {
  const symbols = ["ARXUSDT", "XRPUSDT", "TRUMPUSDT", "LITUSDT", "ZZZUNKNOWNUSDT"];
  const statuses = [
    { adminExecution: { status: "NEW" } },
    { adminExecution: { status: "FILLED", executedQty: "3" } },
    { adminExecution: { status: "FILLED", executedQty: "3" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "3" } }] },
  ];
  const historical = symbols.flatMap((symbol, index) => statuses.map((execution, j) => ({
    id: `${index}-${j}`,
    symbol,
    side: "BUY",
    ...structuredClone(execution),
    ...(j === 1 ? { settlementFeeModel: "some-old-generation" } : {}),
  })));
  const before = structuredClone(historical);
  assert.deepEqual(selectCurrentGenerationTrades(historical), []);
  assert.deepEqual(historical, before);
  assert.ok(historical.every((trade) => deriveTradeLifecycle(trade, remaining) === "HISTORICAL"));
});

test("trade and investment selectors include only exact-generation records with existing parents", () => {
  const trades = [
    { id: "old", settlementFeeModel: undefined },
    { id: "wrong", settlementFeeModel: "some-old-generation" },
    { id: "new", settlementFeeModel: CURRENT_TRADE_FEE_MODEL },
  ];
  const investments = [
    { id: "old-investment", tradeId: "old", status: "ACTIVE" },
    { id: "wrong-investment", tradeId: "wrong", status: "ACTIVE" },
    { id: "new-investment", tradeId: "new", status: "ACTIVE" },
    { id: "orphan-investment", tradeId: "missing", status: "ACTIVE" },
  ];
  assert.deepEqual(selectCurrentGenerationTrades(trades).map((trade) => trade.id), ["new"]);
  assert.deepEqual(selectCurrentGenerationInvestments(investments, trades).map((investment) => investment.id), ["new-investment"]);
});

test("both join endpoints reject historical records before wallet reservation", () => {
  const adminJoin = sourceBetween("const adminUserJoinTradeMatch", "const adminUserMessageMatch");
  const userJoin = sourceBetween("const joinTradeMatch", "const stopTradeMatch");
  for (const route of [adminJoin, userJoin]) {
    assert.match(route, /if \(!isCurrentGenerationTrade\(trade\)\)[\s\S]*?HISTORICAL_TRADE_READ_ONLY/);
    assert.ok(route.indexOf("HISTORICAL_TRADE_READ_ONLY") < route.indexOf("reserveTradeInvestmentFunds"));
    assert.match(route, /fields: \["meta", "tradeInvestments", "wallets", "transactions"/);
  }
});

test("reconciliation selects current-generation trades before exchange reads", () => {
  const reconcile = sourceBetween("async function reconcileTradeStatuses", "function startTradeReconciliation");
  assert.match(reconcile, /selectCurrentGenerationTrades\(db\.tradeIntents\)\.filter\(shouldReconcileTrade\)/);
  assert.ok(reconcile.indexOf("const candidates") < reconcile.indexOf("for (const trade of candidates)"));
  assert.match(sourceBetween("function shouldReconcileTrade", "async function reconcileTradeStatuses"), /!isCurrentGenerationTrade\(trade\)/);
});

test("investment reconciliation resolves and filters the current-generation parent first", () => {
  for (const section of [
    sourceBetween("async function settleInactiveTradeInvestmentsForUsers", "async function settleClosedTradeInvestments"),
    sourceBetween("async function reconcileOrphanedClosedTradeInvestments", "async function settleStaleTradeInvestmentsForWithdrawal"),
  ]) {
    assert.match(section, /selectCurrentGenerationInvestments\(ensureTradeInvestmentsState\(\), db\.tradeIntents\)/);
  }
});

test("direct historical settlement is rejected before lock, financial mutation, or transaction creation", () => {
  const settlement = sourceBetween("async function settleTradeInvestment", "async function settleInactiveTradeInvestmentsForUsers");
  assert.ok(settlement.indexOf("requireCurrentGenerationTrade(trade)") < settlement.indexOf("withUserFinancialLock"));
  assert.ok(settlement.indexOf("requireCurrentGenerationTrade(trade)") < settlement.indexOf("markFinancialMutation"));
  assert.ok(settlement.indexOf("requireCurrentGenerationTrade(trade)") < settlement.indexOf("db.transactions.unshift"));
  assert.match(settlement, /persistedInvestment = \(Array\.isArray\(db\.tradeInvestments\)/);
  assert.match(settlement, /parentTrade = persistedInvestment[\s\S]*?db\.tradeIntents/);
});

test("automatic trade close, stop, take-profit, cancel-sync, and history-clear paths preserve historical records", () => {
  assert.match(sourceBetween("async function executeTradeExit", "async function autoPlaceTakeProfit"), /requireCurrentGenerationTrade\(trade\)/);
  assert.match(sourceBetween("async function autoPlaceTakeProfit", "function isSecureRequest"), /requireCurrentGenerationTrade\(trade\)/);
  assert.match(sourceBetween("async function syncCanceledOrderInTrades", "function inferBaseAssetFromSymbol"), /if \(!isCurrentGenerationTrade\(trade\)\) continue/);
  assert.match(sourceBetween("if (req.method === \"POST\" && url.pathname === \"/api/trades/history/clear\")", "const takeProfitMatch"), /!isCurrentGenerationTrade\(trade\)/);
});

test("new trades receive server-side marker and trade worker requires readiness, persistence, and approval", () => {
  const creation = sourceBetween("async function createTradeIntent", "async function executeSignalAutoTrade");
  assert.match(creation, /settlementFeeModel: CURRENT_TRADE_FEE_MODEL/);
  assert.doesNotMatch(creation, /orderInput\.settlementFeeModel|orderInput\.tradingGeneration/);
  const worker = sourceBetween("function startTradeReconciliation", "async function waitForTradeReconciliation");
  assert.match(worker, /startupState\.ready/);
  assert.match(worker, /isMongoAppStatePersistenceReady/);
  assert.match(worker, /financialIntegrity\.getStatus\(\)\.writable/);
  assert.match(worker, /isTradingIsolationMode\(\)/);
});
