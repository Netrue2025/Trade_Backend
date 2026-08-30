const {
  add,
  clampDebit,
  compare,
  isPositive,
  multiplyRatio,
  percentChange,
  subtract,
} = require("../lib/money");
const { getEnvValue } = require("../lib/env");
const { randomId } = require("../lib/security");

const SUPPORTED_CURRENCIES = ["USDT", "NGN"];
const WITHDRAWAL_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "REJECTED", "CANCELLED"];
const DEPOSIT_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

function nowIso() {
  return new Date().toISOString();
}

function normalizeCurrency(value, fallback = "USDT") {
  const currency = String(value || fallback).trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return currency;
}

function normalizeAmount(value, label = "Amount") {
  const amount = String(value ?? "").replace(/,/g, "").trim();
  if (!isPositive(amount)) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return amount;
}

function normalizeNonNegativeAmount(value, label = "Amount") {
  const amount = String(value ?? "").replace(/,/g, "").trim();
  if (compare(amount || "0", "0") < 0) {
    throw new Error(`${label} cannot be negative.`);
  }
  return amount || "0";
}

function defaultSettings() {
  const configuredRate = getEnvValue("USDT_NGN_RATE", "BYBIT_USDT_NGN_RATE") || "1600";
  return {
    general: {
      platformName: getEnvValue("PLATFORM_NAME") || "NetrueFX",
      supportEmail: getEnvValue("SUPPORT_EMAIL") || "support@netrue.local",
      maintenanceMode: false,
    },
    deposit: {
      usdtAddress: getEnvValue("DEPOSIT_USDT_ADDRESS") || "",
      usdtNetwork: getEnvValue("DEPOSIT_USDT_NETWORK") || "TRC20",
      minUsdt: getEnvValue("MIN_DEPOSIT_USDT") || "1",
      maxUsdt: getEnvValue("MAX_DEPOSIT_USDT") || "1000000",
    },
    withdrawal: {
      ngnEnabled: true,
      usdtEnabled: true,
      minUsdt: getEnvValue("MIN_WITHDRAWAL_USDT") || "1",
      maxUsdt: getEnvValue("MAX_WITHDRAWAL_USDT") || "1000000",
      minNgn: getEnvValue("MIN_WITHDRAWAL_NGN") || "1000",
      maxNgn: getEnvValue("MAX_WITHDRAWAL_NGN") || "1000000000",
      maxDailyCount: Number(getEnvValue("MAX_DAILY_WITHDRAWALS") || 2),
      usdtFee: getEnvValue("WITHDRAWAL_USDT_FEE") || "0",
      ngnFee: getEnvValue("WITHDRAWAL_NGN_FEE") || "0",
    },
    exchangeRate: {
      usdtToNgn: configuredRate,
      updatedAt: nowIso(),
      updatedBy: "system",
    },
    trading: {
      tradingEnabled: true,
      dailyPerformanceMode: "manual",
      supportedExchanges: ["bybit", "binance"],
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FinancialService {
  constructor({ db, persist = () => undefined, idGenerator = randomId, clock = nowIso } = {}) {
    this.db = db;
    this.persist = persist;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  ensureState() {
    this.db.wallets = Array.isArray(this.db.wallets) ? this.db.wallets : [];
    this.db.transactions = Array.isArray(this.db.transactions) ? this.db.transactions : [];
    this.db.deposits = Array.isArray(this.db.deposits) ? this.db.deposits : [];
    this.db.withdrawals = Array.isArray(this.db.withdrawals) ? this.db.withdrawals : [];
    this.db.dailyPerformances = Array.isArray(this.db.dailyPerformances) ? this.db.dailyPerformances : [];
    this.db.auditLogs = Array.isArray(this.db.auditLogs) ? this.db.auditLogs : [];
    this.db.idempotencyKeys = Array.isArray(this.db.idempotencyKeys) ? this.db.idempotencyKeys : [];
    this.db.systemSettings = {
      ...defaultSettings(),
      ...(this.db.systemSettings || {}),
      general: {
        ...defaultSettings().general,
        ...(this.db.systemSettings?.general || {}),
      },
      deposit: {
        ...defaultSettings().deposit,
        ...(this.db.systemSettings?.deposit || {}),
      },
      withdrawal: {
        ...defaultSettings().withdrawal,
        ...(this.db.systemSettings?.withdrawal || {}),
      },
      exchangeRate: {
        ...defaultSettings().exchangeRate,
        ...(this.db.systemSettings?.exchangeRate || {}),
      },
      trading: {
        ...defaultSettings().trading,
        ...(this.db.systemSettings?.trading || {}),
      },
    };

    for (const user of this.db.users || []) {
      if (user.role === "user") {
        for (const currency of SUPPORTED_CURRENCIES) {
          this.ensureWallet(user.id, currency);
        }
      }
    }
  }

  getSettings() {
    this.ensureState();
    return clone(this.db.systemSettings);
  }

  updateSettings(admin, patch = {}, requestMeta = {}) {
    this.ensureState();
    const before = this.getSettings();
    const next = {
      ...before,
      general: {
        ...before.general,
        ...(patch.general || {}),
      },
      deposit: {
        ...before.deposit,
        ...(patch.deposit || {}),
      },
      withdrawal: {
        ...before.withdrawal,
        ...(patch.withdrawal || {}),
      },
      exchangeRate: {
        ...before.exchangeRate,
        ...(patch.exchangeRate || {}),
      },
      trading: {
        ...before.trading,
        ...(patch.trading || {}),
      },
    };

    if (patch.exchangeRate?.usdtToNgn !== undefined) {
      normalizeAmount(patch.exchangeRate.usdtToNgn, "USDT to NGN rate");
      next.exchangeRate.updatedAt = this.clock();
      next.exchangeRate.updatedBy = admin.id;
    }

    next.withdrawal.maxDailyCount = Math.max(0, Math.floor(Number(next.withdrawal.maxDailyCount || 0)));
    this.db.systemSettings = next;
    this.audit(admin, "SETTINGS_UPDATED", "SystemSettings", "current", { sections: Object.keys(patch) }, requestMeta);
    this.persist();
    return this.getSettings();
  }

  ensureWallet(userId, currency) {
    const normalizedCurrency = normalizeCurrency(currency);
    let wallet = this.db.wallets.find((item) => item.userId === userId && item.currency === normalizedCurrency);
    if (!wallet) {
      wallet = {
        id: this.idGenerator(12),
        userId,
        currency: normalizedCurrency,
        availableBalance: "0",
        lockedBalance: "0",
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.db.wallets.push(wallet);
    }
    return wallet;
  }

  getWallets(userId) {
    this.ensureState();
    return SUPPORTED_CURRENCIES.map((currency) => this.ensureWallet(userId, currency)).map(clone);
  }

  getTransactions(userId, { limit = 50, offset = 0 } = {}) {
    this.ensureState();
    return this.db.transactions
      .filter((item) => item.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(offset, offset + limit)
      .map(clone);
  }

  getDashboard(user) {
    this.ensureState();
    const wallets = this.getWallets(user.id);
    const usdtWallet = wallets.find((wallet) => wallet.currency === "USDT");
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const totalNgnEquivalent = multiplyRatio(usdtWallet.availableBalance, rate, "1");
    const today = new Date().toISOString().slice(0, 10);
    const todayPerformance = this.db.transactions
      .filter(
        (transaction) =>
          transaction.userId === user.id &&
          ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type) &&
          String(transaction.createdAt || "").startsWith(today)
      )
      .reduce((sum, transaction) => add(sum, transaction.amount), "0");

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      wallets,
      totalBalance: {
        usdt: usdtWallet.availableBalance,
        ngnEquivalent: totalNgnEquivalent,
        usdtToNgnRate: rate,
      },
      performance: {
        todayUsdt: todayPerformance,
        totalUsdt: this.db.transactions
          .filter((transaction) => transaction.userId === user.id && ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type))
          .reduce((sum, transaction) => add(sum, transaction.amount), "0"),
      },
      recentTransactions: this.getTransactions(user.id, { limit: 10 }),
      settings: {
        deposit: clone(this.db.systemSettings.deposit),
        withdrawal: clone(this.db.systemSettings.withdrawal),
        exchangeRate: clone(this.db.systemSettings.exchangeRate),
      },
    };
  }

  createDeposit(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const idempotent = this.findIdempotent("deposit:create", user.id, requestMeta.idempotencyKey);
    if (idempotent) {
      return idempotent;
    }

    const amount = normalizeAmount(input.amount, "Deposit amount");
    const settings = this.db.systemSettings.deposit;
    if (compare(amount, settings.minUsdt) < 0 || compare(amount, settings.maxUsdt) > 0) {
      throw new Error(`Deposit amount must be between ${settings.minUsdt} and ${settings.maxUsdt} USDT.`);
    }

    const deposit = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      currency: "USDT",
      depositAddress: settings.usdtAddress,
      network: settings.usdtNetwork,
      status: "PENDING",
      transactionHash: String(input.transactionHash || "").trim(),
      submittedAt: this.clock(),
      reviewedAt: null,
      reviewedBy: null,
      adminNote: "",
    };
    this.db.deposits.unshift(deposit);
    this.audit(user, "DEPOSIT_SUBMITTED", "Deposit", deposit.id, { amount, currency: "USDT" }, requestMeta);
    this.saveIdempotent("deposit:create", user.id, requestMeta.idempotencyKey, deposit);
    this.persist();
    return clone(deposit);
  }

  listDeposits(user, { status } = {}) {
    this.ensureState();
    const normalizedStatus = status ? String(status).trim().toUpperCase() : "";
    return this.db.deposits
      .filter((deposit) => {
        if (user.role !== "admin" && deposit.userId !== user.id) {
          return false;
        }
        return !normalizedStatus || deposit.status === normalizedStatus;
      })
      .map((deposit) => this.enrichUserRecord(deposit));
  }

  approveDeposit(admin, depositId, input = {}, requestMeta = {}) {
    this.ensureState();
    const deposit = this.getDeposit(depositId);
    if (deposit.status !== "PENDING") {
      throw new Error("Deposit request is no longer pending.");
    }

    const wallet = this.ensureWallet(deposit.userId, deposit.currency);
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = add(wallet.availableBalance, deposit.amount);
    wallet.updatedAt = this.clock();
    deposit.status = "APPROVED";
    deposit.reviewedAt = this.clock();
    deposit.reviewedBy = admin.id;
    deposit.adminNote = String(input.adminNote || "").trim();
    this.db.transactions.unshift({
      id: this.idGenerator(12),
      userId: deposit.userId,
      type: "DEPOSIT",
      currency: deposit.currency,
      amount: deposit.amount,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: deposit.id,
      status: "APPROVED",
      description: "Manual USDT deposit approved by admin.",
      createdBy: admin.id,
      createdAt: this.clock(),
    });
    this.audit(admin, "DEPOSIT_APPROVED", "Deposit", deposit.id, { amount: deposit.amount, currency: deposit.currency }, requestMeta);
    this.persist();
    return clone(deposit);
  }

  rejectDeposit(admin, depositId, input = {}, requestMeta = {}) {
    this.ensureState();
    const deposit = this.getDeposit(depositId);
    if (deposit.status !== "PENDING") {
      throw new Error("Deposit request is no longer pending.");
    }
    deposit.status = "REJECTED";
    deposit.reviewedAt = this.clock();
    deposit.reviewedBy = admin.id;
    deposit.adminNote = String(input.adminNote || "").trim();
    this.audit(admin, "DEPOSIT_REJECTED", "Deposit", deposit.id, { amount: deposit.amount, currency: deposit.currency }, requestMeta);
    this.persist();
    return clone(deposit);
  }

  createWithdrawal(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const idempotent = this.findIdempotent("withdrawal:create", user.id, requestMeta.idempotencyKey);
    if (idempotent) {
      return idempotent;
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Withdrawal amount");
    this.validateWithdrawalSettings(currency, amount);
    this.validateDailyWithdrawalLimit(user.id);
    const wallet = this.ensureWallet(user.id, currency);
    if (compare(wallet.availableBalance, amount) < 0) {
      throw new Error("Insufficient available balance.");
    }

    const balanceBefore = wallet.availableBalance;
    const lockedBefore = wallet.lockedBalance;
    wallet.availableBalance = subtract(wallet.availableBalance, amount);
    wallet.lockedBalance = add(wallet.lockedBalance, amount);
    wallet.updatedAt = this.clock();
    const withdrawal = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      currency,
      status: "PENDING",
      exchangeRate: this.db.systemSettings.exchangeRate.usdtToNgn,
      destination: this.normalizeWithdrawalDestination(currency, input.destination || input),
      fee: currency === "USDT" ? this.db.systemSettings.withdrawal.usdtFee : this.db.systemSettings.withdrawal.ngnFee,
      submittedAt: this.clock(),
      processingAt: null,
      processedBy: null,
      completedAt: null,
      completedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      externalTransactionReference: "",
      adminNote: "",
    };
    this.db.withdrawals.unshift(withdrawal);
    this.db.transactions.unshift({
      id: this.idGenerator(12),
      userId: user.id,
      type: "WITHDRAWAL",
      currency,
      amount: `-${amount}`,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: withdrawal.id,
      status: "PENDING",
      description: "Withdrawal amount reserved from available balance.",
      createdBy: user.id,
      createdAt: this.clock(),
      metadata: {
        lockedBalanceBefore: lockedBefore,
        lockedBalanceAfter: wallet.lockedBalance,
      },
    });
    this.audit(user, "WITHDRAWAL_SUBMITTED", "Withdrawal", withdrawal.id, { amount, currency }, requestMeta);
    this.saveIdempotent("withdrawal:create", user.id, requestMeta.idempotencyKey, withdrawal);
    this.persist();
    return clone(withdrawal);
  }

  listWithdrawals(user, { status } = {}) {
    this.ensureState();
    const normalizedStatus = status ? String(status).trim().toUpperCase() : "";
    return this.db.withdrawals
      .filter((withdrawal) => {
        if (user.role !== "admin" && withdrawal.userId !== user.id) {
          return false;
        }
        return !normalizedStatus || withdrawal.status === normalizedStatus;
      })
      .map((withdrawal) => this.enrichUserRecord(withdrawal));
  }

  processWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    const withdrawal = this.changeWithdrawalStatus(admin, withdrawalId, "PROCESSING", input, requestMeta);
    withdrawal.processingAt = this.clock();
    withdrawal.processedBy = admin.id;
    this.persist();
    return clone(withdrawal);
  }

  completeWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (!["PENDING", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only pending or processing withdrawals can be completed.");
    }
    const wallet = this.ensureWallet(withdrawal.userId, withdrawal.currency);
    if (compare(wallet.lockedBalance, withdrawal.amount) < 0) {
      throw new Error("Locked balance is lower than the withdrawal amount.");
    }

    const lockedBefore = wallet.lockedBalance;
    wallet.lockedBalance = subtract(wallet.lockedBalance, withdrawal.amount);
    wallet.updatedAt = this.clock();
    withdrawal.status = "COMPLETED";
    withdrawal.completedAt = this.clock();
    withdrawal.completedBy = admin.id;
    withdrawal.externalTransactionReference = String(input.externalTransactionReference || input.transactionHash || "").trim();
    withdrawal.adminNote = String(input.adminNote || "").trim();
    this.db.transactions.unshift({
      id: this.idGenerator(12),
      userId: withdrawal.userId,
      type: "WITHDRAWAL_COMPLETED",
      currency: withdrawal.currency,
      amount: `-${withdrawal.amount}`,
      balanceBefore: lockedBefore,
      balanceAfter: wallet.lockedBalance,
      reference: withdrawal.id,
      status: "COMPLETED",
      description: "Withdrawal completed and released from locked balance.",
      createdBy: admin.id,
      createdAt: this.clock(),
    });
    this.audit(admin, "WITHDRAWAL_COMPLETED", "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  rejectWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (!["PENDING", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only pending or processing withdrawals can be rejected.");
    }
    const wallet = this.ensureWallet(withdrawal.userId, withdrawal.currency);
    if (compare(wallet.lockedBalance, withdrawal.amount) < 0) {
      throw new Error("Locked balance is lower than the withdrawal amount.");
    }
    const availableBefore = wallet.availableBalance;
    const lockedBefore = wallet.lockedBalance;
    wallet.lockedBalance = subtract(wallet.lockedBalance, withdrawal.amount);
    wallet.availableBalance = add(wallet.availableBalance, withdrawal.amount);
    wallet.updatedAt = this.clock();
    withdrawal.status = "REJECTED";
    withdrawal.rejectedAt = this.clock();
    withdrawal.rejectedBy = admin.id;
    withdrawal.adminNote = String(input.adminNote || "").trim();
    this.db.transactions.unshift({
      id: this.idGenerator(12),
      userId: withdrawal.userId,
      type: "REVERSAL",
      currency: withdrawal.currency,
      amount: withdrawal.amount,
      balanceBefore: availableBefore,
      balanceAfter: wallet.availableBalance,
      reference: withdrawal.id,
      status: "APPROVED",
      description: "Withdrawal rejected and reserved balance returned.",
      createdBy: admin.id,
      createdAt: this.clock(),
      metadata: {
        lockedBalanceBefore: lockedBefore,
        lockedBalanceAfter: wallet.lockedBalance,
      },
    });
    this.audit(admin, "WITHDRAWAL_REJECTED", "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  createDailyPerformance(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const startingCapital = normalizeAmount(input.startingCapital ?? input.adminCapital, "Starting capital");
    const endingCapital = normalizeNonNegativeAmount(input.endingCapital, "Ending capital");
    const profitLoss = subtract(endingCapital, startingCapital);
    const date = String(input.date || new Date().toISOString().slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Performance date must use YYYY-MM-DD.");
    }
    const existing = this.db.dailyPerformances.find((item) => item.date === date);
    if (existing) {
      throw new Error("Daily performance already exists for this date.");
    }
    const performance = {
      id: this.idGenerator(12),
      date,
      adminCapital: String(input.adminCapital || startingCapital),
      startingCapital,
      endingCapital,
      profitLoss,
      profitLossPercentage: percentChange(startingCapital, endingCapital),
      status: "DRAFT",
      createdBy: admin.id,
      createdAt: this.clock(),
      appliedAt: null,
      appliedBy: null,
    };
    this.db.dailyPerformances.unshift(performance);
    this.audit(admin, "DAILY_PERFORMANCE_CREATED", "DailyPerformance", performance.id, { date, profitLoss }, requestMeta);
    this.persist();
    return clone(performance);
  }

  applyDailyPerformance(admin, performanceId, requestMeta = {}) {
    this.ensureState();
    const performance = this.db.dailyPerformances.find((item) => item.id === performanceId);
    if (!performance) {
      throw new Error("Daily performance record not found.");
    }

    let appliedCount = 0;
    for (const user of this.db.users.filter((item) => item.role === "user" && item.status !== "SUSPENDED")) {
      const reference = `${performance.id}:${user.id}`;
      const exists = this.db.transactions.some((item) => item.reference === reference);
      if (exists) {
        continue;
      }
      const wallet = this.ensureWallet(user.id, "USDT");
      const eligibleBalance = wallet.availableBalance;
      if (compare(eligibleBalance, "0") <= 0) {
        continue;
      }
      let userPnl = multiplyRatio(eligibleBalance, performance.profitLoss, performance.startingCapital);
      if (compare(userPnl, "0") < 0) {
        userPnl = `-${clampDebit(userPnl.slice(1), eligibleBalance)}`;
      }
      if (compare(userPnl, "0") === 0) {
        continue;
      }
      const balanceBefore = wallet.availableBalance;
      wallet.availableBalance = add(wallet.availableBalance, userPnl);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: user.id,
        type: compare(userPnl, "0") > 0 ? "TRADING_PROFIT" : "TRADING_LOSS",
        currency: "USDT",
        amount: userPnl,
        balanceBefore,
        balanceAfter: wallet.availableBalance,
        reference,
        status: "APPROVED",
        description: `Daily trading performance for ${performance.date}.`,
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          performanceId: performance.id,
          performanceDate: performance.date,
          profitLossPercentage: performance.profitLossPercentage,
        },
      });
      appliedCount += 1;
    }

    performance.status = "APPLIED";
    performance.appliedAt = performance.appliedAt || this.clock();
    performance.appliedBy = performance.appliedBy || admin.id;
    this.audit(admin, "DAILY_PERFORMANCE_APPLIED", "DailyPerformance", performance.id, { appliedCount }, requestMeta);
    this.persist();
    return {
      performance: clone(performance),
      appliedCount,
    };
  }

  getAdminDashboard() {
    this.ensureState();
    const totalUsers = this.db.users.filter((user) => user.role === "user").length;
    const activeUsers = this.db.users.filter((user) => user.role === "user" && user.status !== "SUSPENDED").length;
    const walletTotals = SUPPORTED_CURRENCIES.reduce((acc, currency) => {
      acc[currency] = this.db.wallets
        .filter((wallet) => wallet.currency === currency)
        .reduce((sum, wallet) => add(sum, add(wallet.availableBalance, wallet.lockedBalance)), "0");
      return acc;
    }, {});
    return {
      totalUsers,
      activeUsers,
      totalUserBalance: walletTotals,
      pendingDeposits: this.db.deposits.filter((deposit) => deposit.status === "PENDING").length,
      pendingWithdrawals: this.db.withdrawals.filter((withdrawal) => withdrawal.status === "PENDING").length,
      todayPnl: this.getTodayPnl(),
      totalPnl: this.db.transactions
        .filter((transaction) => ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type))
        .reduce((sum, transaction) => add(sum, transaction.amount), "0"),
    };
  }

  getAuditLogs({ limit = 100 } = {}) {
    this.ensureState();
    return this.db.auditLogs.slice(0, limit).map(clone);
  }

  getDailyPerformances() {
    this.ensureState();
    return this.db.dailyPerformances.map(clone);
  }

  getTodayPnl() {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.transactions
      .filter((transaction) => ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type) && String(transaction.createdAt || "").startsWith(today))
      .reduce((sum, transaction) => add(sum, transaction.amount), "0");
  }

  getDeposit(depositId) {
    const deposit = this.db.deposits.find((item) => item.id === depositId);
    if (!deposit) {
      throw new Error("Deposit request not found.");
    }
    return deposit;
  }

  getWithdrawal(withdrawalId) {
    const withdrawal = this.db.withdrawals.find((item) => item.id === withdrawalId);
    if (!withdrawal) {
      throw new Error("Withdrawal request not found.");
    }
    return withdrawal;
  }

  changeWithdrawalStatus(admin, withdrawalId, status, input = {}, requestMeta = {}) {
    this.ensureState();
    if (!WITHDRAWAL_STATUSES.includes(status)) {
      throw new Error("Unsupported withdrawal status.");
    }
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.status === "COMPLETED" || withdrawal.status === "REJECTED") {
      throw new Error("Finalized withdrawals cannot be changed.");
    }
    withdrawal.status = status;
    withdrawal.adminNote = String(input.adminNote || withdrawal.adminNote || "").trim();
    this.audit(admin, `WITHDRAWAL_${status}`, "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return withdrawal;
  }

  validateWithdrawalSettings(currency, amount) {
    const settings = this.db.systemSettings.withdrawal;
    if (currency === "USDT" && !settings.usdtEnabled) {
      throw new Error("USDT withdrawals are currently disabled.");
    }
    if (currency === "NGN" && !settings.ngnEnabled) {
      throw new Error("NGN withdrawals are currently disabled.");
    }
    const min = currency === "USDT" ? settings.minUsdt : settings.minNgn;
    const max = currency === "USDT" ? settings.maxUsdt : settings.maxNgn;
    if (compare(amount, min) < 0 || compare(amount, max) > 0) {
      throw new Error(`Withdrawal amount must be between ${min} and ${max} ${currency}.`);
    }
  }

  validateDailyWithdrawalLimit(userId) {
    const maxDailyCount = Number(this.db.systemSettings.withdrawal.maxDailyCount || 0);
    if (!maxDailyCount) {
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const count = this.db.withdrawals.filter(
      (withdrawal) =>
        withdrawal.userId === userId &&
        !["REJECTED", "CANCELLED"].includes(withdrawal.status) &&
        String(withdrawal.submittedAt || "").startsWith(today)
    ).length;
    if (count >= maxDailyCount) {
      throw new Error("Daily withdrawal limit reached.");
    }
  }

  normalizeWithdrawalDestination(currency, input = {}) {
    if (currency === "USDT") {
      const address = String(input.address || input.walletAddress || "").trim();
      const network = String(input.network || "").trim();
      if (!address || !network) {
        throw new Error("USDT withdrawal address and network are required.");
      }
      return { type: "USDT_WALLET", address, network };
    }

    const bankName = String(input.bankName || "").trim();
    const accountName = String(input.accountName || "").trim();
    const accountNumber = String(input.accountNumber || "").replace(/\s+/g, "").trim();
    if (!bankName || !accountName || !/^\d{10}$/.test(accountNumber)) {
      throw new Error("Bank name, account name, and a 10-digit account number are required.");
    }
    return { type: "NGN_BANK", bankName, accountName, accountNumber };
  }

  enrichUserRecord(record) {
    const user = this.db.users.find((item) => item.id === record.userId);
    return {
      ...clone(record),
      user: user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
          }
        : null,
    };
  }

  audit(actor, action, entityType, entityId, metadata = {}, requestMeta = {}) {
    this.db.auditLogs.unshift({
      id: this.idGenerator(12),
      actorId: actor?.id || "system",
      actorRole: actor?.role || "system",
      action,
      entityType,
      entityId,
      metadata: clone(metadata || {}),
      ipAddress: requestMeta.ipAddress || "",
      userAgent: requestMeta.userAgent || "",
      createdAt: this.clock(),
    });
  }

  findIdempotent(scope, userId, key) {
    if (!key) {
      return null;
    }
    const record = this.db.idempotencyKeys.find((item) => item.scope === scope && item.userId === userId && item.key === key);
    return record ? clone(record.response) : null;
  }

  saveIdempotent(scope, userId, key, response) {
    if (!key) {
      return;
    }
    this.db.idempotencyKeys.push({
      scope,
      userId,
      key,
      response: clone(response),
      createdAt: this.clock(),
    });
  }
}

module.exports = {
  DEPOSIT_STATUSES,
  FinancialService,
  SUPPORTED_CURRENCIES,
  WITHDRAWAL_STATUSES,
};
