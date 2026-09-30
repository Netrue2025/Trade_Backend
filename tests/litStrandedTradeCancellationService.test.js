"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  TARGET_TRADE_ID,
  LitStrandedTradeCancellationService,
} = require("../services/litStrandedTradeCancellationService");

function fixture({ secondUser = false, settlement = false, symbol = "LITUSDT" } = {}) {
  const db = {
    tradeIntents: [{ id: TARGET_TRADE_ID, symbol, status: "OPEN", side: "BUY", adminExecution: { status: "FILLED" } }],
    tradeInvestments: [
      { id: "investment-one", userId: "user-one", tradeId: TARGET_TRADE_ID, amountUsdt: "100", fundingSources: [{ currency: "NGN", amount: "150000" }, { currency: "USDT", amount: "10" }], status: "ACTIVE", settledPnlUsdt: "0" },
      ...(secondUser ? [{ id: "investment-two", userId: "user-two", tradeId: TARGET_TRADE_ID, amountUsdt: "5", fundingSources: [{ currency: "USDT", amount: "5" }], status: "ACTIVE" }] : []),
    ],
    wallets: [
      { userId: "user-one", currency: "NGN", availableBalance: "500", lockedBalance: "150100" },
      { userId: "user-one", currency: "USDT", availableBalance: "20", lockedBalance: "12" },
      ...(secondUser ? [{ userId: "user-two", currency: "USDT", availableBalance: "2", lockedBalance: "5" }] : []),
    ],
    transactions: [
      { id: "join-ngn", userId: "user-one", type: "TRADE_INVESTMENT_LOCK", currency: "NGN", amount: "-150000", reference: "investment-one", status: "APPROVED" },
      { id: "join-usdt", userId: "user-one", type: "TRADE_INVESTMENT_LOCK", currency: "USDT", amount: "-10", reference: "investment-one", status: "APPROVED" },
      ...(secondUser ? [{ id: "join-two", userId: "user-two", type: "TRADE_INVESTMENT_LOCK", currency: "USDT", amount: "-5", reference: "investment-two", status: "APPROVED" }] : []),
      ...(settlement ? [{ id: "settled", type: "TRADE_SETTLEMENT", reference: "trade-settlement:investment-one", status: "APPROVED" }] : []),
    ],
  };
  const mutations = [];
  const service = new LitStrandedTradeCancellationService({
    db,
    withUserFinancialLock: async (_id, operation) => operation(),
    persist: async (options) => { mutations.push({ kind: "persist", options }); },
    markFinancialMutation: (...args) => mutations.push({ kind: "financial", args }),
    idGenerator: () => `generated-${mutations.length}`,
    clock: () => "2026-09-30T00:00:00.000Z",
  });
  return { db, service, mutations };
}

test("dry-run is the read-only default and reports exact principal-only deltas", () => {
  const { db, service, mutations } = fixture();
  const before = structuredClone(db);
  const report = service.inspect();
  assert.equal(report.mode, "dry-run");
  assert.equal(report.safeToExecute, true);
  assert.equal(report.reversibleInvestments, 1);
  assert.equal(report.investments[0].joinEvidence, true);
  assert.deepEqual(report.aggregates, { NGN: "150000", USDT: "10" });
  assert.deepEqual(report.availableIncrease, report.aggregates);
  assert.deepEqual(report.lockedDecrease, { NGN: "-150000", USDT: "-10" });
  assert.equal(report.pnl, "0");
  assert.equal(report.fee, "0");
  assert.equal(report.economicValueCreated, "0");
  assert.equal(report.dryRunMutations, 0);
  assert.deepEqual(db, before);
  assert.deepEqual(mutations, []);
});

test("execution restores NGN and USDT principal, preserves unrelated locks, and creates no P&L or fee", async () => {
  const { db, service, mutations } = fixture();
  const result = await service.execute({ id: "admin", role: "admin" });
  assert.equal(result.status, "CANCELLED");
  assert.equal(db.wallets.find((wallet) => wallet.currency === "NGN").availableBalance, "150500");
  assert.equal(db.wallets.find((wallet) => wallet.currency === "NGN").lockedBalance, "100");
  assert.equal(db.wallets.find((wallet) => wallet.currency === "USDT").availableBalance, "30");
  assert.equal(db.wallets.find((wallet) => wallet.currency === "USDT").lockedBalance, "2");
  assert.equal(db.tradeInvestments[0].status, "STOPPED");
  assert.equal(db.tradeInvestments[0].settledPnlUsdt, "0");
  const cancellation = db.transactions.filter((item) => item.type === "TRADE_CANCELLATION");
  assert.equal(cancellation.length, 1);
  assert.equal(cancellation[0].metadata.pnl, "0");
  assert.equal(cancellation[0].metadata.fee, "0");
  assert.deepEqual(mutations.filter((item) => item.kind === "persist")[0].options.fields, ["meta", "tradeIntents", "tradeInvestments", "wallets", "transactions"]);
});

test("multiple users reverse independently and second execution has zero financial delta", async () => {
  const { db, service } = fixture({ secondUser: true });
  assert.equal((await service.execute({ id: "admin", role: "admin" })).status, "CANCELLED");
  const before = structuredClone(db);
  const second = await service.execute({ id: "admin", role: "admin" });
  assert.equal(second.status, "ALREADY_CANCELLED");
  assert.deepEqual(db.wallets, before.wallets);
  assert.deepEqual(db.transactions, before.transactions);
  assert.equal(db.transactions.filter((item) => item.type === "TRADE_CANCELLATION").length, 2);
  assert.equal(db.tradeInvestments.filter((item) => item.status === "ACTIVE").length, 0);
});

test("preflight aggregates same-user lock requirements before declaring investments reversible", () => {
  const { db, service } = fixture();
  db.tradeInvestments.push({ id: "investment-one-b", userId: "user-one", tradeId: TARGET_TRADE_ID, amountUsdt: "90", fundingSources: [{ currency: "USDT", amount: "9" }], status: "ACTIVE" });
  db.transactions.push({ id: "join-usdt-b", userId: "user-one", type: "TRADE_INVESTMENT_LOCK", currency: "USDT", amount: "-9", reference: "investment-one-b", status: "APPROVED" });
  db.wallets.find((wallet) => wallet.userId === "user-one" && wallet.currency === "USDT").lockedBalance = "12";
  const report = service.inspect();
  assert.equal(report.safeToExecute, false);
  assert.equal(report.investments.find((item) => item.investmentId === "investment-one-b").blocker, "INSUFFICIENT_AGGREGATE_LOCK_USDT");
  assert.equal(report.blockedInvestments, 2);
});

test("non-admin, wrong symbol, and already-settled state fail closed", async () => {
  const auth = fixture();
  await assert.rejects(auth.service.execute({ id: "user", role: "user" }), /Admin authorization/);
  const wrong = fixture({ symbol: "OTHERUSDT" });
  assert.equal(wrong.service.inspect().safeToExecute, false);
  assert.equal((await wrong.service.execute({ id: "admin", role: "admin" })).status, "BLOCKED");
  const settled = fixture({ settlement: true });
  assert.equal(settled.service.inspect().investments[0].blocker, "SETTLEMENT_ALREADY_EXISTS");
  assert.equal((await settled.service.execute({ id: "admin", role: "admin" })).status, "BLOCKED");
  assert.equal(settled.db.wallets[0].availableBalance, "500");
});

test("targeted route is authenticated, defaults to dry-run, and cancellation is terminal without exchange actions", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /url\.pathname === "\/api\/admin\/recovery\/lit-stranded-trade-cancellation"[\s\S]*?requireAuth\(req, res, "admin"\)/);
  assert.match(server, /String\(body\.mode \|\| "dry-run"\)/);
  assert.match(server, /trade\?\.strandedCancellation\?\.reason === LIT_RECOVERY_CANCELLATION_REASON\) return "CANCELED"/);
  const service = fs.readFileSync(path.join(__dirname, "..", "services", "litStrandedTradeCancellationService.js"), "utf8");
  assert.match(service, /const TARGET_TRADE_ID = "644b8224bae460fb10bb134f"/);
  assert.match(service, /const TARGET_SYMBOL = "LITUSDT"/);
  assert.doesNotMatch(service, /createOrder|marketSell|marketBuy|cancelOrder|stopTrade|modifyTakeProfit/i);
});
