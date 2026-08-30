const { SIGNAL_EVENTS } = require("../events/signalBus");

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeConfig(config = {}) {
  return {
    enabled: !!config.enabled,
    firstTradeBalancePercent: clamp(
      toFiniteNumber(config.firstTradeBalancePercent ?? config.balancePercent, 50),
      1,
      100
    ),
    secondTradeBalancePercent: clamp(
      toFiniteNumber(config.secondTradeBalancePercent, 100),
      1,
      100
    ),
    maxSimultaneousTrades: clamp(
      Math.round(toFiniteNumber(config.maxSimultaneousTrades ?? config.maxTradesPerPair, 2)),
      1,
      10
    ),
  };
}

class AutoTradeService {
  constructor({ eventBus, logger = console, config } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.config = normalizeConfig(config);
    this.executor = null;
    this.executionQueue = Promise.resolve();
  }

  setExecutor(executor) {
    this.executor = typeof executor === "function" ? executor : null;
  }

  getConfig() {
    return { ...this.config };
  }

  updateConfig(nextConfig = {}) {
    this.config = normalizeConfig({
      ...this.config,
      ...nextConfig,
    });
    return this.getConfig();
  }

  validate() {
    if (!this.config.enabled) {
      return { ok: false, reason: "auto_trade_disabled" };
    }

    if (!this.executor) {
      return { ok: false, reason: "executor_not_configured" };
    }

    return { ok: true };
  }

  async execute(signal, context = {}) {
    const run = async () => {
      const validation = this.validate();
      if (!validation.ok) {
        this.logger.info(`Auto trade skipped for ${signal.symbol}: ${validation.reason}`);
        return { ok: false, skipped: true, reason: validation.reason };
      }

      const result = await this.executor(signal, {
        ...context,
        config: this.getConfig(),
      });
      if (result?.skipped) {
        this.logger.info(`Auto trade skipped for ${signal.symbol}: ${result.reason || "unknown_reason"}`);
        return result;
      }

      if (this.eventBus?.emit) {
        this.eventBus.emit(SIGNAL_EVENTS.TRADE_EXECUTED, {
          signal,
          execution: result,
          executedAt: new Date().toISOString(),
        });
      }

      return { ok: true, result };
    };

    const queued = this.executionQueue.then(run, run);
    this.executionQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  markClosed() {
    // Active trade lifecycle is resolved by the server's persisted trade state.
  }
}

module.exports = {
  AutoTradeService,
};
