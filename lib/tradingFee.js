"use strict";

const { add, compare, multiplyRatio, subtract } = require("./money");

// This is the only user-facing trading fee. Exchange execution fees remain
// reconciliation evidence and are not deducted separately from settlement.
const FIXED_ROUND_TRIP_FEE_RATE = "0.002";
const FIXED_ROUND_TRIP_FEE_PERCENT = "0.2";
const CURRENT_TRADE_FEE_MODEL = "FIXED_ROUND_TRIP_0_20";

function calculateFixedRoundTripSettlement(principal, grossPnlPercent) {
  const grossPnl = multiplyRatio(principal, grossPnlPercent, "100");
  const tradingFee = multiplyRatio(principal, FIXED_ROUND_TRIP_FEE_PERCENT, "100");
  const netPnl = subtract(grossPnl, tradingFee);
  const proposedSettlementAmount = add(principal, netPnl);

  return {
    grossPnl,
    grossPnlPercent: String(grossPnlPercent),
    tradingFee,
    feeRate: FIXED_ROUND_TRIP_FEE_RATE,
    netPnl,
    netPnlPercent: subtract(grossPnlPercent, FIXED_ROUND_TRIP_FEE_PERCENT),
    settlementAmount: compare(proposedSettlementAmount, "0") < 0 ? "0" : proposedSettlementAmount,
  };
}

module.exports = {
  CURRENT_TRADE_FEE_MODEL,
  FIXED_ROUND_TRIP_FEE_PERCENT,
  FIXED_ROUND_TRIP_FEE_RATE,
  calculateFixedRoundTripSettlement,
};
