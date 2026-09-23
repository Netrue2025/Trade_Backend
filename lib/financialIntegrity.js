function createUserFinancialLock() {
  const queues = new Map();
  return async function withUserLock(userId, operation) {
    const key = String(userId || "").trim();
    if (!key) throw new Error("Financial mutation requires a user ID.");
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    queues.set(key, turn);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (queues.get(key) === turn) queues.delete(key);
    }
  };
}

class FinancialIntegrityState {
  constructor() {
    this.frozen = false;
    this.reason = "";
    this.frozenAt = null;
    this.context = null;
    this.authoritativeStateRegistered = false;
  }

  registerAuthoritativeState() {
    if (!this.frozen) this.authoritativeStateRegistered = true;
  }

  assertWritable() {
    if (!this.authoritativeStateRegistered || this.frozen) {
      throw Object.assign(new Error("Financial operations are temporarily unavailable. Please try again shortly."), {
        statusCode: 503,
        code: "FINANCIAL_SERVICE_TEMPORARILY_UNAVAILABLE",
      });
    }
  }

  assertPersistenceAllowed() {
    if (this.frozen) {
      throw Object.assign(new Error("Application-state persistence is frozen until authoritative restart."), {
        code: "APP_STATE_PERSISTENCE_FROZEN",
      });
    }
  }

  freeze(reason = "required_financial_persistence_failed", context = null) {
    if (!this.frozen) {
      this.frozen = true;
      this.reason = String(reason || "required_financial_persistence_failed");
      this.frozenAt = new Date().toISOString();
      this.context = context && typeof context === "object" ? { ...context } : null;
      console.error("FINANCIAL_PERSISTENCE_FROZEN", { reason: this.reason, ...this.context });
    }
  }

  getStatus({ includeReason = false } = {}) {
    return {
      writable: this.authoritativeStateRegistered && !this.frozen,
      persistenceFrozen: this.frozen,
      frozenAt: this.frozenAt,
      ...(includeReason ? { reason: this.reason, context: this.context } : {}),
    };
  }
}

const financialIntegrity = new FinancialIntegrityState();

function auditFinancialIntegrity(db = {}) {
  const investments = Array.isArray(db.tradeInvestments) ? db.tradeInvestments : [];
  const transactions = Array.isArray(db.transactions) ? db.transactions : [];
  const settlements = transactions.filter((item) => String(item.reference || "").startsWith("trade-settlement:"));
  const counts = settlements.reduce((result, item) => ({ ...result, [item.reference]: (result[item.reference] || 0) + 1 }), {});
  const duplicateSettlementReferences = Object.entries(counts).filter(([, count]) => count > 1).map(([reference]) => reference);
  const settledIds = new Set(settlements.map((item) => String(item.metadata?.investmentId || item.reference).replace(/^trade-settlement:/, "")));
  const missingSettlementReferences = investments.filter((item) => item.status === "STOPPED" && !settledIds.has(String(item.id))).map((item) => ({ userId: item.userId, investmentId: item.id, tradeId: item.tradeId }));
  const candidateUserIds = [...new Set(missingSettlementReferences.map((item) => item.userId))];
  return { usersChecked: new Set((db.users || []).filter((item) => item.role === "user").map((item) => item.id)).size, tradeInvestmentsChecked: investments.length, settlementsChecked: settlements.length, candidateUserIds, candidateDiscrepancies: candidateUserIds.length, duplicateSettlementReferences, missingSettlementReferences };
}

module.exports = { FinancialIntegrityState, financialIntegrity, createUserFinancialLock, auditFinancialIntegrity };
