const axios = require("axios");

const { SubscriberModel } = require("../../models/subscriberModel");

class SignalTelegramService {
  constructor({ config, logger = console, subscriberModel = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.subscriberModel = subscriberModel || new SubscriberModel();
    this.queue = [];
    this.recipientCache = {
      ids: [],
      expiresAt: 0,
    };
  }

  isEnabled() {
    return !!this.config?.telegram?.token;
  }

  formatSignalMessage(signal) {
    const headline = signal?.meta?.testOnly
      ? `${String(signal.symbol || "").replace(/USDT$/, "/USDT")} TEST BUY SIGNAL`
      : `${String(signal.symbol || "").replace(/USDT$/, "/USDT")} BUY SIGNAL`;
    return [
      headline,
      `Strategy: ${signal.strategy}`,
      `Entry: ${signal.entry}`,
      `SL: ${signal.stopLoss}`,
      `TP: ${signal.takeProfit}`,
      `Confidence: ${Number(signal.confidence || 0).toFixed(2)}`,
      `Timeframe: ${signal.timeframe}`,
    ].join("\n");
  }

  async init() {
    if (this.subscriberModel?.init) {
      await this.subscriberModel.init().catch((error) => {
        this.logger.warn("Signal subscriber store init failed:", error.message || error);
      });
    }
    return this;
  }

  async sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${this.config.telegram.token}/sendMessage`;
    return axios.post(url, {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, {
      timeout: 15000,
      proxy: false,
    });
  }

  async sendWithRetry(chatId, text) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.telegram.retryAttempts; attempt += 1) {
      try {
        await this.sendMessage(chatId, text);
        return true;
      } catch (error) {
        lastError = error;
        this.logger.error(`Signal Telegram send failed for chat ${chatId} on attempt ${attempt}:`, error.message || error);
        await new Promise((resolve) => setTimeout(resolve, this.config.telegram.retryDelayMs * attempt));
      }
    }
    throw lastError;
  }

  async getSubscriberRecipientIds() {
    const now = Date.now();
    if (this.recipientCache.expiresAt > now) {
      return [...this.recipientCache.ids];
    }

    let ids = [];
    if (this.subscriberModel?.listSubscribed) {
      const subscribers = await this.subscriberModel.listSubscribed().catch((error) => {
        this.logger.warn("Signal subscriber lookup failed:", error.message || error);
        return [];
      });
      ids = subscribers
        .map((subscriber) => String(subscriber?.chatId || "").trim())
        .filter(Boolean);
    }

    this.recipientCache = {
      ids,
      expiresAt: now + 15_000,
    };
    return [...ids];
  }

  async dispatchToRecipients(recipientIds = [], message) {
    const ids = [...new Set(recipientIds.map((chatId) => String(chatId || "").trim()).filter(Boolean))];
    if (!ids.length) {
      return [];
    }

    return Promise.allSettled(ids.map((chatId) => this.sendWithRetry(chatId, message)));
  }

  async dispatchSignal(signal) {
    if (!this.isEnabled()) {
      return { dispatched: false, reason: "telegram_disabled" };
    }

    const message = this.formatSignalMessage(signal);
    const primaryRecipientId = String(this.config.telegram.chatId || "").trim();
    const startedAt = Date.now();

    const primaryDispatch = primaryRecipientId
      ? this.sendWithRetry(primaryRecipientId, message)
          .then(() => {
            this.logger.info(`Primary signal Telegram delivery completed for ${signal.symbol} in ${Date.now() - startedAt}ms.`);
          })
          .catch((error) => {
            this.logger.error(`Primary signal Telegram delivery failed for ${signal.symbol}:`, error.message || error);
          })
      : Promise.resolve();

    const subscriberDispatch = this.getSubscriberRecipientIds()
      .then((subscriberIds) => subscriberIds.filter((chatId) => chatId !== primaryRecipientId))
      .then((subscriberIds) => this.dispatchToRecipients(subscriberIds, message))
      .catch((error) => {
        this.logger.error(`Signal subscriber fanout failed for ${signal.symbol}:`, error.message || error);
        return [];
      });

    const [primaryResult, subscriberResults] = await Promise.all([primaryDispatch, subscriberDispatch]);

    return {
      dispatched: true,
      primaryRecipientId,
      subscriberCount: Array.isArray(subscriberResults) ? subscriberResults.length : 0,
      primaryResult,
    };
  }

  invalidateRecipientCache() {
    this.recipientCache = {
      ids: [],
      expiresAt: 0,
    };
  }

  enqueue() {
    // Kept only for backward compatibility with any external callers.
    this.logger.warn("SignalTelegramService.enqueue is deprecated. dispatchSignal now sends immediately.");
  }

  async flushQueue() {
    return;
  }

}

module.exports = {
  SignalTelegramService,
};
