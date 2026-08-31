const cron = require("node-cron");

const { createBroadcaster } = require("../utils/broadcast");

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

function buildTargetMessage(exchange) {
  if (normalizeExchange(exchange) === "bybit") {
    return [
      "📊 Bybit Update",
      "",
      "🎯 Daily Profit Target Reached: 2%",
      "",
      "For bybit mirrored user, wawooo! 💃",
      "You have hit the daily target of 2% today 🎉",
    ].join("\n");
  }

  return [
    "📊 Binance Update",
    "",
    "🎯 Daily Profit Target Reached: 2%",
  ].join("\n");
}

class TradeListener {
  constructor({ telegramService, subscriberModel, logger = console } = {}) {
    this.telegramService = telegramService;
    this.subscriberModel = subscriberModel;
    this.logger = logger;
    this.broadcaster = createBroadcaster({
      telegramService,
      subscriberModel,
      logger,
    });
    this.binanceDailyProfit = 0;
    this.bybitDailyProfit = 0;
    this.binanceTargetHit = false;
    this.bybitTargetHit = false;
    this.processedOrderExecutionKeys = new Map();
    this.resetTask = null;
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

    if (!this.resetTask) {
      this.resetTask = cron.schedule("0 0 * * *", () => {
        this.resetDailyState();
      });
    }

    this.started = true;
    return this;
  }

  stop() {
    if (this.resetTask) {
      this.resetTask.stop();
      this.resetTask = null;
    }
    this.started = false;
  }

  resetDailyState() {
    this.binanceDailyProfit = 0;
    this.bybitDailyProfit = 0;
    this.binanceTargetHit = false;
    this.bybitTargetHit = false;
    this.logger.log("Trade listener daily profit counters reset.");
  }

  getDailyProfit(exchange) {
    return normalizeExchange(exchange) === "binance" ? this.binanceDailyProfit : this.bybitDailyProfit;
  }

  hasTargetHit(exchange) {
    return normalizeExchange(exchange) === "binance" ? this.binanceTargetHit : this.bybitTargetHit;
  }

  markTargetHit(exchange) {
    if (normalizeExchange(exchange) === "binance") {
      this.binanceTargetHit = true;
      return;
    }
    this.bybitTargetHit = true;
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
      } else if (exitOrder.kind === "STOP_LOSS" || exitOrder.kind === "BREAKEVEN_STOP") {
        await this.broadcast(buildShortSwingStopMessage(trade, exitOrder), exchange, { exchange });
      } else {
        await this.broadcast(buildOrderFilledMessage({ exchange, trade, exitOrder, profitPercent }), exchange, { exchange });
      }
      await this.updateDailyProfit(exchange, profitPercent);
      return;
    }

    if (exitOrder.kind === "TAKE_PROFIT") {
      await this.broadcast(
        buildTakeProfitHitMessage({ exchange, trade, exitOrder, profitPercent }),
        exchange,
        { exchange }
      );
    } else {
      await this.broadcast(
        buildOrderFilledMessage({ exchange, trade, exitOrder, profitPercent }),
        exchange,
        { exchange }
      );
    }

    await this.updateDailyProfit(exchange, profitPercent);
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
      return { ok: true, managed: true };
    }

    await this.broadcast(buildOrderFilledMessage({ exchange, trade }), exchange, { exchange });
    return { ok: true, managed: false };
  }

  async updateDailyProfit(exchange, profitPercent) {
    const normalizedExchange = normalizeExchange(exchange);
    const numericProfit = toNumber(profitPercent);
    if (!Number.isFinite(numericProfit) || numericProfit === 0) {
      return;
    }

    if (normalizedExchange === "binance") {
      this.binanceDailyProfit += numericProfit;
    } else {
      this.bybitDailyProfit += numericProfit;
    }

    if (this.getDailyProfit(normalizedExchange) >= 2 && !this.hasTargetHit(normalizedExchange)) {
      this.markTargetHit(normalizedExchange);
      await this.broadcast(buildTargetMessage(normalizedExchange), "dailyProfit", {
        exchange: normalizedExchange,
      });
    }
  }
}

module.exports = {
  TradeListener,
  calculateProfitPercent,
};
