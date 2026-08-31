const test = require("node:test");
const assert = require("node:assert/strict");

const { FinancialService } = require("../services/financialService");

function createHarness() {
  let id = 0;
  const db = {
    users: [
      {
        id: "admin-1",
        name: "Admin",
        email: "admin@example.com",
        role: "admin",
      },
      {
        id: "user-1",
        name: "Ada User",
        email: "ada@example.com",
        role: "user",
      },
    ],
  };
  const service = new FinancialService({
    db,
    persist: () => undefined,
    idGenerator: () => `id-${++id}`,
    clock: () => "2026-08-30T10:00:00.000Z",
  });
  service.ensureState();
  return {
    admin: db.users[0],
    db,
    service,
    user: db.users[1],
  };
}

function setWallet(service, userId, currency, availableBalance, lockedBalance = "0") {
  const wallet = service.ensureWallet(userId, currency);
  wallet.availableBalance = String(availableBalance);
  wallet.lockedBalance = String(lockedBalance);
  return wallet;
}

test("deposit approval credits once and second approval is rejected", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const deposit = service.createDeposit(user, { amount: "50", transactionHash: "0xabc" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");

  service.approveDeposit(admin, deposit.id);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "150");
  assert.throws(() => service.approveDeposit(admin, deposit.id), /no longer pending/i);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "150");
});

test("naira deposit approval credits NGN wallet", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "2500");

  const deposit = service.createDeposit(user, {
    amount: "5000",
    currency: "NGN",
    transactionHash: "bank-ref-1",
    depositorName: "Ada User",
  });

  assert.equal(deposit.currency, "NGN");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");

  service.approveDeposit(admin, deposit.id);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7500");
});

test("withdrawal completion reserves funds and clears locked balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const withdrawal = service.createWithdrawal(user, {
    amount: "20",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "80");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "20");

  service.completeWithdrawal(admin, withdrawal.id, { transactionHash: "0xdef" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "80");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "0");
});

test("withdrawal rejection refunds reserved funds", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const withdrawal = service.createWithdrawal(user, {
    amount: "20",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  service.rejectWithdrawal(admin, withdrawal.id, { adminNote: "Invalid destination" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "0");
});

test("daily performance compounds from current eligible balance and does not double apply", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const dayOne = service.createDailyPerformance(admin, {
    date: "2026-08-30",
    startingCapital: "2000",
    endingCapital: "2040",
  });
  const firstApply = service.applyDailyPerformance(admin, dayOne.id);
  assert.equal(firstApply.appliedCount, 1);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "102");
  assert.equal(service.getDashboard(user).performance.todayPercentage, "2");

  const duplicateApply = service.applyDailyPerformance(admin, dayOne.id);
  assert.equal(duplicateApply.appliedCount, 0);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "102");

  const dayTwo = service.createDailyPerformance(admin, {
    date: "2026-08-31",
    startingCapital: "2000",
    endingCapital: "1980",
  });
  const secondApply = service.applyDailyPerformance(admin, dayTwo.id);
  assert.equal(secondApply.appliedCount, 1);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100.98");
});

test("daily withdrawal limit is enforced", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  for (let index = 0; index < 2; index += 1) {
    service.createWithdrawal(user, {
      amount: "10",
      currency: "USDT",
      destination: {
        address: `TUserWalletAddress${index}`,
        network: "TRC20",
      },
    });
  }

  assert.throws(
    () =>
      service.createWithdrawal(user, {
        amount: "10",
        currency: "USDT",
        destination: {
          address: "TUserWalletAddress3",
          network: "TRC20",
        },
      }),
    /daily withdrawal limit/i
  );
});

test("admin bonus credits user wallet and creates notification", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "2500");

  const result = service.addBonus(admin, user.id, {
    currency: "NGN",
    amount: "7500",
    note: "Welcome bonus",
  });

  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "10000");
  assert.equal(result.transaction.type, "BONUS");
  assert.equal(result.profile.wallets.find((wallet) => wallet.currency === "NGN").availableBalance, "10000");
  assert.equal(service.listNotifications(user)[0].type, "BONUS");
});

test("admin can set a user balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "15");

  const result = service.setUserBalance(admin, user.id, {
    currency: "USDT",
    amount: "42",
    note: "Correction",
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "42");
  assert.equal(result.transaction.type, "BALANCE_ADJUSTMENT");
  assert.equal(result.transaction.amount, "27");
  assert.equal(service.listNotifications(user)[0].type, "BALANCE");
});

test("USDT withdrawal can reserve NGN equivalent when USDT wallet is short", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "5");
  setWallet(service, user.id, "NGN", "32000");

  const withdrawal = service.createWithdrawal(user, {
    amount: "25",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  assert.deepEqual(withdrawal.fundingSources, [
    { currency: "USDT", amount: "5" },
    { currency: "NGN", amount: "32000" },
  ]);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "0");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "5");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "0");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "32000");
});

test("admin can delete selected finance history records", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const deposit = service.createDeposit(user, { amount: "10", transactionHash: "0xabc" });
  service.approveDeposit(admin, deposit.id);
  const transactionId = service.getTransactions(user.id)[0].id;

  const result = service.deleteFinanceHistory(admin, {
    depositIds: [deposit.id],
    transactionIds: [transactionId],
  });

  assert.equal(result.deletedCount, 2);
  assert.equal(service.listDeposits(admin).some((item) => item.id === deposit.id), false);
  assert.equal(service.listTransactions(admin).some((item) => item.id === transactionId), false);
});
