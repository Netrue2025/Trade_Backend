"use strict";

const { add, compare, subtract } = require("../lib/money");
const { randomId } = require("../lib/security");

const TARGET_TRADE_ID = "55eeebf4f15abd1cc81df79f";
const TARGET_SYMBOL = "AURORAUSDT";
const RECOVERY_REASON = "STRANDED_AURORA_TRADE_PRINCIPAL_RESTORED";
const EXECUTION_ACTION = "RESTORE_AURORA_PRINCIPAL_ONLY";

function recoveryReference(investmentId) {
  return `trade-cancellation:${TARGET_TRADE_ID}:${investmentId}`;
}

function readSources(investment) {
  const totals = new Map();
  for (const source of Array.isArray(investment?.fundingSources) ? investment.fundingSources : []) {
    const currency = String(source.currency || "").trim().toUpperCase();
    const amount = String(source.amount ?? "");
    if (!["NGN", "USDT"].includes(currency) || !amount || compare(amount, "0") <= 0) {
      throw new Error("ORIGINAL_PRINCIPAL_INVALID");
    }
    totals.set(currency, add(totals.get(currency) || "0", amount));
  }
  if (!totals.size) throw new Error("ORIGINAL_PRINCIPAL_MISSING");
  return totals;
}

class AuroraStrandedTradeRecoveryService {
  constructor({ db, withUserFinancialLock, persist, markFinancialMutation, idGenerator = randomId, clock = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.withUserFinancialLock = withUserFinancialLock;
    this.persist = persist;
    this.markFinancialMutation = markFinancialMutation;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  inspect() {
    const trade = (this.db.tradeIntents || []).find((item) => String(item.id) === TARGET_TRADE_ID);
    const investments = (this.db.tradeInvestments || []).filter((item) => String(item.tradeId) === TARGET_TRADE_ID);
    const transactions = this.db.transactions || [];
    const report = {
      mode: "dry-run", tradeId: TARGET_TRADE_ID, symbol: trade?.symbol || null,
      investments: [], safeToExecute: false, principalOnly: true,
      pnl: "0", fee: "0", financialWrites: 0, blocker: null,
    };
    if (!trade) report.blocker = "TARGET_TRADE_NOT_FOUND";
    else if (String(trade.symbol || "").toUpperCase() !== TARGET_SYMBOL) report.blocker = "TARGET_SYMBOL_MISMATCH";
    else if (trade.strandedRecovery?.reason === RECOVERY_REASON) {
      report.status = "ALREADY_RECOVERED";
      report.safeToExecute = true;
      return report;
    } else if (String(trade.adminExecution?.status || "").toUpperCase() !== "FILLED") {
      report.blocker = "ENTRY_NOT_CONFIRMED_FILLED";
    }

    const active = investments.filter((item) => ["ACTIVE", "JOINED"].includes(String(item.status || "").toUpperCase()));
    if (!report.blocker && active.length !== 1) report.blocker = "EXPECTED_EXACTLY_ONE_ACTIVE_INVESTMENT";
    const exitProof = (trade?.exitOrders || []).some((item) => (
      String(item?.adminExecution?.status || "").toUpperCase() === "FILLED"
      && Number(item?.adminExecution?.executedQty || 0) > 0
    ));
    if (!report.blocker && !exitProof) report.blocker = "FILLED_EXIT_EVIDENCE_MISSING";

    for (const investment of investments) {
      const id = String(investment.id || "");
      const ref = recoveryReference(id);
      const row = { investmentId: id, status: investment.status, sources: {}, reversible: false, blocker: null, reference: ref };
      let sources;
      try { sources = readSources(investment); } catch (error) { row.blocker = error.message; }
      if (sources) {
        const joins = transactions.filter((item) => String(item.reference || "") === id
          && String(item.type || "").toUpperCase() === "TRADE_INVESTMENT_LOCK"
          && String(item.status || "").toUpperCase() === "APPROVED");
        for (const [currency, amount] of sources) {
          const wallet = (this.db.wallets || []).find((item) => String(item.userId) === String(investment.userId)
            && String(item.currency || "").toUpperCase() === currency);
          const matching = joins.filter((item) => String(item.currency || "").toUpperCase() === currency
            && compare(String(item.amount || "0"), subtract("0", amount)) === 0);
          if (matching.length !== 1) row.blocker ||= matching.length ? "DUPLICATE_OR_MISMATCHED_JOIN_RECORD" : "JOIN_RECORD_MISSING";
          if (!wallet) row.blocker ||= `WALLET_MISSING_${currency}`;
          else if (["ACTIVE", "JOINED"].includes(String(investment.status || "").toUpperCase())
            && compare(String(wallet.lockedBalance || "0"), amount) < 0) row.blocker ||= `INSUFFICIENT_LOCKED_${currency}`;
          row.sources[currency] = { principal: amount, available: String(wallet?.availableBalance || "0"), locked: String(wallet?.lockedBalance || "0") };
        }
      }
      if (transactions.some((item) => String(item.reference || "") === `trade-settlement:${id}`
        || String(item.metadata?.investmentId || "") === id && String(item.type || "").toUpperCase().includes("SETTLEMENT"))) {
        row.blocker ||= "SETTLEMENT_ALREADY_EXISTS";
      }
      if (transactions.some((item) => String(item.reference || "") === ref)) row.blocker ||= "RECOVERY_ALREADY_EXISTS";
      row.reversible = !row.blocker && ["ACTIVE", "JOINED"].includes(String(investment.status || "").toUpperCase());
      report.investments.push(row);
    }
    const activeRows = report.investments.filter((item) => ["ACTIVE", "JOINED"].includes(String(item.status || "").toUpperCase()));
    const blockedActive = activeRows.some((item) => !item.reversible);
    report.safeToExecute = !report.blocker && activeRows.length === 1 && !blockedActive;
    if (!report.blocker && blockedActive) report.blocker = activeRows.find((item) => !item.reversible)?.blocker || "INVESTMENT_NOT_REVERSIBLE";
    report.operatorConfirmationRequired = "Confirm Bybit AURORAUSDT exposure and open orders are closed before execution.";
    return report;
  }

  async execute(admin, { action, confirmExchangeClosed } = {}) {
    if (!admin || admin.role !== "admin") throw new Error("Admin authorization is required.");
    if (action !== EXECUTION_ACTION || confirmExchangeClosed !== true) throw new Error("Explicit principal-only recovery confirmation is required.");
    const first = this.inspect();
    if (first.status === "ALREADY_RECOVERED") return { status: first.status, report: first };
    if (!first.safeToExecute) return { status: "BLOCKED", report: first };
    const targetRow = first.investments.find((item) => item.reversible);
    if (!targetRow) return { status: "BLOCKED", report: { ...first, safeToExecute: false, blocker: "ACTIVE_INVESTMENT_NOT_REVERSIBLE" } };
    const userId = String(this.db.tradeInvestments.find((item) => item.id === targetRow.investmentId).userId || "");
    if (!userId) return { status: "BLOCKED", report: { ...first, safeToExecute: false, blocker: "INVESTMENT_USER_MISSING" } };

    return this.withUserFinancialLock(userId, async () => {
      const report = this.inspect();
      if (report.status === "ALREADY_RECOVERED") return { status: report.status, report };
      if (!report.safeToExecute) return { status: "BLOCKED", report };
      const currentTargetRow = report.investments.find((item) => item.reversible);
      if (!currentTargetRow) return { status: "BLOCKED", report: { ...report, safeToExecute: false, blocker: "ACTIVE_INVESTMENT_NOT_REVERSIBLE" } };
      const investment = this.db.tradeInvestments.find((item) => item.id === currentTargetRow.investmentId);
      const trade = this.db.tradeIntents.find((item) => String(item.id) === TARGET_TRADE_ID);
      const now = this.clock();
      const reference = recoveryReference(investment.id);
      const released = [];
      const wallets = [];
      const walletSnapshots = [];
      const investmentSnapshot = {
        status: investment.status, stoppedAt: investment.stoppedAt, updatedAt: investment.updatedAt,
        stopReason: investment.stopReason, cancellationReference: investment.cancellationReference,
      };
      const tradeSnapshot = { status: trade.status, closedAt: trade.closedAt, strandedRecovery: trade.strandedRecovery };
      const previousQuarantine = [...(this.db.systemSettings?.trading?.quarantinedTradeIds || [])];
      for (const [currency, amount] of readSources(investment)) {
        const wallet = this.db.wallets.find((item) => String(item.userId) === userId && String(item.currency || "").toUpperCase() === currency);
        const availableBefore = String(wallet.availableBalance || "0");
        const lockedBefore = String(wallet.lockedBalance || "0");
        walletSnapshots.push({ wallet, availableBalance: wallet.availableBalance, lockedBalance: wallet.lockedBalance, updatedAt: wallet.updatedAt });
        wallet.availableBalance = add(availableBefore, amount);
        wallet.lockedBalance = subtract(lockedBefore, amount);
        wallet.updatedAt = now;
        wallets.push(wallet);
        released.push({ currency, principal: amount, availableBefore, availableAfter: wallet.availableBalance, lockedBefore, lockedAfter: wallet.lockedBalance });
      }
      investment.status = "STOPPED";
      investment.stoppedAt = now;
      investment.updatedAt = now;
      investment.stopReason = RECOVERY_REASON;
      investment.cancellationReference = reference;
      this.db.transactions.unshift({
        id: this.idGenerator(12), userId, type: "TRADE_CANCELLATION",
        currency: released.length === 1 ? released[0].currency : "MIXED",
        amount: released.length === 1 ? released[0].principal : "0",
        balanceBefore: released.length === 1 ? released[0].availableBefore : "0",
        balanceAfter: released.length === 1 ? released[0].availableAfter : "0",
        reference, status: "APPROVED", description: "AURORAUSDT stranded trade principal restored; no P&L or fee applied.",
        createdBy: admin.id, createdAt: now,
        metadata: { tradeId: TARGET_TRADE_ID, investmentId: investment.id, recoveryKind: "PRINCIPAL_ONLY", reason: RECOVERY_REASON, releasedSources: released, pnl: "0", fee: "0", operatorConfirmedExchangeClosed: true },
      });
      this.markFinancialMutation(wallets, RECOVERY_REASON, reference);
      trade.status = "CANCELED";
      trade.closedAt = now;
      trade.strandedRecovery = { reason: RECOVERY_REASON, recoveredAt: now, investmentId: investment.id, reference };
      this.db.systemSettings ||= {};
      this.db.systemSettings.trading ||= {};
      const quarantined = new Set((this.db.systemSettings.trading.quarantinedTradeIds || []).map(String));
      quarantined.add(TARGET_TRADE_ID);
      this.db.systemSettings.trading.quarantinedTradeIds = [...quarantined];
      try {
        await this.persist({ required: true, fields: ["meta", "tradeIntents", "tradeInvestments", "wallets", "transactions"], operation: { reason: RECOVERY_REASON, reference, userId } });
      } catch (error) {
        for (const snapshot of walletSnapshots) Object.assign(snapshot.wallet, {
          availableBalance: snapshot.availableBalance, lockedBalance: snapshot.lockedBalance, updatedAt: snapshot.updatedAt,
        });
        Object.assign(investment, investmentSnapshot);
        Object.assign(trade, tradeSnapshot);
        this.db.transactions = this.db.transactions.filter((item) => String(item.reference || "") !== reference);
        this.db.systemSettings.trading.quarantinedTradeIds = previousQuarantine;
        throw error;
      }
      return { status: "RECOVERED", report: this.inspect(), reference };
    });
  }
}

module.exports = { AuroraStrandedTradeRecoveryService, TARGET_TRADE_ID, TARGET_SYMBOL, RECOVERY_REASON, EXECUTION_ACTION, recoveryReference };
