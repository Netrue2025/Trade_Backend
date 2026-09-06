const test = require("node:test");
const assert = require("node:assert/strict");

const { TradeListener } = require("../services/tradeListener");

function createListenerHarness() {
  const subscriberMessages = [];
  const channelMessages = [];
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
    error: () => undefined,
  };
  const listener = new TradeListener({
    telegramService,
    subscriberModel,
    logger,
    channelSender: async (message, options) => {
      channelMessages.push({ message, options });
      return { sent: 1, skipped: 0, failed: 0 };
    },
  });
  return {
    channelMessages,
    listener,
    subscriberMessages,
  };
}

test("daily target alert is followed by additional profit messages", async () => {
  const { channelMessages, listener, subscriberMessages } = createListenerHarness();

  await listener.updateDailyProfit("bybit", 0.6);
  assert.equal(subscriberMessages.length, 0);
  assert.equal(channelMessages.length, 0);

  await listener.updateDailyProfit("bybit", 0.4);
  assert.equal(subscriberMessages.length, 1);
  assert.match(subscriberMessages[0].message, /Daily 1% target accomplished today/);
  assert.match(subscriberMessages[0].message, /Total profit today\n\+1\.00%/);
  assert.equal(channelMessages[0].options.type, "DAILY_TARGET");

  await listener.updateDailyProfit("bybit", 0.25);
  assert.equal(subscriberMessages.length, 2);
  assert.match(subscriberMessages[1].message, /in addition to the daily 1% accomplished today/);
  assert.match(subscriberMessages[1].message, /Total profit today\n\+1\.25%/);
  assert.equal(channelMessages[1].options.type, "DAILY_EXTRA_PROFIT");
});
