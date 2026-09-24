const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assessClosedTradeInvestmentRecovery } = require("../lib/tradeInvestmentRecovery");

function fixture(overrides = {}) {
  const investment = {
    id: "investment-1",
    userId: "user-1",
    tradeId: "trade-1",
    status: "ACTIVE",
    joinedAt: "2026-09-22T13:42:07.057Z",
    amountUsdt: "80.93384615",
    baselinePnlPercent: "0.21345708",
    fundingSources: [{ currency: "NGN", amount: "105213.999995" }],
  };
  const trade = {
    id: "trade-1",
    price: "0.10775",
    adminExecution: { status: "FILLED", avgPrice: "0.10775" },
    exitOrders: [{
      createdAt: "2026-09-22T14:00:00.000Z",
      adminExecution: { status: "FILLED", avgPrice: "0.10916", transactTime: Date.parse("2026-09-22T15:00:00.000Z") },
    }],
  };
  const user = { id: "user-1", role: "user" };
  const transactions = [{
    reference: "investment-1",
    type: "TRADE_INVESTMENT_LOCK",
    status: "APPROVED",
    currency: "NGN",
    amount: "-105213.999995",
  }];
  const wallets = [{ userId: "user-1", currency: "NGN", availableBalance: "0.000005", lockedBalance: "105213.999995" }];
  return {
    investment: { ...investment, ...(overrides.investment || {}) },
    trade: { ...trade, ...(overrides.trade || {}) },
    user: overrides.user === undefined ? user : overrides.user,
    transactions: overrides.transactions || transactions,
    wallets: overrides.wallets || wallets,
  };
}

test("active investment on a closed filled trade is eligible only with complete authoritative evidence", () => {
  const result = assessClosedTradeInvestmentRecovery(fixture());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.settlementReference, "trade-settlement:investment-1");
  assert.equal(result.checks.joinedBeforeFilledExit, true);
  assert.equal(result.checks.fundsStillLocked, true);
});

test("eligibility assessment is read-only and preserves balances users and roles", () => {
  const state = fixture();
  const before = structuredClone(state);
  assessClosedTradeInvestmentRecovery(state);
  assert.deepEqual(state, before);
  assert.equal(state.wallets[0].lockedBalance, "105213.999995");
  assert.equal(state.user.role, "user");
});

test("stopped historical investment without settlement is never automatically eligible", () => {
  const result = assessClosedTradeInvestmentRecovery(fixture({ investment: { status: "STOPPED" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("active"));
});

test("existing exact settlement makes repeated reconciliation ineligible", () => {
  const state = fixture();
  state.transactions.push({
    reference: "trade-settlement:investment-1",
    type: "TRADING_PROFIT",
    status: "APPROVED",
    metadata: { investmentId: "investment-1" },
  });
  const result = assessClosedTradeInvestmentRecovery(state);
  assert.equal(result.eligible, false);
  assert.equal(result.checks.exactSettlementAbsent, false);
  assert.equal(result.checks.equivalentSettlementAbsent, false);
});

test("equivalent historical settlement under another reference blocks recovery", () => {
  const state = fixture();
  state.transactions.push({ reference: "legacy-credit", type: "TRADING_PROFIT", metadata: { investmentId: "investment-1" } });
  const result = assessClosedTradeInvestmentRecovery(state);
  assert.equal(result.eligible, false);
  assert.equal(result.checks.equivalentSettlementAbsent, false);
});

test("missing join debit locked funds timestamps or prices require forensic review", () => {
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ transactions: [] })).eligible, false);
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ wallets: [] })).eligible, false);
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ investment: { joinedAt: "invalid" } })).eligible, false);
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ trade: { adminExecution: { status: "FILLED", avgPrice: "0" } } })).eligible, false);
});

test("investment joined after the filled exit is not eligible", () => {
  const result = assessClosedTradeInvestmentRecovery(fixture({ investment: { joinedAt: "2026-09-22T16:00:00.000Z" } }));
  assert.equal(result.eligible, false);
  assert.equal(result.checks.joinedBeforeFilledExit, false);
});

test("scheduler revisits closed-trade investments through the canonical settlement primitive", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const reconciliation = server.slice(
    server.indexOf("async function reconcileTradeStatuses"),
    server.indexOf("function startTradeReconciliation")
  );
  const recovery = server.slice(
    server.indexOf("async function reconcileOrphanedClosedTradeInvestments"),
    server.indexOf("async function settleStaleTradeInvestmentsForWithdrawal")
  );
  assert.match(reconciliation, /await reconcileOrphanedClosedTradeInvestments\(\)/);
  assert.match(recovery, /investment\.status === "ACTIVE"/);
  assert.match(recovery, /deriveTradeLifecycle\(trade\) !== "CLOSED"/);
  assert.match(recovery, /assessClosedTradeInvestmentRecovery/);
  assert.match(recovery, /await settleTradeInvestment\(/);
  assert.ok(recovery.indexOf("await settleTradeInvestment(") < recovery.indexOf("handleRecoveredSettlement"));
  assert.match(recovery, /Recovered trade Telegram notification failed/);
  assert.match(recovery, /INVESTMENT_RECONCILIATION_REVIEW_REQUIRED/);
  assert.match(recovery, /catch \(error\)/);
});

test("canonical settlement remains atomic scoped idempotent and notification-after-durability", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const settlement = server.slice(
    server.indexOf("async function settleTradeInvestment"),
    server.indexOf("async function settleInactiveTradeInvestmentsForUsers")
  );
  assert.match(settlement, /withUserFinancialLock\(user\.id/);
  assert.match(settlement, /`trade-settlement:\$\{currentInvestment\.id\}`/);
  assert.match(settlement, /existingTransaction/);
  assert.match(settlement, /fields: \["meta", "tradeInvestments", "wallets", "transactions"\]/);
  assert.doesNotMatch(settlement, /fields:.*users/);
  assert.ok(settlement.indexOf("await persist({") < settlement.indexOf("financialService.createNotification"));
});

test("required persistence failure still freezes financial integrity", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const persistence = server.slice(server.indexOf("function persist("), server.indexOf("function markRequestDurableMutation"));
  assert.match(persistence, /if \(durabilityRequired\)/);
  assert.match(persistence, /financialIntegrity\.freeze/);
  assert.match(persistence, /throw error/);
});
