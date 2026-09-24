const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createUserFinancialLock, FinancialIntegrityState } = require("../lib/financialIntegrity");
const { AdminBonusReversalService, EXECUTION_ACTION } = require("../services/adminBonusReversalService");

function createHarness({ amount = "0.33", available = amount, locked = "0", currency = "USDT", persistFailure = false, notificationFailure = false } = {}) {
  let id = 0;
  const persistenceCalls = [];
  const notifications = [];
  const integrity = new FinancialIntegrityState();
  integrity.registerAuthoritativeState();
  const db = {
    meta: { stateRevision: 0 },
    users: [{ id: "admin-1", role: "admin" }, { id: "user-1", role: "user" }],
    wallets: [
      { id: "usdt-wallet", userId: "user-1", currency: "USDT", availableBalance: available, lockedBalance: locked, revision: 0 },
      { id: "ngn-wallet", userId: "user-1", currency: "NGN", availableBalance: "5000", lockedBalance: "200", revision: 0 },
    ],
    transactions: [
      { id: "bonus-1", userId: "user-1", type: "BONUS", currency, amount, balanceBefore: "0", balanceAfter: amount, reference: "bonus-ref", status: "APPROVED", description: "Bonus", createdBy: "admin-1", createdAt: "2026-09-24T13:00:00.000Z" },
      { id: "later-1", userId: "user-1", type: "GIFT_CARD", currency: "NGN", amount: "100", reference: "later-ref", status: "APPROVED", createdAt: "2026-09-24T14:00:00.000Z" },
    ],
  };
  const persist = async (options) => {
    persistenceCalls.push(options);
    if (persistFailure && options.required) {
      integrity.freeze("forced bonus reversal persistence failure", options.operation);
      throw new Error("forced bonus reversal persistence failure");
    }
  };
  const service = new AdminBonusReversalService({
    db,
    withUserFinancialLock: async (userId, operation) => {
      integrity.assertWritable();
      return lock(userId, operation);
    },
    persist,
    markFinancialMutation: (wallet) => {
      wallet.revision += 1;
      db.meta.stateRevision += 1;
    },
    createNotification: (notification) => {
      if (notificationFailure) throw new Error("notification unavailable");
      notifications.push(notification);
    },
    idGenerator: () => `id-${++id}`,
    clock: () => "2026-09-24T15:00:00.000Z",
  });
  const lock = createUserFinancialLock();
  return { db, integrity, notifications, persistenceCalls, service };
}

test("dry-run is default, authoritative, and performs no writes", () => {
  const { db, persistenceCalls, service } = createHarness();
  const before = structuredClone(db);
  const result = service.inspect("bonus-ref");
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.eligible, true);
  assert.equal(result.proposedDelta, "-0.33");
  assert.equal(result.expectedAvailableBalance, "0");
  assert.deepEqual(db, before);
  assert.equal(persistenceCalls.length, 0);
});

for (const amount of ["0.33", "0.74"]) {
  test(`exact ${amount} bonus reversal preserves original and unrelated state`, async () => {
    const { db, notifications, persistenceCalls, service } = createHarness({ amount });
    const usersBefore = structuredClone(db.users);
    const ngnBefore = structuredClone(db.wallets[1]);
    const laterBefore = structuredClone(db.transactions[1]);
    const result = await service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION });
    assert.equal(result.status, "REVERSED");
    assert.equal(db.wallets[0].availableBalance, "0");
    assert.equal(db.wallets[0].lockedBalance, "0");
    assert.equal(result.transaction.amount, `-${amount}`);
    assert.equal(result.transaction.reference, "admin-bonus-reversal:bonus-ref");
    assert.equal(result.transaction.balanceBefore, amount);
    assert.equal(result.transaction.balanceAfter, "0");
    assert.equal(db.transactions.find((item) => item.reference === "bonus-ref").amount, amount);
    assert.deepEqual(db.wallets[1], ngnBefore);
    assert.deepEqual(db.transactions.find((item) => item.id === "later-1"), laterBefore);
    assert.deepEqual(db.users, usersBefore);
    assert.deepEqual(persistenceCalls[0].fields, ["meta", "wallets", "transactions"]);
    assert.equal(notifications.length, 1);
  });
}

test("amount and user are derived from the original bonus", async () => {
  const { db, service } = createHarness();
  const result = await service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION, amount: "99", userId: "other" });
  assert.equal(result.transaction.userId, "user-1");
  assert.equal(result.transaction.amount, "-0.33");
});

test("non-bonus, non-admin-created, and NGN transactions are rejected", () => {
  const first = createHarness();
  first.db.transactions[0].type = "DEPOSIT";
  assert.throws(() => first.service.inspect("bonus-ref"), /not an approved admin bonus/);
  const second = createHarness();
  second.db.transactions[0].createdBy = "user-1";
  assert.throws(() => second.service.inspect("bonus-ref"), /not an approved admin bonus/);
  assert.throws(() => createHarness({ currency: "NGN" }).service.inspect("bonus-ref"), /Only USDT/);
});

test("insufficient available balance requires manual review without touching locked or NGN", async () => {
  const { db, persistenceCalls, service } = createHarness({ available: "0.32", locked: "4" });
  const walletsBefore = structuredClone(db.wallets);
  const result = await service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION });
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
  assert.deepEqual(db.wallets, walletsBefore);
  assert.equal(persistenceCalls.length, 0);
});

test("second and concurrent execution deduct exactly once", async () => {
  const { db, service } = createHarness();
  const [first, second] = await Promise.all([
    service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION }),
    service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["ALREADY_REVERSED", "REVERSED"]);
  assert.equal(db.wallets[0].availableBalance, "0");
  assert.equal(db.transactions.filter((item) => item.reference === "admin-bonus-reversal:bonus-ref").length, 1);
});

test("required persistence failure freezes and prevents success notification", async () => {
  const { db, integrity, notifications, service } = createHarness({ persistFailure: true });
  await assert.rejects(service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION }), /forced bonus reversal/);
  assert.equal(integrity.getStatus().persistenceFrozen, true);
  assert.equal(notifications.length, 0);
});

test("notification failure does not undo a durable reversal", async () => {
  const { db, service } = createHarness({ notificationFailure: true });
  const result = await service.execute(db.users[0], "bonus-ref", { action: EXECUTION_ACTION });
  assert.equal(result.status, "REVERSED");
  assert.equal(db.wallets[0].availableBalance, "0");
  assert.equal(db.transactions.filter((item) => item.type === "BONUS_REVERSAL").length, 1);
});

test("execution requires authenticated admin and exact explicit action", async () => {
  const { db, service } = createHarness();
  await assert.rejects(service.execute(db.users[1], "bonus-ref", { action: EXECUTION_ACTION }), /Admin authorization/);
  await assert.rejects(service.execute(db.users[0], "bonus-ref", {}), /Explicit action/);
  assert.equal(db.wallets[0].availableBalance, "0.33");
});

test("HTTP exposure is admin-only and dry-run unless exact execution action is supplied", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = server.indexOf('url.pathname === "/api/admin/bonus-reversals"');
  const route = server.slice(start, server.indexOf("const hideTradeMatch", start));
  assert.match(route, /requireAuth\(req, res, "admin"\)/);
  assert.match(route, /body\.action === BONUS_REVERSAL_EXECUTION_ACTION/);
  assert.match(route, /adminBonusReversalService\.inspect\(reference\)/);
});
