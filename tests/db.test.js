const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing, mergeMongoSnapshots, shouldUseMongo } = require("../lib/db");

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
