const EventEmitter = require("node:events");
const crypto = require("node:crypto");

const { SIGNAL_EVENTS } = require("../events/signalBus");

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value, fallback = NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeConfidence(value) {
  const numeric = toFiniteNumber(value, NaN);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return NaN;
  }
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(100, Number(percent.toFixed(2)));
}

function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }

  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

function sortSignals(signals = []) {
  return [...signals].sort((left, right) => {
    const rightTime = Number(right?.timestamp || Date.parse(right?.createdAt || "") || 0);
    const leftTime = Number(left?.timestamp || Date.parse(left?.createdAt || "") || 0);
    return rightTime - leftTime;
  });
}

class SignalEngine extends EventEmitter {
  constructor({
    config,
    signalModel,
    eventBus,
    telegramService,
    autoTradeService,
    marketDataService,
    logger = console,
  } = {}) {
    super();
    this.config = config;
    this.signalModel = signalModel;
    this.eventBus = eventBus;
    this.telegramService = telegramService;
    this.autoTradeService = autoTradeService;
    this.marketDataService = marketDataService;
    this.logger = logger;
    this.timeframe = config.defaultTimeframe;
    this.started = false;
    this.status = {
      ok: false,
      message: "Signal receiver is idle.",
      updatedAt: new Date().toISOString(),
    };
    this.allSignals = [];
    this.snapshot = {
      timeframe: this.timeframe,
      supportedTimeframes: config.supportedTimeframes,
      pairs: config.symbols,
      signals: [],
      generatedAt: new Date().toISOString(),
      streamStatus: "IDLE",
      statusMessage: this.status.message,
    };
  }

  normalizeTimeframe(timeframe) {
    const normalized = String(timeframe || "").trim();
    return this.config.supportedTimeframes.includes(normalized) ? normalized : this.config.defaultTimeframe;
  }

  setStatus(ok, message) {
    this.status = {
      ok,
      message: String(message || "").trim() || (ok ? "Signal receiver is ready." : "Signal receiver is idle."),
      updatedAt: new Date().toISOString(),
    };
    this.emit("status", this.status);
    this.eventBus.emit(SIGNAL_EVENTS.STATUS_UPDATED, this.status);
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      timeframe: this.timeframe,
      generatedAt: new Date().toISOString(),
      streamStatus: this.started ? "LIVE" : "IDLE",
      statusMessage: this.status.message,
    };
  }

  getTimeframe() {
    return this.timeframe;
  }

  getStoredSignals() {
    return [...this.allSignals];
  }

  async init() {
    await this.signalModel.init();
    await this.telegramService.init();
    await this.refreshSnapshot();
    return this;
  }

  async start() {
    if (this.started) {
      return this;
    }

    await this.init();
    this.started = true;
    this.setStatus(true, `Signal receiver is ready on ${this.timeframe}.`);
    await this.refreshSnapshot();
    return this;
  }

  stop() {
    this.started = false;
    this.setStatus(false, "Signal receiver stopped.");
  }

  async setTimeframe(timeframe) {
    this.timeframe = this.normalizeTimeframe(timeframe);
    await this.refreshSnapshot();
    this.setStatus(true, `Signal dashboard filter set to ${this.timeframe}.`);
    return this.getSnapshot();
  }

  async refreshSnapshot() {
    this.allSignals = sortSignals(await this.signalModel.listActive());
    const filteredSignals = this.allSignals.filter((signal) => signal.timeframe === this.timeframe);
    const pairs = [...new Set(this.allSignals.map((signal) => String(signal.symbol || signal.pair || "").trim()).filter(Boolean))];

    this.snapshot = {
      timeframe: this.timeframe,
      supportedTimeframes: this.config.supportedTimeframes,
      pairs: pairs.length ? pairs : this.config.symbols,
      signals: filteredSignals,
      generatedAt: new Date().toISOString(),
      streamStatus: this.started ? "LIVE" : "IDLE",
      statusMessage: this.status.message,
    };

    this.emit("snapshot", this.snapshot);
    this.eventBus.emit(SIGNAL_EVENTS.SNAPSHOT_UPDATED, this.snapshot);
    return this.snapshot;
  }

  buildSignalRecord(payload = {}) {
    const symbol = String(payload.symbol || payload.pair || "").trim().toUpperCase();
    const type = String(payload.type || "BUY").trim().toUpperCase();
    const strategy = String(payload.strategy || payload.strategyType || "").trim().toUpperCase();
    const timeframe = this.normalizeTimeframe(payload.timeframe);
    const timestamp = normalizeTimestamp(payload.createdAt);
    const confidence = normalizeConfidence(payload.confidence);
    const entry = toFiniteNumber(payload.entry ?? payload.entryPrice, NaN);
    const stopLoss = toFiniteNumber(payload.stopLoss, NaN);
    const takeProfit = toFiniteNumber(payload.takeProfit, NaN);

    if (!symbol) {
      throw new Error("Signal symbol is required.");
    }
    if (type !== "BUY") {
      throw new Error("Only BUY signals are supported.");
    }
    if (!strategy) {
      throw new Error("Signal strategy is required.");
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error("Signal createdAt must be a valid ISO timestamp.");
    }
    if (!Number.isFinite(confidence)) {
      throw new Error("Signal confidence must be a valid number.");
    }
    if (!Number.isFinite(entry) || entry <= 0) {
      throw new Error("Signal entry must be a positive number.");
    }
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
      throw new Error("Signal stopLoss must be a positive number.");
    }
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
      throw new Error("Signal takeProfit must be a positive number.");
    }

    const createdAt = new Date(timestamp).toISOString();
    const signalKey = String(payload.signalKey || `${symbol}:${timeframe}:${strategy}:${timestamp}`).trim();
    const expiresAtTimestamp = normalizeTimestamp(payload.expiresAt);
    const expiresAt = Number.isFinite(expiresAtTimestamp)
      ? new Date(expiresAtTimestamp).toISOString()
      : new Date(timestamp + Number(this.config.signalTtlMs || 0)).toISOString();

    const incomingMeta = payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? cloneValue(payload.meta)
      : {};

    if (payload.reason && incomingMeta.reason === undefined) {
      incomingMeta.reason = String(payload.reason);
    }
    if (payload.details && incomingMeta.details === undefined) {
      incomingMeta.details = cloneValue(payload.details);
    }
    if (payload.supportLevel !== undefined && incomingMeta.supportLevel === undefined) {
      incomingMeta.supportLevel = toFiniteNumber(payload.supportLevel, null);
    }
    if (payload.resistanceLevel !== undefined && incomingMeta.resistanceLevel === undefined) {
      incomingMeta.resistanceLevel = toFiniteNumber(payload.resistanceLevel, null);
    }

    return {
      id: crypto.createHash("sha1").update(signalKey).digest("hex"),
      signalKey,
      symbol,
      pair: symbol,
      type,
      strategy,
      strategyType: strategy,
      confidence,
      entry: Number(entry.toFixed(6)),
      entryPrice: Number(entry.toFixed(6)),
      stopLoss: Number(stopLoss.toFixed(6)),
      takeProfit: Number(takeProfit.toFixed(6)),
      timeframe,
      createdAt,
      timestamp,
      expiresAt,
      meta: incomingMeta,
    };
  }

  async receiveSignal(payload = {}) {
    const signal = this.buildSignalRecord(payload);
    const existingSignal = await this.signalModel.getById(signal.id);

    await this.signalModel.upsert(signal);

    if (existingSignal) {
      await this.refreshSnapshot();
      this.setStatus(true, `Signal updated for ${signal.symbol} ${signal.timeframe}.`);
      return {
        created: false,
        signal,
      };
    }

    this.logger.info(`Signal received for ${signal.symbol} ${signal.timeframe} ${signal.strategy} at confidence ${signal.confidence}.`);
    this.emit("signal", signal);
    this.eventBus.emit(SIGNAL_EVENTS.SIGNAL_GENERATED, signal);
    this.setStatus(true, `Signal received for ${signal.symbol} ${signal.timeframe}.`);
    void this.telegramService.dispatchSignal(signal).catch((error) => {
      this.logger.error(`Telegram dispatch failed for ${signal.symbol}:`, error.message || error);
    });
    await this.refreshSnapshot();

    if (signal.meta?.testOnly) {
      this.logger.info(`Auto trade intentionally skipped for test signal ${signal.symbol} ${signal.strategy}.`);
    } else if (this.autoTradeService) {
      void this.autoTradeService.execute(signal).catch((error) => {
        this.logger.error(`Auto trade failed for ${signal.symbol}:`, error.message || error);
      });
    }

    return {
      created: true,
      signal,
    };
  }

  async expireSignals(now = Date.now()) {
    const expiredSignals = await this.signalModel.pruneExpired(now);
    if (expiredSignals.length) {
      await this.refreshSnapshot();
    }
    return expiredSignals;
  }

  async hydrateSignals(signals = []) {
    const items = Array.isArray(signals) ? signals : [];
    for (const signal of items) {
      try {
        await this.signalModel.upsert(this.buildSignalRecord(signal));
      } catch (error) {
        this.logger.warn("Skipping invalid hydrated signal:", error.message || error);
      }
    }
    await this.refreshSnapshot();
    return this.getStoredSignals();
  }

  async deleteSignals(signalIds = []) {
    const result = await this.signalModel.deleteMany(signalIds);
    await this.refreshSnapshot();
    return result;
  }

  async getChartSnapshot(symbol, signalId = "") {
    const activeSignal = signalId ? await this.signalModel.getById(signalId) : null;
    const targetSymbol = String(symbol || activeSignal?.symbol || "").trim().toUpperCase();
    if (!targetSymbol) {
      return null;
    }

    const timeframe = this.normalizeTimeframe(activeSignal?.timeframe || this.timeframe);
    return this.marketDataService.buildChart(targetSymbol, timeframe, activeSignal);
  }
}

module.exports = {
  SignalEngine,
};
