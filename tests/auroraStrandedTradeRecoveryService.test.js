"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AuroraStrandedTradeRecoveryService,
  TARGET_TRADE_ID,
  EXECUTION_ACTION,
} = require("../services/auroraStrandedTradeRecoveryService");

function fixture({ settlement = false, secondInvestment = false, settledHistory = false } = {}) {
  const db = {
    tradeIntents: [{ id: TARGET_TRADE_ID, symbol: "AURORAUSDT", status: "OPEN", side: "BUY", adminExecution: { status: "FILLED" }, exitOrders: [{ adminExecution: { status: "FILLED", executedQty: "19412.59" } }] }],
    tradeInvestments: [{ id: "aurora-investment", tradeId: TARGET_TRADE_ID, userId: "user-1", status: "ACTIVE", fundingSources: [{ currency: "USDT", amount: "25" }], settledPnlUsdt: "0" },
      ...(secondInvestment ? [{ id: "other-investment", tradeId: TARGET_TRADE_ID, userId: "user-2", status: "ACTIVE", fundingSources: [{ currency: "USDT", amount: "5" }] }] : []),
      ...(settledHistory ? [{ id: "old-settled-one", tradeId: TARGET_TRADE_ID, userId: "old-user", status: "STOPPED", fundingSources: [{ currency: "NGN", amount: "1000" }] }, { id: "old-settled-two", tradeId: TARGET_TRADE_ID, userId: "old-user-2", status: "STOPPED", fundingSources: [{ currency: "NGN", amount: "2000" }] }] : [])],
    wallets: [{ userId: "user-1", currency: "USDT", availableBalance: "75", lockedBalance: "25" },
      ...(secondInvestment ? [{ userId: "user-2", currency: "USDT", availableBalance: "5", lockedBalance: "5" }] : [])],
    transactions: [{ id: "join-1", userId: "user-1", type: "TRADE_INVESTMENT_LOCK", currency: "USDT", amount: "-25", reference: "aurora-investment", status: "APPROVED" },
      ...(secondInvestment ? [{ id: "join-2", userId: "user-2", type: "TRADE_INVESTMENT_LOCK", currency: "USDT", amount: "-5", reference: "other-investment", status: "APPROVED" }] : []),
      ...(settledHistory ? [
        { id: "old-join-1", type: "TRADE_INVESTMENT_LOCK", currency: "NGN", amount: "-1000", reference: "old-settled-one", status: "APPROVED" },
        { id: "old-settlement-1", type: "TRADE_SETTLEMENT", reference: "trade-settlement:old-settled-one", status: "APPROVED" },
        { id: "old-join-2", type: "TRADE_INVESTMENT_LOCK", currency: "NGN", amount: "-2000", reference: "old-settled-two", status: "APPROVED" },
        { id: "old-settlement-2", type: "TRADE_SETTLEMENT", reference: "trade-settlement:old-settled-two", status: "APPROVED" },
      ] : []),
      ...(settlement ? [{ id: "settlement-1", type: "TRADE_SETTLEMENT", reference: "trade-settlement:aurora-investment", status: "APPROVED" }] : [])],
    systemSettings: { trading: { quarantinedTradeIds: [] } },
  };
  const events = [];
  const service = new AuroraStrandedTradeRecoveryService({
    db,
    withUserFinancialLock: async (_userId, operation) => operation(),
    persist: async (options) => events.push({ type: "persist", options }),
    markFinancialMutation: (...args) => events.push({ type: "mutation", args }),
    idGenerator: () => "generated-id",
    clock: () => "2026-10-02T00:00:00.000Z",
  });
  return { db, service, events };
}

test("AURORA recovery dry-run is read-only and previews exact principal release", () => {
  const { db, service, events } = fixture();
  const before = structuredClone(db);
  const report = service.inspect();
  assert.equal(report.safeToExecute, true);
  assert.equal(report.principalOnly, true);
  assert.equal(report.pnl, "0");
  assert.equal(report.fee, "0");
  assert.deepEqual(report.investments[0].sources.USDT, { principal: "25", available: "75", locked: "25" });
  assert.deepEqual(db, before);
  assert.deepEqual(events, []);
});

test("recovery requires admin, explicit exchange confirmation, and exact principal-only action", async () => {
  const { service, db, events } = fixture();
  await assert.rejects(service.execute({ id: "user", role: "user" }, { action: EXECUTION_ACTION, confirmExchangeClosed: true }), /Admin authorization/);
  await assert.rejects(service.execute({ id: "admin", role: "admin" }, { action: EXECUTION_ACTION }), /Explicit principal-only/);
  assert.equal(db.wallets[0].availableBalance, "75");
  assert.deepEqual(events, []);
});

test("execution restores original principal exactly once and quarantines the target trade", async () => {
  const { db, service, events } = fixture();
  const result = await service.execute({ id: "admin", role: "admin" }, { action: EXECUTION_ACTION, confirmExchangeClosed: true });
  assert.equal(result.status, "RECOVERED");
  assert.equal(db.wallets[0].availableBalance, "100");
  assert.equal(db.wallets[0].lockedBalance, "0");
  assert.equal(db.tradeInvestments[0].status, "STOPPED");
  assert.equal(db.tradeIntents[0].strandedRecovery.reason, "STRANDED_AURORA_TRADE_PRINCIPAL_RESTORED");
  assert.equal(db.systemSettings.trading.quarantinedTradeIds.includes(TARGET_TRADE_ID), true);
  const recovery = db.transactions.filter((item) => item.type === "TRADE_CANCELLATION");
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].amount, "25");
  assert.equal(recovery[0].metadata.pnl, "0");
  assert.equal(recovery[0].metadata.fee, "0");
  assert.deepEqual(events.filter((item) => item.type === "persist")[0].options.fields, ["meta", "tradeIntents", "tradeInvestments", "wallets", "transactions"]);
  const beforeRepeat = structuredClone(db);
  assert.equal((await service.execute({ id: "admin", role: "admin" }, { action: EXECUTION_ACTION, confirmExchangeClosed: true })).status, "ALREADY_RECOVERED");
  assert.deepEqual(db, beforeRepeat);
});

test("settled historical investments do not block or change the sole active principal recovery", async () => {
  const { db, service } = fixture({ settledHistory: true });
  const historicalBefore = structuredClone(db.tradeInvestments.slice(1));
  const historyTransactionsBefore = structuredClone(db.transactions.filter((item) => item.id.startsWith("old-")));
  const report = service.inspect();
  assert.equal(report.safeToExecute, true);
  assert.equal(report.investments.length, 3);
  assert.equal(report.investments.filter((item) => item.reversible).length, 1);
  assert.equal((await service.execute({ id: "admin", role: "admin" }, { action: EXECUTION_ACTION, confirmExchangeClosed: true })).status, "RECOVERED");
  assert.deepEqual(db.tradeInvestments.slice(1), historicalBefore);
  assert.deepEqual(db.transactions.filter((item) => item.id.startsWith("old-")), historyTransactionsBefore);
  assert.equal(db.transactions.filter((item) => item.type === "TRADE_CANCELLATION").length, 1);
});

test("recovery blocks multiple joiners, prior settlement, missing exit, and insufficient locks", () => {
  assert.equal(fixture({ secondInvestment: true }).service.inspect().blocker, "EXPECTED_EXACTLY_ONE_ACTIVE_INVESTMENT");
  assert.equal(fixture({ settlement: true }).service.inspect().investments[0].blocker, "SETTLEMENT_ALREADY_EXISTS");
  const missingExit = fixture();
  missingExit.db.tradeIntents[0].exitOrders = [];
  assert.equal(missingExit.service.inspect().blocker, "FILLED_EXIT_EVIDENCE_MISSING");
  const shortLock = fixture();
  shortLock.db.wallets[0].lockedBalance = "24";
  assert.equal(shortLock.service.inspect().investments[0].blocker, "INSUFFICIENT_LOCKED_USDT");
});

test("required persistence failure rolls back the in-memory principal release and recovery marker", async () => {
  const { db, service } = fixture();
  service.persist = async () => { throw new Error("durable save failed"); };
  await assert.rejects(service.execute({ id: "admin", role: "admin" }, { action: EXECUTION_ACTION, confirmExchangeClosed: true }), /durable save failed/);
  assert.equal(db.wallets[0].availableBalance, "75");
  assert.equal(db.wallets[0].lockedBalance, "25");
  assert.equal(db.tradeInvestments[0].status, "ACTIVE");
  assert.equal(db.tradeIntents[0].strandedRecovery, undefined);
  assert.equal(db.transactions.some((item) => item.type === "TRADE_CANCELLATION"), false);
  assert.equal(service.inspect().safeToExecute, true);
});

test("AURORA recovery endpoint is admin-only and defaults to dry-run", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /url\.pathname === "\/api\/admin\/recovery\/aurora-stranded-trade"[\s\S]*?requireAuth\(req, res, "admin"\)/);
  assert.match(server, /String\(body\.mode \|\| "dry-run"\)/);
  assert.match(server, /confirmExchangeClosed: body\.confirmExchangeClosed === true/);
  assert.match(server, /strandedRecovery\?\.reason === AURORA_RECOVERY_REASON\) return "CANCELED"/);
});
