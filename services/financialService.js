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
      ngnEnabled: true,
      bankName: getEnvValue("DEPOSIT_BANK_NAME") || "",
      accountName: getEnvValue("DEPOSIT_ACCOUNT_NAME") || "",
      accountNumber: getEnvValue("DEPOSIT_ACCOUNT_NUMBER") || "",
      bankNote: getEnvValue("DEPOSIT_BANK_NOTE") || "",
      usdtAddress: getEnvValue("DEPOSIT_USDT_ADDRESS") || "",
      usdtNetwork: getEnvValue("DEPOSIT_USDT_NETWORK") || "TRC20",
      minUsdt: getEnvValue("MIN_DEPOSIT_USDT") || "1",
      maxUsdt: getEnvValue("MAX_DEPOSIT_USDT") || "1000000",
      minNgn: getEnvValue("MIN_DEPOSIT_NGN") || "1000",
      maxNgn: getEnvValue("MAX_DEPOSIT_NGN") || "1000000000",
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
    this.db.notifications = Array.isArray(this.db.notifications) ? this.db.notifications : [];
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
      next.exchangeRate.usdtToNgn = normalizeAmount(patch.exchangeRate.usdtToNgn, "USDT to NGN rate");
      next.exchangeRate.updatedAt = this.clock();
      next.exchangeRate.updatedBy = admin.id;
    }

    next.withdrawal.maxDailyCount = Math.max(0, Math.floor(Number(next.withdrawal.maxDailyCount || 0)));
    this.db.systemSettings = next;
    this.audit(admin, "SETTINGS_UPDATED", "SystemSettings", "current", { sections: Object.keys(patch) }, requestMeta);
    this.persist();
    return this.getSettings();
  }

  convertAmount(amount, fromCurrency, toCurrency, rate = this.db.systemSettings.exchangeRate.usdtToNgn) {
    const from = normalizeCurrency(fromCurrency);
    const to = normalizeCurrency(toCurrency);
    if (from === to) {
      return String(amount);
    }
    normalizeAmount(rate, "USDT to NGN rate");
    return from === "USDT"
      ? multiplyRatio(amount, rate, "1")
      : multiplyRatio(amount, "1", rate);
  }

  getDisplayAmounts(amount, currency, rate = this.db.systemSettings.exchangeRate.usdtToNgn) {
    const normalizedCurrency = normalizeCurrency(currency);
    return {
      USDT: normalizedCurrency === "USDT" ? String(amount) : this.convertAmount(amount, "NGN", "USDT", rate),
      NGN: normalizedCurrency === "NGN" ? String(amount) : this.convertAmount(amount, "USDT", "NGN", rate),
      rate: String(rate),
    };
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

  listTransactions(user, { limit = 200, offset = 0 } = {}) {
    this.ensureState();
    return this.db.transactions
      .filter((item) => user.role === "admin" || item.userId === user.id)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(offset, offset + limit)
      .map((transaction) => this.enrichUserRecord(transaction));
  }

  getUserFinanceProfile(userId) {
    this.ensureState();
    const user = this.db.users.find((item) => item.id === userId && item.role === "user");
    if (!user) {
      throw new Error("User not found.");
    }
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      wallets: this.getWallets(user.id),
      recentTransactions: this.getTransactions(user.id, { limit: 12 }),
    };
  }

  listNotifications(user, { limit = 20 } = {}) {
    this.ensureState();
    return this.db.notifications
      .filter((item) => item.userId === user.id)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, limit)
      .map((item) => this.enrichUserRecord(item));
  }

  markNotificationRead(user, notificationId) {
    this.ensureState();
    const notification = this.db.notifications.find((item) => item.id === notificationId && item.userId === user.id);
    if (!notification) {
      throw new Error("Notification not found.");
    }
    notification.readAt = notification.readAt || this.clock();
    this.persist();
    return clone(notification);
  }

  createNotification(input = {}) {
    const notification = {
      id: this.idGenerator(12),
      userId: input.userId || "",
      type: String(input.type || "INFO").trim().toUpperCase(),
      title: String(input.title || "Update").trim(),
      message: String(input.message || "").trim(),
      entityType: String(input.entityType || "").trim(),
      entityId: String(input.entityId || "").trim(),
      readAt: null,
      createdAt: this.clock(),
    };
    this.db.notifications.unshift(notification);
    return notification;
  }

  notifyAdmins(input = {}) {
    for (const admin of this.db.users.filter((user) => user.role === "admin")) {
      this.createNotification({ ...input, userId: admin.id });
    }
  }

  getDashboard(user) {
    this.ensureState();
    const wallets = this.getWallets(user.id);
    const usdtWallet = wallets.find((wallet) => wallet.currency === "USDT");
    const ngnWallet = wallets.find((wallet) => wallet.currency === "NGN");
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const availableUsdtEquivalent = add(usdtWallet.availableBalance, this.convertAmount(ngnWallet.availableBalance, "NGN", "USDT", rate));
    const totalNgnEquivalent = add(ngnWallet.availableBalance, this.convertAmount(usdtWallet.availableBalance, "USDT", "NGN", rate));
    const lockedUsdtEquivalent = add(usdtWallet.lockedBalance, this.convertAmount(ngnWallet.lockedBalance, "NGN", "USDT", rate));
    const lockedNgnEquivalent = add(ngnWallet.lockedBalance, this.convertAmount(usdtWallet.lockedBalance, "USDT", "NGN", rate));
    const today = this.clock().slice(0, 10);
    const todayTransactions = this.db.transactions
      .filter(
        (transaction) =>
          transaction.userId === user.id &&
          ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type) &&
          String(transaction.createdAt || "").startsWith(today)
      );
    const todayPerformance = todayTransactions
      .reduce((sum, transaction) => add(sum, transaction.amount), "0");
    const todayMirroredPercentage = todayTransactions
      .find((transaction) => transaction.metadata?.profitLossPercentage)
      ?.metadata?.profitLossPercentage || "0";

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      wallets,
      totalBalance: {
        usdt: availableUsdtEquivalent,
        ngnEquivalent: totalNgnEquivalent,
        lockedUsdt: lockedUsdtEquivalent,
        lockedNgnEquivalent,
        usdtToNgnRate: rate,
      },
      performance: {
        todayUsdt: todayPerformance,
        todayPercentage: todayMirroredPercentage,
        totalUsdt: this.db.transactions
          .filter((transaction) => transaction.userId === user.id && ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type))
          .reduce((sum, transaction) => add(sum, transaction.amount), "0"),
      },
      recentTransactions: this.getTransactions(user.id, { limit: 10 }),
      notifications: this.listNotifications(user, { limit: 12 }),
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

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Deposit amount");
    const settings = this.db.systemSettings.deposit;
    if (currency === "NGN" && settings.ngnEnabled === false) {
      throw new Error("NGN deposits are currently disabled.");
    }

    const min = currency === "NGN" ? settings.minNgn || "1000" : settings.minUsdt || "1";
    const max = currency === "NGN" ? settings.maxNgn || "1000000000" : settings.maxUsdt || "1000000";
    if (compare(amount, min) < 0 || compare(amount, max) > 0) {
      throw new Error(`Deposit amount must be between ${min} and ${max} ${currency}.`);
    }

    const deposit = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      currency,
      exchangeRate: this.db.systemSettings.exchangeRate.usdtToNgn,
      displayAmounts: this.getDisplayAmounts(amount, currency),
      depositAddress: currency === "USDT" ? settings.usdtAddress : "",
      network: currency === "USDT" ? settings.usdtNetwork : "BANK",
      status: "PENDING",
      transactionHash: String(input.transactionHash || "").trim(),
      depositorName: String(input.depositorName || "").trim(),
      submittedAt: this.clock(),
      reviewedAt: null,
      reviewedBy: null,
      adminNote: "",
    };
    this.db.deposits.unshift(deposit);
    this.notifyAdmins({
      type: "DEPOSIT",
      title: "Deposit request",
      message: `${user.name || "User"} submitted ${amount} ${currency}.`,
      entityType: "Deposit",
      entityId: deposit.id,
    });
    this.audit(user, "DEPOSIT_SUBMITTED", "Deposit", deposit.id, { amount, currency }, requestMeta);
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
      description: `Manual ${deposit.currency} deposit approved by admin.`,
      createdBy: admin.id,
      createdAt: this.clock(),
      metadata: {
        displayAmounts: deposit.displayAmounts || this.getDisplayAmounts(deposit.amount, deposit.currency, deposit.exchangeRate),
      },
    });
    this.createNotification({
      userId: deposit.userId,
      type: "DEPOSIT",
      title: "Deposit approved",
      message: `${deposit.amount} ${deposit.currency} added to your wallet.`,
      entityType: "Deposit",
      entityId: deposit.id,
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
    this.createNotification({
      userId: deposit.userId,
      type: "DEPOSIT",
      title: "Deposit rejected",
      message: deposit.adminNote || "Your deposit request was rejected.",
      entityType: "Deposit",
      entityId: deposit.id,
    });
    this.audit(admin, "DEPOSIT_REJECTED", "Deposit", deposit.id, { amount: deposit.amount, currency: deposit.currency }, requestMeta);
    this.persist();
    return clone(deposit);
  }

  addBonus(admin, userId, input = {}, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Bonus amount");
    const note = String(input.note || "Bonus").trim();
    const wallet = this.ensureWallet(targetUser.id, currency);
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = add(wallet.availableBalance, amount);
    wallet.updatedAt = this.clock();
    const transaction = {
      id: this.idGenerator(12),
      userId: targetUser.id,
      type: "BONUS",
      currency,
      amount,
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: this.idGenerator(12),
      status: "APPROVED",
      description: note,
      createdBy: admin.id,
      createdAt: this.clock(),
    };
    this.db.transactions.unshift(transaction);
    this.createNotification({
      userId: targetUser.id,
      type: "BONUS",
      title: "Bonus added",
      message: `${amount} ${currency} added to your wallet.`,
      entityType: "Transaction",
      entityId: transaction.id,
    });
    this.audit(admin, "BONUS_ADDED", "User", targetUser.id, { amount, currency }, requestMeta);
    this.persist();
    return {
      transaction: clone(transaction),
      profile: this.getUserFinanceProfile(targetUser.id),
    };
  }

  setUserBalance(admin, userId, input = {}, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeNonNegativeAmount(input.amount, "Balance");
    const note = String(input.note || "Balance updated").trim();
    const wallet = this.ensureWallet(targetUser.id, currency);
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = amount;
    wallet.updatedAt = this.clock();
    const transaction = {
      id: this.idGenerator(12),
      userId: targetUser.id,
      type: "BALANCE_ADJUSTMENT",
      currency,
      amount: subtract(amount, balanceBefore),
      balanceBefore,
      balanceAfter: wallet.availableBalance,
      reference: this.idGenerator(12),
      status: "APPROVED",
      description: note,
      createdBy: admin.id,
      createdAt: this.clock(),
    };
    this.db.transactions.unshift(transaction);
    this.createNotification({
      userId: targetUser.id,
      type: "BALANCE",
      title: "Balance updated",
      message: `${currency} balance is now ${amount}.`,
      entityType: "Transaction",
      entityId: transaction.id,
    });
    this.audit(admin, "BALANCE_UPDATED", "User", targetUser.id, { amount, currency }, requestMeta);
    this.persist();
    return {
      transaction: clone(transaction),
      profile: this.getUserFinanceProfile(targetUser.id),
    };
  }

  sendAdminMessage(admin, userId, input = {}, requestMeta = {}) {
    this.ensureState();
    const targetUser = this.db.users.find((user) => user.id === userId && user.role === "user");
    if (!targetUser) {
      throw new Error("User not found.");
    }
    const message = String(input.message || "").trim();
    if (!message) {
      throw new Error("Message is required.");
    }
    const notification = this.createNotification({
      userId: targetUser.id,
      type: "MESSAGE",
      title: String(input.title || "Admin message").trim(),
      message,
      entityType: "User",
      entityId: targetUser.id,
    });
    this.audit(admin, "ADMIN_MESSAGE_SENT", "User", targetUser.id, { notificationId: notification.id }, requestMeta);
    this.persist();
    return clone(notification);
  }

  resolveWithdrawalFunding(userId, currency, amount) {
    const primaryWallet = this.ensureWallet(userId, currency);
    if (compare(primaryWallet.availableBalance, amount) >= 0) {
      return [{ wallet: primaryWallet, currency, amount }];
    }

    const sources = [];
    let remainingAmount = amount;
    if (compare(primaryWallet.availableBalance, "0") > 0) {
      sources.push({ wallet: primaryWallet, currency, amount: primaryWallet.availableBalance });
      remainingAmount = subtract(remainingAmount, primaryWallet.availableBalance);
    }

    const alternateCurrency = currency === "USDT" ? "NGN" : "USDT";
    const alternateAmount = this.convertAmount(remainingAmount, currency, alternateCurrency);
    const alternateWallet = this.ensureWallet(userId, alternateCurrency);
    if (compare(alternateWallet.availableBalance, alternateAmount) < 0) {
      throw new Error("Insufficient available balance.");
    }

    sources.push({ wallet: alternateWallet, currency: alternateCurrency, amount: alternateAmount });
    return sources;
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
    const fundingSources = this.resolveWithdrawalFunding(user.id, currency, amount);
    const withdrawal = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      currency,
      status: "PENDING",
      exchangeRate: this.db.systemSettings.exchangeRate.usdtToNgn,
      displayAmounts: this.getDisplayAmounts(amount, currency),
      destination: this.normalizeWithdrawalDestination(currency, input.destination || input),
      fee: currency === "USDT" ? this.db.systemSettings.withdrawal.usdtFee : this.db.systemSettings.withdrawal.ngnFee,
      submittedAt: this.clock(),
      processingAt: null,
      processedBy: null,
      completedAt: null,
      completedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      fundingSources: fundingSources.map((source) => ({
        currency: source.currency,
        amount: source.amount,
      })),
      externalTransactionReference: "",
      adminNote: "",
    };

    for (const source of fundingSources) {
      const balanceBefore = source.wallet.availableBalance;
      const lockedBefore = source.wallet.lockedBalance;
      source.wallet.availableBalance = subtract(source.wallet.availableBalance, source.amount);
      source.wallet.lockedBalance = add(source.wallet.lockedBalance, source.amount);
      source.wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: user.id,
        type: "WITHDRAWAL",
        currency: source.currency,
        amount: `-${source.amount}`,
        balanceBefore,
        balanceAfter: source.wallet.availableBalance,
        reference: withdrawal.id,
        status: "PENDING",
        description: currency === source.currency ? "Withdrawal amount reserved." : `Reserved for ${currency} withdrawal.`,
        createdBy: user.id,
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: currency,
          requestedAmount: amount,
          lockedBalanceBefore: lockedBefore,
          lockedBalanceAfter: source.wallet.lockedBalance,
        },
      });
    }

    this.db.withdrawals.unshift(withdrawal);
    this.notifyAdmins({
      type: "WITHDRAWAL",
      title: "Withdrawal request",
      message: `${user.name || "User"} requested ${amount} ${currency}.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
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
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      if (compare(wallet.lockedBalance, source.amount) < 0) {
        throw new Error("Locked balance is lower than the withdrawal amount.");
      }
    }

    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const lockedBefore = wallet.lockedBalance;
      wallet.lockedBalance = subtract(wallet.lockedBalance, source.amount);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: withdrawal.userId,
        type: "WITHDRAWAL_COMPLETED",
        currency: source.currency,
        amount: `-${source.amount}`,
        balanceBefore: lockedBefore,
        balanceAfter: wallet.lockedBalance,
        reference: withdrawal.id,
        status: "COMPLETED",
        description: withdrawal.currency === source.currency ? "Withdrawal completed." : `${withdrawal.currency} withdrawal completed.`,
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
        },
      });
    }
    withdrawal.status = "COMPLETED";
    withdrawal.completedAt = this.clock();
    withdrawal.completedBy = admin.id;
    withdrawal.externalTransactionReference = String(input.externalTransactionReference || input.transactionHash || "").trim();
    withdrawal.adminNote = String(input.adminNote || "").trim();
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal complete",
      message: `${withdrawal.amount} ${withdrawal.currency} sent.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
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
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      if (compare(wallet.lockedBalance, source.amount) < 0) {
        throw new Error("Locked balance is lower than the withdrawal amount.");
      }
    }

    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const availableBefore = wallet.availableBalance;
      const lockedBefore = wallet.lockedBalance;
      wallet.lockedBalance = subtract(wallet.lockedBalance, source.amount);
      wallet.availableBalance = add(wallet.availableBalance, source.amount);
      wallet.updatedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: withdrawal.userId,
        type: "REVERSAL",
        currency: source.currency,
        amount: source.amount,
        balanceBefore: availableBefore,
        balanceAfter: wallet.availableBalance,
        reference: withdrawal.id,
        status: "APPROVED",
        description: "Withdrawal rejected.",
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          lockedBalanceBefore: lockedBefore,
          lockedBalanceAfter: wallet.lockedBalance,
        },
      });
    }
    withdrawal.status = "REJECTED";
    withdrawal.rejectedAt = this.clock();
    withdrawal.rejectedBy = admin.id;
    withdrawal.adminNote = String(input.adminNote || "").trim();
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal rejected",
      message: withdrawal.adminNote || "Your reserved funds were returned.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
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
      let userPnl = multiplyRatio(eligibleBalance, performance.profitLossPercentage, "100");
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
      notifications: this.listNotifications(this.db.users.find((user) => user.role === "admin") || { role: "admin" }, { limit: 20 }),
      settings: {
        deposit: clone(this.db.systemSettings.deposit),
        withdrawal: clone(this.db.systemSettings.withdrawal),
        exchangeRate: clone(this.db.systemSettings.exchangeRate),
      },
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
    const today = this.clock().slice(0, 10);
    return this.db.transactions
      .filter((transaction) => ["TRADING_PROFIT", "TRADING_LOSS"].includes(transaction.type) && String(transaction.createdAt || "").startsWith(today))
      .reduce((sum, transaction) => add(sum, transaction.amount), "0");
  }

  deleteFinanceHistory(admin, input = {}, requestMeta = {}) {
    this.ensureState();
    const transactionIds = new Set((input.transactionIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    const depositIds = new Set((input.depositIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    const withdrawalIds = new Set((input.withdrawalIds || []).map((id) => String(id || "").trim()).filter(Boolean));

    if (!transactionIds.size && !depositIds.size && !withdrawalIds.size) {
      throw new Error("Select at least one history item.");
    }

    const before = {
      transactions: this.db.transactions.length,
      deposits: this.db.deposits.length,
      withdrawals: this.db.withdrawals.length,
    };
    this.db.transactions = this.db.transactions.filter((item) => !transactionIds.has(item.id));
    this.db.deposits = this.db.deposits.filter((item) => !depositIds.has(item.id));
    this.db.withdrawals = this.db.withdrawals.filter((item) => !withdrawalIds.has(item.id));

    const deleted = {
      transactions: before.transactions - this.db.transactions.length,
      deposits: before.deposits - this.db.deposits.length,
      withdrawals: before.withdrawals - this.db.withdrawals.length,
    };
    const deletedCount = deleted.transactions + deleted.deposits + deleted.withdrawals;
    if (!deletedCount) {
      throw new Error("Selected history was not found.");
    }

    this.audit(admin, "FINANCE_HISTORY_DELETED", "FinanceHistory", "bulk", deleted, requestMeta);
    this.persist();
    return { deletedCount, deleted };
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

  getWithdrawalFundingSources(withdrawal) {
    const sources = Array.isArray(withdrawal.fundingSources) && withdrawal.fundingSources.length
      ? withdrawal.fundingSources
      : [{ currency: withdrawal.currency, amount: withdrawal.amount }];
    return sources.map((source) => ({
      currency: normalizeCurrency(source.currency || withdrawal.currency),
      amount: normalizeAmount(source.amount || withdrawal.amount, "Withdrawal funding amount"),
    }));
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
    const today = this.clock().slice(0, 10);
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
      const address = String(input.address || input.walletAddress || input.usdtAddress || input.destinationAddress || "").trim();
      const network = String(input.network || input.usdtNetwork || input.chain || this.db.systemSettings.deposit.usdtNetwork || "").trim();
      if (!address || !network) {
        throw new Error("USDT withdrawal address and network are required.");
      }
      return { type: "USDT_WALLET", address, network };
    }

    const bankName = String(input.bankName || input.bank || input.bank_name || "").trim();
    const accountName = String(input.accountName || input.accountHolder || input.accountHolderName || input.name || "").trim();
    const accountNumber = String(input.accountNumber || input.accountNo || input.account || input.number || "").replace(/\D/g, "").trim();
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
