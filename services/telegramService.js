const TelegramBot = require("node-telegram-bot-api");

const { disableBrokenLocalProxyEnv } = require("../lib/network");
const { getEnvValue, normalizeEnvValue } = require("../lib/env");
const { defaultPreferences } = require("../models/subscriberModel");

function maskToken(token = "") {
  const value = String(token || "").trim();
  if (!value) {
    return "";
  }
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatPreferenceLabel(key, enabled) {
  const labels = {
    binance: "Binance alerts",
    bybit: "Bybit alerts",
    dailyProfit: "Daily profit alerts",
  };
  return `${enabled ? "✅" : "⬜"} ${labels[key] || key}`;
}

function withTimeout(promise, label, timeoutMs = 6000) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

function isTrue(value) {
  return normalizeEnvValue(value).toLowerCase() === "true";
}

function isFalse(value) {
  return normalizeEnvValue(value).toLowerCase() === "false";
}

function shouldEnableTradeBotPolling() {
  const explicit = getEnvValue("TELEGRAM_TRADE_BOT_POLLING_ENABLED");
  if (explicit) {
    return isTrue(explicit);
  }

  const runningOnRender = !!getEnvValue("RENDER", "RENDER_EXTERNAL_URL");
  return !runningOnRender;
}

class TelegramService {
  constructor({ token = getEnvValue("TELEGRAM_TRADE_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"), subscriberModel, logger = console } = {}) {
    this.token = normalizeEnvValue(token);
    this.subscriberModel = subscriberModel;
    this.logger = logger;
    this.bot = null;
    this.started = false;
    this.pollingRestartTimer = null;
    this.lastPollingError = null;
    this.pollingEnabled = shouldEnableTradeBotPolling();
  }

  isEnabled() {
    return !!this.token && !!this.bot && this.started;
  }

  isHealthy() {
    if (!this.isEnabled()) {
      return false;
    }

    if (!this.pollingEnabled) {
      return true;
    }

    return typeof this.bot.isPolling === "function" ? this.bot.isPolling() : true;
  }

  getDiagnostics() {
    return {
      tokenLoaded: !!this.token,
      tokenPreview: maskToken(this.token),
      started: this.started,
      pollingEnabled: this.pollingEnabled,
      polling: !!this.bot,
      pollingActive: this.isHealthy(),
      webhook: false,
      subscriberStoreEnabled: !!this.subscriberModel?.isEnabled?.(),
      lastPollingError: this.lastPollingError,
    };
  }

  buildSettingsKeyboard(preferences = defaultPreferences()) {
    return {
      inline_keyboard: [
        [
          {
            text: formatPreferenceLabel("binance", preferences.binance !== false),
            callback_data: "telegram-pref:binance",
          },
        ],
        [
          {
            text: formatPreferenceLabel("bybit", preferences.bybit !== false),
            callback_data: "telegram-pref:bybit",
          },
        ],
        [
          {
            text: formatPreferenceLabel("dailyProfit", preferences.dailyProfit !== false),
            callback_data: "telegram-pref:dailyProfit",
          },
        ],
      ],
    };
  }

  async start() {
    if (!this.token) {
      this.started = false;
      this.bot = null;
      this.logger.warn("Telegram bot service disabled: TELEGRAM_TRADE_BOT_TOKEN or TELEGRAM_BOT_TOKEN is missing.");
      return this;
    }

    disableBrokenLocalProxyEnv(this.logger, "Telegram trade bot");

    if (!this.bot) {
      if (this.subscriberModel?.init) {
        await this.subscriberModel.init();
      }

      this.bot = new TelegramBot(this.token, {
        polling: false,
      });

      this.registerHandlers();
      this.logger.log("Telegram bot started");
    }

    if (this.pollingEnabled) {
      await this.ensurePolling();
    } else {
      this.logger.log("Telegram trade bot polling is disabled for this instance. Outgoing notifications remain enabled.");
    }
    this.started = true;
    return this;
  }

  async stop() {
    clearTimeout(this.pollingRestartTimer);
    this.pollingRestartTimer = null;
    if (!this.bot) {
      this.started = false;
      return;
    }

    await this.bot.stopPolling().catch(() => {});
    this.bot = null;
    this.started = false;
  }

  async ensurePolling() {
    if (!this.bot) {
      throw new Error("Telegram bot is not initialized.");
    }

    if (!this.pollingEnabled) {
      return;
    }

    if (typeof this.bot.isPolling === "function" && this.bot.isPolling()) {
      return;
    }

    await this.bot.deleteWebHook({ drop_pending_updates: false }).catch((error) => {
      this.logger.warn("Telegram bot webhook cleanup failed:", error.message || error);
    });

    await this.bot.startPolling({
      restart: true,
    });

    this.lastPollingError = null;
    this.logger.log("Telegram bot polling mode active.");
  }

  schedulePollingRestart(reason, error = null) {
    if (!this.pollingEnabled) {
      return;
    }

    if (error) {
      this.lastPollingError = {
        message: error.message || String(error),
        at: new Date().toISOString(),
        reason,
      };
    }

    if (this.pollingRestartTimer || !this.bot) {
      return;
    }

    this.pollingRestartTimer = setTimeout(() => {
      this.pollingRestartTimer = null;
      void this.ensurePolling().catch((restartError) => {
        this.logger.error("Telegram bot polling restart failed:", restartError.message || restartError);
        this.schedulePollingRestart("restart_failed", restartError);
      });
    }, 5000);
  }

  async sendMessage(chatId, text, options = {}) {
    if (!this.bot) {
      throw new Error("Telegram bot is not initialized.");
    }

    return this.bot.sendMessage(chatId, text, {
      disable_web_page_preview: true,
      ...options,
    });
  }

  async getSubscriberWithFallback(chatId, contextLabel) {
    const fallbackSubscriber = {
      chatId,
      subscribed: true,
      preferences: defaultPreferences(),
    };

    try {
      const subscriber = await withTimeout(
        this.subscriberModel.subscribe(chatId),
        `${contextLabel} subscriber sync`
      );
      return {
        subscriber: subscriber || fallbackSubscriber,
        degraded: false,
      };
    } catch (error) {
      this.logger.error(`${contextLabel} subscriber sync failed:`, error.message || error);
      const existingSubscriber = await withTimeout(
        this.subscriberModel.findByChatId(chatId),
        `${contextLabel} subscriber fallback lookup`,
        2500
      ).catch((fallbackError) => {
        this.logger.error(`${contextLabel} subscriber fallback lookup failed:`, fallbackError.message || fallbackError);
        return null;
      });

      return {
        subscriber: existingSubscriber || fallbackSubscriber,
        degraded: true,
        error,
      };
    }
  }

  registerHandlers() {
    this.bot.on("message", (msg) => {
      this.logger.log(
        `Telegram bot incoming update from chat ${msg?.chat?.id || "unknown"}: ${String(msg?.text || "[non-text]").slice(0, 120)}`
      );
    });

    this.bot.on("polling_error", (error) => {
      const message = String(error?.message || error || "");
      this.logger.error("Telegram bot polling error:", message);
      if (message.includes("409 Conflict")) {
        this.lastPollingError = {
          message,
          at: new Date().toISOString(),
          reason: "polling_conflict",
        };
        this.pollingEnabled = false;
        void this.bot.stopPolling().catch(() => {});
        this.logger.warn("Telegram trade bot polling disabled after a 409 conflict. Outgoing notifications are still available.");
        return;
      }
      this.schedulePollingRestart("polling_error", error);
    });

    this.bot.on("webhook_error", (error) => {
      this.logger.error("Telegram bot webhook error:", error.message || error);
      this.schedulePollingRestart("webhook_error", error);
    });

    this.bot.onText(/^\/start$/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const { degraded } = await this.getSubscriberWithFallback(chatId, "Telegram /start");
        await this.sendMessage(
          chatId,
          degraded
            ? "The bot is online, but subscriber storage is responding slowly right now.\n\nYour alert preferences may not save yet. Use /settings again in a moment if the buttons do not reflect your choices."
            : "You are now subscribed to trade alerts.\n\nUse /settings to choose Binance, Bybit, and daily profit notifications.\nUse /stop any time to unsubscribe."
        );
      } catch (error) {
        this.logger.error("Telegram /start failed:", error.message || error);
        await this.sendMessage(chatId, "I could not save your subscription right now. Please try again in a moment.").catch(() => {});
      }
    });

    this.bot.onText(/^\/stop$/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        await this.subscriberModel.unsubscribe(chatId);
        await this.sendMessage(chatId, "You have been unsubscribed from trade alerts. Send /start whenever you want them back.");
      } catch (error) {
        this.logger.error("Telegram /stop failed:", error.message || error);
        await this.sendMessage(chatId, "I could not update your subscription right now. Please try again in a moment.").catch(() => {});
      }
    });

    this.bot.onText(/^\/settings$/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const { subscriber, degraded } = await this.getSubscriberWithFallback(chatId, "Telegram /settings");
        await this.sendMessage(
          chatId,
          degraded
            ? "Choose which alerts you want to receive.\n\nStorage is reconnecting, so button changes may take a moment to persist."
            : "Choose which alerts you want to receive:",
          {
            reply_markup: this.buildSettingsKeyboard(subscriber?.preferences),
          }
        );
      } catch (error) {
        this.logger.error("Telegram /settings failed:", error.message || error);
        await this.sendMessage(chatId, "I could not load your settings right now. Please try again in a moment.").catch(() => {});
      }
    });

    this.bot.on("callback_query", async (query) => {
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      const data = String(query.data || "");
      if (!chatId || !messageId || !data.startsWith("telegram-pref:")) {
        return;
      }

      const preferenceKey = data.replace("telegram-pref:", "").trim();
      try {
        const subscriber = await withTimeout(
          this.subscriberModel.togglePreference(chatId, preferenceKey),
          "Telegram preference toggle"
        );
        await this.bot.editMessageReplyMarkup(this.buildSettingsKeyboard(subscriber?.preferences), {
          chat_id: chatId,
          message_id: messageId,
        });
        await this.bot.answerCallbackQuery(query.id, {
          text: `${formatPreferenceLabel(
            preferenceKey,
            subscriber?.preferences?.[preferenceKey] !== false
          )}`,
        });
      } catch (error) {
        this.logger.error("Telegram preference toggle failed:", error.message || error);
        await this.bot.answerCallbackQuery(query.id, {
          text: "That setting could not be updated right now.",
          show_alert: false,
        }).catch(() => {});
      }
    });
  }
}

module.exports = {
  TelegramService,
};
