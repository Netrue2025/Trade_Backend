const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing, mergeMongoSnapshots, shouldUseMongo } = require("../lib/db");
const { TradeLearningService } = require("../services/tradeLearning");

const mongoEnvKeys = [
  "MONGODB_URI",
  "MONGO_URI",
  "MONGO_URL",
  "DATABASE_URL",
  "mongodb_URI",
  "mongodb_uri",
  "mongo_URI",
  "mongo_uri",
  "mongo_URL",
  "mongo_url",
  "database_URL",
  "database_url",
];

function withMongoEnv(envPatch, callback) {
  const previous = {};
  for (const key of mongoEnvKeys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, envPatch);
  try {
    return callback();
  } finally {
    for (const key of mongoEnvKeys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function withEnv(keys, envPatch, callback) {
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, envPatch);
  try {
    return callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

async function withEnvAsync(keys, envPatch, callback) {
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, envPatch);
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label = "condition") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createMemoryLogger() {
  const entries = [];
  return {
    entries,
    log(message) {
      entries.push({ level: "log", message: String(message) });
    },
    warn(message) {
      entries.push({ level: "warn", message: String(message) });
    },
  };
}

test("mongo detection accepts lowercase Railway URI alias", () => {
  withMongoEnv({
    mongo_URI: "mongodb+srv://trade_mvp:trade123@cluster0.x8eukch.mongodb.net/trade_mvp?appName=Cluster0",
  }, () => {
    assert.equal(shouldUseMongo(), true);
  });
});

test("mongo client options use production-safe default timeouts", () => {
  withEnv([
    "MONGODB_SERVER_SELECTION_TIMEOUT_MS",
    "MONGODB_CONNECT_TIMEOUT_MS",
    "MONGODB_SOCKET_TIMEOUT_MS",
  ], {}, () => {
    assert.deepEqual(__testing.getMongoClientOptions(), {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      maxPoolSize: 10,
    });
  });
});

test("mongo client options do not allow 1000ms production server selection", () => {
  withEnv([
    "MONGODB_SERVER_SELECTION_TIMEOUT_MS",
    "MONGODB_CONNECT_TIMEOUT_MS",
    "MONGODB_SOCKET_TIMEOUT_MS",
  ], {
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: "1000",
    MONGODB_CONNECT_TIMEOUT_MS: "1000",
    MONGODB_SOCKET_TIMEOUT_MS: "5000",
  }, () => {
    assert.deepEqual(__testing.getMongoClientOptions(), {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      maxPoolSize: 10,
    });
  });
});

test("app-state full snapshot read timeout is not shorter than Mongo server selection", () => {
  withEnv(["MONGODB_APP_STATE_READ_TIMEOUT_MS"], {}, () => {
    assert.equal(__testing.getAppStateReadTimeoutMs(), 20000);
  });
  withEnv(["MONGODB_APP_STATE_READ_TIMEOUT_MS"], {
    MONGODB_APP_STATE_READ_TIMEOUT_MS: "8000",
  }, () => {
    assert.equal(__testing.getAppStateReadTimeoutMs(), 10000);
  });
});

test("full snapshot read falls back to projected field reads on read failure", async () => {
  let callCount = 0;
  const collection = {
    async findOne(_filter, options = {}) {
      callCount += 1;
      if (!options.projection) {
        throw new Error("simulated slow full read");
      }
      const field = Object.keys(options.projection).find((key) => key !== "_id");
      return { _id: "trade-mvp-state", [field]: field === "users" ? [{ id: "user-1" }] : [] };
    },
  };

  const snapshot = await __testing.loadMongoSnapshot(collection);

  assert.equal(callCount > 1, true);
  assert.equal(snapshot._id, "trade-mvp-state");
  assert.deepEqual(snapshot.users, [{ id: "user-1" }]);
});

test("projected fallback preserves notifications and chatMessages", async () => {
  const collection = {
    async findOne(_filter, options = {}) {
      if (!options.projection) {
        throw new Error("simulated slow full read");
      }
      const field = Object.keys(options.projection).find((key) => key !== "_id");
      const values = {
        notifications: [{ id: "notification-1", userId: "admin", message: "Order ready" }],
        chatMessages: [{ id: "chat-1", conversationUserId: "user-1", message: "Hello" }],
      };
      return { _id: "trade-mvp-state", [field]: values[field] || [] };
    },
  };

  const snapshot = await __testing.loadMongoSnapshot(collection);

  assert.deepEqual(snapshot.notifications, [{ id: "notification-1", userId: "admin", message: "Order ready" }]);
  assert.deepEqual(snapshot.chatMessages, [{ id: "chat-1", conversationUserId: "user-1", message: "Hello" }]);
});

test("projected fallback default concurrency is safer for M0", () => {
  withEnv(["MONGODB_APP_STATE_PROJECTION_CONCURRENCY"], {}, () => {
    assert.equal(__testing.getAppStateProjectionConcurrency(), 2);
  });
});

test("one persist request produces exactly one app-state save", async () => {
  const saves = [];
  const controller = __testing.createAppStateSaveController({
    logger: createMemoryLogger(),
    isMongoEnabled: () => true,
    getCollection: async () => ({}),
    saveMongo: async (_collection, snapshot) => {
      saves.push(snapshot);
    },
    getSlowWarningMs: () => 1000,
  });

  await controller.requestSave({ wallets: [] });

  assert.equal(saves.length, 1);
});

test("rapid persist requests during active save coalesce into one latest-state save", async () => {
  const releaseFirst = deferred();
  const saves = [];
  const db = { wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "1000", updatedAt: "2026-09-13T10:00:00.000Z" }] };
  const logger = createMemoryLogger();
  const controller = __testing.createAppStateSaveController({
    logger,
    isMongoEnabled: () => true,
    getCollection: async () => ({}),
    saveMongo: async (_collection, snapshot) => {
      saves.push(JSON.parse(JSON.stringify(snapshot)));
      if (saves.length === 1) {
        await releaseFirst.promise;
      }
    },
    getSlowWarningMs: () => 1000,
  });

  const firstSave = controller.requestSave(db);
  await waitFor(() => saves.length === 1, "first save start");
  db.wallets[0] = { ...db.wallets[0], availableBalance: "2500", updatedAt: "2026-09-13T10:05:00.000Z" };
  const requests = Array.from({ length: 10 }, () => controller.requestSave(db));
  assert.equal(saves.length, 1);
  releaseFirst.resolve();
  await firstSave;
  await Promise.allSettled(requests);

  assert.equal(saves.length, 2);
  assert.equal(saves[0].wallets[0].availableBalance, "1000");
  assert.equal(saves[1].wallets[0].availableBalance, "2500");
  assert.equal(logger.entries.some((entry) => entry.message.includes("coalesced")), true);
});

test("transaction added during active save is included in subsequent snapshot", async () => {
  const releaseFirst = deferred();
  const saves = [];
  const db = { transactions: [] };
  const controller = __testing.createAppStateSaveController({
    logger: createMemoryLogger(),
    isMongoEnabled: () => true,
    getCollection: async () => ({}),
    saveMongo: async (_collection, snapshot) => {
      saves.push(JSON.parse(JSON.stringify(snapshot)));
      if (saves.length === 1) {
        await releaseFirst.promise;
      }
    },
    getSlowWarningMs: () => 1000,
  });

  const firstSave = controller.requestSave(db);
  await waitFor(() => saves.length === 1, "first save start");
  db.transactions.push({ id: "txn-1", amount: "-100", createdAt: "2026-09-13T10:01:00.000Z" });
  const secondRequest = controller.requestSave(db);
  releaseFirst.resolve();
  await firstSave;
  await secondRequest;

  assert.equal(saves.length, 2);
  assert.equal(saves[0].transactions.length, 0);
  assert.equal(saves[1].transactions.length, 1);
  assert.equal(saves[1].transactions[0].id, "txn-1");
});

test("slow save warning does not release the save lock before Mongo operation settles", async () => {
  const releaseFirst = deferred();
  const saves = [];
  const logger = createMemoryLogger();
  const controller = __testing.createAppStateSaveController({
    logger,
    isMongoEnabled: () => true,
    getCollection: async () => ({}),
    saveMongo: async (_collection, snapshot) => {
      saves.push(JSON.parse(JSON.stringify(snapshot)));
      if (saves.length === 1) {
        await releaseFirst.promise;
      }
    },
    getSlowWarningMs: () => 10,
  });

  const db = { wallets: [{ userId: "user-1", currency: "USDT", availableBalance: "1", updatedAt: "2026-09-13T10:00:00.000Z" }] };
  const firstSave = controller.requestSave(db);
  await waitFor(() => logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("slow app_state save")), "slow warning");
  db.wallets[0] = { ...db.wallets[0], availableBalance: "2", updatedAt: "2026-09-13T10:02:00.000Z" };
  const secondRequest = controller.requestSave(db);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(saves.length, 1);
  releaseFirst.resolve();
  await firstSave;
  await secondRequest;
  assert.equal(saves.length, 2);
  assert.equal(saves[1].wallets[0].availableBalance, "2");
});

test("save rejection is reported and subsequent saves can recover", async () => {
  let shouldFail = true;
  const saves = [];
  const logger = createMemoryLogger();
  const controller = __testing.createAppStateSaveController({
    logger,
    isMongoEnabled: () => true,
    getCollection: async () => ({}),
    saveMongo: async (_collection, snapshot) => {
      saves.push(snapshot);
      if (shouldFail) {
        throw new Error("simulated mongo failure");
      }
    },
    getSlowWarningMs: () => 1000,
  });

  await assert.rejects(() => controller.requestSave({ wallets: [] }), /simulated mongo failure/);
  shouldFail = false;
  await controller.requestSave({ wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "10" }] });

  assert.equal(saves.length, 2);
  assert.equal(logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("save failed")), true);
});

test("backup throttling remains functional", () => {
  withEnv([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, () => {
    __testing.resetBackupThrottle();
    assert.equal(__testing.shouldBackupMongoSnapshot(), true);
    assert.equal(__testing.shouldBackupMongoSnapshot(), false);
  });
});

test("trade learning remains disabled by default", async () => {
  await withEnvAsync(["MONGODB_URI", "TRADE_LEARNING_ENABLED"], {
    MONGODB_URI: "mongodb+srv://trade_mvp:trade123@cluster0.x8eukch.mongodb.net/trade_mvp?appName=Cluster0",
  }, async () => {
    const service = new TradeLearningService({ logger: createMemoryLogger() });
    assert.equal(service.isEnabled(), false);
    const result = await service.recordTrade({ id: "trade-1" });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "trade_learning_disabled");
  });
});

test("mongo snapshot merge preserves newer wallet balances from current state", () => {
  const staleSave = {
    users: [{ id: "user-1", email: "ada@example.com", role: "user", createdAt: "2026-09-11T08:00:00.000Z" }],
    wallets: [
      {
        id: "wallet-1",
        userId: "user-1",
        currency: "NGN",
        availableBalance: "10000",
        lockedBalance: "0",
        updatedAt: "2026-09-11T08:00:00.000Z",
      },
    ],
    transactions: [],
  };
  const currentMongo = {
    users: [{ id: "user-1", email: "ada@example.com", role: "user", createdAt: "2026-09-11T08:00:00.000Z" }],
    wallets: [
      {
        id: "wallet-1",
        userId: "user-1",
        currency: "NGN",
        availableBalance: "8500",
        lockedBalance: "0",
        updatedAt: "2026-09-11T10:00:00.000Z",
      },
    ],
    transactions: [
      {
        id: "txn-1",
        userId: "user-1",
        type: "DIGITAL_SERVICE",
        reference: "digital-1",
        amount: "-1500",
        createdAt: "2026-09-11T09:30:00.000Z",
      },
    ],
  };

  const merged = mergeMongoSnapshots(staleSave, currentMongo);

  assert.equal(merged.wallets.length, 1);
  assert.equal(merged.wallets[0].availableBalance, "8500");
  assert.equal(merged.transactions.length, 1);
});

test("mongo snapshot merge preserves newer Store product overrides", () => {
  const staleSave = {
    systemSettings: {
      digitalServices: {
        enabled: true,
        updatedAt: "2026-09-11T08:00:00.000Z",
        productOverrides: {},
      },
    },
    digitalServiceProducts: [],
  };
  const currentMongo = {
    systemSettings: {
      digitalServices: {
        enabled: true,
        updatedAt: "2026-09-11T10:00:00.000Z",
        productOverrides: {
          "94": {
            enabled: true,
            displayName: "Gemini Pro",
            customPriceNgn: "2500",
          },
        },
      },
    },
    digitalServiceProducts: [
      {
        id: "94",
        supplierProductId: "94",
        name: "Gemini Pro",
        available: true,
        syncedAt: "2026-09-11T10:00:00.000Z",
      },
    ],
  };

  const merged = mergeMongoSnapshots(staleSave, currentMongo);

  assert.equal(merged.systemSettings.digitalServices.productOverrides["94"].displayName, "Gemini Pro");
  assert.equal(merged.digitalServiceProducts.length, 1);
  assert.equal(merged.digitalServiceProducts[0].id, "94");
});

test("mongo snapshot merge keeps newer conflicting Store override", () => {
  const staleSave = {
    systemSettings: {
      digitalServices: {
        enabled: true,
        updatedAt: "2026-09-11T08:00:00.000Z",
        productOverrides: {
          "94": {
            enabled: false,
            displayName: "Old Gemini",
            customPriceNgn: "1000",
          },
        },
      },
    },
  };
  const currentMongo = {
    systemSettings: {
      digitalServices: {
        enabled: true,
        updatedAt: "2026-09-11T10:00:00.000Z",
        productOverrides: {
          "94": {
            enabled: true,
            displayName: "Gemini Pro",
            customPriceNgn: "2500",
          },
        },
      },
    },
  };

  const merged = mergeMongoSnapshots(staleSave, currentMongo);

  assert.equal(merged.systemSettings.digitalServices.productOverrides["94"].enabled, true);
  assert.equal(merged.systemSettings.digitalServices.productOverrides["94"].displayName, "Gemini Pro");
  assert.equal(merged.systemSettings.digitalServices.productOverrides["94"].customPriceNgn, "2500");
});
