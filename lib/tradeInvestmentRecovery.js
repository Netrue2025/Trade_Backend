"use strict";

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function getExecutionTimestamp(execution, fallback) {
  for (const value of [
    execution?.transactTime,
    execution?.updateTime,
    execution?.time,
    execution?.filledAt,
    fallback,
  ]) {
    const timestamp = toTimestamp(value);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function getFilledExitEvidence(trade) {
  return (trade?.exitOrders || [])
    .map((exitOrder) => ({
      execution: exitOrder?.adminExecution || null,
      fallback: exitOrder?.updatedAt || exitOrder?.createdAt || null,
    }))
    .filter(({ execution }) => String(execution?.status || "").trim().toUpperCase() === "FILLED")
    .map(({ execution, fallback }) => ({
      execution,
      timestamp: getExecutionTimestamp(execution, fallback),
    }));
}

function hasEquivalentSettlement(transactions, investmentId) {
  return (transactions || []).some((transaction) => {
    if (String(transaction?.type || "").toUpperCase() === "TRADE_INVESTMENT_LOCK") return false;
    const reference = String(transaction?.reference || "");
    const metadataInvestmentId = String(transaction?.metadata?.investmentId || "");
    return reference === investmentId
      || reference === `trade-settlement:${investmentId}`
      || metadataInvestmentId === investmentId;
  });
}

function assessClosedTradeInvestmentRecovery({ investment, trade, user, transactions = [], wallets = [] }) {
  const investmentId = String(investment?.id || "");
  const settlementReference = `trade-settlement:${investmentId}`;
  const joinedAt = toTimestamp(investment?.joinedAt || investment?.createdAt);
  const filledExits = getFilledExitEvidence(trade);
  const exactSettlementAbsent = !transactions.some((transaction) => transaction?.reference === settlementReference);
  const equivalentSettlementAbsent = !hasEquivalentSettlement(transactions, investmentId);
  const joinTransactions = transactions.filter((transaction) => (
    transaction?.reference === investmentId
    && String(transaction?.type || "").toUpperCase() === "TRADE_INVESTMENT_LOCK"
    && String(transaction?.status || "").toUpperCase() === "APPROVED"
  ));
  const fundingSources = Array.isArray(investment?.fundingSources)
    ? investment.fundingSources.filter((source) => Number(source?.amount) > 0)
    : [];
  const sourceTotals = fundingSources.reduce((totals, source) => {
    const currency = String(source.currency || "").toUpperCase();
    totals[currency] = (totals[currency] || 0) + Number(source.amount || 0);
    return totals;
  }, {});
  const fundsStillLocked = fundingSources.length > 0 && Object.entries(sourceTotals).every(([currency, amount]) => {
    const wallet = wallets.find((item) => item?.userId === investment?.userId && String(item?.currency || "").toUpperCase() === currency);
    return Number(wallet?.lockedBalance || 0) + 1e-8 >= amount;
  });
  const joinedBeforeFilledExit = joinedAt !== null
    && filledExits.some(({ timestamp }) => timestamp !== null && joinedAt <= timestamp);
  const parentClosed = filledExits.length > 0;
  const entryPrice = Number(trade?.adminExecution?.avgPrice || trade?.adminExecution?.price || trade?.price || 0);
  const exitPrice = Number(filledExits[0]?.execution?.avgPrice || filledExits[0]?.execution?.price || 0);
  const settlementInputsComplete = Number(investment?.amountUsdt) > 0
    && Number.isFinite(Number(investment?.baselinePnlPercent))
    && entryPrice > 0
    && exitPrice > 0
    && fundingSources.length > 0;
  const validDurableJoinDebit = joinTransactions.length === fundingSources.length && fundingSources.every((source) => (
    joinTransactions.some((transaction) => (
      String(transaction.currency || "").toUpperCase() === String(source.currency || "").toUpperCase()
      && Math.abs(Math.abs(Number(transaction.amount || 0)) - Number(source.amount || 0)) < 1e-8
    ))
  ));

  const checks = {
    active: String(investment?.status || "").toUpperCase() === "ACTIVE",
    userExists: !!user && String(user.role || "").toLowerCase() === "user",
    validDurableJoinDebit,
    joinedBeforeFilledExit,
    parentClosed,
    filledExitAuthoritative: filledExits.length > 0,
    exactSettlementAbsent,
    equivalentSettlementAbsent,
    fundsStillLocked,
    settlementInputsComplete,
    canonicalCalculationDeterministic: settlementInputsComplete,
  };
  const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { eligible: reasons.length === 0, reasons, checks, settlementReference };
}

module.exports = { assessClosedTradeInvestmentRecovery, hasEquivalentSettlement, toTimestamp };
