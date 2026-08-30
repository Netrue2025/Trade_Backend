const { Server } = require("socket.io");

const { SIGNAL_EVENTS } = require("../events/signalBus");

class SocketSignalService {
  constructor({ eventBus, logger = console } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.io = null;
    this.snapshotProvider = null;
  }

  attach(server, { authorize, snapshotProvider } = {}) {
    this.snapshotProvider = snapshotProvider || null;
    this.io = new Server(server, {
      path: "/socket.io",
      cors: {
        origin: true,
        credentials: true,
      },
    });

    if (typeof authorize === "function") {
      this.io.use((socket, next) => {
        try {
          const result = authorize(socket.request);
          if (!result) {
            next(new Error("Unauthorized"));
            return;
          }
          socket.data.user = result;
          next();
        } catch (error) {
          next(error);
        }
      });
    }

    this.io.of("/signals").on("connection", async (socket) => {
      this.logger.info(`Signal socket connected: ${socket.id}`);
      if (this.snapshotProvider) {
        socket.emit("signals:snapshot", await this.snapshotProvider());
      }
    });

    this.eventBus.on(SIGNAL_EVENTS.SIGNAL_GENERATED, (payload) => {
      this.broadcast("signals:new", payload);
    });
    this.eventBus.on(SIGNAL_EVENTS.SNAPSHOT_UPDATED, (payload) => {
      this.broadcast("signals:snapshot", payload);
    });
    this.eventBus.on(SIGNAL_EVENTS.STATUS_UPDATED, (payload) => {
      this.broadcast("signals:status", payload);
    });
  }

  broadcast(eventName, payload) {
    if (!this.io) {
      return;
    }
    this.io.of("/signals").emit(eventName, payload);
  }
}

module.exports = {
  SocketSignalService,
};
