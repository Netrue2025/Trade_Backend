const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing, mergeMongoSnapshots, saveDb, shouldUseMongo } = require("../lib/db");
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

test("startup refuses to bootstrap defaults when existing app_state cannot be read", async () => {
  __testing.resetMongoAppStatePersistenceReady();
  let insertCalled = false;
  const collection = {
    async findOne() {
      return null;
    },
    async countDocuments() {
      return 1;
    },
    async insertOne() {
      insertCalled = true;
    },
  };

  await assert.rejects(
    () => __testing.loadDbFromMongoCollection(collection),
    /existing app_state document could not be read safely/
  );

  assert.equal(insertCalled, false);
  assert.equal(__testing.isMongoAppStatePersistenceReady(), false);
});

test("startup refuses to persist when projected fallback omits an app_state field", async () => {
  __testing.resetMongoAppStatePersistenceReady();
  let insertCalled = false;
  const collection = {
    async findOne(_filter, options = {}) {
      if (!options.projection) {
        throw new Error("simulated full read timeout");
      }
      const field = Object.keys(options.projection).find((key) => key !== "_id");
      if (field === "transactions") {
        return { _id: "trade-mvp-state" };
      }
      return { _id: "trade-mvp-state", [field]: [] };
    },
    async countDocuments() {
      return 1;
    },
    async insertOne() {
      insertCalled = true;
    },
  };

  await assert.rejects(
    () => __testing.loadDbFromMongoCollection(collection),
    /existing app_state document could not be read safely/
  );

  assert.equal(insertCalled, false);
  assert.equal(__testing.isMongoAppStatePersistenceReady(), false);
});

test("saveDb refuses Mongo writes before startup state is verified", async () => {
  await withMongoEnv({
    MONGODB_URI: "mongodb+srv://trade_mvp:trade123@cluster0.x8eukch.mongodb.net/trade_mvp?appName=Cluster0",
  }, async () => {
    __testing.resetMongoAppStatePersistenceReady();
    await assert.rejects(
      () => saveDb({ users: [] }),
      /before startup state has been loaded and verified/
    );
  });
});

test("projected startup fallback preserves users roles wallets and financial history through save and reload", async () => {
  await withEnvAsync([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, async () => {
    __testing.resetMongoAppStatePersistenceReady();
    __testing.markBackupThrottleNow();
    const baseline = __testing.normalizeDb({
      users: Array.from({ length: 100 }, (_, index) => ({
        id: `user-${index + 1}`,
        email: `user-${index + 1}@example.com`,
        role: index === 0 ? "admin" : "user",
        createdAt: "2026-09-13T08:00:00.000Z",
      })),
      wallets: [{ userId: "user-2", currency: "NGN", availableBalance: "100", lockedBalance: "0", updatedAt: "2026-09-13T08:00:00.000Z" }],
      transactions: [{ id: "txn-1", userId: "user-2", amount: "100", type: "DEPOSIT", createdAt: "2026-09-13T08:00:00.000Z" }],
      deposits: [{ id: "dep-1", userId: "user-2", amount: "100", status: "APPROVED", createdAt: "2026-09-13T08:00:00.000Z" }],
      withdrawals: [{ id: "wd-1", userId: "user-2", amount: "25", status: "SUCCESS", createdAt: "2026-09-13T08:00:00.000Z" }],
      referrals: [{ id: "ref-1", referrerUserId: "user-2", referredUserId: "user-3", status: "REWARDED", createdAt: "2026-09-13T08:00:00.000Z" }],
    });
    let document = { _id: "trade-mvp-state", ...JSON.parse(JSON.stringify(baseline)) };
    const collection = {
      async findOne(_filter, options = {}) {
        if (!options.projection) {
          throw new Error("simulated full read timeout");
        }
        const field = Object.keys(options.projection).find((key) => key !== "_id");
        return { _id: document._id, [field]: JSON.parse(JSON.stringify(document[field])) };
      },
      async countDocuments() {
        return document ? 1 : 0;
      },
      async updateOne(_filter, update) {
        document = {
          ...document,
          ...(update.$set || {}),
        };
        return { acknowledged: true };
      },
      async insertOne() {
        throw new Error("insert should not be used for existing app_state");
      },
    };

    const loaded = await __testing.loadDbFromMongoCollection(collection);
    assert.equal(loaded.users.length, 100);
    assert.equal(loaded.users[0].role, "admin");
    assert.equal(loaded.wallets[0].availableBalance, "100");
    assert.equal(loaded.transactions.length, 1);
    assert.equal(loaded.deposits.length, 1);
    assert.equal(loaded.withdrawals.length, 1);
    assert.equal(loaded.referrals.length, 1);
    assert.equal(__testing.isMongoAppStatePersistenceReady(), true);

    loaded.users.push({
      id: "user-101",
      email: "user-101@example.com",
      role: "user",
      createdAt: "2026-09-13T09:00:00.000Z",
    });
    loaded.wallets[0] = { ...loaded.wallets[0], availableBalance: "150", updatedAt: "2026-09-13T09:00:00.000Z" };
    loaded.transactions.unshift({ id: "txn-2", userId: "user-2", amount: "50", type: "DEPOSIT", createdAt: "2026-09-13T09:00:00.000Z" });

    await __testing.saveMongoSnapshot(collection, loaded, { logger: createMemoryLogger() });
    __testing.resetMongoAppStatePersistenceReady();
    const reloaded = await __testing.loadDbFromMongoCollection(collection);

    assert.equal(reloaded.users.length, 101);
    assert.equal(reloaded.users.some((user) => user.id === "user-101"), true);
    assert.equal(reloaded.users.find((user) => user.id === "user-1").role, "admin");
    assert.equal(reloaded.wallets[0].availableBalance, "150");
    assert.equal(reloaded.transactions.length, 2);
    assert.equal(reloaded.deposits.length, 1);
    assert.equal(reloaded.withdrawals.length, 1);
    assert.equal(reloaded.referrals.length, 1);
  });
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

test("coalesced follow-up save persists final C state for financial arrays", async () => {
  const releaseFirst = deferred();
  const saves = [];
  const db = {
    wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "A", updatedAt: "2026-09-13T10:00:00.000Z" }],
    transactions: [{ id: "txn-a", amount: "A", createdAt: "2026-09-13T10:00:00.000Z" }],
    deposits: [{ id: "dep-a", amount: "A", createdAt: "2026-09-13T10:00:00.000Z" }],
    withdrawals: [{ id: "wd-a", amount: "A", createdAt: "2026-09-13T10:00:00.000Z" }],
    referrals: [{ id: "ref-a", rewardAmount: "A", createdAt: "2026-09-13T10:00:00.000Z" }],
    digitalServiceOrders: [{ id: "order-a", amountCharged: "A", createdAt: "2026-09-13T10:00:00.000Z" }],
  };
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
  db.wallets[0] = { ...db.wallets[0], availableBalance: "B", updatedAt: "2026-09-13T10:01:00.000Z" };
  db.transactions = [{ id: "txn-b", amount: "B", createdAt: "2026-09-13T10:01:00.000Z" }];
  db.deposits = [{ id: "dep-b", amount: "B", createdAt: "2026-09-13T10:01:00.000Z" }];
  db.withdrawals = [{ id: "wd-b", amount: "B", createdAt: "2026-09-13T10:01:00.000Z" }];
  db.referrals = [{ id: "ref-b", rewardAmount: "B", createdAt: "2026-09-13T10:01:00.000Z" }];
  db.digitalServiceOrders = [{ id: "order-b", amountCharged: "B", createdAt: "2026-09-13T10:01:00.000Z" }];
  const secondRequest = controller.requestSave(db);

  db.wallets[0] = { ...db.wallets[0], availableBalance: "C", updatedAt: "2026-09-13T10:02:00.000Z" };
  db.transactions = [{ id: "txn-c", amount: "C", createdAt: "2026-09-13T10:02:00.000Z" }];
  db.deposits = [{ id: "dep-c", amount: "C", createdAt: "2026-09-13T10:02:00.000Z" }];
  db.withdrawals = [{ id: "wd-c", amount: "C", createdAt: "2026-09-13T10:02:00.000Z" }];
  db.referrals = [{ id: "ref-c", rewardAmount: "C", createdAt: "2026-09-13T10:02:00.000Z" }];
  db.digitalServiceOrders = [{ id: "order-c", amountCharged: "C", createdAt: "2026-09-13T10:02:00.000Z" }];
  const thirdRequest = controller.requestSave(db);

  releaseFirst.resolve();
  await firstSave;
  await Promise.allSettled([secondRequest, thirdRequest]);

  assert.equal(saves.length, 2);
  assert.equal(saves[0].wallets[0].availableBalance, "A");
  assert.equal(saves[1].wallets[0].availableBalance, "C");
  assert.equal(saves[1].transactions[0].id, "txn-c");
  assert.equal(saves[1].deposits[0].id, "dep-c");
  assert.equal(saves[1].withdrawals[0].id, "wd-c");
  assert.equal(saves[1].referrals[0].id, "ref-c");
  assert.equal(saves[1].digitalServiceOrders[0].id, "order-c");
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

test("backup interval enforces six hours before a new backup is due", () => {
  withEnv([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, () => {
    const baseline = Date.parse("2026-09-14T00:00:00.000Z");
    __testing.markBackupThrottleNow(baseline);
    assert.equal(__testing.isMongoBackupDue(baseline + (3 * 60 * 60 * 1000)), false);
    assert.equal(__testing.isMongoBackupDue(baseline + 21600000 - 1), false);
    assert.equal(__testing.isMongoBackupDue(baseline + 21600000), true);
  });
});

test("backup defaults keep three snapshots every six hours", () => {
  withEnv([
    "MONGODB_APP_STATE_BACKUP_LIMIT",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
  ], {}, () => {
    assert.equal(__testing.getMongoBackupLimit(), 3);
    assert.equal(__testing.getMongoBackupIntervalMs(), 21600000);
  });
});

test("rapid normal app-state saves within six hours do not create backup operations", async () => {
  await withEnvAsync([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, async () => {
    __testing.markBackupThrottleNow();
    let updateCount = 0;
    let backupCount = 0;
    const collection = {
      async findOne() {
        throw new Error("pre-save read should not run during non-backup saves");
      },
      async updateOne() {
        updateCount += 1;
        return { acknowledged: true };
      },
    };

    for (let index = 0; index < 100; index += 1) {
      await __testing.saveMongoSnapshot(collection, {
        wallets: [{ userId: "user-1", currency: "NGN", availableBalance: String(1000 + index) }],
      }, {
        logger: createMemoryLogger(),
        backupSnapshot: async () => {
          backupCount += 1;
        },
      });
    }

    assert.equal(updateCount, 100);
    assert.equal(backupCount, 0);
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

test("non-backup app-state save skips pre-save read and writes latest owned fields", async () => {
  await withEnvAsync([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
    "MONGODB_APP_STATE_FULL_OPERATIONS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, async () => {
    __testing.markBackupThrottleNow();
    let findOneCalls = 0;
    const updates = [];
    const collection = {
      async findOne() {
        findOneCalls += 1;
        throw new Error("pre-save read should not run");
      },
      async updateOne(filter, update, options) {
        updates.push({ filter, update, options });
        return { acknowledged: true, modifiedCount: 1 };
      },
    };
    const latest = {
      wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "3000", updatedAt: "2026-09-13T11:00:00.000Z" }],
      transactions: [{ id: "txn-latest", amount: "-100", createdAt: "2026-09-13T11:00:00.000Z" }],
      deposits: [{ id: "dep-latest", amount: "1000", createdAt: "2026-09-13T11:00:00.000Z" }],
      withdrawals: [{ id: "wd-latest", amount: "500", createdAt: "2026-09-13T11:00:00.000Z" }],
      referrals: [{ id: "ref-latest", rewardAmount: "100", createdAt: "2026-09-13T11:00:00.000Z" }],
      digitalServiceOrders: [{ id: "order-latest", amountCharged: "2500", createdAt: "2026-09-13T11:00:00.000Z" }],
    };

    await __testing.saveMongoSnapshot(collection, latest, { logger: createMemoryLogger() });

    assert.equal(findOneCalls, 0);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].filter, { _id: "trade-mvp-state" });
    assert.equal(updates[0].options.upsert, true);
    assert.equal(updates[0].update.$set.wallets[0].availableBalance, "3000");
    assert.equal(updates[0].update.$set.transactions[0].id, "txn-latest");
    assert.equal(updates[0].update.$set.deposits[0].id, "dep-latest");
    assert.equal(updates[0].update.$set.withdrawals[0].id, "wd-latest");
    assert.equal(updates[0].update.$set.referrals[0].id, "ref-latest");
    assert.equal(updates[0].update.$set.digitalServiceOrders[0].id, "order-latest");
  });
});

test("non-backup app-state save uses $set and does not remove unknown top-level fields", async () => {
  await withEnvAsync([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
    "MONGODB_APP_STATE_FULL_OPERATIONS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, async () => {
    __testing.markBackupThrottleNow();
    const updates = [];
    const collection = {
      async findOne() {
        throw new Error("pre-save read should not run");
      },
      async updateOne(filter, update, options) {
        updates.push({ filter, update, options });
        return { acknowledged: true };
      },
    };

    await __testing.saveMongoSnapshot(collection, { wallets: [] }, { logger: createMemoryLogger() });

    assert.equal(updates.length, 1);
    assert.ok(updates[0].update.$set);
    assert.equal(Object.prototype.hasOwnProperty.call(updates[0].update.$set, "someFutureField"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(updates[0].update, "$unset"), false);
  });
});

test("backup-due app-state save reads previous state, merges, updates, and backs up previous state", async () => {
  await withEnvAsync([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
    "MONGODB_APP_STATE_FULL_OPERATIONS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, async () => {
    __testing.resetBackupThrottle();
    let findOneCalls = 0;
    const updates = [];
    const backups = [];
    const previous = {
      _id: "trade-mvp-state",
      wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "9000", updatedAt: "2026-09-13T12:00:00.000Z" }],
      transactions: [{ id: "txn-current", amount: "-50", createdAt: "2026-09-13T12:00:00.000Z" }],
      systemSettings: {},
    };
    const incoming = {
      wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "1000", updatedAt: "2026-09-13T10:00:00.000Z" }],
      transactions: [{ id: "txn-incoming", amount: "-10", createdAt: "2026-09-13T10:00:00.000Z" }],
      systemSettings: {},
    };
    const collection = {
      async findOne() {
        findOneCalls += 1;
        return JSON.parse(JSON.stringify(previous));
      },
      async updateOne(filter, update, options) {
        updates.push({ filter, update, options });
        return { acknowledged: true };
      },
    };

    await __testing.saveMongoSnapshot(collection, incoming, {
      logger: createMemoryLogger(),
      backupSnapshot: async (snapshot) => {
        backups.push(JSON.parse(JSON.stringify(snapshot)));
      },
    });
    await waitFor(() => backups.length === 1, "backup capture");

    assert.equal(findOneCalls, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.$set.wallets[0].availableBalance, "9000");
    assert.equal(updates[0].update.$set.transactions.some((item) => item.id === "txn-current"), true);
    assert.equal(updates[0].update.$set.transactions.some((item) => item.id === "txn-incoming"), true);
    assert.equal(backups[0].wallets[0].availableBalance, "9000");
    assert.equal(__testing.isMongoBackupDue(), false);
  });
});

test("non-backup direct save reports update failure and controller recovers", async () => {
  await withEnvAsync([
    "MONGODB_APP_STATE_BACKUPS_ENABLED",
    "MONGODB_APP_STATE_BACKUP_INTERVAL_MS",
  ], {
    MONGODB_APP_STATE_BACKUPS_ENABLED: "true",
    MONGODB_APP_STATE_BACKUP_INTERVAL_MS: "21600000",
  }, async () => {
    __testing.markBackupThrottleNow();
    let shouldFail = true;
    const updates = [];
    const controller = __testing.createAppStateSaveController({
      logger: createMemoryLogger(),
      isMongoEnabled: () => true,
      getCollection: async () => ({
        async findOne() {
          throw new Error("pre-save read should not run");
        },
        async updateOne(_filter, update) {
          updates.push(update);
          if (shouldFail) {
            throw new Error("simulated update failure");
          }
          return { acknowledged: true };
        },
      }),
      getSlowWarningMs: () => 1000,
    });

    await assert.rejects(() => controller.requestSave({ wallets: [] }), /MongoDB app-state update failed: simulated update failure/);
    shouldFail = false;
    await controller.requestSave({ wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "10" }] });

    assert.equal(updates.length, 2);
    assert.equal(updates[1].$set.wallets[0].availableBalance, "10");
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
