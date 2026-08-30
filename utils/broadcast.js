function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeType(type) {
  return String(type || "").trim().toLowerCase();
}

function normalizeExchange(exchange) {
  const value = String(exchange || "").trim().toLowerCase();
  return value === "binance" || value === "bybit" ? value : "";
}

function shouldReceiveBroadcast(subscriber, type, options = {}) {
  const preferences = {
    binance: true,
    bybit: true,
    dailyProfit: true,
    ...(subscriber?.preferences || {}),
  };
  const normalizedType = normalizeType(type);
  const exchange = normalizeExchange(options.exchange || normalizedType);

  if (normalizedType === "dailyprofit" || normalizedType === "daily_profit") {
    if (preferences.dailyProfit === false) {
      return false;
    }
    if (exchange && preferences[exchange] === false) {
      return false;
    }
    return true;
  }

  if (exchange) {
    return preferences[exchange] !== false;
  }

  return true;
}

function createBroadcaster({ telegramService, subscriberModel, logger = console, delayMs = 80 } = {}) {
  async function sendWithRetry(chatId, message, telegramOptions) {
    try {
      await telegramService.sendMessage(chatId, message, telegramOptions);
      return { ok: true };
    } catch (error) {
      const retryAfterSeconds = Number(error?.response?.body?.parameters?.retry_after || 0);
      if (retryAfterSeconds > 0) {
        await sleep((retryAfterSeconds * 1000) + 250);
        await telegramService.sendMessage(chatId, message, telegramOptions);
        return { ok: true, retried: true };
      }
      throw error;
    }
  }

  async function broadcast(message, type, options = {}) {
    if (!telegramService?.isEnabled?.() || !subscriberModel?.isEnabled?.()) {
      return { sent: 0, skipped: 0, failed: 0, disabled: true };
    }

    const subscribers = await subscriberModel.listSubscribed();
    const recipients = subscribers.filter((subscriber) => shouldReceiveBroadcast(subscriber, type, options));
    const stats = {
      sent: 0,
      skipped: subscribers.length - recipients.length,
      failed: 0,
      disabled: false,
    };

    for (const subscriber of recipients) {
      try {
        await sendWithRetry(subscriber.chatId, message, options.telegramOptions);
        stats.sent += 1;
      } catch (error) {
        stats.failed += 1;
        logger.error(`Telegram broadcast failed for chat ${subscriber.chatId}:`, error.message || error);
      }

      await sleep(options.delayMs || delayMs);
    }

    return stats;
  }

  return {
    broadcast,
  };
}

module.exports = {
  createBroadcaster,
  shouldReceiveBroadcast,
};
