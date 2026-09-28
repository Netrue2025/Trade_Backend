"use strict";

const { add, compare, subtract } = require("../lib/money");
const { randomId } = require("../lib/security");
const { hasEquivalentSettlement } = require("../lib/tradeInvestmentRecovery");
const { isTradeQuarantined } = require("../lib/tradeQuarantine");

const ARX_TRADE_ID = "89eaf6636270d40f995fde20";
const ARX_INVESTMENT_IDS = Object.freeze([
  "a6d4029267ba0aac77c2c0b1",
  "3a79768016674df578fb2c21",
  "2b2f221360d5740bf4f7e08b",
]);
const EXECUTION_ACTION = "EXECUTE_ARX_ABANDONED_PRINCIPAL_RELEASE";

function releaseReference(investmentId) {
  return `abandoned-trade-principal-release:${investmentId}`;
}

function normalizeCurrency(value) {
  return String(value || "").trim().toUpperCase();
}

function sourceTotals(investment) {
  const totals = new Map();
  for (const source of Array.isArray(investment?.fundingSources) ? investment.fundingSources : []) {
    const currency = normalizeCurrency(source.currency);
    const amount = String(source.amount || "0");
    if (!["NGN", "USDT"].includes(currency) || compare(amount, "0") <= 0) {
      throw new Error("Investment funding sources are invalid.");
    }
    totals.set(currency, add(totals.get(currency) || "0", amount));
  }
  if (!totals.size) throw new Error("Investment has no durable funding sources.");
  return totals;
}

function sameAmount(left, right) {
  return compare(left, right) === 0;
}

class ArxAbandonedPrincipalReleaseService {
  constructor({ db, withUserFinancialLock, persist, markFinancialMutation, idGenerator = randomId, clock = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.withUserFinancialLock = withUserFinancialLock;
    this.persist = persist;
    this.markFinancialMutation = markFinancialMutation;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  getInvestment(investmentId) {
    const id = String(investmentId || "").trim();
    if (!ARX_INVESTMENT_IDS.includes(id)) throw new Error("Investment is not allowlisted for ARX principal recovery.");
    const investment = (this.db.tradeInvestments || []).find((item) => item.id === id);
    if (!investment) throw new Error("Allowlisted ARX investment was not found.");
    if (String(investment.tradeId || "") !== ARX_TRADE_ID) throw new Error("Investment does not belong to the quarantined ARX trade.");
    return investment;
  }

  inspect(investmentId) {
    const investment = this.getInvestment(investmentId);
    const reference = releaseReference(investment.id);
    const trade = (this.db.tradeIntents || []).find((item) => item.id === ARX_TRADE_ID);
    const user = (this.db.users || []).find((item) => item.id === investment.userId && item.role === "user");
    const totals = sourceTotals(investment);
    const transactions = this.db.transactions || [];
    const lockTransactions = transactions.filter((item) => (
      String(item.reference || "") === investment.id
      && String(item.type || "").toUpperCase() === "TRADE_INVESTMENT_LOCK"
      && String(item.status || "").toUpperCase() === "APPROVED"
    ));
    const existingTransactions = transactions.filter((item) => String(item.reference || "") === reference);
    const existingIdempotency = (this.db.idempotencyKeys || []).filter((item) => (
      String(item?.key || "") === reference || String(item?.reference || "") === reference
    ));
    const sources = [...totals.entries()].map(([currency, amount]) => {
      const wallet = (this.db.wallets || []).find((item) => item.userId === investment.userId && normalizeCurrency(item.currency) === currency);
      const matchingLocks = lockTransactions.filter((item) => normalizeCurrency(item.currency) === currency && sameAmount(String(Math.abs(Number(item.amount || 0))), amount));
      return {
        currency,
        principal: amount,
        wallet: wallet ? {
          availableBefore: String(wallet.availableBalance || "0"),
          lockedBefore: String(wallet.lockedBalance || "0"),
          availableAfter: add(String(wallet.availableBalance || "0"), amount),
          lockedAfter: subtract(String(wallet.lockedBalance || "0"), amount),
        } : null,
        lockEvidence: matchingLocks.map((item) => ({ id: item.id, amount: item.amount, createdAt: item.createdAt })),
      };
    });
    const reasons = [];
    if (!trade) reasons.push("ARX_TRADE_NOT_FOUND");
    if (!isTradeQuarantined(this.db, ARX_TRADE_ID)) reasons.push("ARX_TRADE_NOT_QUARANTINED");
    if (String(investment.status || "").toUpperCase() !== "ACTIVE") reasons.push("INVESTMENT_NOT_ACTIVE");
    if (!user) reasons.push("USER_NOT_FOUND");
    if (hasEquivalentSettlement(transactions, investment.id)) reasons.push("SETTLEMENT_ALREADY_EXISTS");
    if (existingTransactions.length || existingIdempotency.length) reasons.push("RELEASE_ALREADY_EXISTS");
    for (const source of sources) {
      if (!source.wallet) reasons.push(`WALLET_NOT_FOUND_${source.currency}`);
      if (source.lockEvidence.length !== 1) reasons.push(`LOCK_EVIDENCE_INVALID_${source.currency}`);
      if (!source.wallet || compare(source.wallet.lockedBefore, source.principal) < 0) reasons.push(`INSUFFICIENT_LOCKED_BALANCE_${source.currency}`);
      if (source.wallet && !sameAmount(source.wallet.lockedBefore, source.principal)) reasons.push(`LOCK_NOT_EXCLUSIVELY_ATTRIBUTABLE_${source.currency}`);
    }
    return {
      mode: "DRY_RUN",
      investmentId: investment.id,
      userId: investment.userId,
      tradeId: investment.tradeId,
      investmentStatus: investment.status,
      originalEconomicPrincipal: { requestedUsdt: String(investment.amountUsdt || "0"), sourcePrincipal: sources.map(({ currency, principal }) => ({ currency, amount: principal })) },
      fundingSources: sources,
      settlementCount: transactions.filter((item) => String(item.reference || "") === `trade-settlement:${investment.id}`).length,
      releaseReference: reference,
      existingReleaseCount: existingTransactions.length + existingIdempotency.length,
      eligible: reasons.length === 0,
      reason: reasons.length ? reasons.join(",") : "ELIGIBLE",
      profitCredited: false,
      exchangeCalls: 0,
    };
  }

  async execute(admin, investmentId, { action } = {}) {
    if (!admin || admin.role !== "admin") throw new Error("Admin authorization is required.");
    if (action !== EXECUTION_ACTION) throw new Error(`Explicit action ${EXECUTION_ACTION} is required.`);
    const initial = this.inspect(investmentId);
    if (!initial.eligible) return { status: initial.existingReleaseCount ? "ALREADY_RELEASED" : "NOT_RELEASED", preview: initial };
    return this.withUserFinancialLock(initial.userId, async () => {
      const preview = this.inspect(investmentId);
      if (!preview.eligible) return { status: preview.reason.includes("RELEASE_ALREADY_EXISTS") ? "ALREADY_RELEASED" : "NOT_RELEASED", preview };
      const investment = this.getInvestment(investmentId);
      const now = this.clock();
      const releasedSources = [];
      for (const source of preview.fundingSources) {
        const wallet = (this.db.wallets || []).find((item) => item.userId === investment.userId && normalizeCurrency(item.currency) === source.currency);
        const availableBefore = wallet.availableBalance;
        const lockedBefore = wallet.lockedBalance;
        wallet.availableBalance = add(wallet.availableBalance, source.principal);
        wallet.lockedBalance = subtract(wallet.lockedBalance, source.principal);
        releasedSources.push({ currency: source.currency, amount: source.principal, availableBefore, availableAfter: wallet.availableBalance, lockedBefore, lockedAfter: wallet.lockedBalance });
        this.markFinancialMutation(wallet, "ABANDONED_TRADE_PRINCIPAL_RELEASE", preview.releaseReference);
      }
      investment.status = "STOPPED";
      investment.stoppedAt = now;
      investment.updatedAt = now;
      investment.stopReason = "QUARANTINED_PRINCIPAL_RELEASE";
      investment.recoveryReference = preview.releaseReference;
      investment.releasedPrincipalSources = releasedSources.map(({ currency, amount }) => ({ currency, amount }));
      this.db.transactions.unshift({
        id: this.idGenerator(12), userId: investment.userId, type: "ABANDONED_TRADE_PRINCIPAL_RELEASE", currency: "MIXED",
        amount: "0", balanceBefore: "0", balanceAfter: "0",
        reference: preview.releaseReference, status: "APPROVED", description: "Quarantined ARX trade principal restored.", createdBy: admin.id, createdAt: now,
        metadata: { investmentId: investment.id, tradeId: ARX_TRADE_ID, recoveryKind: "PRINCIPAL_ONLY", releasedSources },
      });
      this.db.idempotencyKeys = Array.isArray(this.db.idempotencyKeys) ? this.db.idempotencyKeys : [];
      this.db.idempotencyKeys.push({ id: this.idGenerator(12), scope: "arx_abandoned_principal_release", userId: investment.userId, key: preview.releaseReference, createdAt: now });
      await this.persist({ required: true, fields: ["meta", "wallets", "transactions", "tradeInvestments", "idempotencyKeys"], operation: { reason: "ABANDONED_TRADE_PRINCIPAL_RELEASE", reference: preview.releaseReference, userId: investment.userId } });
      return { status: "RELEASED", preview: this.inspect(investmentId), releasedSources };
    });
  }
}

module.exports = { ARX_TRADE_ID, ARX_INVESTMENT_IDS, EXECUTION_ACTION, releaseReference, ArxAbandonedPrincipalReleaseService };
