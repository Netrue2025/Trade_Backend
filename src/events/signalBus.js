const EventEmitter = require("node:events");

const SIGNAL_EVENTS = {
  SIGNAL_GENERATED: "signalGenerated",
  TRADE_EXECUTED: "tradeExecuted",
  TRADE_CLOSED: "tradeClosed",
  SNAPSHOT_UPDATED: "snapshotUpdated",
  STATUS_UPDATED: "statusUpdated",
};

const signalBus = new EventEmitter();
signalBus.setMaxListeners(50);

module.exports = {
  SIGNAL_EVENTS,
  signalBus,
};
