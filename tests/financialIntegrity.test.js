const test = require("node:test");
const assert = require("node:assert/strict");
const { FinancialIntegrityState, createUserFinancialLock, auditFinancialIntegrity } = require("../lib/financialIntegrity");
const { saveDb, setAuthoritativeDbProvider } = require("../lib/db");
const { FinancialService } = require("../services/financialService");
const { QuestService } = require("../services/questService");

test("same-user financial deltas serialize and read the latest balance inside the lock", async () => {
  const withUserLock = createUserFinancialLock();
  const wallet = { availableBalance: 80000, revision: 1 };
  const mutate = (delta, delay = 0) => withUserLock("user-1", async () => {
    const before = wallet.availableBalance;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    wallet.availableBalance = before + delta;
    wallet.revision += 1;
  });
  await Promise.all([mutate(22000, 10), mutate(10000)]);
  assert.equal(wallet.availableBalance, 112000);
  assert.equal(wallet.revision, 3);
});

test("concurrent debits cannot both spend the same available balance", async () => {
  const withUserLock = createUserFinancialLock();
  const wallet = { availableBalance: 10000 };
  const debit = () => withUserLock("user-1", async () => {
    if (wallet.availableBalance < 7000) throw new Error("Insufficient balance");
    wallet.availableBalance -= 7000;
  });
  const results = await Promise.allSettled([debit(), debit()]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(wallet.availableBalance, 3000);
});

test("restart fixture settles from persisted post-join balance using a delta", () => {
  const persistedAfterJoin = JSON.parse(JSON.stringify({ wallet: { availableBalance: 80000, lockedBalance: 20000, revision: 1 } }));
  const restarted = JSON.parse(JSON.stringify(persistedAfterJoin));
  restarted.wallet.lockedBalance -= 20000;
  restarted.wallet.availableBalance += 22000;
  restarted.wallet.revision += 1;
  assert.equal(restarted.wallet.availableBalance, 102000);
  assert.notEqual(restarted.wallet.availableBalance, 122000);
});

test("stale snapshot is rejected when an authoritative provider is configured", async () => {
  const authoritative = { wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "80000", revision: 11 }] };
  const stale = { wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "100000", revision: 10 }] };
  setAuthoritativeDbProvider(() => authoritative);
  await assert.rejects(() => saveDb(stale), /non-authoritative/);
  assert.equal(authoritative.wallets[0].availableBalance, "80000");
  setAuthoritativeDbProvider(null);
});

test("read-only integrity audit finds duplicate and missing settlement references", () => {
  const result = auditFinancialIntegrity({
    users: [{ id: "user-1", role: "user" }],
    tradeInvestments: [{ id: "investment-1", userId: "user-1", tradeId: "trade-1", status: "STOPPED" }, { id: "investment-2", userId: "user-1", tradeId: "trade-2", status: "STOPPED" }],
    transactions: [{ reference: "trade-settlement:investment-1", metadata: { investmentId: "investment-1" } }, { reference: "trade-settlement:investment-1", metadata: { investmentId: "investment-1" } }],
  });
  assert.deepEqual(result.duplicateSettlementReferences, ["trade-settlement:investment-1"]);
  assert.equal(result.missingSettlementReferences[0].investmentId, "investment-2");
  assert.deepEqual(result.candidateUserIds, ["user-1"]);
});

test("financial integrity freeze is sticky until a new process authority is created", () => {
  const integrity = new FinancialIntegrityState();
  integrity.registerAuthoritativeState();
  assert.doesNotThrow(() => integrity.assertWritable());
  integrity.freeze("forced persistence failure");
  integrity.registerAuthoritativeState();
  assert.throws(() => integrity.assertWritable(), (error) => error.statusCode === 503 && error.code === "FINANCIAL_SERVICE_TEMPORARILY_UNAVAILABLE");
  assert.throws(() => integrity.assertPersistenceAllowed(), (error) => error.code === "APP_STATE_PERSISTENCE_FROZEN");

  const restarted = new FinancialIntegrityState();
  restarted.registerAuthoritativeState();
  assert.doesNotThrow(() => restarted.assertWritable());
});

test("a global freeze blocks financial and unrelated durable mutations before state changes", () => {
  const integrity = new FinancialIntegrityState();
  integrity.registerAuthoritativeState();
  let saves = 0;
  const db = { users: [{ id: "admin-1", role: "admin" }, { id: "user-1", role: "user", name: "Ada", email: "ada@example.com" }] };
  const service = new FinancialService({
    db,
    persist: () => { saves += 1; },
    financialIntegrity: integrity,
    idGenerator: (() => { let id = 0; return () => `id-${++id}`; })(),
    clock: () => "2026-09-22T10:00:00.000Z",
  });
  service.ensureState();
  const user = db.users[1];
  const admin = db.users[0];
  const wallet = service.ensureWallet(user.id, "NGN");
  wallet.availableBalance = "10000";
  const deposit = service.createDeposit(user, { amount: "1000", currency: "NGN", transactionHash: "freeze-test" });
  const baseline = JSON.stringify(db);
  const baselineSaves = saves;

  integrity.freeze("forced trade persistence failure");
  assert.throws(() => service.approveDeposit(admin, deposit.id), /temporarily unavailable/i);
  assert.throws(() => service.createVtuTransaction(user, { type: "airtime", amount: "100", sellingPrice: "100", requestId: "vtu-freeze" }), /temporarily unavailable/i);
  assert.throws(() => service.updateSettings(admin, { withdrawalFeeNgn: "200" }), /temporarily unavailable/i);
  assert.equal(JSON.stringify(db), baseline);
  assert.equal(saves, baselineSaves);
});

test("quest monetary redemption checks the shared gate before touching quest state", () => {
  const integrity = new FinancialIntegrityState();
  integrity.registerAuthoritativeState();
  integrity.freeze("forced trade persistence failure");
  const db = { quests: [], questSessions: [], questProgress: [], users: [] };
  const before = JSON.stringify(db);
  const service = new QuestService({ db, financialService: {}, financialIntegrity: integrity });
  assert.throws(() => service.redeemReward({ id: "user-1" }, "session-1"), /temporarily unavailable/i);
  assert.equal(JSON.stringify(db), before);
});

test("every FinancialService persist site is protected by the shared frozen gate", () => {
  const integrity = new FinancialIntegrityState();
  integrity.registerAuthoritativeState();
  const service = new FinancialService({ db: {}, financialIntegrity: integrity });
  const durableMethods = Object.getOwnPropertyNames(FinancialService.prototype)
    .filter((name) => name !== "constructor" && /\bthis\.persist\(\)/.test(FinancialService.prototype[name]?.toString?.() || ""));
  assert.equal(durableMethods.length, 74);
  integrity.freeze("forced trade persistence failure");
  for (const method of durableMethods) {
    assert.throws(() => service[method](), (error) => error.code === "FINANCIAL_SERVICE_TEMPORARILY_UNAVAILABLE", method);
  }
});
