const { compare, subtract } = require("../lib/money");
const { randomId } = require("../lib/security");

const EXECUTION_ACTION = "EXECUTE_ADMIN_BONUS_REVERSAL";

class AdminBonusReversalService {
  constructor({ db, withUserFinancialLock, persist, markFinancialMutation, createNotification, idGenerator = randomId, clock = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.withUserFinancialLock = withUserFinancialLock;
    this.persist = persist;
    this.markFinancialMutation = markFinancialMutation;
    this.createNotification = createNotification;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  getOriginalBonus(reference) {
    const normalizedReference = String(reference || "").trim();
    const transaction = (this.db.transactions || []).find((item) => item.reference === normalizedReference);
    if (!transaction) throw new Error("Original bonus transaction was not found.");
    const creator = (this.db.users || []).find((user) => user.id === transaction.createdBy);
    if (transaction.type !== "BONUS" || transaction.status !== "APPROVED" || creator?.role !== "admin") {
      throw new Error("Transaction is not an approved admin bonus.");
    }
    if (transaction.currency !== "USDT") throw new Error("Only USDT admin bonuses can be reversed by this mechanism.");
    if (compare(transaction.amount, "0") <= 0) throw new Error("Original admin bonus amount must be positive.");
    return transaction;
  }

  getWallet(userId) {
    const wallet = (this.db.wallets || []).find((item) => item.userId === userId && item.currency === "USDT");
    if (!wallet) throw new Error("Authoritative USDT wallet was not found.");
    return wallet;
  }

  inspect(reference) {
    const bonus = this.getOriginalBonus(reference);
    const wallet = this.getWallet(bonus.userId);
    const reversalReference = `admin-bonus-reversal:${bonus.reference}`;
    const existing = (this.db.transactions || []).find((item) => item.reference === reversalReference);
    const sufficient = compare(wallet.availableBalance, bonus.amount) >= 0;
    return {
      mode: "DRY_RUN",
      userId: bonus.userId,
      originalBonusReference: bonus.reference,
      bonusAmount: bonus.amount,
      currency: bonus.currency,
      currentAvailableBalance: wallet.availableBalance,
      currentLockedBalance: wallet.lockedBalance,
      reversalReference,
      eligible: !existing && sufficient,
      reason: existing ? "ALREADY_REVERSED" : sufficient ? "ELIGIBLE" : "MANUAL_REVIEW_REQUIRED",
      proposedDelta: `-${bonus.amount}`,
      expectedAvailableBalance: sufficient ? subtract(wallet.availableBalance, bonus.amount) : wallet.availableBalance,
    };
  }

  async execute(admin, reference, { action, reason = "Unnecessary admin bonus reversal" } = {}) {
    if (!admin || admin.role !== "admin") throw new Error("Admin authorization is required.");
    if (action !== EXECUTION_ACTION) throw new Error(`Explicit action ${EXECUTION_ACTION} is required.`);
    const initialBonus = this.getOriginalBonus(reference);

    return this.withUserFinancialLock(initialBonus.userId, async () => {
      const bonus = this.getOriginalBonus(reference);
      if (bonus.userId !== initialBonus.userId) throw new Error("Original bonus ownership changed during reversal.");
      const wallet = this.getWallet(bonus.userId);
      const reversalReference = `admin-bonus-reversal:${bonus.reference}`;
      const existing = (this.db.transactions || []).find((item) => item.reference === reversalReference);
      if (existing) return { status: "ALREADY_REVERSED", transaction: existing, preview: this.inspect(reference) };
      if (compare(wallet.availableBalance, bonus.amount) < 0) {
        return { status: "MANUAL_REVIEW_REQUIRED", transaction: null, preview: this.inspect(reference) };
      }

      const balanceBefore = wallet.availableBalance;
      const lockedBefore = wallet.lockedBalance;
      wallet.availableBalance = subtract(wallet.availableBalance, bonus.amount);
      wallet.updatedAt = this.clock();
      this.markFinancialMutation(wallet, "ADMIN_BONUS_REVERSAL", reversalReference);
      const transaction = {
        id: this.idGenerator(12), userId: bonus.userId, type: "BONUS_REVERSAL", currency: "USDT",
        amount: `-${bonus.amount}`, balanceBefore, balanceAfter: wallet.availableBalance,
        reference: reversalReference, status: "APPROVED", description: "Admin bonus reversal",
        createdBy: admin.id, createdAt: this.clock(),
        metadata: {
          reason: String(reason || "Unnecessary admin bonus reversal"),
          originalBonusReference: bonus.reference,
          originalBonusAmount: bonus.amount,
          originalBonusTransactionId: bonus.id,
          lockedBalanceBefore: lockedBefore,
          lockedBalanceAfter: wallet.lockedBalance,
          initiatingAdminId: admin.id,
        },
      };
      this.db.transactions.unshift(transaction);
      await this.persist({
        required: true,
        fields: ["meta", "wallets", "transactions"],
        operation: { reason: "ADMIN_BONUS_REVERSAL", reference: reversalReference, userId: bonus.userId },
      });

      try {
        this.createNotification?.({
          userId: bonus.userId, type: "BONUS", title: "Admin bonus reversal",
          message: `${bonus.amount} USDT admin bonus reversed.`, entityType: "Transaction", entityId: transaction.id,
        });
        void this.persist({ bestEffort: true });
      } catch (error) {
        console.error("Admin bonus reversal notification failed:", error.message || error);
      }
      return { status: "REVERSED", transaction, preview: this.inspect(reference) };
    });
  }
}

module.exports = { AdminBonusReversalService, EXECUTION_ACTION };
