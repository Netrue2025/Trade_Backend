const { createBroadcaster } = require("../utils/broadcast");

const DAILY_PROFIT_TARGET_PERCENT = 1;
const REPORTING_TIME_ZONE = "Africa/Lagos";

function normalizeExchange(exchange) {
  const value = String(exchange || "").trim().toLowerCase();
  return value === "binance" || value === "bybit" ? value : "bybit";
}

function getExchangeLabel(exchange) {
  return normalizeExchange(exchange) === "binance" ? "Binance" : "Bybit";
}

function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatNumber(value, digits = 8) {
  const numeric = toNumber(value);
  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

function formatSignedPercent(value) {
  const numeric = toNumber(value);
  const sign = numeric >= 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatTimestamp(value) {
  const date = new Date(value || Date.now());
  return date.toLocaleString();
}

function getExecutionStatus(execution) {
  return String(execution?.status || "").trim().toUpperCase();
}

function getExecutionQuantity(execution) {
  const executedQty = toNumber(execution?.executedQty);
  if (executedQty > 0) {
    return executedQty;
  }
  return toNumber(execution?.origQty);
}

function getExecutionPrice(execution) {
  const directPrice = toNumber(execution?.price || execution?.rawPrice);
  if (directPrice > 0) {
    return directPrice;
  }

  const qty = getExecutionQuantity(execution);
  const notional = toNumber(execution?.cummulativeQuoteQty);
  if (qty > 0 && notional > 0) {
    return notional / qty;
  }

  return 0;
}

function getMirroredCount(trade) {
  return (trade?.mirroredExecutions || []).filter((item) => item?.status !== "SKIPPED").length;
}

function getExitOrderMap(trade) {
  return new Map((trade?.exitOrders || []).map((exitOrder) => [exitOrder.id, exitOrder]));
}

function calculateProfitPercent(trade, exitOrder) {
  const entryPrice = getExecutionPrice(trade?.adminExecution) || toNumber(trade?.price);
  const exitPrice = getExecutionPrice(exitOrder?.adminExecution) || toNumber(exitOrder?.price);
  if (!entryPrice || !exitPrice) {
    return null;
  }

  if (String(trade?.side || "").trim().toUpperCase() === "SELL") {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  return ((exitPrice - entryPrice) / entryPrice) * 100;
}

function getNigeriaDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getFilledTradeExitSummary(trade) {
  const entryQuantity = getExecutionQuantity(trade?.adminExecution);
  const exits = (trade?.exitOrders || [])
    .map((exitOrder) => ({ exitOrder, execution: exitOrder?.adminExecution }))
    .filter(({ execution }) => ["FILLED", "PARTIALLY_FILLED"].includes(getExecutionStatus(execution)))
    .map((item) => ({ ...item, quantity: getExecutionQuantity(item.execution), price: getExecutionPrice(item.execution) }))
    .filter((item) => item.quantity > 0 && item.price > 0);
  const exitedQuantity = exits.reduce((sum, item) => sum + item.quantity, 0);
  if (!(entryQuantity > 0) || exitedQuantity + 1e-8 < entryQuantity || !exits.length) return null;
  const entryPrice = getExecutionPrice(trade?.adminExecution) || toNumber(trade?.price);
  if (!(entryPrice > 0)) return null;
  const exitPrice = exits.reduce((sum, item) => sum + (item.quantity * item.price), 0) / exitedQuantity;
  const timestamps = exits.map(({ execution, exitOrder }) => {
    const numeric = Number(execution?.transactTime || execution?.updateTime || execution?.time || 0);
    return numeric > 0 ? numeric : Date.parse(exitOrder?.closedAt || exitOrder?.updatedAt || exitOrder?.createdAt || "");
  }).filter(Number.isFinite);
  if (!timestamps.length) return null;
  const side = String(trade?.side || "BUY").trim().toUpperCase();
  const profitPercent = side === "SELL"
    ? ((entryPrice - exitPrice) / entryPrice) * 100
    : ((exitPrice - entryPrice) / entryPrice) * 100;
  return { closedAt: new Date(Math.max(...timestamps)).toISOString(), profitPercent };
}

function aggregateDailyTradeProfit(trades = [], { exchange = "bybit", at = new Date() } = {}) {
  const normalizedExchange = normalizeExchange(exchange);
  const date = getNigeriaDateKey(at);
  const records = [];
  const includedTradeIds = new Set();
  for (const trade of trades) {
    if (normalizeExchange(trade?.exchange) !== normalizedExchange) continue;
    const tradeId = String(trade?.id || "").trim();
    if (!tradeId || includedTradeIds.has(tradeId)) continue;
    const summary = getFilledTradeExitSummary(trade);
    if (!summary || getNigeriaDateKey(summary.closedAt) !== date) continue;
    includedTradeIds.add(tradeId);
    records.push({ tradeId, closedAt: summary.closedAt, profitPercent: summary.profitPercent });
  }
  return {
    date,
    exchange: normalizedExchange,
    tradesClosed: records.length,
    totalPercent: records.reduce((sum, record) => sum + record.profitPercent, 0),
    records,
  };
}

function buildExchangeHeader(exchange, suffix = "Trade") {
  return `📊 ${getExchangeLabel(exchange)} ${suffix}`;
}

function isShortSwingTrade(trade) {
  return String(trade?.strategyContext?.type || "").trim().toUpperCase() === "SHORT_SWING_SPOT";
}

function isQualityEmaTrade(trade) {
  return String(trade?.strategyContext?.type || "").trim().toUpperCase() === "QUALITY_EMA_SUPPORT_RESISTANCE";
}

function isManagedStrategyTrade(trade) {
  return isShortSwingTrade(trade) || isQualityEmaTrade(trade);
}

function isBuyEntryTrade(trade) {
  return String(trade?.side || "").trim().toUpperCase() === "BUY";
}

function getStrategyReason(trade, exitOrder = null) {
  return (
    String(exitOrder?.reason || "").trim()
    || String(trade?.strategyContext?.reason || "").trim()
    || String(trade?.strategyContext?.signalReason || "").trim()
    || "Trend Pullback Breakout"
  );
}

function buildShortSwingSignalDetectedMessage(signal) {
  return [
    "SIGNAL DETECTED",
    `Pair: ${signal.pair}`,
    `Entry: ${formatNumber(signal.entryPrice, 6)}`,
    `TP: ${formatNumber(signal.takeProfit, 6)}`,
    `SL: ${formatNumber(signal.stopLoss, 6)}`,
    `Reason: ${String(signal?.meta?.reason || "Trend Pullback Breakout")}`,
  ].join("\n");
}

function buildShortSwingExecutedMessage(trade) {
  const entry = getExecutionPrice(trade?.adminExecution) || toNumber(trade?.price);
  return [
    "BUY EXECUTED",
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(entry, 6)}`,
    `TP: ${formatNumber(trade.takeProfitTargetPrice, 6)}`,
    `SL: ${formatNumber(trade.stopLossTargetPrice, 6)}`,
    `Reason: ${getStrategyReason(trade)}`,
  ].join("\n");
}

function buildShortSwingTakeProfitMessage(trade, exitOrder) {
  const entry = getExecutionPrice(trade?.adminExecution) || toNumber(trade?.price);
  const exit = getExecutionPrice(exitOrder?.adminExecution) || toNumber(exitOrder?.price);
  return [
    "TP HIT",
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(entry, 6)}`,
    `TP: ${formatNumber(exit || trade.takeProfitTargetPrice, 6)}`,
    `SL: ${formatNumber(trade.stopLossTargetPrice, 6)}`,
    `Reason: ${getStrategyReason(trade, exitOrder)}`,
  ].join("\n");
}

function buildShortSwingStopMessage(trade, exitOrder) {
  const entry = getExecutionPrice(trade?.adminExecution) || toNumber(trade?.price);
  const exit = getExecutionPrice(exitOrder?.adminExecution) || toNumber(exitOrder?.price);
  return [
    "SL HIT",
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(entry, 6)}`,
    `TP: ${formatNumber(trade.takeProfitTargetPrice, 6)}`,
    `SL: ${formatNumber(exit || trade.stopLossTargetPrice, 6)}`,
    `Reason: ${getStrategyReason(trade, exitOrder)}`,
  ].join("\n");
}

function buildOrderPlacedMessage({ exchange, trade, exitOrder = null }) {
  const execution = exitOrder?.adminExecution || trade?.adminExecution;
  const eventLabel = exitOrder
    ? exitOrder.kind === "TAKE_PROFIT"
      ? "📝 Take Profit Order Placed"
      : "📝 Exit Order Placed"
    : "📝 Order Placed";

  return [
    buildExchangeHeader(exchange, "Trade"),
    "",
    eventLabel,
    `Pair: ${trade.symbol}`,
    `Side: ${exitOrder?.side || trade.side}`,
    `Type: ${exitOrder?.type || trade.type}`,
    `Entry: ${formatNumber(getExecutionPrice(trade.adminExecution) || trade.price, 6)}`,
    `Mirrored Users: ${getMirroredCount(trade)}`,
    execution?.orderId ? `Order ID: ${execution.orderId}` : null,
    `Time: ${formatTimestamp(execution?.transactTime || Date.now())}`,
  ].filter(Boolean).join("\n");
}

function buildOrderFilledMessage({ exchange, trade, exitOrder = null, profitPercent = null }) {
  const execution = exitOrder?.adminExecution || trade?.adminExecution;
  const isExit = !!exitOrder;
  const exitPrice = getExecutionPrice(execution) || toNumber(exitOrder?.price);

  return [
    buildExchangeHeader(exchange, "Trade"),
    "",
    isExit ? "✅ Exit Order Filled" : "✅ Order Filled",
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(getExecutionPrice(trade.adminExecution) || trade.price, 6)}`,
    isExit ? `Exit: ${formatNumber(exitPrice, 6)}` : null,
    `Executed Qty: ${formatNumber(getExecutionQuantity(execution), 8)}`,
    profitPercent === null ? null : `Profit: ${formatSignedPercent(profitPercent)}`,
    `Time: ${formatTimestamp(execution?.transactTime || Date.now())}`,
  ].filter(Boolean).join("\n");
}

function buildTakeProfitHitMessage({ exchange, trade, exitOrder, profitPercent }) {
  const execution = exitOrder?.adminExecution || null;
  return [
    buildExchangeHeader(exchange, "Trade"),
    "",
    "🎯 Take Profit Hit",
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(getExecutionPrice(trade.adminExecution) || trade.price, 6)}`,
    `Exit: ${formatNumber(getExecutionPrice(execution) || exitOrder.price, 6)}`,
    profitPercent === null ? null : `Profit: ${formatSignedPercent(profitPercent)}`,
    `Time: ${formatTimestamp(execution?.transactTime || Date.now())}`,
  ].filter(Boolean).join("\n");
}

function buildPublicOpenTradeMessage({ exchange, trade }) {
  const entry = getExecutionPrice(trade?.adminExecution) || toNumber(trade?.price);
  return [
    "OPEN TRADE",
    `Exchange: ${getExchangeLabel(exchange)}`,
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(entry, 6)}`,
    trade.takeProfitTargetPrice ? `TP: ${formatNumber(trade.takeProfitTargetPrice, 6)}` : null,
    trade.stopLossTargetPrice ? `SL: ${formatNumber(trade.stopLossTargetPrice, 6)}` : null,
    "Status: Open",
  ].filter(Boolean).join("\n");
}

function buildPublicTakeProfitMessage({ exchange, trade, exitOrder, profitPercent }) {
  const execution = exitOrder?.adminExecution || null;
  return [
    "TAKE PROFIT HIT",
    `Exchange: ${getExchangeLabel(exchange)}`,
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(getExecutionPrice(trade.adminExecution) || trade.price, 6)}`,
    `Exit: ${formatNumber(getExecutionPrice(execution) || exitOrder.price, 6)}`,
    profitPercent === null ? null : `Profit: ${formatSignedPercent(profitPercent)}`,
  ].filter(Boolean).join("\n");
}

function buildPublicTradeClosedMessage({ exchange, trade, exitOrder, profitPercent }) {
  const execution = exitOrder?.adminExecution || null;
  return [
    "TRADE CLOSED",
    `Exchange: ${getExchangeLabel(exchange)}`,
    `Pair: ${trade.symbol}`,
    `Entry: ${formatNumber(getExecutionPrice(trade.adminExecution) || trade.price, 6)}`,
    `Exit: ${formatNumber(getExecutionPrice(execution) || exitOrder.price, 6)}`,
    profitPercent === null ? null : `P&L: ${formatSignedPercent(profitPercent)}`,
    exitOrder?.kind === "MANUAL_SELL" ? "Status: Closed before TP" : null,
  ].filter(Boolean).join("\n");
}

function buildTargetMessage(exchange) {
  return [
    `📊 ${getExchangeLabel(exchange)} Update`,
    "",
    `🎯 Daily Profit Target Reached: ${DAILY_PROFIT_TARGET_PERCENT}%`,
    "",
    "Congratulations 🎉",
    `You have hit the daily target of ${DAILY_PROFIT_TARGET_PERCENT}% today.`,
  ].join("\n");
}

function buildDailyTargetMessage(exchange, totalPercent = DAILY_PROFIT_TARGET_PERCENT, report = {}) {
  return [
    "🎉 Daily Target Hit",
    `${getExchangeLabel(exchange)} Profit Update`,
    "",
    `✅ Daily ${DAILY_PROFIT_TARGET_PERCENT}% target accomplished today`,
    report.date ? `Date: ${report.date} (Africa/Lagos)` : null,
    Number.isFinite(Number(report.tradesClosed)) ? `Trades closed today: ${report.tradesClosed}` : null,
    "",
    "Total profit today",
    formatSignedPercent(totalPercent),
  ].filter(Boolean).join("\n");
}

function buildDailyAdditionalProfitMessage(exchange, additionalPercent, totalPercent, report = {}) {
  return [
    "🎉 Profit Update",
    `${getExchangeLabel(exchange)} Daily Progress`,
    "",
    `Congratulations! You have ${formatSignedPercent(additionalPercent)} profit in addition to the daily ${DAILY_PROFIT_TARGET_PERCENT}% accomplished today.`,
    report.date ? `Date: ${report.date} (Africa/Lagos)` : null,
    Number.isFinite(Number(report.tradesClosed)) ? `Trades closed today: ${report.tradesClosed}` : null,
    "",
    "Total profit today",
    formatSignedPercent(totalPercent),
  ].filter(Boolean).join("\n");
}

class TradeListener {
  constructor({ telegramService, subscriberModel, logger = console, channelSender = null, tradeUrlBuilder = null, dailyProfitProvider = null } = {}) {
    this.telegramService = telegramService;
    this.subscriberModel = subscriberModel;
    this.logger = logger;
    this.channelSender = typeof channelSender === "function" ? channelSender : null;
    this.tradeUrlBuilder = typeof tradeUrlBuilder === "function" ? tradeUrlBuilder : null;
    this.dailyProfitProvider = typeof dailyProfitProvider === "function" ? dailyProfitProvider : null;
    this.broadcaster = createBroadcaster({
      telegramService,
      subscriberModel,
      logger,
    });
    this.processedOrderExecutionKeys = new Map();
    this.started = false;
  }

  async start() {
    if (this.telegramService?.start) {
      await this.telegramService.start();
      if (this.telegramService?.getDiagnostics) {
        this.logger.log(`Telegram trade bot diagnostics: ${JSON.stringify(this.telegramService.getDiagnostics())}`);
      }
    }

    if (this.started) {
      return this;
    }

    this.started = true;
    return this;
  }

  stop() {
    this.started = false;
  }

  async broadcast(message, type, options = {}) {
    const result = await this.broadcaster.broadcast(message, type, options);
    const exchangeLabel = options.exchange ? getExchangeLabel(options.exchange) : String(type || "trade");

    if (result.disabled) {
      this.logger.warn(`Telegram broadcast skipped for ${exchangeLabel}: bot or subscriber store is disabled.`);
    } else if (!result.sent && !result.failed) {
      this.logger.warn(`Telegram broadcast had no active recipients for ${exchangeLabel}.`);
    } else {
      this.logger.log(
        `Telegram broadcast for ${exchangeLabel}: sent ${result.sent}, skipped ${result.skipped}, failed ${result.failed}.`
      );
    }

    return result;
  }

  async sendChannel(message, options = {}) {
    if (!this.channelSender) {
      return { sent: 0, skipped: 1, disabled: true };
    }

    const result = await this.channelSender(message, options).catch((error) => {
      this.logger.warn("Telegram channel alert skipped:", error.message || error);
      return { sent: 0, failed: 1, disabled: false };
    });
    if (result?.failed) {
      this.logger.error("Telegram channel delivery failed:", result.channelError || "Channel sender reported a failed delivery.");
    }
    return result;
  }

  buildTradeKeyboard(trade) {
    const url = this.tradeUrlBuilder ? this.tradeUrlBuilder(trade) : "";
    if (!url) {
      return null;
    }
    return {
      inline_keyboard: [[
        {
          text: "View trade",
          url,
        },
      ]],
    };
  }

  buildTradeTelegramOptions(trade) {
    const replyMarkup = this.buildTradeKeyboard(trade);
    return replyMarkup ? { reply_markup: replyMarkup } : {};
  }

  async handleStrategySignalDetected(signal, exchange = "bybit") {
    if (!signal?.pair) {
      return;
    }

    await this.broadcast(buildShortSwingSignalDetectedMessage(signal), normalizeExchange(exchange), {
      exchange: normalizeExchange(exchange),
    });
  }

  async handleTradeCreated(trade) {
    if (!trade?.symbol) {
      return;
    }

    const exchange = normalizeExchange(trade.exchange);
    if (isManagedStrategyTrade(trade)) {
      return;
    }

    await this.broadcast(buildOrderPlacedMessage({ exchange, trade }), exchange, { exchange });
  }

  async handleExitOrderCreated(trade, exitOrder) {
    if (!trade?.symbol || !exitOrder?.id) {
      return;
    }

    const exchange = normalizeExchange(trade.exchange || exitOrder.exchange);
    if (getExecutionStatus(exitOrder.adminExecution) !== "ERROR") {
      await this.broadcast(buildOrderPlacedMessage({ exchange, trade, exitOrder }), exchange, { exchange });
    }

    if (getExecutionStatus(exitOrder.adminExecution) === "FILLED") {
      await this.handleFilledExit(trade, exitOrder, exchange);
    }
  }

  async handleTradeUpdated(previousTrade, nextTrade) {
    if (!nextTrade?.symbol) {
      return;
    }

    const exchange = normalizeExchange(nextTrade.exchange);
    const previousExitOrders = getExitOrderMap(previousTrade);
    for (const exitOrder of nextTrade.exitOrders || []) {
      const previousExitOrder = previousExitOrders.get(exitOrder.id);
      const previousStatus = getExecutionStatus(previousExitOrder?.adminExecution);
      const nextStatus = getExecutionStatus(exitOrder.adminExecution);
      if (previousStatus !== "FILLED" && nextStatus === "FILLED") {
        await this.handleFilledExit(nextTrade, exitOrder, exchange);
      }
    }
  }

  async handleFilledExit(trade, exitOrder, exchange) {
    const profitPercent = calculateProfitPercent(trade, exitOrder);

    if (isManagedStrategyTrade(trade)) {
      if (exitOrder.kind === "TAKE_PROFIT") {
        await this.broadcast(buildShortSwingTakeProfitMessage(trade, exitOrder), exchange, { exchange });
        await this.sendChannel(buildPublicTakeProfitMessage({ exchange, trade, exitOrder, profitPercent }), {
          type: "TAKE_PROFIT",
          exchange,
          trade,
          telegramOptions: this.buildTradeTelegramOptions(trade),
        });
      } else if (exitOrder.kind === "STOP_LOSS" || exitOrder.kind === "BREAKEVEN_STOP") {
        await this.broadcast(buildShortSwingStopMessage(trade, exitOrder), exchange, { exchange });
      } else {
        await this.broadcast(buildOrderFilledMessage({ exchange, trade, exitOrder, profitPercent }), exchange, { exchange });
        if (exitOrder.kind === "MANUAL_SELL") {
          await this.sendChannel(buildPublicTradeClosedMessage({ exchange, trade, exitOrder, profitPercent }), {
            type: "TRADE_CLOSED",
            exchange,
            trade,
            telegramOptions: this.buildTradeTelegramOptions(trade),
          });
        }
      }
      await this.updateDailyProfit(exchange, profitPercent, { trade, exitOrder });
      return;
    }

    if (exitOrder.kind === "TAKE_PROFIT") {
      await this.broadcast(
        buildTakeProfitHitMessage({ exchange, trade, exitOrder, profitPercent }),
        exchange,
        { exchange }
      );
      await this.sendChannel(buildPublicTakeProfitMessage({ exchange, trade, exitOrder, profitPercent }), {
        type: "TAKE_PROFIT",
        exchange,
        trade,
        telegramOptions: this.buildTradeTelegramOptions(trade),
      });
    } else {
      await this.broadcast(
        buildOrderFilledMessage({ exchange, trade, exitOrder, profitPercent }),
        exchange,
        { exchange }
      );
      if (exitOrder.kind === "MANUAL_SELL") {
        await this.sendChannel(buildPublicTradeClosedMessage({ exchange, trade, exitOrder, profitPercent }), {
          type: "TRADE_CLOSED",
          exchange,
          trade,
          telegramOptions: this.buildTradeTelegramOptions(trade),
        });
      }
    }

    await this.updateDailyProfit(exchange, profitPercent, { trade, exitOrder });
  }

  async handleRecoveredSettlement(trade) {
    const exitOrder = [...(trade?.exitOrders || [])].reverse().find(
      (item) => getExecutionStatus(item?.adminExecution) === "FILLED"
    );
    if (!trade?.symbol || !exitOrder) {
      return { sent: 0, skipped: 1, reason: "missing_filled_exit" };
    }

    const exchange = normalizeExchange(trade.exchange || exitOrder.exchange);
    const profitPercent = calculateProfitPercent(trade, exitOrder);
    const isTakeProfit = exitOrder.kind === "TAKE_PROFIT";
    const subscriberMessage = isTakeProfit
      ? buildTakeProfitHitMessage({ exchange, trade, exitOrder, profitPercent })
      : buildOrderFilledMessage({ exchange, trade, exitOrder, profitPercent });
    const channelMessage = isTakeProfit
      ? buildPublicTakeProfitMessage({ exchange, trade, exitOrder, profitPercent })
      : buildPublicTradeClosedMessage({ exchange, trade, exitOrder, profitPercent });

    await this.broadcast(subscriberMessage, exchange, { exchange });
    return this.sendChannel(channelMessage, {
      type: isTakeProfit ? "TAKE_PROFIT" : "TRADE_CLOSED",
      exchange,
      trade,
      telegramOptions: this.buildTradeTelegramOptions(trade),
    });
  }

  async handleOrderExecuted(orderEvent = {}) {
    const trade = orderEvent.trade || null;
    if (!trade?.symbol) {
      return { ok: false, skipped: true, reason: "missing_trade" };
    }

    const execution = orderEvent.execution || trade.adminExecution || null;
    const eventKey = String(
      orderEvent.eventKey
      || `${trade.id}:${execution?.orderId || execution?.clientOrderId || execution?.transactTime || "entry"}`
    ).trim();
    if (!eventKey) {
      return { ok: false, skipped: true, reason: "missing_event_key" };
    }

    const now = Date.now();
    for (const [key, value] of this.processedOrderExecutionKeys.entries()) {
      if (now - value > 24 * 60 * 60 * 1000) {
        this.processedOrderExecutionKeys.delete(key);
      }
    }
    if (this.processedOrderExecutionKeys.has(eventKey)) {
      return { ok: true, skipped: true, reason: "duplicate_order_execution" };
    }
    this.processedOrderExecutionKeys.set(eventKey, now);

    const exchange = normalizeExchange(orderEvent.exchange || trade.exchange);
    if (isManagedStrategyTrade(trade)) {
      await this.broadcast(buildShortSwingExecutedMessage(trade), exchange, { exchange });
      if (isBuyEntryTrade(trade)) {
        await this.sendChannel(buildPublicOpenTradeMessage({ exchange, trade }), {
          type: "OPEN_TRADE",
          exchange,
          trade,
          telegramOptions: this.buildTradeTelegramOptions(trade),
        });
      }
      return { ok: true, managed: true };
    }

    await this.broadcast(buildOrderFilledMessage({ exchange, trade }), exchange, { exchange });
    if (isBuyEntryTrade(trade)) {
      await this.sendChannel(buildPublicOpenTradeMessage({ exchange, trade }), {
        type: "OPEN_TRADE",
        exchange,
        trade,
        telegramOptions: this.buildTradeTelegramOptions(trade),
      });
    }
    return { ok: true, managed: false };
  }

  async updateDailyProfit(exchange, profitPercent, context = {}) {
    const normalizedExchange = normalizeExchange(exchange);
    const numericProfit = toNumber(profitPercent);
    if (!Number.isFinite(numericProfit) || numericProfit === 0) {
      return;
    }

    if (!this.dailyProfitProvider) return;
    const report = await this.dailyProfitProvider({ exchange: normalizedExchange, ...context });
    const dailyProfit = toNumber(report?.totalPercent);
    const currentRecord = (report?.records || []).find((record) => record.tradeId === String(context.trade?.id || ""));
    if (!currentRecord) return;
    const previousProfit = dailyProfit - toNumber(currentRecord?.profitPercent ?? numericProfit);
    if (dailyProfit >= DAILY_PROFIT_TARGET_PERCENT && previousProfit < DAILY_PROFIT_TARGET_PERCENT) {
      const message = buildDailyTargetMessage(normalizedExchange, dailyProfit, report);
      await this.broadcast(message, "dailyProfit", {
        exchange: normalizedExchange,
      });
      await this.sendChannel(message, {
        type: "DAILY_TARGET",
        exchange: normalizedExchange,
      });
      return;
    }

    if (dailyProfit >= DAILY_PROFIT_TARGET_PERCENT && previousProfit >= DAILY_PROFIT_TARGET_PERCENT && numericProfit > 0) {
      const message = buildDailyAdditionalProfitMessage(normalizedExchange, numericProfit, dailyProfit, report);
      await this.broadcast(message, "dailyProfit", {
        exchange: normalizedExchange,
      });
      await this.sendChannel(message, {
        type: "DAILY_EXTRA_PROFIT",
        exchange: normalizedExchange,
      });
    }
  }
}

module.exports = {
  TradeListener,
  aggregateDailyTradeProfit,
  calculateProfitPercent,
  getNigeriaDateKey,
};
