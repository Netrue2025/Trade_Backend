"use strict";

const { getEnvValue } = require("./env");

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isFinancialRecoveryMode() {
  return enabled(getEnvValue("FINANCIAL_RECOVERY_MODE") || "true");
}

function isRecoveryOperationAllowed(operation) {
  if (!isFinancialRecoveryMode()) return true;
  const key = String(operation || "").trim().toUpperCase();
  if (key === "DEPOSIT") return enabled(getEnvValue("FINANCIAL_RECOVERY_ALLOW_DEPOSITS"));
  if (key === "WITHDRAWAL") return enabled(getEnvValue("FINANCIAL_RECOVERY_ALLOW_WITHDRAWALS"));
  return false;
}

function assertRecoveryOperationAllowed(operation) {
  if (isRecoveryOperationAllowed(operation)) return;
  const error = new Error("This operation is temporarily unavailable during financial recovery.");
  error.statusCode = 503;
  error.code = "FINANCIAL_RECOVERY_MODE";
  throw error;
}

module.exports = { isFinancialRecoveryMode, isRecoveryOperationAllowed, assertRecoveryOperationAllowed };
