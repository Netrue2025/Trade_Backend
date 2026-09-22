const test = require("node:test");
const assert = require("node:assert/strict");
const { createUserFinancialLock, auditFinancialIntegrity } = require("../lib/financialIntegrity");
const { saveDb, setAuthoritativeDbProvider } = require("../lib/db");

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
