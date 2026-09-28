const assert = require("node:assert/strict");
const test = require("node:test");
const { createUserFinancialLock } = require("../lib/financialIntegrity");
const { ARX_TRADE_ID, ARX_INVESTMENT_IDS, EXECUTION_ACTION, releaseReference, ArxAbandonedPrincipalReleaseService } = require("../services/arxAbandonedPrincipalReleaseService");

function harness({ investmentId = ARX_INVESTMENT_IDS[0], tradeId = ARX_TRADE_ID, status = "ACTIVE", quarantined = true, existingRelease = false, existingSettlement = false, missingLock = false, insufficientLock = false } = {}) {
  let sequence = 0;
  const calls = [];
  const db = {
    meta: { stateRevision: 0 },
    systemSettings: { trading: { quarantinedTradeIds: quarantined ? [ARX_TRADE_ID] : [] } },
    users: [{ id: "admin", role: "admin" }, { id: "user", role: "user" }],
    wallets: [
      { id: "ngn", userId: "user", currency: "NGN", availableBalance: "10", lockedBalance: insufficientLock ? "99" : "100", revision: 0 },
      { id: "usdt", userId: "user", currency: "USDT", availableBalance: "2", lockedBalance: "1", revision: 0 },
      { id: "vtu", userId: "other", currency: "NGN", availableBalance: "0", lockedBalance: "500" },
    ],
    tradeIntents: [{ id: ARX_TRADE_ID, symbol: "ARXUSDT" }],
    tradeInvestments: [{ id: investmentId, userId: "user", tradeId, status, amountUsdt: "1.077", fundingSources: [{ currency: "NGN", amount: "100" }, { currency: "USDT", amount: "1" }] }],
    transactions: [],
    idempotencyKeys: [],
  };
  for (const source of db.tradeInvestments[0].fundingSources) {
    if (!missingLock) db.transactions.push({ id: `lock-${source.currency}`, userId: "user", type: "TRADE_INVESTMENT_LOCK", currency: source.currency, amount: `-${source.amount}`, reference: investmentId, status: "APPROVED" });
  }
  if (existingSettlement) db.transactions.push({ id: "settlement", userId: "user", type: "TRADING_PROFIT", currency: "USDT", amount: "1", reference: `trade-settlement:${investmentId}`, status: "APPROVED" });
  if (existingRelease) db.transactions.push({ id: "release", userId: "user", type: "ABANDONED_TRADE_PRINCIPAL_RELEASE", currency: "NGN", amount: "100", reference: releaseReference(investmentId), status: "APPROVED" });
  const service = new ArxAbandonedPrincipalReleaseService({
    db,
    withUserFinancialLock: createUserFinancialLock(),
    persist: async (options) => calls.push(options),
    markFinancialMutation: (wallet) => { wallet.revision += 1; db.meta.stateRevision += 1; },
    idGenerator: () => `id-${++sequence}`,
    clock: () => "2026-09-28T10:00:00.000Z",
  });
  return { db, calls, service };
}

test("only the three explicit ARX investments are eligible and dry run changes nothing", () => {
  for (const id of ARX_INVESTMENT_IDS) {
    const { db, calls, service } = harness({ investmentId: id });
    const before = structuredClone(db);
    const preview = service.inspect(id);
    assert.equal(preview.eligible, true);
    assert.deepEqual(db, before);
    assert.equal(calls.length, 0);
  }
  assert.throws(() => harness().service.inspect("b0002ec3b525ec6de7d69a12"), /allowlisted/);
});

test("wrong trade, settled, missing lock, and insufficient or mixed lock are rejected", () => {
  assert.throws(() => harness({ tradeId: "other" }).service.inspect(ARX_INVESTMENT_IDS[0]), /does not belong/);
  for (const options of [{ status: "STOPPED" }, { existingSettlement: true }, { missingLock: true }, { insufficientLock: true }]) {
    assert.equal(harness(options).service.inspect(ARX_INVESTMENT_IDS[0]).eligible, false);
  }
  const mixed = harness();
  mixed.db.wallets[0].lockedBalance = "600";
  assert.equal(mixed.service.inspect(ARX_INVESTMENT_IDS[0]).eligible, false);
});

test("principal release restores only exact source balances and leaves unrelated locks untouched", async () => {
  const { db, calls, service } = harness();
  const result = await service.execute(db.users[0], ARX_INVESTMENT_IDS[0], { action: EXECUTION_ACTION });
  assert.equal(result.status, "RELEASED");
  assert.equal(db.wallets[0].availableBalance, "110");
  assert.equal(db.wallets[0].lockedBalance, "0");
  assert.equal(db.wallets[1].availableBalance, "3");
  assert.equal(db.wallets[1].lockedBalance, "0");
  assert.equal(db.wallets[2].lockedBalance, "500");
  assert.equal(db.tradeInvestments[0].status, "STOPPED");
  assert.equal(db.transactions.filter((item) => item.reference === releaseReference(ARX_INVESTMENT_IDS[0])).length, 1);
  assert.deepEqual(db.transactions[0].metadata.releasedSources.map(({ currency, amount }) => ({ currency, amount })), [{ currency: "NGN", amount: "100" }, { currency: "USDT", amount: "1" }]);
  assert.deepEqual(calls[0].fields, ["meta", "wallets", "transactions", "tradeInvestments", "idempotencyKeys"]);
});

test("duplicate reference and retry cannot create additional value", async () => {
  const { db, service } = harness();
  await service.execute(db.users[0], ARX_INVESTMENT_IDS[0], { action: EXECUTION_ACTION });
  const afterFirst = structuredClone(db.wallets);
  const retry = await service.execute(db.users[0], ARX_INVESTMENT_IDS[0], { action: EXECUTION_ACTION });
  assert.equal(retry.status, "ALREADY_RELEASED");
  assert.deepEqual(db.wallets, afterFirst);
  assert.equal(db.transactions.filter((item) => item.reference === releaseReference(ARX_INVESTMENT_IDS[0])).length, 1);
});

test("concurrent execution has one release and no duplicate wallet movement", async () => {
  const { db, service } = harness();
  const [first, second] = await Promise.all([
    service.execute(db.users[0], ARX_INVESTMENT_IDS[0], { action: EXECUTION_ACTION }),
    service.execute(db.users[0], ARX_INVESTMENT_IDS[0], { action: EXECUTION_ACTION }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["ALREADY_RELEASED", "RELEASED"]);
  assert.equal(db.wallets[0].availableBalance, "110");
  assert.equal(db.wallets[1].availableBalance, "3");
  assert.equal(db.transactions.filter((item) => item.reference === releaseReference(ARX_INVESTMENT_IDS[0])).length, 1);
});

test("execution requires an admin and exact action, and uses no market dependency", async () => {
  const { db, service } = harness();
  await assert.rejects(service.execute(db.users[1], ARX_INVESTMENT_IDS[0], { action: EXECUTION_ACTION }), /Admin authorization/);
  await assert.rejects(service.execute(db.users[0], ARX_INVESTMENT_IDS[0], {}), /Explicit action/);
  assert.equal(service.inspect(ARX_INVESTMENT_IDS[0]).exchangeCalls, 0);
});
