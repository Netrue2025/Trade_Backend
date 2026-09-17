const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { DigitalServicesService, classifySupplierFulfillmentError, extractDeliveryPayload, mapSupplierStatus, validateSupplierUrl } = require("../services/digitalServices.service");
const { EmmaResellerService } = require("../services/emmaReseller.service");
const { EfemResellerService } = require("../services/efemReseller.service");
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
    emailPublisher: options.emailPublisher || null,
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

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
    headers: { get: () => "" },
  };
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

test("Paystack transaction initialization and verification use server references", async () => {
  const calls = [];
  const service = new PaystackService({
    secretKey: "sk_test_example",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (String(url).includes("/transaction/initialize")) {
        return {
          ok: true,
          json: async () => ({
            status: true,
            data: { authorization_url: "https://checkout.paystack.com/test", access_code: "acc", reference: "ref-1" },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: true,
          data: { status: "success", amount: 400000, currency: "NGN", reference: "ref-1" },
        }),
      };
    },
  });
  const initialized = await service.initializeTransaction({
    email: "ada@example.com",
    amountKobo: 400000,
    reference: "ref-1",
    callbackUrl: "https://netruefi.org/shop?reference=ref-1",
  });
  const verified = await service.verifyTransaction("ref-1");

  assert.equal(initialized.authorization_url, "https://checkout.paystack.com/test");
  assert.equal(verified.data.reference, "ref-1");
  assert.match(calls[0].url, /\/transaction\/initialize$/);
  assert.equal(JSON.parse(calls[0].options.body).reference, "ref-1");
  assert.match(calls[1].url, /\/transaction\/verify\/ref-1$/);
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

test("admin operational notifications are admin-only, pushed, and idempotent", async () => {
  const published = [];
  const { admin, db, service, user } = createHarness({
    notificationPublisher: (notification) => {
      published.push(notification);
    },
  });
  setWallet(service, user.id, "NGN", "50000");
  setVerifiedBank(service, user);
  service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
  service.replaceDigitalServiceProducts([{
    id: "emma-31",
    supplierProductId: "31",
    provider: "emma",
    name: "LEONARDO AI VIDEO GEN",
    category: "AI",
    currency: "NGN",
    providerCost: "1755",
    providerCostNgn: "1755",
    stock: 10,
    available: true,
  }]);

  const deposit = service.createDeposit(user, { amount: "25000", currency: "NGN", depositorName: "Ada User" }, { idempotencyKey: "deposit-once" });
  const duplicateDeposit = service.createDeposit(user, { amount: "25000", currency: "NGN", depositorName: "Ada User" }, { idempotencyKey: "deposit-once" });
  const withdrawal = service.createWithdrawal(user, { amount: "10000", currency: "NGN" }, { idempotencyKey: "withdrawal-once" });
  const product = service.getDigitalServiceProduct("emma-31", { admin: true });
  const order = service.createDigitalServiceOrder(user, { product, quantity: 1 });
  service.notifyAdminShopOrderPlaced(user, order);
  const vtu = service.createVtuTransaction(user, {
    productType: "airtime",
    requestId: "airtime_admin_notice",
    phone: "08012345678",
    network: "mtn",
    faceValue: "1000",
    providerCost: "1000",
    amountCharged: "1000",
    markupAmount: "0",
  });
  service.notifyAdminTradeJoined(user, {
    id: "investment-1",
    tradeId: "trade-1",
    amountUsdt: "50",
    joinedAt: "2026-08-30T10:00:00.000Z",
  }, {
    id: "trade-1",
    symbol: "BTCUSDT",
  });
  service.notifyAdminTradeJoined(user, { id: "investment-1", tradeId: "trade-1", amountUsdt: "50" }, { id: "trade-1", symbol: "BTCUSDT" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(duplicateDeposit.id, deposit.id);
  const adminEvents = db.notifications.filter((item) => item.userId === admin.id && item.category === "adminEvents");
  assert.equal(adminEvents.filter((item) => item.dedupeKey === `admin:deposit-created:${deposit.id}`).length, 1);
  assert.equal(adminEvents.filter((item) => item.dedupeKey === `admin:withdrawal-created:${withdrawal.id}`).length, 1);
  assert.equal(adminEvents.filter((item) => item.dedupeKey === `admin:shop-order:${order.id}`).length, 1);
  assert.equal(adminEvents.filter((item) => item.dedupeKey === `admin:vtu-purchase:${vtu.id}`).length, 1);
  assert.equal(adminEvents.filter((item) => item.dedupeKey === "admin:trade-joined:investment-1").length, 1);
  assert.equal(db.notifications.filter((item) => item.userId === user.id && item.category === "adminEvents").length, 0);
  assert.equal(adminEvents.some((item) => item.message.includes("08012345678")), false);
  assert.deepEqual(
    ["New Deposit Request", "New Withdrawal Request", "New Shop Order", "New VTU Purchase", "User Joined Trade"].every((title) =>
      adminEvents.some((item) => item.title === title)
    ),
    true
  );
  assert.equal(published.filter((item) => item.userId === admin.id && item.category === "adminEvents").length, 5);
});

test("admin notification push failure does not reverse the business transaction", async () => {
  const { db, service, user } = createHarness({
    notificationPublisher: () => Promise.reject(new Error("push transport unavailable")),
  });

  const deposit = service.createDeposit(user, { amount: "5000", currency: "NGN", depositorName: "Ada User" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(db.deposits.length, 1);
  assert.equal(db.deposits[0].id, deposit.id);
  assert.equal(db.deposits[0].status, "PENDING");
  assert.equal(db.notifications.some((item) => item.dedupeKey === `admin:deposit-created:${deposit.id}`), true);
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
  const { admin, db, service, user } = createHarness();
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
  const adminNotification = db.notifications.find((item) => item.userId === admin.id && item.entityId === transaction.id);
  assert.equal(adminNotification?.type, "VTU");
  assert.equal(adminNotification?.title, "New VTU Purchase");
  assert.equal(adminNotification?.metadata?.requestId, "airtime_test_1");

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
  assert.equal(userProduct.priceCurrency, "USD");
  assert.equal(userProduct.displayPrice, "2.2");
  assert.equal(userProduct.ngnEquivalent, "3300");
  assert.equal(adminProduct.providerCostNgn, "3000");
  assert.equal(adminProduct.markupAmount, "300");
  assert.equal(adminProduct.supplierCurrency, "USD");
});

test("emma store products default supplier prices to USD and show NGN equivalent", () => {
  const { admin, service } = createHarness();
  service.updateSettings(admin, {
    exchangeRate: { usdtToNgn: "1600" },
    digitalServices: {
      enabled: true,
      globalMarkupPercent: "25",
    },
  });
  const digitalServices = new DigitalServicesService({
    financialService: service,
    emmaService: {
      baseUrl: "https://ssondigitalworks.online/api/reseller",
      getPublicStatus: () => ({ configured: true }),
      isConfigured: () => true,
    },
  });
  const normalized = digitalServices.normalizeSupplierProduct({
    id: 91,
    name: "Emma AI Plan",
    price: "$10",
    image: "/images/ai.png",
  }, { provider: "emma" });
  service.replaceDigitalServiceProducts([normalized], { provider: "emma" });

  const [userProduct] = service.listDigitalServiceProducts({ store: "emma" });
  const [adminProduct] = service.listDigitalServiceProducts({ store: "emma", admin: true });

  assert.equal(normalized.currency, "USD");
  assert.equal(normalized.providerCost, "10");
  assert.equal(userProduct.priceCurrency, "USD");
  assert.equal(userProduct.displayPrice, "12.5");
  assert.equal(userProduct.ngnEquivalent, "20000");
  assert.equal(adminProduct.providerCostNgn, "16000");
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

test("digital service fixed selling price overrides calculated markup", () => {
  const { admin, service } = createHarness();
  service.updateSettings(admin, {
    digitalServices: {
      enabled: true,
      globalMarkupPercent: "50",
    },
  });
  service.replaceDigitalServiceProducts([
    {
      id: "57",
      supplierProductId: "57",
      provider: "akunding",
      name: "Fixed Price Tool",
      category: "Tools",
      currency: "NGN",
      providerCost: "1000",
      stock: 4,
      available: true,
    },
  ]);
  service.updateDigitalServiceProductOverride(admin, "57", {
    markupMode: "percentage",
    markupValue: "30",
    customPriceNgn: "1200",
  });

  const [userProduct] = service.listDigitalServiceProducts();
  const [adminProduct] = service.listDigitalServiceProducts({ admin: true });

  assert.equal(userProduct.sellingPrice, "1200");
  assert.equal(adminProduct.providerCostNgn, "1000");
  assert.equal(adminProduct.markupAmount, "200");
});

test("digital service percentage markup supports values above 100 percent", () => {
  const { admin, service } = createHarness();
  service.replaceDigitalServiceProducts([
    {
      id: "markup-open",
      supplierProductId: "markup-open",
      provider: "akunding",
      name: "Markup Tool",
      category: "Tools",
      currency: "NGN",
      providerCost: "1000",
      stock: 4,
      available: true,
    },
  ]);

  for (const [markup, expected] of [["0", "1000"], ["50", "1500"], ["100", "2000"], ["150", "2500"], ["300", "4000"]]) {
    service.updateDigitalServiceProductOverride(admin, "markup-open", {
      markupMode: "percentage",
      markupValue: markup,
      customPriceNgn: "0",
    });
    assert.equal(service.getDigitalServiceProduct("markup-open").sellingPrice, expected);
  }

  assert.throws(() => service.updateDigitalServiceProductOverride(admin, "markup-open", { markupValue: "-1" }), /cannot be negative/i);
  assert.throws(() => service.updateDigitalServiceProductOverride(admin, "markup-open", { markupValue: "NaN" }), /valid decimal/i);
  assert.throws(() => service.updateDigitalServiceProductOverride(admin, "markup-open", { markupValue: "Infinity" }), /valid decimal/i);
  assert.throws(() => service.updateDigitalServiceProductOverride(admin, "markup-open", { markupValue: "abc" }), /valid decimal/i);
});

test("digital service API cost drives customer price and checkout ignores client price", async () => {
  const { admin, db, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "10000");
  service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
  service.replaceDigitalServiceProducts([{
    id: "api-price",
    supplierProductId: "api-price",
    provider: "akunding",
    name: "API Price Tool",
    category: "AI",
    currency: "NGN",
    providerCost: "2000",
    stock: 10,
    available: true,
  }]);
  service.updateDigitalServiceProductOverride(admin, "api-price", {
    markupMode: "percentage",
    markupValue: "150",
  });
  const digitalServices = new DigitalServicesService({
    financialService: service,
    akundingService: {
      baseUrl: "https://akunding.shop",
      getPublicStatus: () => ({ configured: true }),
      isConfigured: () => true,
      createOrder: async () => ({ data: { id: "AK-api-price", status: "delivered", activation_link: "https://example.com/api-price" } }),
    },
  });

  const adminProduct = service.getDigitalServiceProduct("api-price", { admin: true });
  assert.equal(adminProduct.providerCostNgn, "2000");
  assert.equal(adminProduct.sellingPrice, "5000");
  await assert.rejects(
    () => digitalServices.purchase(user, { productId: "api-price", quantity: 1, price: "1", expectedAmount: "1" }, { idempotencyKey: "price-stale" }),
    (error) => error.code === "PRICE_CHANGED" && error.currentAmount === "5000"
  );
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "10000");
  assert.equal(db.digitalServiceOrders.length, 0);

  const order = await digitalServices.purchase(user, { productId: "api-price", quantity: 1, price: "1", expectedAmount: "5000" }, { idempotencyKey: "price-ok" });
  assert.equal(order.amountCharged, "5000");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "5000");
});

test("digital service unavailable products remain visible but reject checkout before debit", async () => {
  const { admin, db, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "8000");
  service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
  service.replaceDigitalServiceProducts([
    {
      id: "out-stock",
      supplierProductId: "out-stock",
      provider: "akunding",
      name: "Out Stock Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 0,
      available: false,
      providerStatus: "out_of_stock",
    },
    {
      id: "good-stock",
      supplierProductId: "good-stock",
      provider: "akunding",
      name: "Good Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "1000",
      stock: 5,
      available: true,
    },
  ]);
  const products = service.listDigitalServiceProducts();
  assert.equal(products.some((product) => product.id === "out-stock" && product.available === false), true);
  assert.equal(products.some((product) => product.id === "good-stock" && product.available === true), true);
  assert.throws(() => service.getDigitalServiceProduct("out-stock"), /not available/i);

  let supplierCalls = 0;
  const digitalServices = new DigitalServicesService({
    financialService: service,
    akundingService: {
      baseUrl: "https://akunding.shop",
      getPublicStatus: () => ({ configured: true }),
      isConfigured: () => true,
      createOrder: async () => {
        supplierCalls += 1;
        return { data: { id: "SHOULD-NOT-RUN", status: "delivered" } };
      },
    },
  });
  await assert.rejects(
    () => digitalServices.purchase(user, { productId: "out-stock", paymentMethod: "wallet" }, { idempotencyKey: "out-wallet" }),
    (error) => error.code === "PRODUCT_UNAVAILABLE"
  );
  await assert.rejects(
    () => digitalServices.purchase(user, { productId: "out-stock", paymentMethod: "paystack" }, { idempotencyKey: "out-paystack" }),
    (error) => error.code === "PRODUCT_UNAVAILABLE"
  );
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "8000");
  assert.equal(db.digitalServiceOrders.length, 0);
  assert.equal(db.transactions.length, 0);
  assert.equal(supplierCalls, 0);
});

test("digital service product list skips malformed products without hiding valid products", () => {
  const { service } = createHarness();
  service.db.digitalServiceProducts = [
    {
      id: "malformed-price",
      supplierProductId: "malformed-price",
      provider: "akunding",
      name: "Malformed",
      category: "AI",
      currency: "NGN",
      providerCost: "not-a-number",
      stock: 2,
      available: true,
    },
    {
      id: "valid-price",
      supplierProductId: "valid-price",
      provider: "akunding",
      name: "Valid",
      category: "AI",
      currency: "NGN",
      providerCost: "1000",
      stock: 2,
      available: true,
    },
  ];

  const products = service.listDigitalServiceProducts();
  assert.equal(products.length, 1);
  assert.equal(products[0].id, "valid-price");
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
  assert.equal(product.visible, true);
  assert.equal(product.available, false);
  assert.equal(product.supplierAvailable, false);
});

test("digital service sync preserves products from other stores", () => {
  const { service } = createHarness();
  service.replaceDigitalServiceProducts([
    {
      id: "94",
      supplierProductId: "94",
      provider: "akunding",
      storeKey: "alaba",
      storeName: "Alaba Store",
      name: "Gemini Pro",
      category: "AI",
      currency: "NGN",
      providerCost: "2500",
      available: true,
      stock: 10,
    },
  ], { provider: "akunding" });
  service.replaceDigitalServiceProducts([
    {
      id: "emma:94",
      supplierProductId: "94",
      provider: "emma",
      storeKey: "emma",
      storeName: "Emma Store",
      name: "Emma Canva",
      category: "Design",
      currency: "NGN",
      providerCost: "1500",
      available: true,
      stock: 5,
    },
  ], { provider: "emma" });

  const allProducts = service.listDigitalServiceProducts({ includeInactive: true, admin: true });
  const alabaProducts = service.listDigitalServiceProducts({ store: "alaba", includeInactive: true, admin: true });
  const emmaProducts = service.listDigitalServiceProducts({ store: "emma", includeInactive: true, admin: true });

  assert.equal(allProducts.length, 2);
  assert.equal(alabaProducts.length, 1);
  assert.equal(alabaProducts[0].id, "94");
  assert.equal(emmaProducts.length, 1);
  assert.equal(emmaProducts[0].id, "emma:94");
});

test("digital service products sort available first and preserve missing supplier products", () => {
  const { service } = createHarness();
  service.replaceDigitalServiceProducts([
    {
      id: "out",
      supplierProductId: "out",
      provider: "akunding",
      name: "Out Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "1000",
      available: false,
      stock: 0,
    },
    {
      id: "ready",
      supplierProductId: "ready",
      provider: "akunding",
      name: "Ready Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "1000",
      available: true,
      stock: 5,
    },
  ], { provider: "akunding" });

  assert.deepEqual(service.listDigitalServiceProducts({ includeInactive: true }).map((product) => product.id), ["ready", "out"]);

  service.replaceDigitalServiceProducts([
    {
      id: "ready",
      supplierProductId: "ready",
      provider: "akunding",
      name: "Ready Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "1000",
      available: true,
      stock: 5,
    },
  ], { provider: "akunding" });

  const missing = service.getDigitalServiceProduct("out", { admin: true });
  assert.equal(missing.sourceMissing, true);
  assert.equal(missing.available, false);
  assert.equal(missing.providerStatus, "source_missing");
});

test("generic supplier credentials are encrypted and masked, and disabled supplier blocks checkout", () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    const supplier = service.saveDigitalServiceSupplier(admin, {
      name: "Vendor API",
      baseUrl: "https://vendor.example/api",
      authType: "api_key",
      apiKey: "secret-key-1234",
      productEndpoint: "/products",
      fieldMapping: {
        supplierProductId: "id",
        name: "name",
        supplierCost: "price",
      },
    });

    assert.equal(supplier.id, "vendor-api");
    assert.equal(supplier.secrets.apiKey.includes("secret-key-1234"), false);
    assert.equal(db.systemSettings.digitalServices.suppliers["vendor-api"].apiKeyEncrypted.includes("secret-key-1234"), false);
    assert.equal(service.getDigitalServiceSupplierRuntimeConfig("vendor-api").apiKey, "secret-key-1234");

    service.replaceDigitalServiceProducts([
      {
        id: "vendor-api:123",
        supplierProductId: "123",
        provider: "vendor-api",
        name: "Vendor Tool",
        category: "AI",
        currency: "NGN",
        providerCost: "1000",
        available: true,
        stock: 5,
      },
    ], { provider: "vendor-api" });

    service.disableDigitalServiceSupplier(admin, "vendor-api");
    const product = service.getDigitalServiceProduct("vendor-api:123", { admin: true });
    assert.equal(product.available, false);
    assert.throws(() => service.createDigitalServiceOrder(user, { productId: "vendor-api:123", quantity: 1 }), /not available/i);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("supplier URL validation rejects SSRF targets", async () => {
  await assert.rejects(() => validateSupplierUrl("file:///etc/passwd"), /protocol/i);
  await assert.rejects(() => validateSupplierUrl("https://localhost/products", { resolveDns: false }), /local or private/i);
  await assert.rejects(() => validateSupplierUrl("https://127.0.0.1/products", { resolveDns: false }), /local or private/i);
  await assert.rejects(() => validateSupplierUrl("https://169.254.169.254/latest", { resolveDns: false }), /local or private/i);
  await assert.doesNotReject(() => validateSupplierUrl("https://supplier.example/products", { resolveDns: false }));
});

test("supplier fulfillment errors are classified without treating configuration faults as simple retries", () => {
  const timeout = new Error("timeout");
  timeout.code = "EMMA_TIMEOUT";
  timeout.statusCode = 504;
  assert.equal(classifySupplierFulfillmentError(timeout).fulfillmentStatus, "failed_retryable");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 429 }).supplierStatus, "rate_limited");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 502 }).fulfillmentStatus, "failed_retryable");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 503 }).fulfillmentStatus, "failed_retryable");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 504 }).fulfillmentStatus, "failed_retryable");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 401 }).fulfillmentStatus, "configuration_error");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 403 }).supplierStatus, "supplier_auth_error");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 404 }).supplierStatus, "supplier_endpoint_unavailable");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 405 }).supplierStatus, "supplier_method_not_allowed");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 400 }).fulfillmentStatus, "manual_review");
  assert.equal(classifySupplierFulfillmentError({ statusCode: 422 }).supplierStatus, "supplier_payload_error");
});

test("supplier settings add and edit preserve unrelated system settings", () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service } = createHarness();
    db.systemSettings.general.platformName = "NetrueFi Production";
    db.systemSettings.deposit.bankName = "Preserve Bank";
    db.systemSettings.trading.minJoinUsdt = "75";
    service.saveDigitalServiceSupplier(admin, {
      id: "vendor-keep",
      name: "Vendor Keep",
      baseUrl: "https://vendor.example/api",
      productEndpoint: "/products",
      apiKey: "secret-one",
    });
    service.ensureState();
    assert.equal(db.systemSettings.general.platformName, "NetrueFi Production");
    assert.equal(db.systemSettings.deposit.bankName, "Preserve Bank");
    assert.equal(db.systemSettings.trading.minJoinUsdt, "75");
    assert.ok(db.systemSettings.digitalServices.suppliers["vendor-keep"]);

    service.saveDigitalServiceSupplier(admin, {
      id: "vendor-keep",
      name: "Vendor Keep Edited",
      baseUrl: "https://vendor.example/api",
      productEndpoint: "/catalog",
    });
    service.ensureState();
    assert.equal(db.systemSettings.general.platformName, "NetrueFi Production");
    assert.equal(db.systemSettings.deposit.bankName, "Preserve Bank");
    assert.equal(db.systemSettings.trading.minJoinUsdt, "75");
    assert.equal(db.systemSettings.digitalServices.suppliers["vendor-keep"].productEndpoint, "/catalog");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("Emma adapter uses documented catalog balance and order endpoints", async () => {
  const previousKey = process.env.EMMA_RESELLER_API_KEY;
  process.env.EMMA_RESELLER_API_KEY = "emma-test-key";
  try {
    const calls = [];
    const emma = new EmmaResellerService({
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options });
        const parsed = new URL(String(url));
        const action = parsed.searchParams.get("action");
        if (action === "products") {
          return jsonResponse({ data: [{ id: "EMMA-PROD-1", name: "Gemini", price: 2, status: "available" }] });
        }
        if (action === "balance") {
          return jsonResponse({ data: { balance: 25000, currency: "NGN" } });
        }
        if (action === "order") {
          return jsonResponse({
            data: {
              id: "EMMA-ORDER-1",
              status: "delivered",
              external_order_id: "REQ-123",
              activation_link: "https://example.com/emma",
            },
          });
        }
        return jsonResponse({ error: "Unexpected action" }, { ok: false, status: 404 });
      },
    });

    await emma.listProducts();
    await emma.getBalance();
    await emma.createOrder({ productId: "EMMA-PROD-1", quantity: 1, idempotencyKey: "REQ-123" });

    const [catalogCall, balanceCall, orderCall] = calls;
    assert.equal(new URL(catalogCall.url).pathname, "/api/reseller");
    assert.equal(new URL(catalogCall.url).searchParams.get("action"), "products");
    assert.equal(catalogCall.options.method, "GET");

    assert.equal(new URL(balanceCall.url).pathname, "/api/reseller");
    assert.equal(new URL(balanceCall.url).searchParams.get("action"), "balance");
    assert.equal(balanceCall.options.method, "GET");

    const orderUrl = new URL(orderCall.url);
    assert.equal(orderUrl.pathname, "/api/reseller");
    assert.equal(orderUrl.searchParams.get("action"), "order");
    assert.equal(orderCall.options.method, "POST");
    assert.equal(orderCall.options.headers.Authorization, "Bearer emma-test-key");
    assert.equal(orderCall.options.headers["Content-Type"], "application/json");
    assert.equal(orderCall.options.headers["X-API-Key"], undefined);
    assert.equal(orderCall.options.headers.apiKey, undefined);
    assert.deepEqual(JSON.parse(orderCall.options.body), {
      product_id: "EMMA-PROD-1",
      quantity: 1,
      external_order_id: "REQ-123",
    });
    for (const call of calls) {
      assert.doesNotMatch(new URL(call.url).pathname, /\/(?:orders|purchase|v1\/orders)/);
    }
  } finally {
    if (previousKey === undefined) {
      delete process.env.EMMA_RESELLER_API_KEY;
    } else {
      process.env.EMMA_RESELLER_API_KEY = previousKey;
    }
  }
});

test("Emma fulfillment retries reuse external_order_id and different orders get different IDs", async () => {
  const previousEmmaKey = process.env.EMMA_RESELLER_API_KEY;
  const previousSettingsKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.EMMA_RESELLER_API_KEY = "emma-test-key";
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:IDEMP",
        supplierProductId: "IDEMP",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "Emma Idempotent Tool",
        category: "AI",
        currency: "NGN",
        providerCost: "4000",
        available: true,
        stock: 10,
      },
    ], { provider: "emma" });

    const orderBodies = [];
    const emma = new EmmaResellerService({
      fetchImpl: async (url, options = {}) => {
        const action = new URL(String(url)).searchParams.get("action");
        if (action !== "order") {
          return jsonResponse({ data: [] });
        }
        const body = JSON.parse(options.body || "{}");
        orderBodies.push(body);
        if (orderBodies.length === 1) {
          const timeout = new Error("timeout");
          timeout.name = "AbortError";
          throw timeout;
        }
        return jsonResponse({
          data: {
            id: `EMMA-${orderBodies.length}`,
            status: "delivered",
            external_order_id: body.external_order_id,
            activation_link: `https://example.com/emma-${orderBodies.length}`,
          },
        });
      },
    });
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: emma,
    });

    const failed = await digitalServices.purchase(user, { productId: "emma:IDEMP", quantity: 1 }, { idempotencyKey: "emma-idem-1" });
    assert.equal(failed.paymentStatus, "paid");
    assert.equal(failed.fulfillmentStatus, "failed_retryable");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "6000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "4000");

    const delivered = await digitalServices.fulfillPaidOrder(failed.id, admin);
    assert.equal(delivered.status, "delivered");
    assert.equal(orderBodies[1].external_order_id, orderBodies[0].external_order_id);
    assert.equal(orderBodies[0].product_id, "IDEMP");
    assert.equal(db.digitalServiceOrders.length, 1);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === failed.requestId).length, 1);

    const second = await digitalServices.purchase(user, { productId: "emma:IDEMP", quantity: 1 }, { idempotencyKey: "emma-idem-2" });
    assert.equal(second.status, "delivered");
    assert.notEqual(orderBodies[2].external_order_id, orderBodies[0].external_order_id);
    assert.equal(db.digitalServiceOrders.length, 2);
  } finally {
    if (previousEmmaKey === undefined) {
      delete process.env.EMMA_RESELLER_API_KEY;
    } else {
      process.env.EMMA_RESELLER_API_KEY = previousEmmaKey;
    }
    if (previousSettingsKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousSettingsKey;
    }
  }
});

test("existing paid Emma order retries documented endpoint without a second debit", async () => {
  const previousEmmaKey = process.env.EMMA_RESELLER_API_KEY;
  const previousSettingsKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.EMMA_RESELLER_API_KEY = "emma-test-key";
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:PAID",
        supplierProductId: "PAID",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "Emma Existing Paid Tool",
        category: "AI",
        currency: "NGN",
        providerCost: "4000",
        available: true,
        stock: 5,
      },
    ], { provider: "emma" });

    const product = service.getDigitalServiceProduct("emma:PAID", { admin: true });
    const paid = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    const existingRecord = db.digitalServiceOrders[0];
    existingRecord.fulfillmentStatus = "configuration_error";
    existingRecord.supplierStatus = "supplier_endpoint_unavailable";
    existingRecord.lastFulfillmentError = "HTTP 404: old guessed endpoint failed.";
    existingRecord.supplierOrderId = "";
    const availableAfterDebit = service.ensureWallet(user.id, "NGN").availableBalance;
    const lockedAfterDebit = service.ensureWallet(user.id, "NGN").lockedBalance;
    const transactionCount = db.transactions.length;

    const calls = [];
    const emma = new EmmaResellerService({
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options, body: JSON.parse(options.body || "{}") });
        return jsonResponse({
          data: {
            id: "EMMA-EXISTING-1",
            status: "delivered",
            external_order_id: paid.requestId,
            activation_link: "https://example.com/existing-paid",
          },
        });
      },
    });
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: emma,
    });

    const delivered = await digitalServices.fulfillPaidOrder(paid.id, admin);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.delivery.activationLink, "https://example.com/existing-paid");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, availableAfterDebit);
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
    assert.equal(lockedAfterDebit, "4000");
    assert.equal(db.transactions.length, transactionCount);
    assert.equal(db.digitalServiceOrders.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get("action"), "order");
    assert.equal(calls[0].body.external_order_id, paid.requestId);
    assert.equal(calls[0].body.product_id, "PAID");
  } finally {
    if (previousEmmaKey === undefined) {
      delete process.env.EMMA_RESELLER_API_KEY;
    } else {
      process.env.EMMA_RESELLER_API_KEY = previousEmmaKey;
    }
    if (previousSettingsKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousSettingsKey;
    }
  }
});

test("Emma exact provider delivery_items contract is normalized safely", () => {
  const fixture = {
    ok: true,
    order_id: 8644,
    product_id: 31,
    product_name: "LEONARDO AI VIDEO GEN",
    quantity: 1,
    amount: 0.9,
    delivery_items: [
      "test@example.com:ExamplePassword",
    ],
    external_order_id: "digital_test_order",
    status: "delivered",
  };

  const delivery = extractDeliveryPayload(fixture);

  assert.equal(mapSupplierStatus(fixture), "delivered");
  assert.equal(delivery.deliveryItems.length, 1);
  assert.equal(delivery.deliveryItems[0].rawItem, "test@example.com:ExamplePassword");
  assert.equal(delivery.deliveryItems[0].email, "test@example.com");
  assert.equal(delivery.deliveryItems[0].password, "ExamplePassword");
  assert.equal(delivery.rawItem, "test@example.com:ExamplePassword");
  assert.equal(delivery.email, "test@example.com");
  assert.equal(delivery.password, "ExamplePassword");
});

test("Emma delivery_items supports pipe, multiple, and unstructured delivery values", () => {
  const pipeDelivery = extractDeliveryPayload({
    ok: true,
    order_id: 8645,
    status: "delivered",
    delivery_items: ["test@example.com | ExamplePassword"],
  });
  assert.equal(pipeDelivery.deliveryItems[0].rawItem, "test@example.com | ExamplePassword");
  assert.equal(pipeDelivery.deliveryItems[0].email, "test@example.com");
  assert.equal(pipeDelivery.deliveryItems[0].password, "ExamplePassword");

  const multipleDelivery = extractDeliveryPayload({
    ok: true,
    order_id: 8646,
    quantity: 2,
    status: "delivered",
    delivery_items: [
      "one@example.com:Password1",
      "two@example.com | Password2",
    ],
  });
  assert.equal(multipleDelivery.deliveryItems.length, 2);
  assert.equal(multipleDelivery.deliveryItems[0].rawItem, "one@example.com:Password1");
  assert.equal(multipleDelivery.deliveryItems[1].rawItem, "two@example.com | Password2");
  assert.equal(multipleDelivery.deliveryItems[1].email, "two@example.com");
  assert.equal(multipleDelivery.deliveryItems[1].password, "Password2");

  const unstructuredDelivery = extractDeliveryPayload({
    ok: true,
    order_id: 8647,
    status: "delivered",
    delivery_items: ["LICENSE-ABC-123-XYZ"],
  });
  assert.equal(mapSupplierStatus({ ok: true, status: "delivered", delivery_items: ["LICENSE-ABC-123-XYZ"] }), "delivered");
  assert.equal(unstructuredDelivery.deliveryItems[0].rawItem, "LICENSE-ABC-123-XYZ");
  assert.equal(unstructuredDelivery.deliveryItems[0].value, "LICENSE-ABC-123-XYZ");
  assert.equal(unstructuredDelivery.deliveryItems[0].email, undefined);
  assert.equal(unstructuredDelivery.deliveryItems[0].password, undefined);
});

test("Emma delivery_items response fulfills order with encrypted account credentials", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:31",
        supplierProductId: "31",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "LEONARDO AI VIDEO GEN",
        category: "AI",
        currency: "NGN",
        providerCost: "1755",
        available: true,
        stock: 3,
      },
    ], { provider: "emma" });

    const emma = {
      isConfigured: () => true,
      createOrder: async ({ idempotencyKey }) => ({
        ok: true,
        order_id: 8644,
        product_id: 31,
        product_name: "LEONARDO AI VIDEO GEN",
        quantity: 1,
        amount: 0.9,
        delivery_items: ["customer@example.com | secret-pass"],
        external_order_id: idempotencyKey,
        status: "delivered",
      }),
    };
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: emma,
    });

    const order = await digitalServices.purchase(user, { productId: "emma:31", quantity: 1 }, { idempotencyKey: "emma-real-shape" });
    const stored = db.digitalServiceOrders[0];

    assert.equal(order.status, "delivered");
    assert.equal(order.fulfillmentStatus, "fulfilled");
    assert.equal(stored.supplierOrderId, "8644");
    assert.equal(order.delivery.email, "customer@example.com");
    assert.equal(order.delivery.password, "secret-pass");
    assert.equal(order.delivery.rawItem, "customer@example.com | secret-pass");
    assert.equal(order.delivery.deliveryItems[0].rawItem, "customer@example.com | secret-pass");
    assert.equal(order.delivery.deliveryItems[0].email, "customer@example.com");
    assert.equal(stored.deliveryEncrypted.includes("secret-pass"), false);
    assert.equal(JSON.stringify(stored.supplierResponse).includes("secret-pass"), false);
    assert.equal(stored.supplierResponse.data.delivery_items, "[stored_in_encrypted_delivery]");
    assert.equal(stored.supplierResponse.data.external_order_id, stored.requestId);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "3245");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
    assert.equal(db.transactions.filter((item) => item.reference === order.requestId).length, 1);
    assert.equal(service.listNotifications(user).some((item) => item.dedupeKey === `digital-service-delivered:${order.id}`), true);
    assert.equal(JSON.stringify(service.listNotifications(user)).includes("secret-pass"), false);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("Emma delivery recovery reuses the same external_order_id without new debit or order", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:RECOVER",
        supplierProductId: "31",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "LEONARDO AI VIDEO GEN",
        category: "AI",
        currency: "NGN",
        providerCost: "1755",
        available: true,
        stock: 3,
      },
    ], { provider: "emma" });
    const product = service.getDigitalServiceProduct("emma:RECOVER", { admin: true });
    const paid = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    const record = db.digitalServiceOrders[0];
    record.requestId = "digital_existing_123";
    record.status = "delivered";
    record.paymentStatus = "paid";
    record.fulfillmentStatus = "fulfilled";
    record.supplierStatus = "delivered";
    record.supplierOrderId = "8644";
    record.deliveryEncrypted = "";
    record.supplierResponse = null;
    record.balanceReserved = false;
    record.completedAt = "2026-08-30T10:01:00.000Z";
    service.ensureWallet(user.id, "NGN").lockedBalance = "0";
    service.updateDigitalServiceLedgerStatus(paid.requestId, "SUCCESSFUL", service.ensureWallet(user.id, "NGN").availableBalance);
    service.db.transactions.find((item) => item.reference === paid.requestId).reference = record.requestId;

    const bodies = [];
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: {
        isConfigured: () => true,
        createOrder: async (input) => {
          bodies.push(input);
          return {
            ok: true,
            order_id: 8644,
            product_id: 31,
            product_name: "LEONARDO AI VIDEO GEN",
            quantity: 1,
            amount: 0.9,
            delivery_items: ["existing@example.com:RecoveredPassword"],
            external_order_id: input.idempotencyKey,
            status: "delivered",
          };
        },
      },
    });
    const walletBefore = { ...service.ensureWallet(user.id, "NGN") };
    const orderCountBefore = db.digitalServiceOrders.length;
    const transactionCountBefore = db.transactions.length;

    const [recovered, duplicate] = await Promise.all([
      digitalServices.recoverOrderDelivery(record.id, admin),
      digitalServices.recoverOrderDelivery(record.id, admin),
    ]);

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].idempotencyKey, "digital_existing_123");
    assert.equal(bodies[0].productId, "31");
    assert.equal(recovered.id, duplicate.id);
    assert.equal(recovered.status, "delivered");
    assert.equal(recovered.delivery.email, "existing@example.com");
    assert.equal(recovered.delivery.rawItem, "existing@example.com:RecoveredPassword");
    assert.equal(db.digitalServiceOrders.length, orderCountBefore);
    assert.equal(db.transactions.length, transactionCountBefore);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, walletBefore.availableBalance);
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, walletBefore.lockedBalance);
    assert.equal(db.digitalServiceOrders[0].requestId, "digital_existing_123");
    assert.equal(JSON.stringify(db.digitalServiceOrders[0].supplierResponse).includes("RecoveredPassword"), false);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("delivered Emma order with stored delivery_items can be repaired without supplier retry", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:31",
        supplierProductId: "31",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "LEONARDO AI VIDEO GEN",
        category: "AI",
        currency: "NGN",
        providerCost: "1755",
        available: true,
        stock: 3,
      },
    ], { provider: "emma" });
    const product = service.getDigitalServiceProduct("emma:31", { admin: true });
    const paid = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    const record = db.digitalServiceOrders[0];
    record.status = "delivered";
    record.paymentStatus = "paid";
    record.fulfillmentStatus = "fulfilled";
    record.supplierStatus = "delivered";
    record.supplierOrderId = "8644";
    record.supplierResponse = {
      data: {
        ok: true,
        order_id: 8644,
        product_id: "31",
        product_name: "LEONARDO AI VIDEO GEN",
        quantity: 1,
        amount: 0.9,
        delivery_items: ["customer@example.com:secret-pass"],
        external_order_id: paid.requestId,
        status: "completed",
      },
    };
    record.deliveryEncrypted = "";
    record.balanceReserved = false;
    record.completedAt = "2026-08-30T10:01:00.000Z";
    service.ensureWallet(user.id, "NGN").lockedBalance = "0";
    service.updateDigitalServiceLedgerStatus(record.requestId, "SUCCESSFUL", service.ensureWallet(user.id, "NGN").availableBalance);

    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: {
        isConfigured: () => true,
        createOrder: async () => {
          supplierCalls += 1;
          throw new Error("must not call supplier");
        },
      },
    });
    const beforeWallet = { ...service.ensureWallet(user.id, "NGN") };
    const beforeTransactions = db.transactions.length;

    const repaired = await digitalServices.fulfillPaidOrder(record.id, admin);

    assert.equal(supplierCalls, 0);
    assert.equal(repaired.status, "delivered");
    assert.equal(repaired.delivery.email, "customer@example.com");
    assert.equal(repaired.delivery.password, "secret-pass");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, beforeWallet.availableBalance);
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, beforeWallet.lockedBalance);
    assert.equal(db.transactions.length, beforeTransactions);
    assert.equal(JSON.stringify(db.digitalServiceOrders[0].supplierResponse).includes("secret-pass"), false);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("Emma success without delivery is manual review and does not create duplicate debit on retry", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:ASYNC",
        supplierProductId: "ASYNC",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "Emma Async Tool",
        category: "AI",
        currency: "NGN",
        providerCost: "4000",
        available: true,
        stock: 2,
      },
    ], { provider: "emma" });

    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: {
        isConfigured: () => true,
        createOrder: async ({ idempotencyKey }) => {
          supplierCalls += 1;
          return {
            ok: true,
            order_id: "EMMA-ASYNC-1",
            external_order_id: idempotencyKey,
            status: "completed",
          };
        },
      },
    });

    const order = await digitalServices.purchase(user, { productId: "emma:ASYNC", quantity: 1 }, { idempotencyKey: "emma-async" });
    const retried = await digitalServices.fulfillPaidOrder(order.id, admin);

    assert.equal(order.status, "processing");
    assert.equal(order.paymentStatus, "paid");
    assert.equal(order.fulfillmentStatus, "manual_review");
    assert.equal(db.digitalServiceOrders[0].supplierOrderId, "EMMA-ASYNC-1");
    assert.match(order.lastFulfillmentError, /delivery details were not recognized/i);
    assert.equal(retried.id, order.id);
    assert.equal(supplierCalls, 1);
    assert.equal(db.digitalServiceOrders.length, 1);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === order.requestId).length, 1);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "4000");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("Emma 404 order endpoint is configuration error and traceable without a second charge", async () => {
  const { admin, db, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "5000");
  service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
  service.replaceDigitalServiceProducts([
    {
      id: "emma:404",
      supplierProductId: "404",
      provider: "emma",
      storeKey: "emma",
      storeName: "Emma Store",
      name: "Emma Endpoint Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      available: true,
      stock: 2,
    },
  ], { provider: "emma" });

  let supplierCalls = 0;
  const digitalServices = new DigitalServicesService({
    financialService: service,
    akundingService: { isConfigured: () => false },
    emmaService: {
      baseUrl: "https://ssondigitalworks.online/api/reseller",
      isConfigured: () => true,
      listOrders: async () => [],
      createOrder: async () => {
        supplierCalls += 1;
        const error = new Error("Endpoint not found");
        error.statusCode = 404;
        throw error;
      },
    },
  });

  const order = await digitalServices.purchase(user, { productId: "emma:404", quantity: 1 }, { idempotencyKey: "emma-404" });
  const wallet = service.ensureWallet(user.id, "NGN");
  assert.equal(order.status, "processing");
  assert.equal(order.paymentStatus, "paid");
  assert.equal(order.fulfillmentStatus, "configuration_error");
  assert.equal(order.supplierStatus, "supplier_endpoint_unavailable");
  assert.match(order.lastFulfillmentError, /HTTP 404/i);
  assert.equal(wallet.availableBalance, "1000");
  assert.equal(wallet.lockedBalance, "4000");
  assert.equal(supplierCalls, 1);

  const retried = await digitalServices.purchase(user, { productId: "emma:404", quantity: 1 }, { idempotencyKey: "emma-404" });
  assert.equal(retried.id, order.id);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1000");
  assert.equal(db.digitalServiceOrders.length, 1);
});

test("Emma 405 configuration error can retry the same paid order after correction", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([
      {
        id: "emma:405",
        supplierProductId: "405",
        provider: "emma",
        storeKey: "emma",
        storeName: "Emma Store",
        name: "Emma Method Tool",
        category: "AI",
        currency: "NGN",
        providerCost: "4000",
        available: true,
        stock: 2,
      },
    ], { provider: "emma" });

    let supplierCalls = 0;
    const requestIds = [];
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      emmaService: {
        baseUrl: "https://ssondigitalworks.online/api/reseller",
        isConfigured: () => true,
        listOrders: async () => [],
        createOrder: async ({ idempotencyKey }) => {
          supplierCalls += 1;
          requestIds.push(idempotencyKey);
          if (supplierCalls === 1) {
            const error = new Error("Method not allowed");
            error.statusCode = 405;
            throw error;
          }
          return { data: { id: "EMMA-405-OK", status: "delivered", activation_link: "https://example.com/emma-405" } };
        },
      },
    });

    const failed = await digitalServices.purchase(user, { productId: "emma:405", quantity: 1 }, { idempotencyKey: "emma-405" });
    assert.equal(failed.paymentStatus, "paid");
    assert.equal(failed.status, "processing");
    assert.equal(failed.fulfillmentStatus, "configuration_error");
    assert.equal(failed.supplierStatus, "supplier_method_not_allowed");
    assert.match(failed.lastFulfillmentError, /HTTP 405/i);

    const delivered = await digitalServices.fulfillPaidOrder(failed.id, admin);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.fulfillmentStatus, "fulfilled");
    assert.equal(delivered.delivery.activationLink, "https://example.com/emma-405");
    assert.equal(supplierCalls, 2);
    assert.equal(requestIds[1], requestIds[0]);
    assert.equal(db.digitalServiceOrders.length, 1);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === failed.requestId).length, 1);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
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

test("wallet digital service purchase uses authoritative server price and idempotency response", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "price-safe",
      supplierProductId: "price-safe",
      provider: "akunding",
      name: "Gemini Pro",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 10,
      available: true,
    }]);
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        createOrder: async () => ({ data: { id: "AK-price", status: "delivered", activation_link: "https://example.com/activate" } }),
      },
    });

    const order = await digitalServices.purchase(user, { productId: "price-safe", quantity: 1, amount: "1" });
    const response = { order };
    service.saveIdempotent("digital-service:order", user.id, "same-click", response);
    const duplicate = service.findIdempotent("digital-service:order", user.id, "same-click");

    assert.equal(order.amountCharged, "4000");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "6000");
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === order.requestId).length, 1);
    assert.equal(db.digitalServiceOrders.length, 1);
    assert.equal(duplicate.order.id, order.id);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "6000");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("duplicate wallet digital service purchase key does not double debit or reorder", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "duplicate-safe",
      supplierProductId: "duplicate-safe",
      provider: "akunding",
      name: "Gemini Pro",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 10,
      available: true,
    }]);
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        createOrder: async () => {
          supplierCalls += 1;
          return { data: { id: "AK-duplicate", status: "delivered", activation_link: "https://example.com/duplicate" } };
        },
      },
    });

    const first = await digitalServices.purchase(user, { productId: "duplicate-safe", quantity: 1 }, { idempotencyKey: "dup-key" });
    const second = await digitalServices.purchase(user, { productId: "duplicate-safe", quantity: 1 }, { idempotencyKey: "dup-key" });

    assert.equal(first.id, second.id);
    assert.equal(supplierCalls, 1);
    assert.equal(db.digitalServiceOrders.length, 1);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === first.requestId).length, 1);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "6000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("wallet digital service purchase rejects insufficient balance without partial debit", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "2000");
  service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
  service.replaceDigitalServiceProducts([{
    id: "too-costly",
    supplierProductId: "too-costly",
    provider: "akunding",
    name: "AI Tool",
    category: "AI",
    currency: "NGN",
    providerCost: "4000",
    stock: 10,
    available: true,
  }]);
  const product = service.getDigitalServiceProduct("too-costly", { admin: true });

  assert.throws(() => service.createDigitalServiceOrder(user, { product, quantity: 1 }), /insufficient wallet balance/i);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2000");
  assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  assert.equal(service.listDigitalServiceOrders(user).length, 0);
});

test("Paystack digital service payment verifies amount and fulfills once", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "2500");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "paystack-product",
      supplierProductId: "paystack-product",
      provider: "akunding",
      name: "Gemini Pro",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 10,
      available: true,
    }]);
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        createOrder: async () => {
          supplierCalls += 1;
          return { data: { id: "AK-paystack", status: "delivered", activation_link: "https://example.com/paystack" } };
        },
      },
    });

    const pending = await digitalServices.purchase(user, { productId: "paystack-product", paymentMethod: "paystack" });
    assert.equal(pending.status, "pending_payment");
    assert.equal(pending.paymentStatus, "pending");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");

    assert.throws(
      () => service.confirmDigitalServicePaystackPayment(pending.paymentReference, {
        status: "success",
        reference: pending.paymentReference,
        currency: "NGN",
        amount: toKobo("1"),
      }, user),
      /amount does not match/i
    );
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");

    const paid = service.confirmDigitalServicePaystackPayment(pending.paymentReference, {
      status: "success",
      reference: pending.paymentReference,
      currency: "NGN",
      amount: toKobo("4000"),
    }, user);
    const delivered = await digitalServices.fulfillPaidOrder(paid.id, user);
    const duplicatePaid = service.confirmDigitalServicePaystackPayment(pending.paymentReference, {
      status: "success",
      reference: pending.paymentReference,
      currency: "NGN",
      amount: toKobo("4000"),
    }, user);
    await digitalServices.fulfillPaidOrder(duplicatePaid.id, user);

    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.delivery.activationLink, "https://example.com/paystack");
    assert.equal(supplierCalls, 1);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === pending.requestId).length, 1);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("Paystack paid order can retry retryable supplier failure without another payment", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "retry-product",
      supplierProductId: "retry-product",
      provider: "akunding",
      name: "Retry Product",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 10,
      available: true,
    }]);
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        listOrders: async () => [],
        createOrder: async () => {
          supplierCalls += 1;
          if (supplierCalls === 1) {
            const error = new Error("Supplier timed out.");
            error.statusCode = 504;
            error.code = "AKUNDING_TIMEOUT";
            throw error;
          }
          return { data: { id: "AK-retry", status: "delivered", activation_link: "https://example.com/retry" } };
        },
      },
    });

    const pending = await digitalServices.purchase(user, { productId: "retry-product", paymentMethod: "paystack" }, { idempotencyKey: "retry-pay" });
    const paid = service.confirmDigitalServicePaystackPayment(pending.paymentReference, {
      status: "success",
      reference: pending.paymentReference,
      currency: "NGN",
      amount: toKobo("4000"),
    }, user);
    const failed = await digitalServices.fulfillPaidOrder(paid.id, user);
    assert.equal(failed.paymentStatus, "paid");
    assert.equal(failed.fulfillmentStatus, "failed_retryable");
    assert.equal(failed.status, "processing");
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === pending.requestId).length, 1);

    const delivered = await digitalServices.fulfillPaidOrder(paid.id, user);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.fulfillmentStatus, "fulfilled");
    assert.equal(delivered.delivery.activationLink, "https://example.com/retry");
    assert.equal(supplierCalls, 2);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === pending.requestId).length, 1);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("Paystack fulfillment retry reconciles ambiguous supplier timeout by request reference", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "ambiguous-product",
      supplierProductId: "ambiguous-product",
      provider: "akunding",
      name: "Ambiguous Product",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 10,
      available: true,
    }]);
    let supplierCalls = 0;
    let recordedRequestId = "";
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        listOrders: async () => recordedRequestId
          ? [{ id: "AK-reconciled", client_reference: recordedRequestId, status: "delivered", activation_link: "https://example.com/reconciled" }]
          : [],
        createOrder: async ({ idempotencyKey }) => {
          supplierCalls += 1;
          recordedRequestId = idempotencyKey;
          const error = new Error("Supplier request timed out after submit.");
          error.statusCode = 504;
          error.code = "AKUNDING_TIMEOUT";
          throw error;
        },
      },
    });

    const pending = await digitalServices.purchase(user, { productId: "ambiguous-product", paymentMethod: "paystack" }, { idempotencyKey: "ambiguous-pay" });
    const paid = service.confirmDigitalServicePaystackPayment(pending.paymentReference, {
      status: "success",
      reference: pending.paymentReference,
      currency: "NGN",
      amount: toKobo("4000"),
    }, user);
    const failed = await digitalServices.fulfillPaidOrder(paid.id, user);
    assert.equal(failed.fulfillmentStatus, "failed_retryable");

    const delivered = await digitalServices.fulfillPaidOrder(paid.id, user);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.delivery.activationLink, "https://example.com/reconciled");
    assert.equal(supplierCalls, 1);
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === pending.requestId).length, 1);
  } finally {
    if (previousKey === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("simultaneous paid fulfillment requests do not duplicate supplier orders", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, service, user } = createHarness();
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "simul-product",
      supplierProductId: "simul-product",
      provider: "akunding",
      name: "Simul Product",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 10,
      available: true,
    }]);
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: {
        baseUrl: "https://akunding.shop",
        getPublicStatus: () => ({ configured: true }),
        isConfigured: () => true,
        listOrders: async () => [],
        createOrder: async () => {
          supplierCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { data: { id: "AK-simul", status: "delivered", activation_link: "https://example.com/simul" } };
        },
      },
    });

    const pending = await digitalServices.purchase(user, { productId: "simul-product", paymentMethod: "paystack" }, { idempotencyKey: "simul-pay" });
    const paid = service.confirmDigitalServicePaystackPayment(pending.paymentReference, {
      status: "success",
      reference: pending.paymentReference,
      currency: "NGN",
      amount: toKobo("4000"),
    }, user);
    const [first, second] = await Promise.all([
      digitalServices.fulfillPaidOrder(paid.id, user),
      digitalServices.fulfillPaidOrder(paid.id, user),
    ]);

    assert.equal(first.status, "delivered");
    assert.equal(second.status, "delivered");
    assert.equal(first.id, second.id);
    assert.equal(supplierCalls, 1);
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

test("digital service purchase uses export payload when order lookup returns 404", async () => {
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
        id: "94",
        supplierProductId: "94",
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
            id: 9400,
            status: "pending",
          },
        }),
        getOrder: async () => {
          const error = new Error("Order not found.");
          error.statusCode = 404;
          error.payload = { detail: "Not found" };
          throw error;
        },
        exportOrder: async (orderId) => {
          assert.equal(orderId, "9400");
          return { data: "Activate with https://gemini.google.com/activate/exported-plan" };
        },
      },
    });

    const order = await digitalServices.purchase(user, { productId: "94", quantity: 1 });

    assert.equal(order.status, "delivered");
    assert.equal(order.supplierOrderId, "");
    assert.equal(order.delivery.activationLink, "https://gemini.google.com/activate/exported-plan");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7500");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
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

test("missing digital service order history can be recovered without changing balances", () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, {
      digitalServices: {
        enabled: true,
        globalMarkupPercent: "0",
      },
    });
    service.replaceDigitalServiceProducts([
      {
        id: "93",
        supplierProductId: "93",
        provider: "akunding",
        name: "Gemini Pro",
        category: "AI",
        currency: "NGN",
        providerCost: "2500",
        stock: 5,
        available: true,
      },
    ]);
    const product = service.getDigitalServiceProduct("93", { admin: true });
    const pending = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    const delivered = service.applyDigitalServiceOrderResult(pending.id, {
      status: "delivered",
      supplierStatus: "pending",
      supplierOrderId: "AK-93",
      delivery: { activationLink: "https://gemini.google.com/activate/restored-plan" },
    }, user);
    service.saveIdempotent("digital-service:order", user.id, "digital-restore-key", { order: delivered });

    const walletBefore = { ...service.ensureWallet(user.id, "NGN") };
    db.digitalServiceOrders = [];

    const recovery = service.recoverMissingDigitalServiceOrdersFromHistory(admin);
    const [restored] = service.listDigitalServiceOrders(user, { limit: 10 });

    assert.equal(recovery.count, 1);
    assert.equal(restored.status, "delivered");
    assert.equal(restored.requestId, pending.requestId);
    assert.equal(restored.delivery.activationLink, "https://gemini.google.com/activate/restored-plan");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, walletBefore.availableBalance);
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, walletBefore.lockedBalance);
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

test("Efem adapter uses documented reseller endpoints and X-API-Key auth", async () => {
  const calls = [];
  const efem = new EfemResellerService({
    config: { apiKey: "efem-key", baseUrl: "https://api-geminipro.ignorelist.com/api/reseller/v1" },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
      const path = new URL(String(url)).pathname.replace("/api/reseller/v1", "");
      if (path === "/account/info") return jsonResponse({ ok: true, account: { id: "acct" } });
      if (path === "/account/balance") return jsonResponse({ ok: true, balance: "0.00", currency: "USD" });
      if (path === "/products") return jsonResponse({ ok: true, products: [{ productId: 1, title: "Gemini Pro", price: "0.90", currency: "USD", stock: 5, inStock: true }] });
      if (path === "/products/1") return jsonResponse({ ok: true, product: { productId: 1, title: "Gemini Pro" } });
      if (path === "/orders") return jsonResponse({ ok: true, order: { orderCode: "rs_test", status: "completed", value: "TEST_DELIVERY" } });
      if (path === "/orders/rs_test") return jsonResponse({ ok: true, order: { orderCode: "rs_test", status: "completed", value: "TEST_DELIVERY" } });
      return jsonResponse({ error: "not_found" }, { ok: false, status: 404 });
    },
  });

  await efem.getAccountInfo();
  await efem.getBalance();
  await efem.listProducts();
  await efem.getProduct(1);
  await efem.createOrder({ productId: 1, quantity: 1 });
  await efem.listOrders();
  await efem.getOrder("rs_test");

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname.replace("/api/reseller/v1", "")}`), [
    "GET /account/info",
    "GET /account/balance",
    "GET /products",
    "GET /products/1",
    "POST /orders",
    "GET /orders",
    "GET /orders/rs_test",
  ]);
  assert.equal(calls.every((call) => call.headers["X-API-Key"] === "efem-key"), true);
  assert.deepEqual(calls[4].body, { productId: 1, quantity: 1 });
});

test("selected supplier product import upserts only selected products", async () => {
  const { service } = createHarness();
  const supplierConfig = {
    id: "efem",
    type: "efem",
    name: "Efem Store",
    storeKey: "efem",
    enabled: true,
    apiKey: "test-only",
    baseUrl: "https://api-geminipro.ignorelist.com/api/reseller/v1",
  };
  service.getDigitalServiceSupplierRuntimeConfig = () => supplierConfig;
  service.updateDigitalServiceSupplierSyncStats = () => undefined;
  const digitalServices = new DigitalServicesService({
    financialService: service,
    efemService: {
      baseUrl: supplierConfig.baseUrl,
      isConfigured: () => true,
      listProducts: async () => ({
        products: [
          { id: 101, name: "Selected", price: 10, currency: "USD", stock: 5 },
          { id: 102, name: "Not selected", price: 20, currency: "USD", stock: 5 },
        ],
      }),
    },
  });

  const result = await digitalServices.importSupplierProducts("efem", { selectedProductIds: ["101"] });

  assert.equal(result.summary.importedCount, 1);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].supplierProductId, "101");
  assert.equal(service.listDigitalServiceProducts({ includeInactive: true, admin: true }).some((product) => product.supplierProductId === "102"), false);
});

test("environment-configured Efem supports admin test preview and import without saved supplier row", async () => {
  const { service } = createHarness();
  service.getDigitalServiceSupplierRuntimeConfig = () => null;
  let safeTestCalls = 0;
  const efemService = {
    baseUrl: "https://api-geminipro.ignorelist.com/api/reseller/v1",
    isConfigured: () => true,
    getPublicStatus: () => ({ configured: true, baseUrl: "https://api-geminipro.ignorelist.com/api/reseller/v1" }),
    testConnection: async () => {
      safeTestCalls += 1;
      return { ok: true, status: "active" };
    },
    listProducts: async () => ({ products: [{ id: 201, name: "Environment Product", price: 12, currency: "USD", stock: 3 }] }),
  };
  const digitalServices = new DigitalServicesService({
    financialService: service,
    efemService,
  });

  const tested = await digitalServices.testSupplierConnection({ id: "efem" });
  const preview = await digitalServices.previewSupplierProducts("efem");
  const imported = await digitalServices.importSupplierProducts("efem", { selectedProductIds: ["201"] });

  assert.equal(tested.connected, true);
  assert.equal(safeTestCalls, 1);
  assert.equal(preview.productCount, 1);
  assert.equal(preview.supplier.id, "efem");
  assert.equal(imported.summary.importedCount, 1);
  assert.equal(imported.products[0].supplierProductId, "201");
});

test("Efem completed order encrypts value delivery and charges wallet once", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "efem:1",
      supplierProductId: "1",
      provider: "efem",
      storeKey: "efem",
      storeName: "Efem Store",
      fulfillmentMode: "automatic",
      name: "Gemini Pro",
      description: "Premium Gemini access",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 5,
      available: true,
    }], { provider: "efem" });
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      efemService: {
        isConfigured: () => true,
        getPublicStatus: () => ({ configured: true }),
        createOrder: async () => {
          supplierCalls += 1;
          return { ok: true, order: { orderCode: "rs_test", productId: 1, status: "completed", value: "TEST_DELIVERY" } };
        },
        getOrder: async () => ({ ok: true, order: { orderCode: "rs_test", status: "completed", value: "TEST_DELIVERY" } }),
      },
    });

    const order = await digitalServices.purchase(user, { productId: "efem:1", quantity: 1 }, { idempotencyKey: "efem-ok" });
    const stored = db.digitalServiceOrders[0];

    assert.equal(order.status, "delivered");
    assert.equal(order.supplierOrderId, "");
    assert.equal(stored.supplierOrderId, "rs_test");
    assert.equal(order.delivery.value, "TEST_DELIVERY");
    assert.equal(stored.deliveryEncrypted.includes("TEST_DELIVERY"), false);
    assert.equal(JSON.stringify(stored.supplierResponse).includes("TEST_DELIVERY"), false);
    assert.equal(stored.supplierResponse.data.value, "[stored_in_encrypted_delivery]");
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === order.requestId).length, 1);
    assert.equal(service.listNotifications(user).some((item) => item.dedupeKey === `digital-service-delivered:${order.id}`), true);
    assert.equal(supplierCalls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("Efem concurrent fulfillment posts only once", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "efem:2",
      supplierProductId: "2",
      provider: "efem",
      storeKey: "efem",
      storeName: "Efem Store",
      fulfillmentMode: "automatic",
      name: "Efem Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 5,
      available: true,
    }], { provider: "efem" });
    const product = service.getDigitalServiceProduct("efem:2", { admin: true });
    const paid = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      efemService: {
        isConfigured: () => true,
        createOrder: async () => {
          supplierCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true, order: { orderCode: "rs_once", status: "completed", value: "ONE_DELIVERY" } };
        },
      },
    });

    const [first, second] = await Promise.all([
      digitalServices.fulfillPaidOrder(paid.id, admin),
      digitalServices.fulfillPaidOrder(paid.id, admin),
    ]);

    assert.equal(first.status, "delivered");
    assert.equal(second.status, "delivered");
    assert.equal(supplierCalls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("Efem timeout after dispatch enters manual review and does not blind retry", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "efem:3",
      supplierProductId: "3",
      provider: "efem",
      storeKey: "efem",
      storeName: "Efem Store",
      fulfillmentMode: "automatic",
      name: "Efem Timeout Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 5,
      available: true,
    }], { provider: "efem" });
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      efemService: {
        isConfigured: () => true,
        listOrders: async () => [],
        createOrder: async () => {
          supplierCalls += 1;
          const error = new Error("Efem Store request timed out.");
          error.code = "EFEM_TIMEOUT";
          error.statusCode = 504;
          error.ambiguousSupplierPurchase = true;
          throw error;
        },
      },
    });

    const failed = await digitalServices.purchase(user, { productId: "efem:3", quantity: 1 }, { idempotencyKey: "efem-timeout" });
    const retried = await digitalServices.fulfillPaidOrder(failed.id, admin);

    assert.equal(failed.fulfillmentStatus, "manual_review");
    assert.equal(retried.fulfillmentStatus, "manual_review");
    assert.equal(supplierCalls, 1);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "4000");
    assert.equal(db.transactions.filter((item) => item.type === "DIGITAL_SERVICE" && item.reference === failed.requestId).length, 1);
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("Efem recovery uses known orderCode without POST or second debit", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    service.replaceDigitalServiceProducts([{
      id: "efem:4",
      supplierProductId: "4",
      provider: "efem",
      storeKey: "efem",
      storeName: "Efem Store",
      fulfillmentMode: "automatic",
      name: "Efem Recover Tool",
      category: "AI",
      currency: "NGN",
      providerCost: "4000",
      stock: 5,
      available: true,
    }], { provider: "efem" });
    const product = service.getDigitalServiceProduct("efem:4", { admin: true });
    const paid = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    const record = service.db.digitalServiceOrders[0];
    record.supplierOrderId = "rs_test";
    record.supplierStatus = "completed";
    record.fulfillmentStatus = "manual_review";
    let postCalls = 0;
    let getCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false },
      efemService: {
        isConfigured: () => true,
        createOrder: async () => {
          postCalls += 1;
          return {};
        },
        getOrder: async (orderCode) => {
          getCalls += 1;
          return { ok: true, order: { orderCode, status: "completed", value: "RECOVERED_DELIVERY" } };
        },
      },
    });

    const recovered = await digitalServices.recoverOrderDelivery(paid.id, admin);

    assert.equal(recovered.status, "delivered");
    assert.equal(recovered.delivery.value, "RECOVERED_DELIVERY");
    assert.equal(postCalls, 0);
    assert.equal(getCalls, 1);
    assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "1000");
    assert.equal(service.ensureWallet(user.id, "NGN").lockedBalance, "0");
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("manual products checkout waits for encrypted admin fulfillment and is idempotent", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    const { admin, db, service, user } = createHarness();
    setWallet(service, user.id, "NGN", "10000");
    service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });
    const product = service.createManualDigitalServiceProduct(admin, {
      name: "Custom Premium Account",
      description: "Delivered manually by admin",
      imageUrl: "https://example.com/product.png",
      storefrontLabel: "Manual Store",
      sellingPrice: "2500",
      stock: 2,
      available: true,
    });
    let supplierCalls = 0;
    const digitalServices = new DigitalServicesService({
      financialService: service,
      akundingService: { isConfigured: () => false, createOrder: async () => { supplierCalls += 1; } },
    });

    const walletOrder = await digitalServices.purchase(user, { productId: product.id, quantity: 1 }, { idempotencyKey: "manual-wallet" });
    const pendingPaystack = await digitalServices.purchase(user, { productId: product.id, quantity: 1, paymentMethod: "paystack" }, { idempotencyKey: "manual-paystack" });
    const paidPaystack = service.confirmDigitalServicePaystackPayment(pendingPaystack.paymentReference, {
      status: "success",
      reference: pendingPaystack.paymentReference,
      currency: "NGN",
      amount: toKobo("2500"),
    }, user);
    const delivered = service.fulfillManualDigitalServiceOrder(admin, walletOrder.id, {
      deliveryItems: [
        { type: "Email", value: "customer@example.com" },
        { type: "Password", value: "ManualSecret" },
      ],
      instructions: "Login and change your password.",
    });
    const duplicate = service.fulfillManualDigitalServiceOrder(admin, walletOrder.id, {
      deliveryItems: [{ type: "Password", value: "DifferentSecret" }],
    });

    assert.equal(walletOrder.fulfillmentMode, "manual");
    assert.equal(walletOrder.fulfillmentStatus, "awaiting_manual_fulfillment");
    assert.equal(paidPaystack.fulfillmentStatus, "awaiting_manual_fulfillment");
    assert.equal(delivered.status, "delivered");
    assert.equal(duplicate.delivery.deliveryItems[1].value, "ManualSecret");
    assert.equal(supplierCalls, 0);
    assert.equal(JSON.stringify(db.digitalServiceOrders.find((item) => item.id === walletOrder.id).supplierResponse).includes("ManualSecret"), false);
    assert.equal(service.listNotifications(user).filter((item) => item.dedupeKey === `digital-service-delivered:${walletOrder.id}`).length, 1);
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("manual product admin APIs reject non-admin and cross-user delivery access stays denied", () => {
  const { admin, db, service, user } = createHarness();
  const userB = { id: "user-2", name: "Ben User", email: "ben@example.com", role: "user" };
  db.users.push(userB);
  setWallet(service, user.id, "NGN", "5000");
  service.updateSettings(admin, { digitalServices: { enabled: true, globalMarkupPercent: "0" } });

  assert.throws(
    () => service.createManualDigitalServiceProduct(user, { name: "Bad", description: "No", sellingPrice: "1000" }),
    /Admin access is required/
  );
  const product = service.createManualDigitalServiceProduct(admin, { name: "Manual", description: "Manual desc", sellingPrice: "1000" });
  const order = service.createDigitalServiceOrder(user, { product, quantity: 1 });
  assert.throws(
    () => service.fulfillManualDigitalServiceOrder(user, order.id, { deliveryItems: [{ type: "Code", value: "ABC" }] }),
    /Admin access is required/
  );
  assert.throws(
    () => service.getDigitalServiceOrder(userB, order.id),
    /not found/
  );
});

test("fulfilled OTP-enabled manual orders create one encrypted admin request", async () => {
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const emails = [];
  try {
    const { admin, db, service, user } = createHarness({ emailPublisher: (message) => emails.push(message) });
    setWallet(service, user.id, "NGN", "5000");
    service.updateSettings(admin, { digitalServices: { enabled: true } });
    const product = service.createManualDigitalServiceProduct(admin, {
      name: "OTP Account", description: "Manual account", sellingPrice: "1000",
      otpMode: "ADMIN_REQUEST", otpRequestEnabled: true, otpWaitSeconds: 60,
      whatsappFallbackEnabled: true, whatsappFallbackUrl: "https://wa.me/2348000000000",
    });
    const order = service.createDigitalServiceOrder(user, { product, quantity: 1 });
    const stored = db.digitalServiceOrders.find((item) => item.id === order.id);
    stored.paymentStatus = "paid";
    stored.status = "delivered";
    stored.fulfillmentStatus = "fulfilled";
    service.requestDigitalServiceOtp(user, order.id);
    service.requestDigitalServiceOtp(user, order.id);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stored.otpRequest.status, "waiting");
    assert.equal(stored.otpRequest.requestCount, 1);
    assert.equal(service.listNotifications(admin).filter((item) => item.title === "OTP Requested").length, 1);
    assert.equal(emails.length, 1);

    const response = service.respondDigitalServiceOtp(admin, order.id, { code: "482911" });
    assert.equal(response.otpRequest.code, "482911");
    assert.notEqual(stored.otpRequest.responseEncrypted, "482911");
    assert.equal(JSON.stringify(service.listNotifications(user)).includes("482911"), false);
    assert.throws(() => service.respondDigitalServiceOtp(admin, order.id, { code: "999999" }), /not waiting/);
  } finally {
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
  }
});

test("OTP requests enforce ownership, payment, fulfillment, product configuration, and admin response", () => {
  const { admin, db, service, user } = createHarness();
  const other = { id: "user-2", role: "user", email: "other@example.com" };
  db.users.push(other);
  setWallet(service, user.id, "NGN", "5000");
  service.updateSettings(admin, { digitalServices: { enabled: true } });
  const product = service.createManualDigitalServiceProduct(admin, {
    name: "OTP Account", description: "Manual account", sellingPrice: "1000",
    otpMode: "ADMIN_REQUEST", otpRequestEnabled: true,
  });
  const order = service.createDigitalServiceOrder(user, { product, quantity: 1 });
  const stored = db.digitalServiceOrders.find((item) => item.id === order.id);

  assert.throws(() => service.requestDigitalServiceOtp(other, order.id), (error) => error.statusCode === 403);
  stored.paymentStatus = "pending";
  assert.throws(() => service.requestDigitalServiceOtp(user, order.id), /payment is not confirmed/);
  stored.paymentStatus = "paid";
  assert.throws(() => service.requestDigitalServiceOtp(user, order.id), /must be fulfilled/);
  stored.status = "delivered";
  stored.fulfillmentStatus = "fulfilled";
  db.digitalServiceProducts.find((item) => item.id === product.id).otpSupport.enabled = false;
  assert.throws(() => service.requestDigitalServiceOtp(user, order.id), /not enabled/);
  db.digitalServiceProducts.find((item) => item.id === product.id).otpSupport.enabled = true;
  service.requestDigitalServiceOtp(user, order.id);
  assert.throws(() => service.respondDigitalServiceOtp(user, order.id, { code: "123456" }), (error) => error.statusCode === 403);
});

test("48-hour cleanup deletes only disposable history older than cutoff", () => {
  let persistCount = 0;
  const db = {
    users: [
      { id: "admin-1", role: "admin", name: "Admin" },
      { id: "user-1", role: "user", name: "Ada" },
    ],
    wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "5000", lockedBalance: "0" }],
    transactions: [{ id: "txn-pnl", userId: "user-1", type: "TRADING_PROFIT", amount: "250", createdAt: "2026-08-20T10:00:00.000Z" }],
    deposits: [{ id: "dep-old", userId: "user-1", amount: "1000", status: "APPROVED", createdAt: "2026-08-20T10:00:00.000Z" }],
    withdrawals: [{ id: "wd-old", userId: "user-1", amount: "500", status: "SUCCESS", createdAt: "2026-08-20T10:00:00.000Z" }],
    referrals: [{ id: "ref-old", referrerUserId: "user-1", referredUserId: "user-2", createdAt: "2026-08-20T10:00:00.000Z" }],
    vtuTransactions: [{ id: "vtu-old", userId: "user-1", createdAt: "2026-08-20T10:00:00.000Z" }],
    digitalServiceOrders: [{ id: "order-old", userId: "user-1", createdAt: "2026-08-20T10:00:00.000Z" }],
    dailyPerformances: [{ id: "pnl-old", date: "2026-08-20", createdAt: "2026-08-20T10:00:00.000Z" }],
    auditLogs: [{ id: "audit-old", createdAt: "2026-08-20T10:00:00.000Z" }],
    webhookEvents: [{ id: "webhook-old", createdAt: "2026-08-20T10:00:00.000Z" }],
    notifications: [
      { id: "notice-old", userId: "user-1", createdAt: "2026-08-28T09:58:59.000Z" },
      { id: "notice-boundary", userId: "user-1", createdAt: "2026-08-28T10:00:00.000Z" },
      { id: "notice-recent", userId: "user-1", createdAt: "2026-08-28T10:01:00.000Z" },
      { id: "notice-malformed", userId: "user-1", createdAt: "not-a-date" },
    ],
    chatMessages: [
      { id: "chat-old", createdAt: "2026-08-28T09:58:59.000Z" },
      { id: "chat-boundary", createdAt: "2026-08-28T10:00:00.000Z" },
      { id: "chat-malformed", createdAt: "invalid" },
    ],
    pushNotificationEvents: [
      { id: "push-old", createdAt: "2026-08-28T09:58:59.000Z" },
      { id: "push-recent", createdAt: "2026-08-28T10:01:00.000Z" },
    ],
    strategyLogs: [
      { id: "strategy-old", timestamp: "2026-08-28T09:58:59.000Z" },
      { id: "strategy-recent", timestamp: "2026-08-28T10:01:00.000Z" },
    ],
    signals: [
      { id: "signal-old-expired", status: "EXPIRED", closedAt: "2026-08-28T09:58:59.000Z" },
      { id: "signal-old-active", status: "ACTIVE", createdAt: "2026-08-28T09:58:59.000Z" },
      { id: "signal-recent-expired", status: "EXPIRED", closedAt: "2026-08-28T10:01:00.000Z" },
    ],
    sessions: [
      { id: "session-old", expiresAt: "2026-08-28T09:58:59.000Z" },
      { id: "session-boundary", expiresAt: "2026-08-28T10:00:00.000Z" },
    ],
  };
  const service = new FinancialService({
    db,
    persist: () => {
      persistCount += 1;
    },
    clock: () => "2026-08-30T10:00:00.000Z",
    idGenerator: () => "cleanup-id",
  });
  service.ensureState();

  const result = service.cleanupDisposableHistory(db.users[0], { confirm: true });

  assert.deepEqual(result.deleted, {
    notifications: 1,
    chatMessages: 1,
    pushNotificationEvents: 1,
    strategyLogs: 1,
    expiredSessions: 1,
  });
  assert.equal(db.notifications.some((item) => item.id === "notice-old"), false);
  assert.equal(db.notifications.some((item) => item.id === "notice-boundary"), true);
  assert.equal(db.notifications.some((item) => item.id === "notice-malformed"), true);
  assert.equal(db.chatMessages.some((item) => item.id === "chat-boundary"), true);
  assert.equal(db.pushNotificationEvents.some((item) => item.id === "push-recent"), true);
  assert.equal(db.strategyLogs.some((item) => item.id === "strategy-recent"), true);
  assert.equal(db.signals.some((item) => item.id === "signal-old-expired"), true);
  assert.equal(db.signals.some((item) => item.id === "signal-old-active"), true);
  assert.equal(db.signals.some((item) => item.id === "signal-recent-expired"), true);
  assert.equal(db.sessions.some((item) => item.id === "session-boundary"), true);
  assert.equal(db.users.length, 2);
  assert.equal(db.wallets[0].availableBalance, "5000");
  assert.equal(db.transactions.length, 1);
  assert.equal(db.deposits.length, 1);
  assert.equal(db.withdrawals.length, 1);
  assert.equal(db.referrals.length, 1);
  assert.equal(db.vtuTransactions.length, 1);
  assert.equal(db.digitalServiceOrders.length, 1);
  assert.equal(db.dailyPerformances.length, 1);
  assert.equal(db.webhookEvents.length, 1);
  assert.equal(db.auditLogs.some((item) => item.action === "DISPOSABLE_HISTORY_CLEANED"), true);
  assert.equal(persistCount, 1);
});

test("48-hour cleanup ignores browser supplied cutoff values", () => {
  const db = {
    users: [{ id: "admin-1", role: "admin", name: "Admin" }],
    notifications: [
      { id: "notice-recent", userId: "admin-1", createdAt: "2026-08-30T09:00:00.000Z" },
    ],
  };
  const service = new FinancialService({
    db,
    persist: () => undefined,
    clock: () => "2026-08-30T10:00:00.000Z",
    idGenerator: () => "cleanup-id",
  });
  service.ensureState();

  const result = service.cleanupDisposableHistory(db.users[0], {
    confirm: true,
    nowMs: Date.parse("2027-08-30T10:00:00.000Z"),
  });

  assert.equal(result.deleted.notifications, 0);
  assert.equal(db.notifications.some((item) => item.id === "notice-recent"), true);
});

test("48-hour cleanup requires admin authorization and confirmation", () => {
  const { service, user } = createHarness();

  assert.throws(
    () => service.cleanupDisposableHistory(user, { confirm: true }),
    /Admin access is required/
  );
  assert.throws(
    () => service.cleanupDisposableHistory({ id: "admin-1", role: "admin" }, {}),
    /Confirm old history cleanup/
  );
});
