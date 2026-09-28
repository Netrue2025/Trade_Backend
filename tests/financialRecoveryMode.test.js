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
  isTradingIsolationMode,
  isTradingOperationsEnabled,
  isVtuOperationsEnabled,
  isShopWalletPaymentsEnabled,
  assertRecoveryOperationAllowed,
  assertTradingOperationAllowed,
  assertVtuOperationAllowed,
  assertShopWalletPaymentAllowed,
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

test("trading remains isolated after recovery mode is disabled until separately approved", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: "false", TRADING_OPERATIONS_ENABLED: undefined, TRADING_RESTORATION_APPROVED: undefined }, () => {
    assert.equal(isFinancialRecoveryMode(), false);
    assert.equal(isTradingOperationsEnabled(), false);
    assert.equal(isTradingIsolationMode(), true);
    assert.throws(() => assertTradingOperationAllowed(), { code: "TRADING_OPERATIONS_ISOLATED" });
  });
  withEnv({ FINANCIAL_RECOVERY_MODE: "false", TRADING_OPERATIONS_ENABLED: "true", TRADING_RESTORATION_APPROVED: undefined }, () => {
    assert.equal(isTradingOperationsEnabled(), false);
    assert.equal(isTradingIsolationMode(), true);
  });
  withEnv({ FINANCIAL_RECOVERY_MODE: "false", TRADING_OPERATIONS_ENABLED: "true", TRADING_RESTORATION_APPROVED: "true" }, () => {
    assert.equal(isTradingOperationsEnabled(), true);
    assert.equal(isTradingIsolationMode(), false);
  });
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", TRADING_OPERATIONS_ENABLED: "true", TRADING_RESTORATION_APPROVED: "true" }, () => {
    assert.equal(isTradingOperationsEnabled(), false);
  });
});

test("unsafe VTU and wallet shop flows remain independently disabled after recovery ends", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: "false", VTU_OPERATIONS_ENABLED: undefined, SHOP_WALLET_PAYMENTS_ENABLED: undefined }, () => {
    assert.equal(isVtuOperationsEnabled(), false);
    assert.equal(isShopWalletPaymentsEnabled(), false);
    assert.throws(() => assertVtuOperationAllowed(), { code: "VTU_OPERATIONS_DISABLED" });
    assert.throws(() => assertShopWalletPaymentAllowed(), { code: "SHOP_WALLET_PAYMENTS_DISABLED" });
  });
  withEnv({ FINANCIAL_RECOVERY_MODE: "false", VTU_OPERATIONS_ENABLED: "true", SHOP_WALLET_PAYMENTS_ENABLED: "true" }, () => {
    assert.equal(isVtuOperationsEnabled(), true);
    assert.equal(isShopWalletPaymentsEnabled(), true);
  });
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", VTU_OPERATIONS_ENABLED: "true", SHOP_WALLET_PAYMENTS_ENABLED: "true" }, () => {
    assert.equal(isVtuOperationsEnabled(), false);
    assert.equal(isShopWalletPaymentsEnabled(), false);
  });
});

test("server recovery gates cover trade creation, reconciliation, settlement, deposits, withdrawals, gift cards, and quest money", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /TRADING_OPERATIONS_ISOLATED trade reconciliation skipped/);
  assert.match(server, /if \(isTradingIsolationMode\(\)\) \{\s*return null;/);
  assert.match(server, /async function settleTradeInvestment[\s\S]*?isTradingIsolationMode\(\)/);
  assert.match(server, /async function settleStaleTradeInvestmentsForWithdrawal[\s\S]*?if \(isTradingIsolationMode\(\)\) \{[\s\S]*?settled: \[\]/);
  assert.match(server, /async function reconcileExternalClosuresForOwner[\s\S]*?isTradingIsolationMode\(\)/);
  assert.match(server, /async function createTradeIntent[\s\S]*?assertTradingOperationAllowed\(\)/);
  assert.match(server, /async function executeTradeExit[\s\S]*?assertTradingOperationAllowed\(\)/);
  assert.match(server, /async function autoPlaceTakeProfit[\s\S]*?assertTradingOperationAllowed\(\)/);
  assert.match(server, /takeProfitMatch[\s\S]*?assertTradingOperationAllowed\(\)[\s\S]*?trade\.takeProfitTargetPrice = price/);
  assert.match(server, /assertRecoveryOperationAllowed\("DEPOSIT_CREATE", \{ actorUserId: user\.id, targetUserId: user\.id \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL_CREATE", \{ actorUserId: user\.id, targetUserId: user\.id \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("DEPOSIT_APPROVAL", \{ actorUserId: admin\.id, targetUserId: targetDeposit\.userId, isAdmin: admin\.role === "admin" \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL_APPROVAL", \{ actorUserId: admin\.id, targetUserId: withdrawal\.userId, isAdmin: admin\.role === "admin" \}\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL_PROVIDER_RESULT", \{ targetUserId: recoveryWithdrawal\.userId, providerVerified: true \}\)/);
  assert.match(server, /async function syncProcessingPaystackWithdrawals[\s\S]*?if \(isFinancialRecoveryMode\(\)\) \{\s*return;/);
  assert.match(server, /assertRecoveryOperationAllowed\("GIFT_CARD"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("QUEST_REWARD"\)/);
  assert.match(server, /\/api\/vtu\/airtime[\s\S]*?assertVtuOperationAllowed\(\)/);
  assert.match(server, /\/api\/vtu\/data[\s\S]*?assertVtuOperationAllowed\(\)/);
  assert.match(server, /paymentMethod === "wallet"[\s\S]*?assertShopWalletPaymentAllowed\(\)/);
});

test("minimal core startup does not start optional signal, Telegram, or reconciliation workers", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /TRADING_OPERATIONS_ISOLATED minimal core active; optional workers are disabled\./);
  assert.match(server, /async function ensureSignalEngineRunning[\s\S]*?if \(isTradingIsolationMode\(\)\) \{\s*return false;/);
  assert.match(server, /async function ensureTradeListenerRunning[\s\S]*?if \(isTradingIsolationMode\(\)\) \{\s*return false;/);
  assert.match(server, /async function sweepExpiredSignals[\s\S]*?if \(isTradingIsolationMode\(\)\) \{\s*return \[\];/);
  assert.match(server, /if \(!isTradingIsolationMode\(\)\) \{\s*socketSignalService\.attach/);
  assert.match(server, /const mongoReady = !shouldUseMongo\(\) \|\| isMongoAppStatePersistenceReady\(\)/);
  assert.match(server, /Service is initializing authoritative state/);
});

test("core financial save paths are explicitly scoped away from optional side effects", () => {
  const financial = fs.readFileSync(path.join(__dirname, "..", "services", "financialService.js"), "utf8");
  assert.match(financial, /fields: \["wallets", "transactions", "giftCards", "idempotencyKeys"\]/);
  assert.match(financial, /fields: \["wallets", "transactions", "withdrawals", "idempotencyKeys"\]/);
  assert.match(financial, /bestEffort: true, fields: \["notifications", "auditLogs"\]/);
});
