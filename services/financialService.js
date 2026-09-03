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
const { maskAccountNumber, toKobo } = require("./paystackService");

const SUPPORTED_CURRENCIES = ["USDT", "NGN"];
const WITHDRAWAL_STATUSES = ["PENDING", "APPROVED", "PROCESSING", "SUCCESS", "FAILED", "REJECTED", "REVERSED", "COMPLETED", "CANCELLED"];
const DEPOSIT_STATUSES = ["PENDING", "APPROVED", "REJECTED"];
const ACTIVE_WITHDRAWAL_STATUSES = ["PENDING", "APPROVED", "PROCESSING"];

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

function toDecimalText(value, fallback = "0") {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return number.toFixed(8).replace(/\.?0+$/, "") || "0";
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
    this.db.tradeInvestments = Array.isArray(this.db.tradeInvestments) ? this.db.tradeInvestments : [];
    this.db.notifications = Array.isArray(this.db.notifications) ? this.db.notifications : [];
    this.db.dailyPerformances = Array.isArray(this.db.dailyPerformances) ? this.db.dailyPerformances : [];
    this.db.auditLogs = Array.isArray(this.db.auditLogs) ? this.db.auditLogs : [];
    this.db.idempotencyKeys = Array.isArray(this.db.idempotencyKeys) ? this.db.idempotencyKeys : [];
    this.db.webhookEvents = Array.isArray(this.db.webhookEvents) ? this.db.webhookEvents : [];
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
        user.pnlLots = Array.isArray(user.pnlLots) ? user.pnlLots : [];
        user.bankAccounts = Array.isArray(user.bankAccounts) ? user.bankAccounts : [];
        if (user.bankAccount && !user.bankAccount.id) {
          user.bankAccount.id = this.idGenerator(12);
        }
        for (const currency of SUPPORTED_CURRENCIES) {
          this.ensureWallet(user.id, currency);
        }
      }
    }

    for (const withdrawal of this.db.withdrawals) {
      withdrawal.status = String(withdrawal.status || "PENDING").trim().toUpperCase();
      withdrawal.currency = normalizeCurrency(withdrawal.currency || "NGN");
      withdrawal.balanceReserved = withdrawal.balanceReserved !== false && ACTIVE_WITHDRAWAL_STATUSES.includes(withdrawal.status);
      if (withdrawal.currency === "NGN") {
        withdrawal.amountKobo = Number(withdrawal.amountKobo || toKobo(withdrawal.amount || "0"));
        withdrawal.paystackReference = withdrawal.paystackReference || withdrawal.externalTransactionReference || this.createPaystackReference();
        withdrawal.bank = withdrawal.bank || withdrawal.destination || {};
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

  createPaystackReference() {
    return `wd_${this.idGenerator(24).toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
  }

  normalizeBankAccount(input = {}) {
    const bankName = String(input.bankName || input.bank || input.bank_name || "").trim();
    const bankCode = String(input.bankCode || input.bank_code || "").trim();
    const accountName = String(input.accountName || input.account_name || "").trim();
    const accountNumber = String(input.accountNumber || input.account_number || "").replace(/\D/g, "").trim();
    if (!bankName || !bankCode || !accountName || !/^\d{10}$/.test(accountNumber)) {
      throw new Error("A verified Nigerian bank account is required.");
    }
    return {
      id: String(input.id || this.idGenerator(12)).trim(),
      type: "NGN_BANK",
      bankName,
      bankCode,
      accountNumber,
      maskedAccountNumber: maskAccountNumber(accountNumber),
      accountName,
      paystackRecipientCode: String(input.paystackRecipientCode || input.recipientCode || "").trim(),
      verified: input.verified !== false,
      verifiedAt: input.verifiedAt || this.clock(),
      updatedAt: this.clock(),
    };
  }

  getVerifiedBankAccount(user, bankAccountId = "") {
    const candidates = [
      ...(Array.isArray(user.bankAccounts) ? user.bankAccounts : []),
      user.bankAccount,
    ].filter(Boolean);
    const targetId = String(bankAccountId || "").trim();
    const account = targetId
      ? candidates.find((item) => item.id === targetId)
      : candidates.find((item) => item.verified);
    if (!account || !account.verified) {
      throw new Error("Add and verify a Nigerian bank account before withdrawal.");
    }
    return this.normalizeBankAccount(account);
  }

  updateVerifiedBankAccount(user, input = {}, requestMeta = {}) {
    this.ensureState();
    const bankAccount = this.normalizeBankAccount({ ...input, verified: true });
    user.bankAccount = bankAccount;
    user.bankAccounts = Array.isArray(user.bankAccounts) ? user.bankAccounts : [];
    user.bankAccounts = [
      bankAccount,
      ...user.bankAccounts.filter(
        (item) => item.accountNumber !== bankAccount.accountNumber || item.bankCode !== bankAccount.bankCode
      ),
    ];
    this.audit(user, "BANK_ACCOUNT_VERIFIED", "User", user.id, {
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode,
      maskedAccountNumber: bankAccount.maskedAccountNumber,
    }, requestMeta);
    this.persist();
    return clone(bankAccount);
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
    } else {
      const availableFallback = wallet.availableBalance ?? wallet.balance ?? wallet.amount ?? "0";
      const lockedFallback = wallet.lockedBalance ?? wallet.locked ?? "0";
      wallet.availableBalance = normalizeNonNegativeAmount(availableFallback, "Available balance");
      wallet.lockedBalance = normalizeNonNegativeAmount(lockedFallback, "Locked balance");
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

  getWalletHistory(user, { limit = 80 } = {}) {
    this.ensureState();
    const canSee = (record) => user.role === "admin" || record.userId === user.id;
    const deposits = this.db.deposits
      .filter(canSee)
      .map((deposit) => ({
        id: deposit.id,
        kind: "DEPOSIT",
        type: "DEPOSIT",
        status: deposit.status,
        currency: deposit.currency,
        amount: deposit.amount,
        displayAmounts: deposit.displayAmounts || this.getDisplayAmounts(deposit.amount, deposit.currency, deposit.exchangeRate),
        reference: deposit.transactionHash || deposit.id,
        description: "Deposit",
        createdAt: deposit.submittedAt,
        userId: deposit.userId,
      }));
    const withdrawals = this.db.withdrawals
      .filter(canSee)
      .map((withdrawal) => ({
        id: withdrawal.id,
        kind: "WITHDRAWAL",
        type: "WITHDRAWAL",
        status: withdrawal.status,
        currency: withdrawal.currency,
        amount: `-${withdrawal.amount}`,
        displayAmounts: withdrawal.displayAmounts || this.getDisplayAmounts(withdrawal.amount, withdrawal.currency, withdrawal.exchangeRate),
        reference: withdrawal.externalTransactionReference || withdrawal.id,
        description: "Withdrawal",
        createdAt: withdrawal.submittedAt,
        userId: withdrawal.userId,
      }));
    const ledgerTransactions = this.db.transactions
      .filter((transaction) => canSee(transaction) && !["DEPOSIT", "WITHDRAWAL", "WITHDRAWAL_COMPLETED", "REVERSAL"].includes(transaction.type))
      .map((transaction) => ({
        ...clone(transaction),
        kind: "LEDGER",
        displayAmounts: transaction.metadata?.displayAmounts || this.getDisplayAmounts(transaction.amount, transaction.currency),
      }));

    return [...deposits, ...withdrawals, ...ledgerTransactions]
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, limit)
      .map((item) => this.enrichUserRecord(item));
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
      bankAccount: clone(user.bankAccount || null),
      bankAccounts: clone(user.bankAccounts || []),
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
      walletHistory: this.getWalletHistory(user, { limit: 80 }),
      notifications: this.listNotifications(user, { limit: 12 }),
      settings: {
        deposit: clone(this.db.systemSettings.deposit),
        withdrawal: clone(this.db.systemSettings.withdrawal),
        exchangeRate: clone(this.db.systemSettings.exchangeRate),
      },
    };
  }

  getMirrorPnlPercentage(mirror = {}) {
    const rawPercentage = toDecimalText(mirror.todayPnlPercent ?? mirror.percent ?? "0");
    const adminPnlValue = toDecimalText(mirror.todayPnlValue ?? mirror.amountUsdt ?? "0");
    const adminCapitalBase = toDecimalText(mirror.todayCapitalBase ?? mirror.todayOpeningUsdt ?? mirror.baseUsdt ?? "0");

    if (compare(rawPercentage, "0") !== 0 || compare(adminPnlValue, "0") === 0 || compare(adminCapitalBase, "0") === 0) {
      return rawPercentage;
    }

    return multiplyRatio(adminPnlValue, "100", adminCapitalBase);
  }

  getMirrorDayKey(mirror = {}) {
    return String(mirror.todayLabel || mirror.dayKey || this.clock().slice(0, 10)).slice(0, 10);
  }

  getUserPnlLots(userId) {
    const user = this.db.users.find((item) => item.id === userId);
    if (!user) {
      return [];
    }
    user.pnlLots = Array.isArray(user.pnlLots) ? user.pnlLots : [];
    return user.pnlLots;
  }

  getAvailableUsdtEquivalent(userId, rate = this.db.systemSettings.exchangeRate.usdtToNgn) {
    const usdtWallet = this.ensureWallet(userId, "USDT");
    const ngnWallet = this.ensureWallet(userId, "NGN");
    return add(usdtWallet.availableBalance, this.convertAmount(ngnWallet.availableBalance, "NGN", "USDT", rate));
  }

  resetPnlLotsToCurrentBalance(userId, mirror = {}, { source = "BALANCE_BASELINE", referenceId = "" } = {}) {
    const user = this.db.users.find((item) => item.id === userId);
    if (!user) {
      return null;
    }
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const principalUsdt = this.getAvailableUsdtEquivalent(userId, rate);
    const baselinePercent = this.getMirrorPnlPercentage(mirror);
    const dayKey = this.getMirrorDayKey(mirror);
    const principalNgn = this.convertAmount(principalUsdt, "USDT", "NGN", rate);
    user.pnlLots = compare(principalUsdt, "0") > 0 ? [{
      id: this.idGenerator(12),
      referenceId,
      source,
      currency: "USDT",
      principalUsdt,
      principalNgn,
      baselinePercent,
      lastMirrorPercent: baselinePercent,
      dayKey,
      createdAt: this.clock(),
    }] : [];
    return user.pnlLots[0] || null;
  }

  ensurePnlBaselineForBalance(userId, baseUsdt, rate, mirror = {}) {
    const lots = this.getUserPnlLots(userId);
    if (lots.length || compare(baseUsdt, "0") <= 0) {
      return false;
    }

    const baselinePercent = this.getMirrorPnlPercentage(mirror);
    lots.push({
      id: this.idGenerator(12),
      source: "BALANCE_BASELINE",
      currency: "USDT",
      principalUsdt: String(baseUsdt),
      principalNgn: this.convertAmount(baseUsdt, "USDT", "NGN", rate),
      baselinePercent,
      lastMirrorPercent: baselinePercent,
      dayKey: this.getMirrorDayKey(mirror),
      createdAt: this.clock(),
    });
    return true;
  }

  calculatePnlLotsAtMirror(userId, mirror = {}) {
    const lots = this.getUserPnlLots(userId);
    const percentage = this.getMirrorPnlPercentage(mirror);
    return lots.reduce((sum, lot) => {
      const deltaPercent = subtract(percentage, toDecimalText(lot.baselinePercent || "0"));
      return add(sum, multiplyRatio(lot.principalUsdt || "0", deltaPercent, "100"));
    }, "0");
  }

  settleCurrentUserPnl(userId, mirror = {}) {
    const rate = this.db.systemSettings.exchangeRate.usdtToNgn;
    const baseUsdt = this.getAvailableUsdtEquivalent(userId, rate);
    const baselineCreated = this.ensurePnlBaselineForBalance(userId, baseUsdt, rate, mirror);
    const daySettlement = this.settleUserPnlLotsForMirror(userId, mirror);
    const pnlUsdt = this.calculatePnlLotsAtMirror(userId, mirror);
    if (compare(pnlUsdt, "0") !== 0) {
      const wallet = this.ensureWallet(userId, "USDT");
      wallet.availableBalance = add(wallet.availableBalance, pnlUsdt);
      wallet.updatedAt = this.clock();
    }
    this.resetPnlLotsToCurrentBalance(userId, mirror, { source: "PNL_SETTLED" });
    return {
      pnlUsdt,
      changed: baselineCreated || daySettlement.changed || compare(pnlUsdt, "0") !== 0,
    };
  }

  settleUserPnlLotsForMirror(userId, mirror = {}) {
    const lots = this.getUserPnlLots(userId);
    const percentage = this.getMirrorPnlPercentage(mirror);
    const dayKey = this.getMirrorDayKey(mirror);
    let settledUsdt = "0";
    let changed = false;

    for (const lot of lots) {
      lot.principalUsdt = toDecimalText(lot.principalUsdt || "0");
      lot.baselinePercent = toDecimalText(lot.baselinePercent ?? percentage);
      lot.lastMirrorPercent = toDecimalText(lot.lastMirrorPercent ?? lot.baselinePercent);
      lot.dayKey = String(lot.dayKey || dayKey).slice(0, 10);

      if (lot.dayKey !== dayKey) {
        const previousDelta = subtract(lot.lastMirrorPercent, lot.baselinePercent);
        const lotPnlUsdt = multiplyRatio(lot.principalUsdt, previousDelta, "100");
        if (compare(lotPnlUsdt, "0") !== 0) {
          settledUsdt = add(settledUsdt, lotPnlUsdt);
          lot.principalUsdt = add(lot.principalUsdt, lotPnlUsdt);
        }
        lot.baselinePercent = percentage;
        lot.lastMirrorPercent = percentage;
        lot.dayKey = dayKey;
        changed = true;
      }
    }

    if (compare(settledUsdt, "0") !== 0) {
      const wallet = this.ensureWallet(userId, "USDT");
      wallet.availableBalance = add(wallet.availableBalance, settledUsdt);
      wallet.updatedAt = this.clock();
      changed = true;
    }

    return { lots, changed, settledUsdt };
  }

  calculateUserMirroredPnl(userId, baseUsdt, rate, mirror = {}) {
    const baselineCreated = this.ensurePnlBaselineForBalance(userId, baseUsdt, rate, mirror);
    const settled = this.settleUserPnlLotsForMirror(userId, mirror);
    const effectiveBaseUsdt = add(baseUsdt, settled.settledUsdt || "0");
    const percentage = this.getMirrorPnlPercentage(mirror);
    let pnlUsdt = "0";
    let changed = baselineCreated || settled.changed;

    for (const lot of settled.lots) {
      const deltaPercent = subtract(percentage, toDecimalText(lot.baselinePercent || "0"));
      pnlUsdt = add(pnlUsdt, multiplyRatio(lot.principalUsdt || "0", deltaPercent, "100"));
      if (lot.lastMirrorPercent !== percentage) {
        lot.lastMirrorPercent = percentage;
        changed = true;
      }
    }

    if (changed) {
      this.persist();
    }

    return {
      baseUsdt: effectiveBaseUsdt,
      baseNgnEquivalent: this.convertAmount(effectiveBaseUsdt, "USDT", "NGN", rate),
      pnlUsdt,
      percentage: compare(effectiveBaseUsdt, "0") === 0 ? "0" : multiplyRatio(pnlUsdt, "100", effectiveBaseUsdt),
      lots: clone(settled.lots),
    };
  }

  applyMirroredPnlToDashboard(dashboard, mirror = {}) {
    const userId = dashboard?.user?.id || "";
    const rawBaseUsdt = String(dashboard?.totalBalance?.usdt || "0");
    const rate = String(dashboard?.totalBalance?.usdtToNgnRate || this.db.systemSettings.exchangeRate.usdtToNgn);
    const mirrored = this.calculateUserMirroredPnl(userId, rawBaseUsdt, rate, mirror);
    const baseUsdt = mirrored.baseUsdt;
    const baseNgnEquivalent = mirrored.baseNgnEquivalent;
    const pnlUsdt = mirrored.pnlUsdt;
    const liveUsdt = add(baseUsdt, pnlUsdt);
    const liveNgn = this.convertAmount(liveUsdt, "USDT", "NGN", rate);
    return {
      ...dashboard,
      totalBalance: {
        ...dashboard.totalBalance,
        baseUsdt,
        baseNgnEquivalent,
        usdt: baseUsdt,
        ngnEquivalent: baseNgnEquivalent,
        liveUsdt,
        liveNgnEquivalent: liveNgn,
      },
      performance: {
        ...dashboard.performance,
        todayUsdt: pnlUsdt,
        todayPercentage: mirrored.percentage,
        mirroredFrom: mirror.source || "ADMIN_BYBIT",
      },
      mirrorPnl: {
        source: mirror.source || "ADMIN_BYBIT",
        percent: mirrored.percentage,
        adminPercent: this.getMirrorPnlPercentage(mirror),
        amountUsdt: pnlUsdt,
        adminAmountUsdt: String(mirror.todayPnlValue ?? mirror.amountUsdt ?? "0"),
        adminCapitalBase: String(mirror.todayCapitalBase ?? mirror.todayOpeningUsdt ?? "0"),
        assetPnl: Array.isArray(mirror.todayAssetPnl) ? clone(mirror.todayAssetPnl) : [],
        baseUsdt,
        liveUsdt,
        lots: mirrored.lots,
        stale: !!mirror.stale,
        updatedAt: mirror.updatedAt || mirror.cachedAt || null,
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
    if (!deposit.creditedAt) {
      const balanceBefore = wallet.availableBalance;
      wallet.availableBalance = add(wallet.availableBalance, deposit.amount);
      wallet.updatedAt = this.clock();
      deposit.creditedAt = this.clock();
      deposit.creditedBy = admin.id;
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
          principalCredit: true,
        },
      });
    }
    deposit.status = "APPROVED";
    deposit.reviewedAt = this.clock();
    deposit.reviewedBy = admin.id;
    deposit.adminNote = String(input.adminNote || "").trim();
    for (const transaction of this.db.transactions.filter((item) => item.type === "DEPOSIT" && item.reference === deposit.id)) {
      transaction.status = "APPROVED";
      transaction.description = `Manual ${deposit.currency} deposit approved by admin.`;
      transaction.reviewedAt = deposit.reviewedAt;
      transaction.reviewedBy = admin.id;
    }
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
    const wallet = this.ensureWallet(deposit.userId, deposit.currency);
    if (deposit.creditedAt && !deposit.reversedAt) {
      const balanceBefore = wallet.availableBalance;
      wallet.availableBalance = subtract(wallet.availableBalance, deposit.amount);
      wallet.updatedAt = this.clock();
      deposit.reversedAt = this.clock();
      this.db.transactions.unshift({
        id: this.idGenerator(12),
        userId: deposit.userId,
        type: "REVERSAL",
        currency: deposit.currency,
        amount: `-${deposit.amount}`,
        balanceBefore,
        balanceAfter: wallet.availableBalance,
        reference: deposit.id,
        status: "REJECTED",
        description: "Rejected deposit reversed.",
        createdBy: admin.id,
        createdAt: this.clock(),
        metadata: {
          displayAmounts: deposit.displayAmounts || this.getDisplayAmounts(deposit.amount, deposit.currency, deposit.exchangeRate),
          principalCredit: true,
        },
      });
    }
    deposit.status = "REJECTED";
    deposit.reviewedAt = this.clock();
    deposit.reviewedBy = admin.id;
    deposit.adminNote = String(input.adminNote || "").trim();
    for (const transaction of this.db.transactions.filter((item) => item.type === "DEPOSIT" && item.reference === deposit.id)) {
      transaction.status = "REJECTED";
      transaction.description = "Deposit rejected.";
      transaction.reviewedAt = deposit.reviewedAt;
      transaction.reviewedBy = admin.id;
    }
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

  updateUserBankAccount(user, input = {}, requestMeta = {}) {
    this.ensureState();
    if (input.verified === true || input.accountName || input.account_name) {
      return this.updateVerifiedBankAccount(user, input.destination || input, requestMeta);
    }
    throw new Error("Verify the bank account before saving it.");
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
    const alternateCurrency = currency === "USDT" ? "NGN" : "USDT";
    const alternateWallet = this.ensureWallet(targetUser.id, alternateCurrency);
    const balanceBefore = wallet.availableBalance;
    const alternateBalanceBefore = alternateWallet.availableBalance;
    wallet.availableBalance = amount;
    alternateWallet.availableBalance = "0";
    wallet.updatedAt = this.clock();
    alternateWallet.updatedAt = this.clock();
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
      metadata: {
        overwriteUnifiedBalance: true,
        clearedCurrency: alternateCurrency,
        clearedBalanceBefore: alternateBalanceBefore,
      },
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
    if (["SUSPENDED", "BLOCKED"].includes(String(user.status || "").trim().toUpperCase())) {
      throw new Error("This account cannot request withdrawals right now.");
    }

    const currency = normalizeCurrency(input.currency);
    const amount = normalizeAmount(input.amount, "Withdrawal amount");
    this.validateWithdrawalSettings(currency, amount);
    this.validateDailyWithdrawalLimit(user.id);
    const activeInvestments = this.db.tradeInvestments.filter((item) => item.userId === user.id && item.status === "ACTIVE");
    if (activeInvestments.length) {
      throw new Error("Stop active trades before requesting a withdrawal.");
    }
    let destination = null;
    let bank = null;
    if (currency === "NGN") {
      bank = this.getVerifiedBankAccount(user, input.bankAccountId);
      destination = {
        type: "NGN_BANK",
        bankName: bank.bankName,
        bankCode: bank.bankCode,
        accountName: bank.accountName,
        accountNumber: bank.accountNumber,
        maskedAccountNumber: bank.maskedAccountNumber,
      };
      const duplicate = this.db.withdrawals.find((withdrawal) =>
        withdrawal.userId === user.id &&
        withdrawal.currency === "NGN" &&
        withdrawal.amount === amount &&
        ACTIVE_WITHDRAWAL_STATUSES.includes(withdrawal.status) &&
        (withdrawal.bank?.accountNumber || withdrawal.destination?.accountNumber) === bank.accountNumber
      );
      if (duplicate) {
        throw new Error("A matching withdrawal request is already in review.");
      }
    }
    const fundingSources = this.resolveWithdrawalFunding(user.id, currency, amount);
    if (currency !== "NGN") {
      destination = this.normalizeWithdrawalDestination(currency, input.destination || input);
    }
    const paystackReference = currency === "NGN" ? this.createPaystackReference() : "";
    const withdrawal = {
      id: this.idGenerator(12),
      userId: user.id,
      amount,
      amountKobo: currency === "NGN" ? toKobo(amount) : 0,
      currency,
      status: "PENDING",
      exchangeRate: this.db.systemSettings.exchangeRate.usdtToNgn,
      displayAmounts: this.getDisplayAmounts(amount, currency),
      bank,
      destination,
      paystackRecipientCode: bank?.paystackRecipientCode || "",
      paystackTransferCode: "",
      paystackReference,
      fee: currency === "USDT" ? this.db.systemSettings.withdrawal.usdtFee : this.db.systemSettings.withdrawal.ngnFee,
      submittedAt: this.clock(),
      approvedAt: null,
      approvedBy: null,
      processingAt: null,
      processedBy: null,
      completedAt: null,
      completedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: "",
      failureReason: "",
      telegramMessageId: "",
      balanceReserved: true,
      fundingSources: fundingSources.map((source) => ({
        currency: source.currency,
        amount: source.amount,
      })),
      externalTransactionReference: paystackReference,
      adminNote: "",
      metadata: {},
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
      type: "WITHDRAWAL_REQUEST",
      title: "New Withdrawal Request",
      message: `${user.name || "User"} requested ${amount} ${currency}.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.createNotification({
      userId: user.id,
      type: "WITHDRAWAL",
      title: "Withdrawal submitted",
      message: `Your withdrawal request of ${amount} ${currency} is awaiting approval.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(user, "WITHDRAWAL_CREATED", "Withdrawal", withdrawal.id, { amount, currency }, requestMeta);
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
    const current = this.getWithdrawal(withdrawalId);
    if (current.currency === "NGN" && current.paystackReference) {
      throw new Error("Use Paystack approval for NGN bank withdrawals.");
    }
    const withdrawal = this.changeWithdrawalStatus(admin, withdrawalId, "PROCESSING", input, requestMeta);
    withdrawal.processingAt = this.clock();
    withdrawal.processedBy = admin.id;
    this.persist();
    return clone(withdrawal);
  }

  setWithdrawalTelegramMessage(withdrawalId, telegramMessageId) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    withdrawal.telegramMessageId = String(telegramMessageId || "").trim();
    this.persist();
    return clone(withdrawal);
  }

  setWithdrawalRecipientCode(withdrawalId, recipientCode) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    const code = String(recipientCode || "").trim();
    withdrawal.paystackRecipientCode = code;
    const user = this.db.users.find((item) => item.id === withdrawal.userId);
    if (user?.bankAccount && withdrawal.bank && user.bankAccount.accountNumber === withdrawal.bank.accountNumber && user.bankAccount.bankCode === withdrawal.bank.bankCode) {
      user.bankAccount.paystackRecipientCode = code;
      user.bankAccounts = Array.isArray(user.bankAccounts) ? user.bankAccounts : [];
      user.bankAccounts = user.bankAccounts.map((account) =>
        account.accountNumber === withdrawal.bank.accountNumber && account.bankCode === withdrawal.bank.bankCode
          ? { ...account, paystackRecipientCode: code }
          : account
      );
    }
    this.persist();
    return clone(withdrawal);
  }

  approvePaystackWithdrawal(admin, withdrawalId, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.currency !== "NGN") {
      throw new Error("Only NGN bank withdrawals can be approved through Paystack.");
    }
    if (withdrawal.status !== "PENDING") {
      const error = new Error("Withdrawal has already been processed.");
      error.statusCode = 409;
      throw error;
    }
    if (withdrawal.balanceReserved !== true) {
      throw new Error("Withdrawal balance was not reserved.");
    }
    withdrawal.status = "APPROVED";
    withdrawal.approvedBy = admin.id;
    withdrawal.approvedAt = this.clock();
    withdrawal.paystackReference = withdrawal.paystackReference || this.createPaystackReference();
    withdrawal.externalTransactionReference = withdrawal.paystackReference;
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      approvalIpAddress: requestMeta.ipAddress || "",
    };
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal approved",
      message: "Your withdrawal has been approved and payment is being processed.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_APPROVED", "Withdrawal", withdrawal.id, {
      amount: withdrawal.amount,
      currency: withdrawal.currency,
      maskedAccountNumber: withdrawal.bank?.maskedAccountNumber || maskAccountNumber(withdrawal.bank?.accountNumber),
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferAttempt(admin, withdrawalId, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackTransferAttemptedAt: withdrawal.metadata?.paystackTransferAttemptedAt || this.clock(),
      paystackTransferAttemptedBy: admin.id,
    };
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferProcessing(admin, withdrawalId, paystackPayload = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Only approved withdrawals can move to processing.");
    }
    const data = paystackPayload.data || paystackPayload || {};
    withdrawal.status = "PROCESSING";
    withdrawal.processingAt = withdrawal.processingAt || this.clock();
    withdrawal.processedBy = withdrawal.processedBy || admin.id;
    withdrawal.paystackTransferCode = String(data.transfer_code || withdrawal.paystackTransferCode || "").trim();
    withdrawal.paystackReference = String(data.reference || withdrawal.paystackReference || "").trim();
    withdrawal.externalTransactionReference = withdrawal.paystackReference;
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackStatus: String(data.status || "").trim(),
      requiresOtp: /otp/i.test(String(paystackPayload.message || data.status || "")),
      paystackTransferResponse: {
        id: data.id || data.transfer_code || "",
        status: data.status || "",
      },
    };
    this.audit(admin, "PAYSTACK_TRANSFER_INITIATED", "Withdrawal", withdrawal.id, {
      amountKobo: withdrawal.amountKobo,
      reference: withdrawal.paystackReference,
      transferCode: withdrawal.paystackTransferCode,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  markPaystackTransferUnclear(admin, withdrawalId, error, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackTransferUnclear: true,
      paystackTransferUnclearAt: this.clock(),
      paystackTransferUnclearReason: String(error?.message || error || "").slice(0, 180),
    };
    this.audit(admin, "PAYSTACK_TRANSFER_UNCLEAR", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  completeWithdrawal(admin, withdrawalId, input = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawal(withdrawalId);
    if (withdrawal.currency === "NGN" && withdrawal.paystackReference) {
      throw new Error("Paystack webhook must confirm NGN withdrawal success.");
    }
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
    withdrawal.balanceReserved = false;
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
    if (withdrawal.status !== "PENDING") {
      throw new Error("Only pending withdrawals can be rejected.");
    }
    this.releaseWithdrawalReservation(withdrawal, admin, "REJECTED", "Withdrawal rejected.");
    withdrawal.status = "REJECTED";
    withdrawal.rejectedAt = this.clock();
    withdrawal.rejectedBy = admin.id;
    withdrawal.rejectionReason = String(input.reason || input.adminNote || "").trim();
    withdrawal.adminNote = withdrawal.rejectionReason;
    withdrawal.balanceReserved = false;
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal rejected",
      message: "Your withdrawal request was rejected.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit(admin, "WITHDRAWAL_REJECTED", "Withdrawal", withdrawal.id, { amount: withdrawal.amount, currency: withdrawal.currency }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  consumeWithdrawalReservation(withdrawal, actor, status, description) {
    if (withdrawal.balanceReserved === false) {
      return;
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
        status,
        description,
        createdBy: actor?.id || "system",
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          paystackReference: withdrawal.paystackReference || "",
        },
      });
    }
    withdrawal.balanceReserved = false;
  }

  releaseWithdrawalReservation(withdrawal, actor, status, description) {
    if (withdrawal.balanceReserved === false) {
      return;
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
        status,
        description,
        createdBy: actor?.id || "system",
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          lockedBalanceBefore: lockedBefore,
          lockedBalanceAfter: wallet.lockedBalance,
          paystackReference: withdrawal.paystackReference || "",
        },
      });
    }
    withdrawal.balanceReserved = false;
  }

  creditWithdrawalReversal(withdrawal, actor, description) {
    if (withdrawal.metadata?.reversalCreditedAt) {
      return;
    }
    const fundingSources = this.getWithdrawalFundingSources(withdrawal);
    for (const source of fundingSources) {
      const wallet = this.ensureWallet(withdrawal.userId, source.currency);
      const availableBefore = wallet.availableBalance;
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
        status: "REVERSED",
        description,
        createdBy: actor?.id || "system",
        createdAt: this.clock(),
        metadata: {
          requestedCurrency: withdrawal.currency,
          requestedAmount: withdrawal.amount,
          paystackReference: withdrawal.paystackReference || "",
        },
      });
    }
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      reversalCreditedAt: this.clock(),
    };
  }

  applyPaystackTransferSuccess(reference, eventData = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawalByPaystackReference(reference);
    if (withdrawal.status === "SUCCESS") {
      return clone(withdrawal);
    }
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Withdrawal is not ready for Paystack success.");
    }
    this.assertPaystackEventMatchesWithdrawal(withdrawal, eventData);
    this.consumeWithdrawalReservation(withdrawal, { id: "paystack", role: "system" }, "SUCCESS", "Withdrawal paid by Paystack.");
    withdrawal.status = "SUCCESS";
    withdrawal.completedAt = this.clock();
    withdrawal.paystackTransferCode = String(eventData.transfer_code || withdrawal.paystackTransferCode || "").trim();
    withdrawal.failureReason = "";
    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),
      paystackStatus: String(eventData.status || "success"),
    };
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal paid",
      message: `Your withdrawal of ${withdrawal.amount} NGN has been successfully paid to your bank account.`,
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit({ id: "paystack", role: "system" }, "PAYSTACK_TRANSFER_SUCCESS", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      amountKobo: withdrawal.amountKobo,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  applyPaystackTransferFailed(reference, eventData = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawalByPaystackReference(reference);
    if (withdrawal.status === "FAILED") {
      return clone(withdrawal);
    }
    if (!["APPROVED", "PROCESSING"].includes(withdrawal.status)) {
      throw new Error("Withdrawal is not ready for Paystack failure.");
    }
    this.assertPaystackEventMatchesWithdrawal(withdrawal, eventData);
    this.releaseWithdrawalReservation(withdrawal, { id: "paystack", role: "system" }, "FAILED", "Paystack transfer failed.");
    withdrawal.status = "FAILED";
    withdrawal.failureReason = String(eventData.reason || eventData.gateway_response || "Paystack transfer failed.").slice(0, 180);
    withdrawal.balanceReserved = false;
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal failed",
      message: "We could not complete your withdrawal. The amount has been returned to your available balance.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit({ id: "paystack", role: "system" }, "PAYSTACK_TRANSFER_FAILED", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      amountKobo: withdrawal.amountKobo,
    }, requestMeta);
    this.persist();
    return clone(withdrawal);
  }

  applyPaystackTransferReversed(reference, eventData = {}, requestMeta = {}) {
    this.ensureState();
    const withdrawal = this.getWithdrawalByPaystackReference(reference);
    if (withdrawal.status === "REVERSED") {
      return clone(withdrawal);
    }
    this.assertPaystackEventMatchesWithdrawal(withdrawal, eventData);
    if (withdrawal.balanceReserved !== false) {
      this.releaseWithdrawalReservation(withdrawal, { id: "paystack", role: "system" }, "REVERSED", "Paystack transfer reversed.");
    } else if (withdrawal.status === "SUCCESS") {
      this.creditWithdrawalReversal(withdrawal, { id: "paystack", role: "system" }, "Paystack transfer reversed.");
    }
    withdrawal.status = "REVERSED";
    withdrawal.failureReason = String(eventData.reason || eventData.gateway_response || "Paystack transfer reversed.").slice(0, 180);
    withdrawal.balanceReserved = false;
    this.createNotification({
      userId: withdrawal.userId,
      type: "WITHDRAWAL",
      title: "Withdrawal reversed",
      message: "Your withdrawal was reversed. The amount has been returned to your available balance.",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
    });
    this.audit({ id: "paystack", role: "system" }, "PAYSTACK_TRANSFER_REVERSED", "Withdrawal", withdrawal.id, {
      reference: withdrawal.paystackReference,
      amountKobo: withdrawal.amountKobo,
    }, requestMeta);
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

  getWithdrawalByPaystackReference(reference) {
    const normalized = String(reference || "").trim();
    const withdrawal = this.db.withdrawals.find((item) => item.paystackReference === normalized);
    if (!withdrawal) {
      throw new Error("Withdrawal request not found for Paystack reference.");
    }
    return withdrawal;
  }

  assertPaystackEventMatchesWithdrawal(withdrawal, eventData = {}) {
    const eventAmount = Number(eventData.amount || 0);
    if (eventAmount && eventAmount !== Number(withdrawal.amountKobo || 0)) {
      throw new Error("Paystack webhook amount does not match withdrawal.");
    }
    const eventReference = String(eventData.reference || "").trim();
    if (eventReference && eventReference !== withdrawal.paystackReference) {
      throw new Error("Paystack webhook reference does not match withdrawal.");
    }
    const recipientCode = String(eventData.recipient?.recipient_code || eventData.recipient || "").trim();
    if (recipientCode && withdrawal.paystackRecipientCode && recipientCode !== withdrawal.paystackRecipientCode) {
      throw new Error("Paystack webhook recipient does not match withdrawal.");
    }
  }

  recordPaystackWebhookEvent({ eventType, reference, payloadHash } = {}) {
    this.ensureState();
    const normalizedHash = String(payloadHash || "").trim();
    const existing = this.db.webhookEvents.find((item) => item.provider === "paystack" && item.payloadHash === normalizedHash);
    if (existing) {
      return { duplicate: !!existing.processed, event: clone(existing) };
    }
    const event = {
      id: this.idGenerator(12),
      provider: "paystack",
      eventType: String(eventType || "").trim(),
      reference: String(reference || "").trim(),
      payloadHash: normalizedHash,
      processed: false,
      createdAt: this.clock(),
      processedAt: null,
    };
    this.db.webhookEvents.unshift(event);
    this.persist();
    return { duplicate: false, event };
  }

  markPaystackWebhookEventProcessed(eventId) {
    const event = this.db.webhookEvents.find((item) => item.id === eventId);
    if (event) {
      event.processed = true;
      event.processedAt = this.clock();
      this.persist();
    }
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

  mergeBankDestination(saved = {}, input = {}) {
    const pick = (...values) => {
      for (const value of values) {
        const normalized = String(value || "").trim();
        if (normalized) {
          return normalized;
        }
      }
      return "";
    };
    return {
      bankName: pick(input.bankName, input.bank, input.bank_name, saved.bankName),
      accountName: pick(input.accountName, input.accountHolder, input.accountHolderName, input.name, saved.accountName),
      accountNumber: pick(input.accountNumber, input.accountNo, input.account, input.number, saved.accountNumber),
    };
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
