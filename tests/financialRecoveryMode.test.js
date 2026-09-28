"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getCoreFinancialValidationUserId,
  isCoreFinancialValidationMode,
  isFinancialRecoveryMode,
  isRecoveryOperationAllowed,
  assertRecoveryOperationAllowed,
} = require("../lib/financialRecoveryMode");

function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("financial recovery mode is default-on and blocks mutations until explicitly enabled", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: undefined, CORE_FINANCIAL_VALIDATION_MODE: undefined, CORE_FINANCIAL_VALIDATION_USER_ID: undefined }, () => {
    assert.equal(isFinancialRecoveryMode(), true);
    assert.equal(isRecoveryOperationAllowed("TRADE"), false);
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", { actorUserId: "user-1", targetUserId: "user-1" }), false);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_CREATE", { actorUserId: "user-1", targetUserId: "user-1" }), false);
    assert.throws(() => assertRecoveryOperationAllowed("GIFT_CARD"), { code: "FINANCIAL_RECOVERY_MODE" });
  });
});

test("validation mode allows only the configured user's normal deposit and withdrawal paths", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", CORE_FINANCIAL_VALIDATION_MODE: "true", CORE_FINANCIAL_VALIDATION_USER_ID: "controlled-user" }, () => {
    assert.equal(isCoreFinancialValidationMode(), true);
    assert.equal(getCoreFinancialValidationUserId(), "controlled-user");
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", { actorUserId: "controlled-user", targetUserId: "controlled-user" }), true);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_CREATE", { actorUserId: "controlled-user", targetUserId: "controlled-user" }), true);
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", { actorUserId: "other-user", targetUserId: "other-user" }), false);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_CREATE", { actorUserId: "other-user", targetUserId: "other-user" }), false);
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", { actorUserId: "controlled-user", targetUserId: "other-user" }), false);
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_APPROVAL", { actorUserId: "admin-1", targetUserId: "controlled-user", isAdmin: true }), true);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_APPROVAL", { actorUserId: "admin-1", targetUserId: "controlled-user", isAdmin: true }), true);
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_APPROVAL", { actorUserId: "admin-1", targetUserId: "other-user", isAdmin: true }), false);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_APPROVAL", { actorUserId: "admin-1", targetUserId: "other-user", isAdmin: true }), false);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_PROVIDER_RESULT", { targetUserId: "controlled-user", providerVerified: true }), true);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_PROVIDER_RESULT", { targetUserId: "controlled-user", providerVerified: false }), false);
    assert.equal(isRecoveryOperationAllowed("TRADE_JOIN"), false);
    assert.equal(isRecoveryOperationAllowed("QUEST_REWARD"), false);
    assert.equal(isRecoveryOperationAllowed("GIFT_CARD"), false);
  });
});

test("validation mode fails closed for missing or malformed trusted configuration", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", CORE_FINANCIAL_VALIDATION_MODE: "true", CORE_FINANCIAL_VALIDATION_USER_ID: undefined }, () => {
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", { actorUserId: "controlled-user", targetUserId: "controlled-user" }), false);
  });
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", CORE_FINANCIAL_VALIDATION_MODE: "not-true", CORE_FINANCIAL_VALIDATION_USER_ID: "controlled-user" }, () => {
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_CREATE", { actorUserId: "controlled-user", targetUserId: "controlled-user" }), false);
  });
});

test("legacy broad recovery flags cannot bypass the single-account validation gate", () => {
  withEnv({
    FINANCIAL_RECOVERY_MODE: "true",
    FINANCIAL_RECOVERY_ALLOW_DEPOSITS: "true",
    FINANCIAL_RECOVERY_ALLOW_WITHDRAWALS: "true",
    CORE_FINANCIAL_VALIDATION_MODE: undefined,
    CORE_FINANCIAL_VALIDATION_USER_ID: undefined,
  }, () => {
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", { actorUserId: "other-user", targetUserId: "other-user" }), false);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL_CREATE", { actorUserId: "other-user", targetUserId: "other-user" }), false);
  });
});

test("request-like context cannot enable validation without trusted server configuration", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", CORE_FINANCIAL_VALIDATION_MODE: undefined, CORE_FINANCIAL_VALIDATION_USER_ID: undefined }, () => {
    assert.equal(isRecoveryOperationAllowed("DEPOSIT_CREATE", {
      actorUserId: "controlled-user",
      targetUserId: "controlled-user",
      validationMode: true,
      validationUserId: "controlled-user",
    }), false);
  });
});

test("server recovery gates cover trade creation, reconciliation, settlement, deposits, withdrawals, gift cards, and quest money", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /FINANCIAL_RECOVERY_MODE trade reconciliation skipped/);
  assert.match(server, /if \(isFinancialRecoveryMode\(\)\) \{\s*return null;/);
  assert.match(server, /async function settleTradeInvestment[\s\S]*?isFinancialRecoveryMode\(\)/);
  assert.match(server, /async function settleStaleTradeInvestmentsForWithdrawal[\s\S]*?if \(isFinancialRecoveryMode\(\)\) \{[\s\S]*?settled: \[\]/);
  assert.match(server, /async function reconcileExternalClosuresForOwner[\s\S]*?isFinancialRecoveryMode\(\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("TRADE"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("TRADE_JOIN"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("DEPOSIT_CREATE", \{ actorUserId: user\.id, targetUserId: user\.id \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL_CREATE", \{ actorUserId: user\.id, targetUserId: user\.id \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("DEPOSIT_APPROVAL", \{ actorUserId: admin\.id, targetUserId: targetDeposit\.userId, isAdmin: admin\.role === "admin" \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL_APPROVAL", \{ actorUserId: admin\.id, targetUserId: withdrawal\.userId, isAdmin: admin\.role === "admin" \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL_PROVIDER_RESULT", \{ targetUserId: recoveryWithdrawal\.userId, providerVerified: true \}\)/);
  assert.match(server, /async function syncProcessingPaystackWithdrawals[\s\S]*?if \(isFinancialRecoveryMode\(\)\) \{\s*return;/);
  assert.match(server, /assertRecoveryOperationAllowed\("GIFT_CARD"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("QUEST_REWARD"\)/);
});

test("minimal core startup does not start optional signal, Telegram, or reconciliation workers", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /FINANCIAL_RECOVERY_MODE minimal core active; optional workers are disabled\./);
  assert.match(server, /async function ensureSignalEngineRunning[\s\S]*?if \(isFinancialRecoveryMode\(\)\) \{\s*return false;/);
  assert.match(server, /async function ensureTradeListenerRunning[\s\S]*?if \(isFinancialRecoveryMode\(\)\) \{\s*return false;/);
  assert.match(server, /async function sweepExpiredSignals[\s\S]*?if \(isFinancialRecoveryMode\(\)\) \{\s*return \[\];/);
  assert.match(server, /if \(!isFinancialRecoveryMode\(\)\) \{\s*socketSignalService\.attach/);
  assert.match(server, /const mongoReady = !shouldUseMongo\(\) \|\| isMongoAppStatePersistenceReady\(\)/);
  assert.match(server, /Service is initializing authoritative state/);
});

test("core financial save paths are explicitly scoped away from optional side effects", () => {
  const financial = fs.readFileSync(path.join(__dirname, "..", "services", "financialService.js"), "utf8");
  assert.match(financial, /fields: \["wallets", "transactions", "giftCards", "idempotencyKeys"\]/);
  assert.match(financial, /fields: \["wallets", "transactions", "withdrawals", "idempotencyKeys"\]/);
  assert.match(financial, /bestEffort: true, fields: \["notifications", "auditLogs"\]/);
});
