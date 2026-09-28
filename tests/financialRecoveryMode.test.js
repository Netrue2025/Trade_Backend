"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isFinancialRecoveryMode, isRecoveryOperationAllowed, assertRecoveryOperationAllowed } = require("../lib/financialRecoveryMode");

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
  withEnv({ FINANCIAL_RECOVERY_MODE: undefined, FINANCIAL_RECOVERY_ALLOW_DEPOSITS: undefined, FINANCIAL_RECOVERY_ALLOW_WITHDRAWALS: undefined }, () => {
    assert.equal(isFinancialRecoveryMode(), true);
    assert.equal(isRecoveryOperationAllowed("TRADE"), false);
    assert.equal(isRecoveryOperationAllowed("DEPOSIT"), false);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL"), false);
    assert.throws(() => assertRecoveryOperationAllowed("GIFT_CARD"), { code: "FINANCIAL_RECOVERY_MODE" });
  });
});

test("recovery operator may enable deposits and withdrawals without enabling trading", () => {
  withEnv({ FINANCIAL_RECOVERY_MODE: "true", FINANCIAL_RECOVERY_ALLOW_DEPOSITS: "true", FINANCIAL_RECOVERY_ALLOW_WITHDRAWALS: "true" }, () => {
    assert.equal(isRecoveryOperationAllowed("DEPOSIT"), true);
    assert.equal(isRecoveryOperationAllowed("WITHDRAWAL"), true);
    assert.equal(isRecoveryOperationAllowed("TRADE_JOIN"), false);
  });
});

test("server recovery gates cover trade creation, reconciliation, settlement, deposits, withdrawals, gift cards, and quest money", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /FINANCIAL_RECOVERY_MODE trade reconciliation skipped/);
  assert.match(server, /if \(isFinancialRecoveryMode\(\)\) \{\s*return null;/);
  assert.match(server, /async function settleTradeInvestment[\s\S]*?isFinancialRecoveryMode\(\)/);
  assert.match(server, /async function reconcileExternalClosuresForOwner[\s\S]*?isFinancialRecoveryMode\(\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("TRADE"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("TRADE_JOIN"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("DEPOSIT"\)/);
  assert.match(server, /assertRecoveryOperationAllowed\("WITHDRAWAL"\)/);
  assert.match(server, /eventType\.startsWith\("transfer\."\) && isFinancialRecoveryMode\(\)/);
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
