"use strict";

const { getEnvValue } = require("./env");

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isFinancialRecoveryMode() {
  return enabled(getEnvValue("FINANCIAL_RECOVERY_MODE") || "true");
}

function isTradingOperationsEnabled() {
  return enabled(getEnvValue("TRADING_OPERATIONS_ENABLED"))
    && enabled(getEnvValue("TRADING_RESTORATION_APPROVED"));
}

function isTradingIsolationMode() {
  return !isTradingOperationsEnabled();
}

function assertTradingOperationAllowed() {
  if (isTradingOperationsEnabled()) return;
  const error = new Error("Trading operations are temporarily isolated.");
  error.statusCode = 503;
  error.code = "TRADING_OPERATIONS_ISOLATED";
  throw error;
}

function isVtuOperationsEnabled() {
  return !isFinancialRecoveryMode() && enabled(getEnvValue("VTU_OPERATIONS_ENABLED"));
}

function assertVtuOperationAllowed() {
  if (isVtuOperationsEnabled()) return;
  const error = new Error("VTU purchases are temporarily unavailable while persistence safety work is completed.");
  error.statusCode = 503;
  error.code = "VTU_OPERATIONS_DISABLED";
  throw error;
}

function isShopWalletPaymentsEnabled() {
  return !isFinancialRecoveryMode() && enabled(getEnvValue("SHOP_WALLET_PAYMENTS_ENABLED"));
}

function assertShopWalletPaymentAllowed() {
  if (isShopWalletPaymentsEnabled()) return;
  const error = new Error("Wallet shop payments are temporarily unavailable while persistence safety work is completed.");
  error.statusCode = 503;
  error.code = "SHOP_WALLET_PAYMENTS_DISABLED";
  throw error;
}

const CORE_FINANCIAL_VALIDATION_OPERATIONS = new Set([
  "DEPOSIT_CREATE",
  "DEPOSIT_APPROVAL",
  "WITHDRAWAL_CREATE",
  "WITHDRAWAL_APPROVAL",
  "WITHDRAWAL_PROVIDER_RESULT",
]);

function normalizeId(value) {
  return String(value || "").trim();
}

function getCoreFinancialValidationUserId() {
  return normalizeId(getEnvValue("CORE_FINANCIAL_VALIDATION_USER_ID"));
}

function isCoreFinancialValidationMode() {
  return enabled(getEnvValue("CORE_FINANCIAL_VALIDATION_MODE"));
}

function isRecoveryOperationAllowed(operation, context = {}) {
  if (!isFinancialRecoveryMode()) return true;
  const key = String(operation || "").trim().toUpperCase();
  if (!isCoreFinancialValidationMode() || !CORE_FINANCIAL_VALIDATION_OPERATIONS.has(key)) return false;

  const validationUserId = getCoreFinancialValidationUserId();
  const targetUserId = normalizeId(context.targetUserId);
  if (!validationUserId || targetUserId !== validationUserId) return false;

  if (key === "DEPOSIT_CREATE" || key === "WITHDRAWAL_CREATE") {
    return normalizeId(context.actorUserId) === validationUserId;
  }

  if (key === "DEPOSIT_APPROVAL" || key === "WITHDRAWAL_APPROVAL") {
    return context.isAdmin === true && !!normalizeId(context.actorUserId);
  }

  return context.providerVerified === true;
}

function assertRecoveryOperationAllowed(operation, context = {}) {
  if (isRecoveryOperationAllowed(operation, context)) return;
  const error = new Error("This operation is temporarily unavailable during financial recovery.");
  error.statusCode = 503;
  error.code = "FINANCIAL_RECOVERY_MODE";
  throw error;
}

module.exports = {
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
};
