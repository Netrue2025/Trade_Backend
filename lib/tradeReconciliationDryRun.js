"use strict";

function countByStatus(items, status) {
  return (items || []).filter((item) => String(item?.status || "").toUpperCase() === status).length;
}

function buildTradeReconciliationDryRun({ db, deriveTradeLifecycle, isTradeQuarantined, isHistoricalTradeExcluded, assessClosedTradeInvestmentRecovery }) {
  if (!db || typeof deriveTradeLifecycle !== "function" || typeof isTradeQuarantined !== "function" || typeof assessClosedTradeInvestmentRecovery !== "function") {
    throw new Error("Read-only reconciliation planner requires authoritative state and reconciliation helpers.");
  }
  const trades = Array.isArray(db.tradeIntents) ? db.tradeIntents : [];
  const investments = Array.isArray(db.tradeInvestments) ? db.tradeInvestments : [];
  const transactions = Array.isArray(db.transactions) ? db.transactions : [];
  const wallets = Array.isArray(db.wallets) ? db.wallets : [];
  const users = Array.isArray(db.users) ? db.users : [];
  const knownTradeIds = new Set(trades.map((trade) => String(trade.id || "")).filter(Boolean));
  const candidates = [];

  for (const trade of trades) {
    const lifecycle = deriveTradeLifecycle(trade);
    const related = investments.filter((investment) => investment.tradeId === trade.id);
    const base = { tradeId: trade.id, investmentIds: related.map((investment) => investment.id), symbol: trade.symbol || "", exchange: trade.exchange || "", internalStatus: lifecycle, entryEvidence: String(trade.adminExecution?.status || "MISSING"), exitEvidence: (trade.exitOrders || []).map((exit) => String(exit?.adminExecution?.status || "MISSING")), unexpectedHistoricalRecord: false, settlementPreview: null };
    if (isHistoricalTradeExcluded?.(trade)) {
      candidates.push({ ...base, classification: "HISTORICAL_EXCLUSION", reason: "Explicit historical exclusion." });
    } else if (isTradeQuarantined(db, trade)) {
      candidates.push({ ...base, classification: "QUARANTINED", reason: "Trade is quarantined." });
    } else if (!related.some((investment) => String(investment.status || "").toUpperCase() === "ACTIVE")) {
      candidates.push({ ...base, classification: "NO_ACTION", reason: "No active investment requires reconciliation." });
    } else if (lifecycle === "OPEN" || lifecycle === "PENDING") {
      candidates.push({ ...base, classification: "SAFE_TO_MONITOR", reason: "Trade remains open and is eligible only for monitoring." });
    } else if (lifecycle !== "CLOSED") {
      candidates.push({ ...base, classification: "INSUFFICIENT_EVIDENCE", unexpectedHistoricalRecord: true, reason: "Active investment has no complete authoritative closed-trade evidence." });
    } else {
      for (const investment of related.filter((item) => String(item.status || "").toUpperCase() === "ACTIVE")) {
        const assessment = assessClosedTradeInvestmentRecovery({ investment, trade, user: users.find((item) => item.id === investment.userId) || null, transactions, wallets });
        const settled = transactions.some((transaction) => transaction.reference === assessment.settlementReference);
        candidates.push({ ...base, investmentIds: [investment.id], lockedPrincipal: (investment.fundingSources || []).map((source) => ({ currency: source.currency, amount: source.amount })), existingSettlementReference: settled ? assessment.settlementReference : "", classification: settled ? "NO_ACTION" : (assessment.eligible ? "SAFE_TO_SETTLE" : "INSUFFICIENT_EVIDENCE"), unexpectedHistoricalRecord: !assessment.eligible && assessment.reasons.some((reason) => ["userExists", "validDurableJoinDebit", "fundsStillLocked", "settlementInputsComplete"].includes(reason)), reason: settled ? "A deterministic settlement already exists." : (assessment.eligible ? "Complete durable settlement evidence is present." : assessment.reasons.join(", ")), settlementPreview: assessment.eligible ? { settlementReference: assessment.settlementReference, fundingSources: investment.fundingSources || [], amountUsdt: investment.amountUsdt } : null });
      }
    }
  }
  for (const investment of investments.filter((item) => !knownTradeIds.has(String(item.tradeId || "")))) {
    const historical = !!isHistoricalTradeExcluded?.(investment.tradeId);
    candidates.push({ tradeId: investment.tradeId || "", investmentIds: [investment.id], symbol: "", exchange: "", internalStatus: String(investment.status || ""), entryEvidence: "MISSING", exitEvidence: [], lockedPrincipal: (investment.fundingSources || []).map((source) => ({ currency: source.currency, amount: source.amount })), existingSettlementReference: "", classification: historical ? "HISTORICAL_EXCLUSION" : "INSUFFICIENT_EVIDENCE", unexpectedHistoricalRecord: !historical, reason: "Parent trade record is missing.", settlementPreview: null });
  }
  const labels = ["NO_ACTION", "SAFE_TO_MONITOR", "SAFE_TO_SETTLE", "QUARANTINED", "INSUFFICIENT_EVIDENCE", "HISTORICAL_EXCLUSION"];
  return { state: { openTrades: trades.filter((trade) => deriveTradeLifecycle(trade) === "OPEN").length, activeInvestments: countByStatus(investments, "ACTIVE"), stoppedInvestments: countByStatus(investments, "STOPPED"), settledInvestments: countByStatus(investments, "SETTLED"), quarantinedTrades: trades.filter((trade) => isTradeQuarantined(db, trade)).length, candidates: candidates.length }, counts: Object.fromEntries(labels.map((label) => [label, candidates.filter((candidate) => candidate.classification === label).length])), candidates };
}

module.exports = { buildTradeReconciliationDryRun };
