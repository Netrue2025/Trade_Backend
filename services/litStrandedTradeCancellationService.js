"use strict";

const { add, compare, subtract } = require("../lib/money");
const { randomId } = require("../lib/security");

const TARGET_TRADE_ID = "644b8224bae460fb10bb134f";
const TARGET_SYMBOL = "LITUSDT";
const CANCELLATION_REASON = "STRANDED_TRADE_PRINCIPAL_RESTORED";
const TRADE_CANCELLATION_REASON = "STRANDED_TRADE_CANCELLED";

function cancellationReference(investmentId) {
  return `trade-cancellation:${TARGET_TRADE_ID}:${investmentId}`;
}

function normalizeCurrency(value) {
  return String(value || "").trim().toUpperCase();
}

function sumSources(investment) {
  const totals = new Map();
  const sources = Array.isArray(investment?.fundingSources) ? investment.fundingSources : [];
  if (!sources.length) throw new Error("ORIGINAL_PRINCIPAL_MISSING");
  for (const source of sources) {
    const currency = normalizeCurrency(source.currency);
    const amount = String(source.amount ?? "");
    if (!["NGN", "USDT"].includes(currency) || !amount || compare(amount, "0") <= 0) {
      throw new Error("ORIGINAL_PRINCIPAL_INVALID");
    }
    totals.set(currency, add(totals.get(currency) || "0", amount));
  }
  return totals;
}

function countSettlement(transactions, investmentId) {
  const reference = `trade-settlement:${investmentId}`;
  return transactions.filter((item) => String(item.reference || "") === reference
    || String(item.metadata?.investmentId || "") === investmentId
      && String(item.type || "").toUpperCase().includes("SETTLEMENT")).length;
}

class LitStrandedTradeCancellationService {
  constructor({ db, withUserFinancialLock, persist, markFinancialMutation, idGenerator = randomId, clock = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.withUserFinancialLock = withUserFinancialLock;
    this.persist = persist;
    this.markFinancialMutation = markFinancialMutation;
    this.idGenerator = idGenerator;
    this.clock = clock;
  }

  inspect() {
    const trades = this.db.tradeIntents || [];
    const investments = (this.db.tradeInvestments || []).filter((item) => String(item.tradeId || "") === TARGET_TRADE_ID);
    const transactions = this.db.transactions || [];
    const trade = trades.find((item) => String(item.id || "") === TARGET_TRADE_ID) || null;
    const report = {
      mode: "dry-run",
      tradeId: TARGET_TRADE_ID,
      tradeFound: !!trade,
      symbol: trade?.symbol || null,
      currentStatus: trade?.status || null,
      alreadyCancelled: trade?.strandedCancellation?.reason === TRADE_CANCELLATION_REASON,
      investmentsFound: investments.length,
      activeInvestments: 0,
      reversibleInvestments: 0,
      blockedInvestments: 0,
      investments: [],
      aggregates: {},
      availableIncrease: {},
      lockedDecrease: {},
      pnl: "0",
      fee: "0",
      economicValueCreated: "0",
      dryRunMutations: 0,
      safeToExecute: false,
      blocker: null,
    };

    if (!trade) report.blocker = "TARGET_TRADE_NOT_FOUND";
    else if (String(trade.symbol || "").toUpperCase() !== TARGET_SYMBOL) report.blocker = "TARGET_SYMBOL_MISMATCH";
    else if (report.alreadyCancelled) {
      report.safeToExecute = true;
      report.status = "ALREADY_CANCELLED";
      return report;
    }

    const aggregate = new Map();
    const lockRequirements = new Map();
    for (const investment of investments) {
      const id = String(investment.id || "");
      const ref = cancellationReference(id);
      const status = String(investment.status || "").toUpperCase();
      const settlementCount = countSettlement(transactions, id);
      const reversalCount = transactions.filter((item) => String(item.reference || "") === ref).length;
      const row = {
        investmentId: id,
        status: investment.status || null,
        currency: null,
        principal: null,
        walletAvailable: null,
        walletLocked: null,
        joinEvidence: false,
        settlementExists: settlementCount > 0,
        reversalExists: reversalCount > 0,
        reversible: false,
        blocker: null,
        cancellationReference: ref,
        availableDelta: {},
        lockedDelta: {},
      };
      if (status !== "ACTIVE" && status !== "JOINED") {
        row.blocker = status === "STOPPED" && reversalCount ? "ALREADY_REVERSED" : "INVESTMENT_NOT_ACTIVE";
      }
      let sourceTotals;
      try { sourceTotals = sumSources(investment); } catch (error) { row.blocker ||= error.message; }
      if (sourceTotals) {
        const balances = [];
        for (const [currency, principal] of sourceTotals) {
          const wallet = (this.db.wallets || []).find((item) => String(item.userId) === String(investment.userId)
            && normalizeCurrency(item.currency) === currency);
          const joins = transactions.filter((item) => String(item.reference || "") === id
            && String(item.type || "").toUpperCase() === "TRADE_INVESTMENT_LOCK"
            && String(item.status || "").toUpperCase() === "APPROVED"
            && normalizeCurrency(item.currency) === currency
            && compare(String(item.amount || "0"), subtract("0", principal)) === 0);
          if (joins.length !== 1) row.blocker ||= joins.length ? "DUPLICATE_JOIN_EVIDENCE" : "JOIN_EVIDENCE_MISSING_OR_MISMATCHED";
          if (!wallet) row.blocker ||= `WALLET_MISSING_${currency}`;
          const available = String(wallet?.availableBalance ?? "0");
          const locked = String(wallet?.lockedBalance ?? "0");
          balances.push({ currency, principal, wallet, available, locked });
          row.availableDelta[currency] = principal;
          row.lockedDelta[currency] = subtract("0", principal);
          if (["ACTIVE", "JOINED"].includes(status)) {
            const key = `${investment.userId}:${currency}`;
            const required = lockRequirements.get(key) || { userId: investment.userId, currency, amount: "0", wallet, rows: [] };
            required.amount = add(required.amount, principal);
            required.rows.push(row);
            lockRequirements.set(key, required);
          }
        }
        if (balances.length === 1) {
          row.currency = balances[0].currency;
          row.principal = balances[0].principal;
          row.walletAvailable = balances[0].available;
          row.walletLocked = balances[0].locked;
        } else if (balances.length > 1) {
          row.currency = "MIXED";
          row.principal = Object.fromEntries(balances.map(({ currency, principal }) => [currency, principal]));
          row.walletAvailable = Object.fromEntries(balances.map(({ currency, available }) => [currency, available]));
          row.walletLocked = Object.fromEntries(balances.map(({ currency, locked }) => [currency, locked]));
        }
        row.joinEvidence = balances.length > 0 && balances.every(({ currency, principal }) => transactions.filter((item) => (
          String(item.reference || "") === id && String(item.type || "").toUpperCase() === "TRADE_INVESTMENT_LOCK"
          && String(item.status || "").toUpperCase() === "APPROVED" && normalizeCurrency(item.currency) === currency
          && compare(String(item.amount || "0"), subtract("0", principal)) === 0
        )).length === 1);
      }
      if (settlementCount) row.blocker ||= "SETTLEMENT_ALREADY_EXISTS";
      if (reversalCount) row.blocker ||= "CANCELLATION_ALREADY_EXISTS";
      report.investments.push(row);
    }
    for (const requirement of lockRequirements.values()) {
      if (!requirement.wallet || compare(String(requirement.wallet.lockedBalance ?? "0"), requirement.amount) < 0) {
        for (const row of requirement.rows) row.blocker ||= `INSUFFICIENT_AGGREGATE_LOCK_${requirement.currency}`;
      }
    }
    for (const row of report.investments) {
      row.reversible = !row.blocker;
      if (["ACTIVE", "JOINED"].includes(String(row.status || "").toUpperCase())) report.activeInvestments += 1;
      if (row.reversible) {
        report.reversibleInvestments += 1;
        for (const [currency, amount] of Object.entries(row.availableDelta)) aggregate.set(currency, add(aggregate.get(currency) || "0", amount));
      } else {
        report.blockedInvestments += 1;
      }
    }
    report.aggregates = Object.fromEntries(aggregate);
    report.availableIncrease = { ...report.aggregates };
    report.lockedDecrease = Object.fromEntries(Object.entries(report.aggregates).map(([currency, amount]) => [currency, subtract("0", amount)]));
    const allActiveCovered = report.activeInvestments > 0
      && report.investments.every((item) => item.reversible || item.blocker === "INVESTMENT_NOT_ACTIVE");
    report.safeToExecute = !report.blocker && report.blockedInvestments === 0 && allActiveCovered;
    if (!report.blocker && !report.safeToExecute) report.blocker = report.investments.length ? "ONE_OR_MORE_INVESTMENTS_REQUIRE_REVIEW" : "NO_ACTIVE_INVESTMENTS";
    return report;
  }

  async withLocks(userIds, index, operation) {
    if (index >= userIds.length) return operation();
    return this.withUserFinancialLock(userIds[index], () => this.withLocks(userIds, index + 1, operation));
  }

  async execute(admin) {
    if (!admin || admin.role !== "admin") throw new Error("Admin authorization is required.");
    const first = this.inspect();
    if (first.alreadyCancelled) return { status: "ALREADY_CANCELLED", report: first };
    if (!first.safeToExecute) return { status: "BLOCKED", report: first };
    const userIds = [...new Set((this.db.tradeInvestments || [])
      .filter((item) => String(item.tradeId || "") === TARGET_TRADE_ID && ["ACTIVE", "JOINED"].includes(String(item.status || "").toUpperCase()))
      .map((item) => String(item.userId || "")))].sort();
    if (userIds.some((id) => !id)) return { status: "BLOCKED", report: { ...first, safeToExecute: false, blocker: "INVESTMENT_USER_MISSING" } };

    return this.withLocks(userIds, 0, async () => {
      const report = this.inspect();
      if (report.alreadyCancelled) return { status: "ALREADY_CANCELLED", report };
      if (!report.safeToExecute) return { status: "BLOCKED", report };
      const now = this.clock();
      const createdReferences = [];
      for (const investmentRow of report.investments) {
        const investment = (this.db.tradeInvestments || []).find((item) => String(item.id) === investmentRow.investmentId);
        const sources = sumSources(investment);
        const released = [];
        const investmentWallets = [];
        for (const [currency, principal] of sources) {
          const wallet = (this.db.wallets || []).find((item) => String(item.userId) === String(investment.userId)
            && normalizeCurrency(item.currency) === currency);
          const availableBefore = String(wallet.availableBalance ?? "0");
          const lockedBefore = String(wallet.lockedBalance ?? "0");
          wallet.availableBalance = add(availableBefore, principal);
          wallet.lockedBalance = subtract(lockedBefore, principal);
          investmentWallets.push(wallet);
          released.push({ currency, amount: principal, availableBefore, availableAfter: wallet.availableBalance, lockedBefore, lockedAfter: wallet.lockedBalance });
        }
        const reference = cancellationReference(investment.id);
        investment.status = "STOPPED";
        investment.stoppedAt = now;
        investment.updatedAt = now;
        investment.stopReason = CANCELLATION_REASON;
        investment.cancellationReference = reference;
        this.db.transactions.unshift({
          id: this.idGenerator(12), userId: investment.userId, type: "TRADE_CANCELLATION", currency: released.length === 1 ? released[0].currency : "MIXED",
          amount: released.length === 1 ? released[0].amount : "0", balanceBefore: released.length === 1 ? released[0].availableBefore : "0",
          balanceAfter: released.length === 1 ? released[0].availableAfter : "0", reference, status: "APPROVED",
          description: "Stranded LITUSDT trade principal restored; no P&L or fee applied.", createdBy: admin.id, createdAt: now,
          metadata: { tradeId: TARGET_TRADE_ID, investmentId: investment.id, recoveryKind: "PRINCIPAL_ONLY", reason: CANCELLATION_REASON, releasedSources: released, pnl: "0", fee: "0" },
        });
        this.markFinancialMutation(investmentWallets, "STRANDED_TRADE_PRINCIPAL_RESTORATION", reference);
        createdReferences.push(reference);
      }
      const trade = (this.db.tradeIntents || []).find((item) => String(item.id) === TARGET_TRADE_ID);
      trade.status = "CANCELED";
      trade.closedAt = now;
      trade.strandedCancellation = { reason: TRADE_CANCELLATION_REASON, cancelledAt: now, investmentCount: createdReferences.length, references: createdReferences };
      await this.persist({
        required: true,
        fields: ["meta", "tradeIntents", "tradeInvestments", "wallets", "transactions"],
        operation: { reason: TRADE_CANCELLATION_REASON, reference: `trade-cancellation:${TARGET_TRADE_ID}`, userId: userIds.join(",") },
      });
      return { status: "CANCELLED", report: this.inspect(), reversedInvestments: createdReferences.length };
    });
  }
}

module.exports = { TARGET_TRADE_ID, TARGET_SYMBOL, CANCELLATION_REASON, TRADE_CANCELLATION_REASON, cancellationReference, LitStrandedTradeCancellationService };
