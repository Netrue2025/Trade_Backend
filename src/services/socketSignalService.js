const { Server } = require("socket.io");

const { SIGNAL_EVENTS } = require("../events/signalBus");

class SocketSignalService {
  constructor({ eventBus, logger = console } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.io = null;
    this.namespace = null;
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

    this.namespace = this.io.of("/signals");
    if (typeof authorize === "function") {
      this.namespace.use((socket, next) => {
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

    this.namespace.on("connection", async (socket) => {
      const user = socket.data.user;
      socket.join(`user:${user.id}`);
      if (user.role === "admin") socket.join("role:admin");
      this.logger.info(`Signal socket connected: ${socket.id}`);
    });

    this.eventBus.on(SIGNAL_EVENTS.SIGNAL_GENERATED, (payload) => {
      this.broadcast("signals:new", payload);
    });
    this.eventBus.on(SIGNAL_EVENTS.STATUS_UPDATED, (payload) => {
      this.broadcast("signals:status", payload);
    });
  }

  broadcast(eventName, payload) {
    if (!this.namespace) {
      return;
    }
    this.namespace.emit(eventName, payload);
  }

  emitToUser(userId, eventName, payload) {
    if (!this.namespace || !userId) return;
    this.namespace.to(`user:${userId}`).emit(eventName, payload);
  }

  emitToAdmins(eventName, payload) {
    if (!this.namespace) return;
    this.namespace.to("role:admin").emit(eventName, payload);
  }
}

module.exports = {
  SocketSignalService,
};
