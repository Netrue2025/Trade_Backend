const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CURRENT_TRADE_FEE_MODEL,
  FIXED_ROUND_TRIP_FEE_RATE,
  calculateFixedRoundTripSettlement,
} = require("../lib/tradingFee");

test("fixed round-trip fee uses exact decimal arithmetic for NGN profits, break-even, and losses", () => {
  assert.equal(FIXED_ROUND_TRIP_FEE_RATE, "0.002");
  assert.equal(CURRENT_TRADE_FEE_MODEL, "FIXED_ROUND_TRIP_0_20");

  assert.deepEqual(calculateFixedRoundTripSettlement("100000", "1"), {
    grossPnl: "1000", grossPnlPercent: "1", tradingFee: "200", feeRate: "0.002",
    netPnl: "800", netPnlPercent: "0.8", settlementAmount: "100800",
  });
  assert.equal(calculateFixedRoundTripSettlement("100000", "2").settlementAmount, "101800");
  assert.equal(calculateFixedRoundTripSettlement("100000", "0.5").settlementAmount, "100300");
  assert.equal(calculateFixedRoundTripSettlement("100000", "0").settlementAmount, "99800");
  assert.equal(calculateFixedRoundTripSettlement("100000", "-1").settlementAmount, "98800");
});

test("fixed round-trip fee supports USDT and respects the wallet decimal precision", () => {
  const usdt = calculateFixedRoundTripSettlement("100", "1");
  assert.equal(usdt.tradingFee, "0.2");
  assert.equal(usdt.settlementAmount, "100.8");

  const small = calculateFixedRoundTripSettlement("0.00000001", "-1");
  assert.equal(small.settlementAmount, "0.00000001");
  assert.equal(small.tradingFee, "0");
  assert.equal(small.netPnl, "0");
});
