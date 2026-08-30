const EventEmitter = require("node:events");

const orderEvents = new EventEmitter();
orderEvents.setMaxListeners(25);

function emitOrderExecuted(orderData = {}, logger = console) {
  try {
    orderEvents.emit("orderExecuted", {
      ...orderData,
      emittedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Order event emission failed:", error.message || error);
  }
}

module.exports = {
  emitOrderExecuted,
  orderEvents,
};
