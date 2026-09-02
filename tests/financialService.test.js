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

test("deposit approval credits once and submission does not change balance", () => {
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
  assert.equal(deposit.displayAmounts.USDT, "3.125");
  assert.equal(deposit.displayAmounts.NGN, "5000");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");

  service.approveDeposit(admin, deposit.id);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7500");
  assert.equal(service.getDashboard(user).totalBalance.usdt, "4.6875");
  assert.equal(service.getDashboard(user).totalBalance.ngnEquivalent, "7500");
});

test("admin rate setting drives deposit equivalents", () => {
  const { admin, service, user } = createHarness();
  const settings = service.updateSettings(admin, {
    exchangeRate: {
      usdtToNgn: "1500",
    },
  });

  const deposit = service.createDeposit(user, {
    amount: "3000",
    currency: "NGN",
    transactionHash: "bank-ref-rate",
  });

  assert.equal(settings.exchangeRate.usdtToNgn, "1500");
  assert.equal(deposit.exchangeRate, "1500");
  assert.equal(deposit.displayAmounts.USDT, "2");
  assert.equal(deposit.displayAmounts.NGN, "3000");
});

test("rejected pending deposit does not credit wallet", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const deposit = service.createDeposit(user, { amount: "25", currency: "USDT", transactionHash: "0xreject-credit" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");

  service.rejectDeposit(admin, deposit.id);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");
  assert.equal(service.getDashboard(user).walletHistory.find((item) => item.id === deposit.id).status, "REJECTED");
});

test("wallet history includes deposit and withdrawal request statuses", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const approvedDeposit = service.createDeposit(user, { amount: "10", currency: "USDT", transactionHash: "0xok" });
  service.approveDeposit(admin, approvedDeposit.id);
  const rejectedDeposit = service.createDeposit(user, { amount: "12", currency: "USDT", transactionHash: "0xreject" });
  service.rejectDeposit(admin, rejectedDeposit.id);
  const pendingWithdrawal = service.createWithdrawal(user, {
    amount: "5",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  const history = service.getDashboard(user).walletHistory;
  assert.ok(history.some((item) => item.id === approvedDeposit.id && item.kind === "DEPOSIT" && item.status === "APPROVED"));
  assert.ok(history.some((item) => item.id === rejectedDeposit.id && item.kind === "DEPOSIT" && item.status === "REJECTED"));
  assert.ok(history.some((item) => item.id === pendingWithdrawal.id && item.kind === "WITHDRAWAL" && item.status === "PENDING"));
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

test("USDT withdrawal accepts wallet aliases and configured network", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");
  service.updateSettings(admin, {
    deposit: {
      usdtNetwork: "TRC20",
    },
  });

  const withdrawal = service.createWithdrawal(user, {
    amount: "20",
    currency: "USDT",
    destination: {
      walletAddress: "TUserWalletAddress",
    },
  });

  assert.equal(withdrawal.destination.address, "TUserWalletAddress");
  assert.equal(withdrawal.destination.network, "TRC20");
});

test("NGN withdrawal accepts account aliases and formatted account number", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "25000");

  const withdrawal = service.createWithdrawal(user, {
    amount: "12000",
    currency: "NGN",
    destination: {
      bank: "Test Bank",
      accountHolderName: "Ada User",
      accountNo: "123-456 7890",
    },
  });

  assert.equal(withdrawal.destination.bankName, "Test Bank");
  assert.equal(withdrawal.destination.accountName, "Ada User");
  assert.equal(withdrawal.destination.accountNumber, "1234567890");
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

test("mirrored pnl overlay dynamically adjusts unified user balance", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "10");
  setWallet(service, user.id, "NGN", "16000");

  const dashboard = service.getDashboard(user);
  const mirrored = service.applyMirroredPnlToDashboard(dashboard, {
    todayPnlPercent: "5",
    source: "ADMIN_BYBIT",
  });

  assert.equal(dashboard.totalBalance.usdt, "20");
  assert.equal(mirrored.totalBalance.baseUsdt, "20");
  assert.equal(mirrored.totalBalance.usdt, "20");
  assert.equal(mirrored.totalBalance.liveUsdt, "20");
  assert.equal(mirrored.performance.todayUsdt, "0");
  assert.equal(mirrored.performance.todayPercentage, "0");
});

test("mirrored pnl overlay derives percentage from admin amount and capital base", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "50");

  const mirrored = service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "0",
    todayPnlValue: "8",
    todayCapitalBase: "200",
    source: "ADMIN_BYBIT",
  });

  assert.equal(mirrored.performance.todayUsdt, "0");
  assert.equal(mirrored.performance.todayPercentage, "0");
  assert.equal(mirrored.mirrorPnl.adminPercent, "4");
  assert.equal(mirrored.totalBalance.usdt, "50");
});

test("approved deposit remains idle until user joins a trade", () => {
  const { admin, service, user } = createHarness();

  const deposit = service.createDeposit(user, { amount: "100", currency: "USDT", transactionHash: "0xbaseline" });
  service.approveDeposit(admin, deposit.id);

  const mirrored = service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "0",
    todayLabel: "2026-08-30",
    source: "ADMIN_BYBIT",
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");
  assert.equal(mirrored.performance.todayUsdt, "0");
  assert.equal(mirrored.performance.todayPercentage, "0");
  assert.equal(mirrored.totalBalance.liveUsdt, "100");
});

test("new topup adds to idle wallet balance without automatic pnl", () => {
  const { admin, service, user } = createHarness();

  const firstDeposit = service.createDeposit(user, { amount: "100", currency: "USDT", transactionHash: "0xfirst" });
  service.approveDeposit(admin, firstDeposit.id);
  const secondDeposit = service.createDeposit(user, { amount: "100", currency: "USDT", transactionHash: "0xsecond" });
  service.approveDeposit(admin, secondDeposit.id);

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "200");
  const mirrored = service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "2",
    todayLabel: "2026-08-30",
  });
  assert.equal(mirrored.performance.todayUsdt, "0");
  assert.equal(mirrored.totalBalance.liveUsdt, "200");
});

test("withdrawal is blocked while user has an active trade investment", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");
  service.db.tradeInvestments.push({
    id: "investment-1",
    userId: user.id,
    tradeId: "trade-1",
    amountUsdt: "50",
    baselinePnlPercent: "0",
    status: "ACTIVE",
    joinedAt: "2026-08-30T10:00:00.000Z",
  });

  assert.throws(() => service.createWithdrawal(user, {
    amount: "100000",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  }), /stop active trades/i);
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

test("NGN withdrawal can reserve USDT equivalent when naira wallet is short", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "8000");
  setWallet(service, user.id, "USDT", "10");

  const withdrawal = service.createWithdrawal(user, {
    amount: "16000",
    currency: "NGN",
    destination: {
      bankName: "Test Bank",
      accountName: "Ada User",
      accountNumber: "1234567890",
    },
  });

  assert.deepEqual(withdrawal.fundingSources, [
    { currency: "NGN", amount: "8000" },
    { currency: "USDT", amount: "5" },
  ]);
  assert.equal(withdrawal.displayAmounts.USDT, "10");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "8000");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "5");
});

test("notification can be marked as read by owner", () => {
  const { service, user } = createHarness();
  const notification = service.createNotification({
    userId: user.id,
    type: "MESSAGE",
    title: "Hello",
    message: "Check support.",
  });

  const read = service.markNotificationRead(user, notification.id);
  assert.ok(read.readAt);
  assert.equal(service.listNotifications(user)[0].readAt, read.readAt);
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
