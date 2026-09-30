const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assessClosedTradeInvestmentRecovery } = require("../lib/tradeInvestmentRecovery");

function fixture(overrides = {}) {
  const investment = {
    id: "investment-1",
    userId: "user-1",
    tradeId: "trade-1",
    status: "ACTIVE",
    joinedAt: "2026-09-22T13:42:07.057Z",
    amountUsdt: "80.93384615",
    baselinePnlPercent: "0.21345708",
    fundingSources: [{ currency: "NGN", amount: "105213.999995" }],
  };
  const trade = {
    id: "trade-1",
    price: "0.10775",
    adminExecution: { status: "FILLED", avgPrice: "0.10775" },
    exitOrders: [{
      createdAt: "2026-09-22T14:00:00.000Z",
      adminExecution: { status: "FILLED", avgPrice: "0.10916", transactTime: Date.parse("2026-09-22T15:00:00.000Z") },
    }],
  };
  const user = { id: "user-1", role: "user" };
  const transactions = [{
    reference: "investment-1",
    type: "TRADE_INVESTMENT_LOCK",
    status: "APPROVED",
    currency: "NGN",
    amount: "-105213.999995",
  }];
  const wallets = [{ userId: "user-1", currency: "NGN", availableBalance: "0.000005", lockedBalance: "105213.999995" }];
  return {
    investment: { ...investment, ...(overrides.investment || {}) },
    trade: { ...trade, ...(overrides.trade || {}) },
    user: overrides.user === undefined ? user : overrides.user,
    transactions: overrides.transactions || transactions,
    wallets: overrides.wallets || wallets,
  };
}

test("active investment on a closed filled trade is eligible only with complete authoritative evidence", () => {
  const result = assessClosedTradeInvestmentRecovery(fixture());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.settlementReference, "trade-settlement:investment-1");
  assert.equal(result.checks.joinedBeforeFilledExit, true);
  assert.equal(result.checks.fundsStillLocked, true);
});

test("eligibility assessment is read-only and preserves balances users and roles", () => {
  const state = fixture();
  const before = structuredClone(state);
  assessClosedTradeInvestmentRecovery(state);
  assert.deepEqual(state, before);
  assert.equal(state.wallets[0].lockedBalance, "105213.999995");
  assert.equal(state.user.role, "user");
});

test("stopped historical investment without settlement is never automatically eligible", () => {
  const result = assessClosedTradeInvestmentRecovery(fixture({ investment: { status: "STOPPED" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("active"));
});

test("existing exact settlement makes repeated reconciliation ineligible", () => {
  const state = fixture();
  state.transactions.push({
    reference: "trade-settlement:investment-1",
    type: "TRADING_PROFIT",
    status: "APPROVED",
    metadata: { investmentId: "investment-1" },
  });
  const result = assessClosedTradeInvestmentRecovery(state);
  assert.equal(result.eligible, false);
  assert.equal(result.checks.exactSettlementAbsent, false);
  assert.equal(result.checks.equivalentSettlementAbsent, false);
});

test("equivalent historical settlement under another reference blocks recovery", () => {
  const state = fixture();
  state.transactions.push({ reference: "legacy-credit", type: "TRADING_PROFIT", metadata: { investmentId: "investment-1" } });
  const result = assessClosedTradeInvestmentRecovery(state);
  assert.equal(result.eligible, false);
  assert.equal(result.checks.equivalentSettlementAbsent, false);
});

test("missing join debit locked funds timestamps or prices require forensic review", () => {
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ transactions: [] })).eligible, false);
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ wallets: [] })).eligible, false);
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ investment: { joinedAt: "invalid" } })).eligible, false);
  assert.equal(assessClosedTradeInvestmentRecovery(fixture({ trade: { adminExecution: { status: "FILLED", avgPrice: "0" } } })).eligible, false);
});

test("investment joined after the filled exit is not eligible", () => {
  const result = assessClosedTradeInvestmentRecovery(fixture({ investment: { joinedAt: "2026-09-22T16:00:00.000Z" } }));
  assert.equal(result.eligible, false);
  assert.equal(result.checks.joinedBeforeFilledExit, false);
});

test("scheduler revisits closed-trade investments through the canonical settlement primitive", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const reconciliation = server.slice(
    server.indexOf("async function reconcileTradeStatuses"),
    server.indexOf("function startTradeReconciliation")
  );
  const recovery = server.slice(
    server.indexOf("async function reconcileOrphanedClosedTradeInvestments"),
    server.indexOf("async function settleStaleTradeInvestmentsForWithdrawal")
  );
  assert.match(reconciliation, /await reconcileOrphanedClosedTradeInvestments\(\)/);
  assert.match(recovery, /investment\.status === "ACTIVE"/);
  assert.match(recovery, /deriveTradeLifecycle\(trade\) !== "CLOSED"/);
  assert.match(recovery, /assessClosedTradeInvestmentRecovery/);
  assert.match(recovery, /await settleTradeInvestment\(/);
  assert.ok(recovery.indexOf("await settleTradeInvestment(") < recovery.indexOf("handleRecoveredSettlement"));
  assert.match(recovery, /Recovered trade Telegram notification failed/);
  assert.match(recovery, /INVESTMENT_RECONCILIATION_REVIEW_REQUIRED/);
  assert.match(recovery, /catch \(error\)/);
});

test("canonical settlement remains atomic scoped idempotent and notification-after-durability", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const settlement = server.slice(
    server.indexOf("async function settleTradeInvestment"),
    server.indexOf("async function settleInactiveTradeInvestmentsForUsers")
  );
  assert.match(settlement, /withUserFinancialLock\(user\.id/);
  assert.match(settlement, /`trade-settlement:\$\{currentInvestment\.id\}`/);
  assert.match(settlement, /existingTransaction/);
  assert.match(settlement, /fields: \["meta", "tradeInvestments", "wallets", "transactions"\]/);
  assert.doesNotMatch(settlement, /fields:.*users/);
  assert.ok(settlement.indexOf("await persist({") < settlement.indexOf("financialService.createNotification"));
});

test("one closed current-generation trade settles every active joined investment independently", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const settlement = server.slice(server.indexOf("async function settleClosedTradeInvestments"), server.indexOf("const loggedInvestmentRecoveryReviews"));
  assert.match(settlement, /investment\.status === "ACTIVE" && investment\.tradeId === trade\.id/);
  assert.match(settlement, /for \(const investment of activeInvestments\)/);
  assert.match(settlement, /await settleTradeInvestment\(user, investment, trade/);
  assert.match(settlement, /if \(!isCurrentGenerationTrade\(trade\).*deriveTradeLifecycle\(trade\) !== "CLOSED"\)/s);
  const tradeCreation = server.slice(server.indexOf("async function createTradeIntent"), server.indexOf("async function executeSignalAutoTrade"));
  assert.match(tradeCreation, /settlementFeeModel: CURRENT_TRADE_FEE_MODEL/);
});

test("monitor revisits fast exits every 15 seconds and admin market-sell follows close settlement", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /const TRADE_RECONCILE_BACKGROUND_INTERVAL_MS = 15_000/);
  const adminSell = server.slice(server.indexOf('const sellMatch = url.pathname.match'), server.indexOf("return false;", server.indexOf('const sellMatch = url.pathname.match')));
  assert.match(adminSell, /await executeTradeExit\(trade, admin/);
  const exit = server.slice(server.indexOf("async function executeTradeExit"), server.indexOf("async function autoPlaceTakeProfit"));
  assert.match(exit, /if \(deriveTradeLifecycle\(trade\) === "CLOSED"\)/);
  assert.match(exit, /await settleClosedTradeInvestments\(trade/);
});

test("admin exits and TP order references are persisted before mirrored exit work", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const adminExit = server.slice(server.indexOf("async function executeTradeExit"), server.indexOf("async function autoPlaceTakeProfit"));
  const takeProfit = server.slice(server.indexOf("async function autoPlaceTakeProfit"), server.indexOf("function isSecureRequest"));
  const adminReferenceIndex = adminExit.indexOf("exitOrder.adminExecution = sanitizeExecution(adminOrder)");
  const adminAppendIndex = adminExit.indexOf("trade.exitOrders.push(exitOrder)", adminReferenceIndex);
  const adminPersistIndex = adminExit.indexOf('await persist({ required: true, fields: ["tradeIntents"] })', adminAppendIndex);
  const adminMirrorsIndex = adminExit.indexOf("for (const child of trade.mirroredExecutions", adminPersistIndex);
  assert.ok(adminReferenceIndex >= 0 && adminAppendIndex > adminReferenceIndex);
  assert.ok(adminPersistIndex > adminAppendIndex && adminMirrorsIndex > adminPersistIndex);

  const tpAppendIndex = takeProfit.indexOf("trade.exitOrders.push(exitOrder)");
  const tpPersistIndex = takeProfit.indexOf('await persist({ required: true, fields: ["tradeIntents"] })', tpAppendIndex);
  const tpMirrorsIndex = takeProfit.indexOf("for (const mirror of trade.mirroredExecutions", tpPersistIndex);
  assert.ok(tpAppendIndex >= 0 && tpPersistIndex > tpAppendIndex && tpMirrorsIndex > tpPersistIndex);
  assert.match(takeProfit, /trade\.exitOrders\s*=\s*Array\.isArray\(trade\.exitOrders\)/);
  assert.match(takeProfit, /trade\.exitOrders\.push\(exitOrder\)/);
});

test("new settlement path has no fixed product fee and stop is persisted, bounded, and duplicate guarded", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const settlement = server.slice(server.indexOf("async function settleTradeInvestment"), server.indexOf("async function settleInactiveTradeInvestmentsForUsers"));
  const release = server.slice(server.indexOf("function releaseTradeInvestmentFunds"), server.indexOf("function getTradeEntryPriceSnapshot"));
  const creation = server.slice(server.indexOf("async function createTradeIntent"), server.indexOf("async function executeSignalAutoTrade"));
  const stop = server.slice(server.indexOf("async function executeTradeExitLocked"), server.indexOf("async function autoPlaceTakeProfit"));
  const takeProfit = server.slice(server.indexOf("async function autoPlaceTakeProfit"), server.indexOf("function isSecureRequest"));

  assert.doesNotMatch(settlement, /applyFixedRoundTripFee|calculateFixedRoundTripSettlement/);
  assert.doesNotMatch(release, /calculateFixedRoundTripSettlement|tradingFee/);
  assert.match(settlement, /const settledPnlUsdt = grossPnlUsdt/);
  assert.match(settlement, /tradingFeeUsdt: "0"/);

  const entryIntentPersist = creation.indexOf('await persist({ required: true, fields: ["tradeIntents"] })');
  const entrySubmit = creation.indexOf("placeSpotOrder({ ...adminAccount, exchange }, balanceSafeOrderInput, exchange)");
  const entryFilledPersist = creation.indexOf("trade.adminExecution = sanitizeExecution(adminOrder)");
  assert.ok(entryIntentPersist >= 0 && entryIntentPersist < entrySubmit && entryFilledPersist > entrySubmit);
  assert.ok(takeProfit.indexOf('await persist({ required: true, fields: ["tradeIntents"] })') < takeProfit.indexOf("placeSpotOrder({ ...adminAccount, exchange }, normalizedExitInput, exchange)"));

  assert.match(stop, /trade\.closingAt = nowIso\(\)/);
  assert.match(stop, /getActiveTakeProfitOrders\(trade\)\.length/);
  assert.match(stop, /getRemainingTradeQuantity\(trade\)/);
  assert.match(stop, /requestedQuantity/);
  assert.match(server.slice(server.indexOf("async function executeTradeExit("), server.indexOf("async function executeTradeExitLocked")), /tradeExitOperations\.has\(trade\.id\)/);
  assert.match(server.slice(server.indexOf("const joinTradeMatch"), server.indexOf("const stopTradeMatch")), /lifecycleStatus !== "OPEN"/);
});

test("required persistence failure still freezes financial integrity", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const persistence = server.slice(server.indexOf("function persist("), server.indexOf("function markRequestDurableMutation"));
  assert.match(persistence, /if \(durabilityRequired\)/);
  assert.match(persistence, /financialIntegrity\.freeze/);
  assert.match(persistence, /throw error/);
});

test("trade joins, creation, exits, and reconciliation use scoped required persistence", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const reconciliation = server.slice(server.indexOf("async function reconcileTradeStatuses"), server.indexOf("function startTradeReconciliation"));
  const creation = server.slice(server.indexOf("async function createTradeIntent"), server.indexOf("async function executeSignalAutoTrade"));
  const exit = server.slice(server.indexOf("async function executeTradeExit"), server.indexOf("async function autoPlaceTakeProfit"));
  const takeProfit = server.slice(server.indexOf("async function autoPlaceTakeProfit"), server.indexOf("function isSecureRequest"));
  const adminJoin = server.slice(server.indexOf("const adminUserJoinTradeMatch"), server.indexOf("const adminUserMessageMatch"));
  const userJoin = server.slice(server.indexOf("const joinTradeMatch"), server.indexOf("const stopTradeMatch"));

  assert.match(reconciliation, /fields: \["meta", "tradeIntents", "tradeInvestments", "wallets", "transactions"\]/);
  assert.match(reconciliation, /await persist\(\{ required: true, fields: \["tradeIntents"\] \}\)/);
  assert.match(creation, /await persist\(\{ required: true, fields: \["tradeIntents"\] \}\)/);
  assert.match(exit, /fields: \["meta", "tradeIntents", "tradeInvestments", "wallets", "transactions"\]/);
  assert.match(takeProfit, /await persist\(\{ required: true, fields: \["tradeIntents"\] \}\)/);
  assert.match(adminJoin, /fields: \["meta", "tradeInvestments", "wallets", "transactions"\]/);
  assert.match(userJoin, /fields: \["meta", "tradeInvestments", "wallets", "transactions", "referrals"\]/);
  assert.match(server, /trade\.userJoinOpenNotifiedAt = nowIso\(\);\s*void persist\(\{ bestEffort: true, fields: \["tradeIntents", "notifications"\] \}\)/);
  assert.doesNotMatch(adminJoin, /await persist\(\{ required: true \}\)/);
  assert.doesNotMatch(userJoin, /await persist\(\{ required: true \}\)/);
});

test("settlement requires a complete filled exit and never uses a ticker snapshot", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(__dirname, "..", "lib", "tradeLifecycle.js"), "utf8");
  const settlement = server.slice(
    server.indexOf("async function settleTradeInvestment"),
    server.indexOf("async function settleInactiveTradeInvestmentsForUsers")
  );
  const closedPnl = server.slice(server.indexOf("function getAuthoritativeClosedTradePnlPercent"), server.indexOf("async function buildUserTradeInvestmentSummary"));

  assert.match(lifecycle, /exitStatuses\.includes\("FILLED"\) && entryQuantity > 0 && remainingQuantity <= 1e-8/);
  assert.match(lifecycle, /remainingQuantity > 1e-8/);
  assert.match(closedPnl, /getWeightedAverageExecutionPrice\(getFilledExitExecutions\(trade\)\)/);
  assert.match(closedPnl, /getRemainingTradeQuantity\(trade\) > 1e-8/);
  assert.match(settlement, /getAuthoritativeClosedTradePnlPercent\(trade\)/);
  assert.match(settlement, /TRADE_SETTLEMENT_EVIDENCE_INCOMPLETE/);
  assert.doesNotMatch(settlement, /getTradePnlPercentSnapshot/);
  assert.doesNotMatch(settlement, /getTickerPrice/);
  assert.match(settlement, /void persist\(\{ bestEffort: true, fields: \["notifications", "auditLogs"\] \}\)/);
});
