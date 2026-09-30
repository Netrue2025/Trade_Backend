"use strict";

function calculateTradePnlPercent(entryPrice, currentPrice, side) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  const normalizedSide = String(side || "").trim().toUpperCase();
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || current <= 0) {
    throw new Error("A valid entry and current price are required to calculate trade P&L.");
  }
  if (!["BUY", "SELL"].includes(normalizedSide)) {
    throw new Error("Unsupported trade side for P&L calculation.");
  }
  return ((current - entry) / entry) * 100 * (normalizedSide === "SELL" ? -1 : 1);
}

module.exports = { calculateTradePnlPercent };
