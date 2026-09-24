const test = require("node:test");
const assert = require("node:assert/strict");

const { TradeListener, aggregateDailyTradeProfit, getNigeriaDateKey } = require("../services/tradeListener");

function createListenerHarness(options = {}) {
  const subscriberMessages = [];
  const channelMessages = [];
  const errors = [];
  const telegramService = {
    isEnabled: () => true,
    sendMessage: async (chatId, message, telegramOptions) => {
      subscriberMessages.push({ chatId, message, telegramOptions });
    },
  };
  const subscriberModel = {
    isEnabled: () => true,
    listSubscribed: async () => [
      {
        chatId: "123",
        preferences: {
          bybit: true,
          dailyProfit: true,
        },
      },
    ],
  };
  const logger = {
    log: () => undefined,
    warn: () => undefined,
    error: (...args) => errors.push(args.join(" ")),
  };
  const listener = new TradeListener({
    telegramService,
    subscriberModel,
    logger,
    channelSender: async (message, options) => {
      channelMessages.push({ message, options });
      return { sent: 1, skipped: 0, failed: 0 };
    },
    dailyProfitProvider: options.dailyProfitProvider,
  });
  return {
    channelMessages,
    errors,
    listener,
    subscriberMessages,
  };
}

test("daily target alert is followed by additional profit messages", async () => {
  const reports = [
    { totalPercent: 0.6, records: [{ tradeId: "a", profitPercent: 0.6 }] },
    { totalPercent: 1, records: [{ tradeId: "a", profitPercent: 0.6 }, { tradeId: "b", profitPercent: 0.4 }] },
    { totalPercent: 1.25, records: [{ tradeId: "a", profitPercent: 0.6 }, { tradeId: "b", profitPercent: 0.4 }, { tradeId: "c", profitPercent: 0.25 }] },
  ];
  const { channelMessages, listener, subscriberMessages } = createListenerHarness({ dailyProfitProvider: async () => reports.shift() });

  await listener.updateDailyProfit("bybit", 0.6, { trade: { id: "a" } });
  assert.equal(subscriberMessages.length, 0);
  assert.equal(channelMessages.length, 0);

  await listener.updateDailyProfit("bybit", 0.4, { trade: { id: "b" } });
  assert.equal(subscriberMessages.length, 1);
  assert.match(subscriberMessages[0].message, /Daily 1% target accomplished today/);
  assert.match(subscriberMessages[0].message, /Total profit today\n\+1\.00%/);
  assert.equal(channelMessages[0].options.type, "DAILY_TARGET");

  await listener.updateDailyProfit("bybit", 0.25, { trade: { id: "c" } });
  assert.equal(subscriberMessages.length, 2);
  assert.match(subscriberMessages[1].message, /in addition to the daily 1% accomplished today/);
  assert.match(subscriberMessages[1].message, /Total profit today\n\+1\.25%/);
  assert.equal(channelMessages[1].options.type, "DAILY_EXTRA_PROFIT");
});

function closedTrade(id, profitPercent, closedAt, kind = "TAKE_PROFIT", createdAt = closedAt) {
  const entryPrice = 100;
  const exitPrice = entryPrice * (1 + (profitPercent / 100));
  return {
    id,
    symbol: "BTCUSDT",
    exchange: "bybit",
    side: "BUY",
    createdAt,
    adminExecution: { status: "FILLED", executedQty: "1", price: String(entryPrice) },
    exitOrders: [{
      id: `exit-${id}`,
      kind,
      createdAt: closedAt,
      adminExecution: { status: "FILLED", executedQty: "1", price: String(exitPrice), transactTime: Date.parse(closedAt) },
    }],
  };
}

test("recovered TP settlement publishes subscriber and configured channel messages", async () => {
  const { channelMessages, listener, subscriberMessages } = createListenerHarness();
  const trade = closedTrade("recovered", 1.25, "2026-09-24T10:00:00.000Z");

  const result = await listener.handleRecoveredSettlement(trade);

  assert.equal(result.sent, 1);
  assert.equal(subscriberMessages.length, 1);
  assert.equal(channelMessages.length, 1);
  assert.equal(channelMessages[0].options.type, "TAKE_PROFIT");
  assert.match(channelMessages[0].message, /TAKE PROFIT HIT/);
});

test("recovered settlement channel failure is visible and does not reject durable recovery", async () => {
  const errors = [];
  const listener = new TradeListener({
    telegramService: { isEnabled: () => true, sendMessage: async () => undefined },
    subscriberModel: { isEnabled: () => true, listSubscribed: async () => [] },
    logger: { log: () => undefined, warn: () => undefined, error: (...args) => errors.push(args.join(" ")) },
    channelSender: async () => ({ sent: 1, failed: 1, channelError: "forbidden" }),
  });
  const trade = closedTrade("recovered-failure", 0.75, "2026-09-24T11:00:00.000Z");

  const result = await listener.handleRecoveredSettlement(trade);

  assert.equal(result.failed, 1);
  assert.match(errors.join("\n"), /Telegram channel delivery failed: forbidden/);
});

test("daily profit is reconstructed from all same-day TP and manual closes", () => {
  const at = "2026-09-22T18:00:00.000Z";
  const trades = [
    closedTrade("a", 1, "2026-09-22T08:00:00.000Z"),
    closedTrade("b", 2, "2026-09-22T10:00:00.000Z"),
    closedTrade("c", 0.5, "2026-09-22T12:00:00.000Z", "MANUAL_SELL"),
  ];
  const report = aggregateDailyTradeProfit(trades, { exchange: "bybit", at });
  assert.equal(report.tradesClosed, 3);
  assert.ok(Math.abs(report.totalPercent - 3.5) < 1e-9);

  trades[2] = closedTrade("c", -0.5, "2026-09-22T12:00:00.000Z", "MANUAL_SELL");
  assert.ok(Math.abs(aggregateDailyTradeProfit(trades, { exchange: "bybit", at }).totalPercent - 2.5) < 1e-9);
});

test("Nigeria calendar boundary uses close time and survives state reload", () => {
  const previousDay = closedTrade("previous", 4, "2026-09-22T22:59:59.000Z");
  const newDay = closedTrade("new", 1, "2026-09-22T23:00:01.000Z", "MANUAL_SELL", "2026-09-22T22:00:00.000Z");
  const persisted = JSON.parse(JSON.stringify([previousDay]));
  const restarted = JSON.parse(JSON.stringify(persisted));
  restarted.push(newDay);

  assert.equal(getNigeriaDateKey("2026-09-22T23:00:01.000Z"), "2026-09-23");
  assert.equal(aggregateDailyTradeProfit(persisted, { at: "2026-09-22T22:59:59.000Z" }).totalPercent, 4);
  const report = aggregateDailyTradeProfit(restarted, { at: "2026-09-22T23:00:01.000Z" });
  assert.equal(report.tradesClosed, 1);
  assert.ok(Math.abs(report.totalPercent - 1) < 1e-9);
});

test("open, cancelled, partial and duplicate input identities do not inflate realized totals", () => {
  const closed = closedTrade("closed", 2, "2026-09-22T12:00:00.000Z");
  const open = { ...closedTrade("open", 3, "2026-09-22T13:00:00.000Z"), exitOrders: [] };
  const cancelled = closedTrade("cancelled", 5, "2026-09-22T14:00:00.000Z");
  cancelled.exitOrders[0].adminExecution.status = "CANCELED";
  const partial = closedTrade("partial", 6, "2026-09-22T15:00:00.000Z");
  partial.exitOrders[0].adminExecution.executedQty = "0.5";
  const duplicate = JSON.parse(JSON.stringify(closed));
  const report = aggregateDailyTradeProfit([closed, duplicate, open, cancelled, partial], { at: "2026-09-22T18:00:00.000Z" });
  assert.equal(report.tradesClosed, 1);
  assert.ok(Math.abs(report.totalPercent - 2) < 1e-9);
});

test("Telegram failure and retry cannot mutate reconstructed accounting", async () => {
  const trades = [closedTrade("stable", 2, "2026-09-22T12:00:00.000Z")];
  const before = aggregateDailyTradeProfit(trades, { at: "2026-09-22T18:00:00.000Z" });
  const listener = new TradeListener({
    telegramService: { isEnabled: () => true, sendMessage: async () => { throw new Error("offline"); } },
    subscriberModel: { isEnabled: () => true, listSubscribed: async () => [{ chatId: "1", preferences: { dailyProfit: true, bybit: true } }] },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    dailyProfitProvider: async () => aggregateDailyTradeProfit(trades, { at: "2026-09-22T18:00:00.000Z" }),
  });
  await listener.updateDailyProfit("bybit", 2, { trade: trades[0] });
  await listener.updateDailyProfit("bybit", 2, { trade: trades[0] });
  assert.deepEqual(aggregateDailyTradeProfit(trades, { at: "2026-09-22T18:00:00.000Z" }), before);
});
