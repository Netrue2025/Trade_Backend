const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { DigitalServicesService, extractDeliveryPayload, mapSupplierStatus } = require("../services/digitalServices.service");
const { FinancialService } = require("../services/financialService");
const { PaystackService, toKobo } = require("../services/paystackService");

function createHarness(options = {}) {
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
    notificationPublisher: options.notificationPublisher || null,
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

function setVerifiedBank(service, user) {
  return service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "1234567890",
    accountName: "ADA USER",
  });
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
    amount: "50",
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
    amount: "50",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "50");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "50");

  service.completeWithdrawal(admin, withdrawal.id, { transactionHash: "0xdef" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "50");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "0");
});

test("withdrawal rejection refunds reserved funds", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const withdrawal = service.createWithdrawal(user, {
    amount: "50",
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

test("active withdrawal blocks another withdrawal until it settles", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const withdrawal = service.createWithdrawal(user, {
    amount: "50",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "50");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "50");
  assert.throws(() => service.createWithdrawal(user, {
    amount: "50",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress2",
      network: "TRC20",
    },
  }), /already processing/i);

  service.rejectWithdrawal(admin, withdrawal.id, { adminNote: "Retry allowed" });
  const nextWithdrawal = service.createWithdrawal(user, {
    amount: "50",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress2",
      network: "TRC20",
    },
  });

  assert.equal(nextWithdrawal.status, "PENDING");
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "50");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "50");
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
    amount: "50",
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
  const bankAccount = setVerifiedBank(service, user);

  const withdrawal = service.createWithdrawal(user, {
    amount: "12000",
    currency: "NGN",
    bankAccountId: bankAccount.id,
  });

  assert.equal(withdrawal.destination.bankName, "Test Bank");
  assert.equal(withdrawal.destination.accountName, "ADA USER");
  assert.equal(withdrawal.destination.accountNumber, "1234567890");
  assert.equal(withdrawal.amountKobo, 1190000);
  assert.equal(withdrawal.status, "PENDING");
  assert.equal(withdrawal.balanceReserved, true);
});

test("NGN withdrawal reserves requested amount and pays net after fee", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "25000");
  const bankAccount = setVerifiedBank(service, user);

  const withdrawal = service.createWithdrawal(user, {
    amount: "1000",
    currency: "NGN",
    bankAccountId: bankAccount.id,
  });

  assert.equal(withdrawal.amount, "1000");
  assert.equal(withdrawal.requestedAmount, "1000");
  assert.equal(withdrawal.fee, "100");
  assert.equal(withdrawal.feeCurrency, "NGN");
  assert.equal(withdrawal.netAmount, "900");
  assert.equal(withdrawal.amountKobo, 90000);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "24000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "1000");
});

test("admin can set minimum trade join, withdrawal amounts, and NGN fee", () => {
  const { admin, service } = createHarness();

  const settings = service.updateSettings(admin, {
    withdrawal: {
      minNgn: "1500",
      minUsdt: "75",
      ngnFee: "100",
    },
    trading: {
      minJoinUsdt: "25",
    },
  });

  assert.equal(settings.withdrawal.minNgn, "1500");
  assert.equal(settings.withdrawal.minUsdt, "75");
  assert.equal(settings.withdrawal.ngnFee, "100");
  assert.equal(settings.trading.minJoinUsdt, "25");
});

test("NGN withdrawal accepts a verified one-time bank account", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "25000");

  const withdrawal = service.createWithdrawal(user, {
    amount: "12000",
    currency: "NGN",
    bankAccount: {
      bankName: "One Time Bank",
      bankCode: "011",
      accountNumber: "1234567890",
      accountName: "ADA USER",
      verified: true,
    },
  });

  assert.equal(withdrawal.destination.bankName, "One Time Bank");
  assert.equal(withdrawal.destination.accountNumber, "1234567890");
  assert.equal(user.bankAccount, undefined);
  assert.deepEqual(user.bankAccounts, []);
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

test("approved USDT deposit clears stale mirrored pnl lots", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");
  service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "0",
    todayLabel: "2026-08-30",
  });
  assert.equal(service.getUserPnlLots(user.id).length, 1);

  const deposit = service.createDeposit(user, { amount: "50", currency: "USDT", transactionHash: "0xtopup" });
  service.approveDeposit(admin, deposit.id);

  const mirrored = service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "-50",
    todayLabel: "2026-08-30",
  });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "150");
  assert.equal(mirrored.performance.todayUsdt, "0");
  assert.equal(mirrored.totalBalance.liveUsdt, "150");
});

test("admin balance overwrite clears stale mirrored pnl lots", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");
  service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "0",
    todayLabel: "2026-08-30",
  });

  service.setUserBalance(admin, user.id, {
    currency: "USDT",
    amount: "250",
    note: "Correction",
  });
  const mirrored = service.applyMirroredPnlToDashboard(service.getDashboard(user), {
    todayPnlPercent: "-60",
    todayLabel: "2026-08-30",
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "250");
  assert.equal(mirrored.performance.todayUsdt, "0");
  assert.equal(mirrored.totalBalance.liveUsdt, "250");
});

test("admin balance overwrite retires active trade investments", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "20", "80");
  service.db.tradeInvestments.push({
    id: "investment-1",
    userId: user.id,
    tradeId: "trade-1",
    amountUsdt: "80",
    fundingSources: [
      {
        currency: "USDT",
        amount: "80",
      },
    ],
    baselinePnlPercent: "0",
    status: "ACTIVE",
    joinedAt: "2026-08-30T09:30:00.000Z",
  });

  const result = service.setUserBalance(admin, user.id, {
    currency: "USDT",
    amount: "25",
    note: "Authoritative correction",
  });

  const wallet = service.ensureWallet(user.id, "USDT");
  assert.equal(wallet.availableBalance, "25");
  assert.equal(wallet.lockedBalance, "0");
  assert.equal(service.db.tradeInvestments[0].status, "STOPPED");
  assert.equal(service.db.tradeInvestments[0].stopReason, "ADMIN_BALANCE_OVERWRITE");
  assert.equal(result.transaction.metadata.clearedActiveInvestments, 1);
  assert.equal(result.transaction.metadata.releasedInvestmentLocks[0].amount, "80");
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

test("daily NGN withdrawal limit is enforced by amount, not request count", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "7000");

  for (let index = 0; index < 3; index += 1) {
    const withdrawal = service.createWithdrawal(user, {
      amount: "50",
      currency: "USDT",
      destination: {
        address: `TUserWalletAddress${index}`,
        network: "TRC20",
      },
    });
    service.completeWithdrawal(admin, withdrawal.id, { transactionHash: `0x${index}` });
  }

  const largeWithdrawal = service.createWithdrawal(user, {
    amount: "5000",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddressLarge",
      network: "TRC20",
    },
  });
  service.completeWithdrawal(admin, largeWithdrawal.id, { transactionHash: "0xlarge" });

  assert.throws(
    () =>
      service.createWithdrawal(user, {
        amount: "1300",
        currency: "USDT",
        destination: {
          address: "TUserWalletAddressOver",
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

test("referral code generation preserves existing users and balances", () => {
  const { db, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "2500");
  const userCountBefore = db.users.length;
  const balanceBefore = service.ensureWallet(user.id, "NGN").availableBalance;

  const profile = service.getReferralProfile(user);

  assert.match(profile.referralCode, /^NTR-[A-Z0-9]+$/);
  assert.equal(db.users.length, userCountBefore);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, balanceBefore);
});

test("valid referral signup records relationship without paying bonus", () => {
  const { db, service, user } = createHarness();
  const referrer = {
    id: "referrer-1",
    name: "Referrer",
    email: "referrer@example.com",
    role: "user",
  };
  db.users.push(referrer);
  service.ensureState();

  const referral = service.registerReferralForSignup(user, referrer.referralCode);

  assert.equal(referral.referrerUserId, referrer.id);
  assert.equal(referral.referredUserId, user.id);
  assert.equal(referral.status, "registered");
  assert.equal(service.ensureWallet(referrer.id, "NGN").availableBalance, "0");
  assert.equal(service.db.transactions.some((item) => item.type === "REFERRAL_BONUS"), false);
});

test("invalid and self referral codes do not block normal accounts", () => {
  const { service, user } = createHarness();

  assert.equal(service.registerReferralForSignup(user, "NTR-NOTREAL"), null);
  assert.equal(service.registerReferralForSignup(user, user.referralCode), null);
  assert.equal(service.db.referrals.length, 0);
});

test("referral pays once after deposit and successful VTU spend qualify", () => {
  const { admin, db, service, user } = createHarness();
  const referrer = {
    id: "referrer-1",
    name: "Referrer",
    email: "referrer@example.com",
    role: "user",
  };
  db.users.push(referrer);
  service.ensureState();
  service.registerReferralForSignup(user, referrer.referralCode);

  const firstDeposit = service.createDeposit(user, { amount: "1999", currency: "NGN", depositorName: "Ada User" });
  service.approveDeposit(admin, firstDeposit.id);
  service.evaluateReferralQualification(user.id);
  assert.equal(service.db.referrals[0].depositQualified, false);
  assert.equal(service.ensureWallet(referrer.id, "NGN").availableBalance, "0");

  const secondDeposit = service.createDeposit(user, { amount: "1000", currency: "NGN", depositorName: "Ada User" });
  service.approveDeposit(admin, secondDeposit.id);
  service.evaluateReferralQualification(user.id);
  assert.equal(service.db.referrals[0].depositQualified, true);
  assert.equal(service.ensureWallet(referrer.id, "NGN").availableBalance, "0");

  const failed = service.createVtuTransaction(user, {
    productType: "airtime",
    requestId: "airtime-failed",
    phone: "08030000000",
    network: "mtn",
    faceValue: "2000",
    providerCost: "2000",
    amountCharged: "2000",
  });
  service.applyVtuProviderResult(failed.requestId, { mappedStatus: "failed", data: { status: "failed" } });
  service.evaluateReferralQualification(user.id);
  assert.equal(service.db.referrals[0].spendQualified, false);

  setWallet(service, user.id, "NGN", "2500");
  const successful = service.createVtuTransaction(user, {
    productType: "data",
    requestId: "data-success",
    phone: "08030000000",
    network: "mtn",
    planName: "2GB",
    faceValue: "2000",
    providerCost: "2000",
    amountCharged: "2000",
  });
  service.applyVtuProviderResult(successful.requestId, { mappedStatus: "successful", data: { status: "successful" } });
  service.evaluateReferralQualification(user.id);
  service.evaluateReferralQualification(user.id);

  const rewards = service.db.transactions.filter((item) => item.type === "REFERRAL_BONUS");
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].amount, "500");
  assert.equal(rewards[0].status, "SUCCESSFUL");
  assert.equal(service.ensureWallet(referrer.id, "NGN").availableBalance, "500");
  assert.equal(service.db.referrals[0].status, "rewarded");
});

test("referral can qualify through two active joined trades", () => {
  const { admin, db, service, user } = createHarness();
  const referrer = {
    id: "referrer-1",
    name: "Referrer",
    email: "referrer@example.com",
    role: "user",
  };
  db.users.push(referrer);
  service.ensureState();
  service.registerReferralForSignup(user, referrer.referralCode);
  const deposit = service.createDeposit(user, { amount: "2000", currency: "NGN", depositorName: "Ada User" });
  service.approveDeposit(admin, deposit.id);
  service.db.tradeInvestments.push(
    { id: "trade-investment-1", userId: user.id, tradeId: "trade-1", amountUsdt: "1", status: "ACTIVE", joinedAt: "2026-08-30T10:00:00.000Z" },
    { id: "trade-investment-2", userId: user.id, tradeId: "trade-2", amountUsdt: "1", status: "ACTIVE", joinedAt: "2026-08-30T10:00:00.000Z" },
    { id: "trade-investment-3", userId: user.id, tradeId: "trade-3", amountUsdt: "1", status: "STOPPED", joinedAt: "2026-08-30T10:00:00.000Z" }
  );

  const referral = service.evaluateReferralQualification(user.id);

  assert.equal(referral.tradeQualified, true);
  assert.equal(referral.qualifiedTradeCount, 2);
  assert.equal(service.ensureWallet(referrer.id, "NGN").availableBalance, "500");
});

test("admin referral bonus changes affect future rewards only", () => {
  const { admin, db, service, user } = createHarness();
  const referrer = {
    id: "referrer-1",
    name: "Referrer",
    email: "referrer@example.com",
    role: "user",
  };
  const nextUser = {
    id: "user-2",
    name: "Bola User",
    email: "bola@example.com",
    role: "user",
  };
  db.users.push(referrer, nextUser);
  service.ensureState();
  service.registerReferralForSignup(user, referrer.referralCode);
  const oldDeposit = service.createDeposit(user, { amount: "2000", currency: "NGN", depositorName: "Ada User" });
  service.approveDeposit(admin, oldDeposit.id);
  service.db.tradeInvestments.push(
    { id: "trade-investment-1", userId: user.id, tradeId: "trade-1", amountUsdt: "1", status: "ACTIVE", joinedAt: "2026-08-30T10:00:00.000Z" },
    { id: "trade-investment-2", userId: user.id, tradeId: "trade-2", amountUsdt: "1", status: "ACTIVE", joinedAt: "2026-08-30T10:00:00.000Z" }
  );
  service.evaluateReferralQualification(user.id);

  service.updateSettings(admin, { referral: { bonusAmountNgn: "700" } });
  service.registerReferralForSignup(nextUser, referrer.referralCode);
  const newDeposit = service.createDeposit(nextUser, { amount: "2000", currency: "NGN", depositorName: "Bola User" });
  service.approveDeposit(admin, newDeposit.id);
  service.db.tradeInvestments.push(
    { id: "trade-investment-3", userId: nextUser.id, tradeId: "trade-3", amountUsdt: "1", status: "ACTIVE", joinedAt: "2026-08-30T10:00:00.000Z" },
    { id: "trade-investment-4", userId: nextUser.id, tradeId: "trade-4", amountUsdt: "1", status: "ACTIVE", joinedAt: "2026-08-30T10:00:00.000Z" }
  );
  service.evaluateReferralQualification(nextUser.id);

  const rewards = service.db.transactions.filter((item) => item.type === "REFERRAL_BONUS");
  assert.deepEqual(rewards.map((item) => item.amount).sort(), ["500", "700"]);
  assert.equal(service.db.referrals.find((item) => item.referredUserId === user.id).rewardAmountSnapshot, "500");
});

test("admin can generate and track Netrue gift cards", () => {
  const { admin, service } = createHarness();

  const giftCard = service.createGiftCard(admin, {
    amount: "2500",
    currency: "NGN",
    note: "Promo",
  });

  assert.match(giftCard.code, /^\d{14}$/);
  assert.equal(giftCard.status, "UNUSED");
  assert.equal(giftCard.amount, "2500");
  assert.equal(service.listGiftCards(admin)[0].id, giftCard.id);
});

test("user can redeem a Netrue gift card once", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "500");
  const giftCard = service.createGiftCard(admin, {
    amount: "2500",
    currency: "NGN",
  });

  const result = service.redeemGiftCard(user, { code: giftCard.code });

  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "3000");
  assert.equal(result.giftCard.status, "USED");
  assert.equal(result.transaction.type, "GIFT_CARD");
  assert.equal(result.transaction.amount, "2500");
  assert.equal(service.listGiftCards(admin)[0].redeemedByUserId, user.id);
  assert.throws(() => service.redeemGiftCard(user, { code: giftCard.code }), /already been used/i);
});

test("withdrawal minimums are enforced for NGN and USDT", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");
  setWallet(service, user.id, "NGN", "1000");
  setVerifiedBank(service, user);

  assert.throws(
    () =>
      service.createWithdrawal(user, {
        amount: "49.99",
        currency: "USDT",
        destination: {
          address: "TUserWalletAddress",
          network: "TRC20",
        },
      }),
    /between 50/i
  );
  assert.throws(
    () =>
      service.createWithdrawal(user, {
        amount: "499",
        currency: "NGN",
      }),
    /between 500/i
  );
});

test("admin can set a user balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "15");
  setWallet(service, user.id, "NGN", "16000");

  const result = service.setUserBalance(admin, user.id, {
    currency: "USDT",
    amount: "42",
    note: "Correction",
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "42");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "0");
  assert.equal(result.transaction.type, "BALANCE_ADJUSTMENT");
  assert.equal(result.transaction.amount, "27");
  assert.equal(result.transaction.metadata.clearedCurrency, "NGN");
  assert.equal(service.listNotifications(user)[0].type, "BALANCE");
});

test("admin balance overwrite prevents stale legacy balance remigration", () => {
  const { admin, service, user } = createHarness();
  user.balance = "75000";
  setWallet(service, user.id, "NGN", "75000");

  service.setUserBalance(admin, user.id, {
    currency: "NGN",
    amount: "0",
    note: "Reset",
  });
  service.ensureState();

  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "0");
  assert.equal(service.getAvailableUsdtEquivalent(user.id), "0");
  assert.equal(user.legacyBalanceMigratedAt, "2026-08-30T10:00:00.000Z");
});

test("user can transfer wallet funds by registered email", () => {
  const { db, service, user } = createHarness();
  const recipient = {
    id: "user-2",
    name: "Ben User",
    email: "ben@example.com",
    role: "user",
  };
  db.users.push(recipient);
  setWallet(service, user.id, "NGN", "10000");
  setWallet(service, recipient.id, "NGN", "1500");

  const result = service.transferBetweenUsers(user, {
    email: "ben@example.com",
    currency: "NGN",
    amount: "2500",
  });

  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7500");
  assert.equal(service.ensureWallet(recipient.id, "NGN").availableBalance, "4000");
  assert.equal(result.transaction.type, "TRANSFER_SENT");
  assert.equal(service.getTransactions(recipient.id, { limit: 1 })[0].type, "TRANSFER_RECEIVED");
  assert.equal(service.listNotifications(recipient)[0].type, "TRANSFER");
});

test("user transfer requires enough selected currency balance", () => {
  const { db, service, user } = createHarness();
  db.users.push({
    id: "user-2",
    name: "Ben User",
    email: "ben@example.com",
    role: "user",
  });
  setWallet(service, user.id, "USDT", "4");

  assert.throws(
    () => service.transferBetweenUsers(user, {
      email: "ben@example.com",
      currency: "USDT",
      amount: "5",
    }),
    /insufficient usdt balance/i
  );
});

test("legacy wallet balance fields are available for one click trade join", () => {
  const { service, user } = createHarness();
  const usdtWallet = service.ensureWallet(user.id, "USDT");
  const ngnWallet = service.ensureWallet(user.id, "NGN");
  delete usdtWallet.availableBalance;
  usdtWallet.balance = "125";
  delete ngnWallet.availableBalance;
  ngnWallet.amount = "32000";
  delete ngnWallet.lockedBalance;
  ngnWallet.locked = "0";

  assert.equal(service.getAvailableUsdtEquivalent(user.id), "145");
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "125");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "32000");
});

test("legacy user balance field migrates into wallet rows", () => {
  const db = {
    users: [
      {
        id: "user-legacy",
        name: "Legacy User",
        email: "legacy@example.com",
        role: "user",
        balance: "75000",
      },
    ],
  };
  const service = new FinancialService({
    db,
    idGenerator: () => "id-legacy",
    clock: () => "2026-08-30T10:00:00.000Z",
  });

  service.ensureState();

  assert.equal(service.ensureWallet("user-legacy", "NGN").availableBalance, "75000");
  assert.equal(service.getAvailableUsdtEquivalent("user-legacy"), "46.875");
  assert.equal(db.users[0].legacyBalanceMigratedAt, "2026-08-30T10:00:00.000Z");
});

test("Paystack kobo conversion and webhook signature verification", () => {
  const secretKey = "sk_test_example";
  const rawBody = Buffer.from(JSON.stringify({ event: "transfer.success", data: { reference: "wd_test" } }));
  const signature = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  const service = new PaystackService({ secretKey, fetchImpl: async () => ({ ok: true, json: async () => ({ status: true }) }) });

  assert.equal(toKobo("50000"), 5000000);
  assert.equal(toKobo("50000.75"), 5000075);
  assert.equal(service.verifyWebhookSignature(rawBody, signature), true);
  assert.equal(service.verifyWebhookSignature(rawBody, "bad-signature"), false);
});

test("NGN withdrawal requires a verified bank account", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");

  assert.throws(() => service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  }), /verify a Nigerian bank account/i);
});

test("NGN Paystack withdrawal success consumes reserved balance once", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });

  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "30000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "20000");
  const approved = service.approvePaystackWithdrawal(admin, withdrawal.id);
  const processing = service.markPaystackTransferProcessing(admin, approved.id, {
    data: {
      transfer_code: "TRF_test",
      reference: approved.paystackReference,
      status: "pending",
    },
  });
  const success = service.applyPaystackTransferSuccess(processing.paystackReference, {
    reference: processing.paystackReference,
    amount: processing.amountKobo,
    transfer_code: "TRF_test",
    recipient: { recipient_code: processing.paystackRecipientCode },
  });
  const duplicate = service.applyPaystackTransferSuccess(processing.paystackReference, {
    reference: processing.paystackReference,
    amount: processing.amountKobo,
  });

  assert.equal(success.status, "SUCCESS");
  assert.equal(duplicate.status, "SUCCESS");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "30000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("Paystack failed withdrawal releases reserved balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });
  const approved = service.approvePaystackWithdrawal(admin, withdrawal.id);
  service.markPaystackTransferProcessing(admin, approved.id, {
    data: { transfer_code: "TRF_failed", reference: approved.paystackReference },
  });
  const failed = service.applyPaystackTransferFailed(approved.paystackReference, {
    reference: approved.paystackReference,
    amount: approved.amountKobo,
    reason: "failed",
  });

  assert.equal(failed.status, "FAILED");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "50000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("rejected Paystack withdrawal releases reserved balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });
  const rejected = service.rejectWithdrawal(admin, withdrawal.id, { reason: "Incorrect request" });

  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.balanceReserved, false);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "50000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("retryable Paystack setup failure keeps withdrawal pending and reserved", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });
  const approved = service.approvePaystackWithdrawal(admin, withdrawal.id);
  const retryable = service.markPaystackTransferRetryable(admin, approved.id, new Error("Paystack balance is insufficient."));

  assert.equal(retryable.status, "PENDING");
  assert.equal(retryable.balanceReserved, true);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "30000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "20000");
  assert.equal(service.findActiveWithdrawalForUser(user.id).id, withdrawal.id);
});

test("approved Paystack withdrawal without transfer attempt can be rejected", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });
  const approved = service.approvePaystackWithdrawal(admin, withdrawal.id);
  const rejected = service.rejectWithdrawal(admin, approved.id, { reason: "Paystack setup failed" });

  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.balanceReserved, false);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "50000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("manual NGN withdrawal completion consumes reserved balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });
  const completed = service.completeManualWithdrawal(admin, withdrawal.id, {
    manualReference: "BANK-TRANSFER-001",
  });

  assert.equal(completed.status, "SUCCESS");
  assert.equal(completed.balanceReserved, false);
  assert.equal(completed.metadata.manualPayout, true);
  assert.equal(completed.externalTransactionReference, "BANK-TRANSFER-001");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "30000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  assert.equal(service.findActiveWithdrawalForUser(user.id), undefined);
});

test("reversed successful Paystack withdrawal credits user once", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "20000",
    currency: "NGN",
  });
  const approved = service.approvePaystackWithdrawal(admin, withdrawal.id);
  service.markPaystackTransferProcessing(admin, approved.id, {
    data: { transfer_code: "TRF_reversed", reference: approved.paystackReference },
  });
  service.applyPaystackTransferSuccess(approved.paystackReference, {
    reference: approved.paystackReference,
    amount: approved.amountKobo,
  });
  service.applyPaystackTransferReversed(approved.paystackReference, {
    reference: approved.paystackReference,
    amount: approved.amountKobo,
  });
  const duplicate = service.applyPaystackTransferReversed(approved.paystackReference, {
    reference: approved.paystackReference,
    amount: approved.amountKobo,
  });

  assert.equal(duplicate.status, "REVERSED");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "50000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("USDT withdrawal can reserve NGN equivalent when USDT wallet is short", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "5");
  setWallet(service, user.id, "NGN", "72000");

  const withdrawal = service.createWithdrawal(user, {
    amount: "50",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  assert.deepEqual(withdrawal.fundingSources, [
    { currency: "USDT", amount: "5" },
    { currency: "NGN", amount: "72000" },
  ]);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "0");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "5");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "0");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "72000");
});

test("NGN withdrawal can reserve USDT equivalent when naira wallet is short", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "8000");
  setWallet(service, user.id, "USDT", "10");
  setVerifiedBank(service, user);

  const withdrawal = service.createWithdrawal(user, {
    amount: "16000",
    currency: "NGN",
  });

  assert.deepEqual(withdrawal.fundingSources, [
    { currency: "NGN", amount: "8000" },
    { currency: "USDT", amount: "5" },
  ]);
  assert.equal(withdrawal.displayAmounts.USDT, "10");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "8000");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "5");
});

test("NGN withdrawal is clear when bank account name matches first and last name", () => {
  const { service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  setWallet(service, user.id, "NGN", "50000");
  service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "1234567890",
    accountName: "ADA CHUKWU USER",
  });

  const withdrawal = service.createWithdrawal(user, {
    amount: "1000",
    currency: "NGN",
  });

  assert.equal(withdrawal.fraudReview.status, "CLEAR");
  assert.equal(user.fraudReview, undefined);
});

test("NGN withdrawal accepts reversed first and last account names", () => {
  const { service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  setWallet(service, user.id, "NGN", "50000");
  const bankAccount = service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "1234567890",
    accountName: "USER ADA",
  });

  const dashboard = service.getDashboard(user);
  const withdrawal = service.createWithdrawal(user, {
    amount: "1000",
    currency: "NGN",
    bankAccountId: bankAccount.id,
  });

  assert.equal(dashboard.bankAccount.nameMatch, true);
  assert.equal(dashboard.bankAccount.matchedNameCount, 2);
  assert.equal(withdrawal.fraudReview.status, "CLEAR");
});

test("NGN withdrawal is flagged when bank account name does not match user names", () => {
  const { db, service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  const relatedUser = {
    id: "user-copy",
    name: "Ada User",
    firstName: "Ada",
    lastName: "User",
    email: "copy@example.com",
    role: "user",
    bankAccounts: [
      {
        id: "bank-copy",
        bankName: "Test Bank",
        bankCode: "058",
        accountNumber: "2222222222",
        accountName: "OTHER NAME",
        verified: true,
      },
    ],
  };
  db.users.push(relatedUser);
  setWallet(service, user.id, "NGN", "50000");
  service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "2222222222",
    accountName: "OTHER NAME",
  });

  const withdrawal = service.createWithdrawal(user, {
    amount: "1000",
    currency: "NGN",
  });

  assert.equal(withdrawal.fraudReview.status, "SUSPICIOUS");
  assert.equal(withdrawal.fraudReview.reason, "BANK_NAME_MISMATCH");
  assert.deepEqual(withdrawal.fraudReview.relatedUserIds, ["user-copy"]);
  assert.equal(user.fraudReview.status, "SUSPICIOUS");
  assert.equal(relatedUser.fraudReview.status, "SUSPICIOUS");
});

test("flagged NGN withdrawal becomes successful when admin approves review", () => {
  const { admin, service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  setWallet(service, user.id, "NGN", "50000");
  service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "1234567890",
    accountName: "OTHER NAME",
  });
  const withdrawal = service.createWithdrawal(user, {
    amount: "1000",
    currency: "NGN",
  });

  const approved = service.completeReviewedWithdrawal(admin, withdrawal.id);

  assert.equal(approved.status, "SUCCESS");
  assert.equal(approved.fraudReview.status, "APPROVED");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "49000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("legacy reopened reviewed withdrawal stays successful after startup normalization", () => {
  const { admin, service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  setWallet(service, user.id, "NGN", "50000");
  service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "1234567890",
    accountName: "OTHER NAME",
  });
  const withdrawal = service.createWithdrawal(user, {
    amount: "1000",
    currency: "NGN",
  });
  const reviewed = service.completeReviewedWithdrawal(admin, withdrawal.id);
  const reopened = service.getWithdrawal(reviewed.id);
  reopened.status = "PENDING";
  reopened.balanceReserved = true;
  reopened.completedAt = null;
  reopened.completedBy = "";
  reopened.metadata.reviewedPaystackReopenedAt = "2026-09-01T00:00:00.000Z";
  service.ensureWallet(user.id, "NGN").lockedBalance = "1000";

  service.ensureState();

  const finalized = service.getWithdrawal(reviewed.id);
  assert.equal(finalized.status, "SUCCESS");
  assert.equal(finalized.balanceReserved, false);
  assert.equal(finalized.metadata.paystackRetryable, false);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "49000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  assert.equal(service.findActiveWithdrawalForUser(user.id), undefined);
});

test("duplicate user detail scan flags similar accounts for admin review", () => {
  const { admin, db, service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  user.bankAccounts = [
    {
      id: "bank-1",
      bankName: "Test Bank",
      bankCode: "058",
      accountNumber: "1234567890",
      accountName: "ADA USER",
      verified: true,
    },
  ];
  const duplicate = {
    id: "user-2",
    name: "Ada User",
    firstName: "Ada",
    lastName: "User",
    email: "ada.two@example.com",
    role: "user",
    bankAccounts: [
      {
        id: "bank-2",
        bankName: "Test Bank",
        bankCode: "058",
        accountNumber: "1234567890",
        accountName: "ADA USER",
        verified: true,
      },
    ],
  };
  db.users.push(duplicate);

  const result = service.scanDuplicateUserReviews();

  assert.equal(result.flaggedCount, 2);
  assert.equal(user.fraudReview.status, "SUSPICIOUS");
  assert.equal(duplicate.fraudReview.status, "SUSPICIOUS");
  assert.ok(user.fraudReview.reasons.includes("DUPLICATE_FULL_NAME"));
  assert.ok(user.fraudReview.reasons.includes("DUPLICATE_BANK_ACCOUNT"));

  service.clearUserFraudReview(admin, user.id);
  service.scanDuplicateUserReviews();
  assert.equal(user.fraudReview.status, "CLEARED");
});

test("bank account name match details include warning for mismatched names", () => {
  const { service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";

  const result = service.evaluateBankAccountNameMatch(user, {
    accountName: "CHINEDU OKAFOR",
  });

  assert.equal(result.matches, false);
  assert.equal(result.matchedCount, 0);
  assert.match(result.warning, /does not match your registered name/i);
});

test("user can remove a saved bank account", () => {
  const { service, user } = createHarness();
  user.firstName = "Ada";
  user.lastName = "User";
  const first = service.updateVerifiedBankAccount(user, {
    bankName: "Test Bank",
    bankCode: "058",
    accountNumber: "1234567890",
    accountName: "ADA USER",
  });
  const second = service.updateVerifiedBankAccount(user, {
    bankName: "Second Bank",
    bankCode: "044",
    accountNumber: "2222222222",
    accountName: "ADA USER",
  });

  const result = service.removeVerifiedBankAccount(user, second.id);

  assert.equal(result.removedBankAccountId, second.id);
  assert.equal(result.bankAccounts.length, 1);
  assert.equal(result.bankAccounts[0].id, first.id);
  assert.equal(user.bankAccount.id, first.id);
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
  assert.equal(service.listNotifications(user, { includeRead: false }).length, 0);
});

test("user support message creates admin notification", () => {
  const { admin, service, user } = createHarness();

  const notifications = service.sendSupportMessage(user, {
    message: "Please check my withdrawal.",
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].userId, admin.id);
  assert.equal(notifications[0].type, "MESSAGE");
  assert.match(notifications[0].message, /Ada User/);
  assert.equal(notifications[0].entityType, "ChatMessage");
  assert.equal(notifications[0].metadata.conversationUserId, user.id);
  assert.equal(service.db.chatMessages.length, 1);
  assert.equal(service.db.chatMessages[0].conversationUserId, user.id);
  assert.match(service.listNotifications(admin)[0].message, /withdrawal/);
});

test("user support message publishes message push notification", async () => {
  const published = [];
  const { admin, service, user } = createHarness({
    notificationPublisher: (notification) => {
      published.push(notification);
    },
  });

  const notifications = service.sendSupportMessage(user, {
    message: "Please check my withdrawal.",
  });
  await Promise.resolve();

  assert.equal(notifications[0].category, "messages");
  assert.equal(published.length, 1);
  assert.equal(published[0].userId, admin.id);
  assert.equal(published[0].type, "MESSAGE");
  assert.equal(published[0].category, "messages");
  assert.equal(published[0].entityType, "ChatMessage");
});

test("admin reply creates a temporary user chat message", () => {
  const { admin, service, user } = createHarness();

  const result = service.sendAdminMessage(admin, user.id, {
    message: "Your withdrawal has been reviewed.",
  });

  assert.equal(result.notification.userId, user.id);
  assert.equal(result.notification.entityType, "ChatMessage");
  assert.equal(result.notification.metadata.conversationUserId, user.id);
  assert.equal(result.message.conversationUserId, user.id);
  assert.equal(result.message.senderRole, "admin");
  assert.equal(service.db.chatMessages.length, 1);
});

test("admin reply publishes message push notification", async () => {
  const published = [];
  const { admin, service, user } = createHarness({
    notificationPublisher: (notification) => {
      published.push(notification);
    },
  });

  const result = service.sendAdminMessage(admin, user.id, {
    message: "Your withdrawal has been reviewed.",
  });
  await Promise.resolve();

  assert.equal(result.notification.category, "messages");
  assert.equal(published.length, 1);
  assert.equal(published[0].userId, user.id);
  assert.equal(published[0].type, "MESSAGE");
  assert.equal(published[0].category, "messages");
  assert.equal(published[0].entityId, result.message.id);
});

test("chat notifications expire after 24 hours", () => {
  const { admin, service, user } = createHarness();

  const messages = service.sendSupportMessage(user, {
    message: "Short lived chat.",
  });
  service.createNotification({
    userId: admin.id,
    type: "DEPOSIT",
    title: "Deposit",
    message: "Persistent finance notice.",
  });

  assert.ok(messages[0].expiresAt);
  assert.equal(service.db.chatMessages.length, 1);
  assert.equal(service.listNotifications(admin).filter((item) => item.type === "MESSAGE").length, 1);

  service.clock = () => "2026-08-31T10:00:01.000Z";
  const remaining = service.listNotifications(admin);

  assert.equal(remaining.some((item) => item.type === "MESSAGE"), false);
  assert.equal(remaining.some((item) => item.type === "DEPOSIT"), true);
  assert.equal(service.db.notifications.some((item) => item.type === "MESSAGE"), false);
  assert.equal(service.db.chatMessages.length, 0);
});

test("VTU settings encrypt credentials and never return secrets", () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service } = createHarness();
    const settings = service.updateVtuSettings(admin, {
      username: "vtu@example.com",
      password: "super-secret-password",
      pin: "1234",
      airtimeEnabled: true,
      dataEnabled: true,
      airtimeMarkupPercent: "0",
      dataMarkupPercent: "4",
    });

    assert.equal(settings.configured, true);
    assert.equal(settings.hasPassword, true);
    assert.equal(settings.hasPin, true);
    assert.equal(settings.password, undefined);
    assert.equal(settings.pin, undefined);
    assert.equal(db.systemSettings.vtu.usernameEncrypted.includes("vtu@example.com"), false);
    assert.equal(db.systemSettings.vtu.passwordEncrypted.includes("super-secret-password"), false);
    assert.equal(db.systemSettings.vtu.pinEncrypted.includes("1234"), false);

    const publicSettings = service.getSettings().vtu;
    assert.equal(publicSettings.hasPassword, true);
    assert.equal(publicSettings.passwordEncrypted, undefined);
    assert.equal(publicSettings.accessTokenEncrypted, undefined);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("VTU purchase reserves wallet and success consumes reserve once", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "10000");

  const transaction = service.createVtuTransaction(user, {
    productType: "airtime",
    requestId: "airtime_test_1",
    phone: "08012345678",
    network: "mtn",
    faceValue: "1000",
    providerCost: "1000",
    amountCharged: "1000",
    markupAmount: "0",
  });

  assert.equal(transaction.status, "processing");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "9000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "1000");

  const settled = service.applyVtuProviderResult("airtime_test_1", {
    code: "success",
    data: {
      status: "completed-api",
      amount_charged: "975",
      order_id: "VTU-1",
    },
  });
  const duplicateRefund = service.applyVtuProviderResult("airtime_test_1", {
    code: "success",
    data: {
      status: "refunded",
    },
  });

  assert.equal(settled.status, "successful");
  assert.equal(duplicateRefund.status, "successful");
  assert.equal(duplicateRefund.markupAmount, "25");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "9000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  assert.equal(service.getWalletHistory(user).some((item) => item.kind === "VTU" && item.reference === "airtime_test_1"), true);
});

test("digital service product pricing hides supplier cost from users", () => {
  const { admin, service } = createHarness();
  service.updateSettings(admin, {
    exchangeRate: { usdtToNgn: "1500" },
    digitalServices: {
      enabled: true,
      globalMarkupPercent: "10",
    },
  });
  service.replaceDigitalServiceProducts([
    {
      id: "55",
      supplierProductId: "55",
      provider: "akunding",
      name: "Design Tool",
      category: "Design",
      currency: "USD",
      providerCost: "2",
      stock: 5,
      available: true,
      imageUrl: "https://akunding.shop/image.png",
      syncedAt: "2026-08-30T10:00:00.000Z",
    },
  ]);

  const [userProduct] = service.listDigitalServiceProducts();
  const [adminProduct] = service.listDigitalServiceProducts({ admin: true });

  assert.equal(userProduct.sellingPrice, "3300");
  assert.equal(userProduct.providerCost, undefined);
  assert.equal(adminProduct.providerCostNgn, "3000");
  assert.equal(adminProduct.markupAmount, "300");
  assert.equal(adminProduct.supplierCurrency, "USD");
});

test("digital service products use supplier price by default", () => {
  const previousMarkup = process.env.AKUNDING_GLOBAL_MARKUP_PERCENT;
  delete process.env.AKUNDING_GLOBAL_MARKUP_PERCENT;
  try {
    const { service } = createHarness();
    service.replaceDigitalServiceProducts([
      {
        id: "56",
        supplierProductId: "56",
        provider: "akunding",
        name: "Cloud Tool",
        category: "Cloud",
        currency: "NGN",
        providerCost: "1000",
        stock: 3,
        available: true,
      },
    ]);

    const [userProduct] = service.listDigitalServiceProducts();
    const [adminProduct] = service.listDigitalServiceProducts({ admin: true });

    assert.equal(userProduct.price, "1000");
    assert.equal(userProduct.sellingPrice, "1000");
    assert.equal(adminProduct.providerCostNgn, "1000");
    assert.equal(adminProduct.markupAmount, "0");
  } finally {
    if (previousMarkup === undefined) {
      delete process.env.AKUNDING_GLOBAL_MARKUP_PERCENT;
    } else {
      process.env.AKUNDING_GLOBAL_MARKUP_PERCENT = previousMarkup;
    }
  }
});

test("digital service sync accepts nested API product payloads and reseller cost", async () => {
  const { admin, service } = createHarness();
  service.updateSettings(admin, {
    digitalServices: {
      enabled: true,
    },
  });
  const digitalServices = new DigitalServicesService({
    financialService: service,
    akundingService: {
      baseUrl: "https://akunding.shop",
      getPublicStatus: () => ({ configured: true }),
      isConfigured: () => true,
      listProducts: async () => ({
        data: {
          products: [
            {
              id: 57,
              name: "Nested Tool",
              price: "1500",
              reseller_price: "1200",
              currency: "NGN",
              stock: 8,
            },
          ],
        },
      }),
    },
  });

  const [product] = await digitalServices.syncProducts({ force: true });
  assert.equal(product.name, "Nested Tool");
  assert.equal(product.providerCostNgn, "1200");
  assert.equal(product.sellingPrice, "1200");
});

test("digital service supplier relative images are normalized to provider URLs", () => {
  const { service } = createHarness();
  const digitalServices = new DigitalServicesService({
    financialService: service,
    akundingService: {
      baseUrl: "https://akunding.shop",
      getPublicStatus: () => ({ configured: true }),
      isConfigured: () => true,
    },
  });

  const product = digitalServices.normalizeSupplierProduct({
    id: 57,
    name: "Image Tool",
    price: "500",
    image: "/storage/products/tool.png",
  });

  assert.equal(product.imageUrl, "https://akunding.shop/storage/products/tool.png");
});

test("admin can refresh a single digital service product API price", async () => {
  const { admin, service } = createHarness();
  service.updateSettings(admin, {
    digitalServices: {
      enabled: true,
      globalMarkupPercent: "25",
    },
  });
  service.replaceDigitalServiceProducts([
    {
      id: "59",
      supplierProductId: "59",
      provider: "akunding",
      name: "Old Price Tool",
      category: "Media",
      currency: "NGN",
      providerCost: "1000",
      stock: 4,
      available: true,
    },
  ]);
  service.updateDigitalServiceProductOverride(admin, "59", {
    displayName: "Published Tool",
    customImageUrl: "https://cdn.example.com/products/published.png",
  });
  const digitalServices = new DigitalServicesService({
    financialService: service,
    akundingService: {
      baseUrl: "https://akunding.shop",
      getPublicStatus: () => ({ configured: true }),
      isConfigured: () => true,
      getProduct: async () => ({
        data: {
          id: 59,
          name: "Fresh API Tool",
          reseller_price: "2000",
          currency: "NGN",
          stock: 9,
          image: "/storage/products/fresh.png",
        },
      }),
    },
  });

  const product = await digitalServices.refreshProduct("59");
  assert.equal(product.name, "Published Tool");
  assert.equal(product.providerCostNgn, "2000");
  assert.equal(product.markupAmount, "500");
  assert.equal(product.sellingPrice, "2500");
  assert.equal(product.imageUrl, "https://cdn.example.com/products/published.png");
});

test("digital service product image can be set by admin override", () => {
  const { admin, service } = createHarness();
  service.replaceDigitalServiceProducts([
    {
      id: "58",
      supplierProductId: "58",
      provider: "akunding",
      name: "Image Override Tool",
      category: "Media",
      currency: "NGN",
      providerCost: "750",
      stock: 4,
      available: true,
      imageUrl: "https://akunding.shop/default.png",
    },
  ]);

  service.updateDigitalServiceProductOverride(admin, "58", {
    customImageUrl: "https://cdn.example.com/products/override.png",
  });

  const [product] = service.listDigitalServiceProducts();
  assert.equal(product.imageUrl, "https://cdn.example.com/products/override.png");
});

test("admin-enabled digital service product is visible in user store", () => {
  const { admin, service } = createHarness();
  service.replaceDigitalServiceProducts([
    {
      id: "60",
      supplierProductId: "60",
      provider: "akunding",
      name: "Manual Publish Tool",
      category: "Store",
      currency: "NGN",
      providerCost: "900",
      stock: 0,
      available: false,
    },
  ]);
  service.updateDigitalServiceProductOverride(admin, "60", {
    enabled: true,
  });

  const [product] = service.listDigitalServiceProducts();
  assert.equal(product.name, "Manual Publish Tool");
  assert.equal(product.available, true);
  assert.equal(product.supplierAvailable, false);
});

test("digital service order reserves wallet and delivery consumes reserve once", () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, {
      digitalServices: {
        enabled: true,
        globalMarkupPercent: "0",
      },
    });
    service.replaceDigitalServiceProducts([
      {
        id: "77",
        supplierProductId: "77",
        provider: "akunding",
        name: "AI Tool",
        category: "AI",
        currency: "NGN",
        providerCost: "2500",
        stock: 10,
        available: true,
      },
    ]);

    const product = service.getDigitalServiceProduct("77", { admin: true });
    const order = service.createDigitalServiceOrder(user, { product, quantity: 2 });
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "5000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "5000");

    const delivered = service.applyDigitalServiceOrderResult(order.id, {
      status: "delivered",
      supplierStatus: "delivered",
      supplierOrderId: "9001",
      delivery: { pin: "SECRET-PIN" },
    }, user);
    assert.equal(delivered.delivery.pin, "SECRET-PIN");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "5000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");

    service.applyDigitalServiceOrderResult(order.id, { status: "delivered" }, user);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "5000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("digital service purchase treats supplier activation link as delivered", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, {
      digitalServices: {
        enabled: true,
        globalMarkupPercent: "0",
      },
    });
    service.replaceDigitalServiceProducts([
      {
        id: "91",
        supplierProductId: "91",
        provider: "akunding",
        name: "Gemini Pro",
        category: "AI",
        currency: "NGN",
        providerCost: "2500",
        stock: 10,
        available: true,
      },
    ]);
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        createOrder: async () => ({
          data: {
            id: "AK-91",
            status: "pending",
            activation_link: "https://gemini.google.com/activate/example-plan",
          },
        }),
      },
    });

    assert.equal(mapSupplierStatus({ data: { status: "pending", activation_link: "https://gemini.google.com/activate/example-plan" } }), "delivered");
    assert.equal(mapSupplierStatus({ data: { status: "pending", message: "Order is still processing" } }), "processing");
    assert.equal(extractDeliveryPayload({ data: { activation_link: "https://gemini.google.com/activate/example-plan" } }).activationLink, "https://gemini.google.com/activate/example-plan");

    const order = await digitalServices.purchase(user, { productId: "91", quantity: 1 });

    assert.equal(order.status, "delivered");
    assert.equal(order.delivery.activationLink, "https://gemini.google.com/activate/example-plan");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7500");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
    assert.equal(service.listNotifications(admin).some((item) => item.title === "Store order completed" && item.entityId === order.id), true);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("user can requery pending digital service order with supplier link", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, {
      digitalServices: {
        enabled: true,
        globalMarkupPercent: "0",
      },
    });
    service.replaceDigitalServiceProducts([
      {
        id: "92",
        supplierProductId: "92",
        provider: "akunding",
        name: "Gemini Pro",
        category: "AI",
        currency: "NGN",
        providerCost: "3000",
        stock: 5,
        available: true,
      },
    ]);
    const product = service.getDigitalServiceProduct("92", { admin: true });
    const pending = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    service.applyDigitalServiceOrderResult(pending.id, {
      status: "processing",
      supplierStatus: "pending",
      supplierOrderId: "AK-STRING-92",
    }, user);
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        getOrder: async (orderId) => {
          assert.equal(orderId, "AK-STRING-92");
          return {
            data: {
              id: "AK-STRING-92",
              status: "pending",
              link: "https://gemini.google.com/activate/requery-plan",
            },
          };
        },
      },
    });

    const delivered = await digitalServices.requeryOrder(user, pending.id);

    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.delivery.activationLink, "https://gemini.google.com/activate/requery-plan");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("digital service supplier failure refunds reserved wallet once", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "6000");
  service.updateSettings(admin, {
    digitalServices: {
      enabled: true,
      globalMarkupPercent: "0",
    },
  });
  service.replaceDigitalServiceProducts([
    {
      id: "88",
      supplierProductId: "88",
      provider: "akunding",
      name: "Streaming Slot",
      category: "Streaming",
      currency: "NGN",
      providerCost: "3000",
      stock: 1,
      available: true,
    },
  ]);

  const product = service.getDigitalServiceProduct("88", { admin: true });
  const order = service.createDigitalServiceOrder(user, { product, quantity: 1 });
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "3000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "3000");

  service.applyDigitalServiceOrderResult(order.id, {
    status: "failed",
    message: "Out of stock",
  }, admin);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "6000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");

  service.applyDigitalServiceOrderResult(order.id, { status: "failed" }, admin);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "6000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
});

test("VTU refund releases reserved wallet exactly once", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "NGN", "2500");

  service.createVtuTransaction(user, {
    productType: "data",
    requestId: "data_test_1",
    phone: "08012345678",
    network: "airtel",
    variationId: "airtel-1gb",
    planName: "1GB - 30 Days",
    faceValue: "500",
    providerCost: "500",
    amountCharged: "520",
    markupAmount: "20",
  });
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1980");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "520");

  service.applyVtuProviderResult("data_test_1", {
    code: "success",
    data: {
      status: "refunded",
    },
  });
  service.applyVtuProviderResult("data_test_1", {
    code: "success",
    data: {
      status: "refunded",
    },
  });

  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  assert.equal(service.listTransactions(user).filter((item) => item.type === "VTU_REFUND").length, 1);
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
