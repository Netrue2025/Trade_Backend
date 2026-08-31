const { MongoClient } = require("mongodb");
const { getMongoCollectionByName } = require("../lib/db");
const { assertValidMongoConnectionString, getEnvValue, getMongoDbNameFromUri, isMongoConnectionString } = require("../lib/env");

const DEFAULT_COLLECTION_NAME = "telegram_subscribers";
const DEFAULT_OPERATION_TIMEOUT_MS = 8000;

function getMongoUri() {
  return assertValidMongoConnectionString(
    getEnvValue("MONGO_URI", "MONGODB_URI"),
    "Telegram subscriber MongoDB connection string"
  );
}

function getMongoDbName(uri) {
  return getEnvValue("MONGO_DB_NAME", "MONGODB_DB_NAME")
    || getMongoDbNameFromUri(uri, "trade_mvp")
    || "trade_mvp";
}

function getCollectionName() {
  return getEnvValue("TELEGRAM_SUBSCRIBERS_COLLECTION") || DEFAULT_COLLECTION_NAME;
}

function getAppMongoUri() {
  const mongoUri = getEnvValue("MONGODB_URI");
  return isMongoConnectionString(mongoUri) ? mongoUri : "";
}

function getMongoClientOptions() {
  return {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 30000,
    maxPoolSize: 5,
  };
}

function defaultPreferences() {
  return {
    binance: true,
    bybit: true,
    dailyProfit: true,
  };
}

function sanitizeChatId(chatId) {
  const numeric = Number(chatId);
  return Number.isFinite(numeric) ? numeric : 0;
}

function withTimeout(promise, label, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

class SubscriberModel {
  constructor({ mongoUri, dbName, collectionName, logger = console } = {}) {
    this.mongoUri = mongoUri || getMongoUri();
    this.dbName = dbName || (this.mongoUri ? getMongoDbName(this.mongoUri) : "");
    this.collectionName = collectionName || getCollectionName();
    this.logger = logger;
    this.clientPromise = null;
    this.collectionPromise = null;
  }

  isEnabled() {
    return !!this.mongoUri;
  }

  shouldUseSharedAppMongo() {
    return !!this.mongoUri && this.mongoUri === getAppMongoUri();
  }

  resetConnectionState() {
    this.clientPromise = null;
    this.collectionPromise = null;
  }

  async getCollection() {
    if (!this.isEnabled()) {
      throw new Error("MongoDB is not configured for Telegram subscribers.");
    }

    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        if (this.shouldUseSharedAppMongo()) {
          const collection = await getMongoCollectionByName(this.collectionName);
          if (collection) {
            return collection;
          }
        }

        if (!this.clientPromise) {
          this.clientPromise = MongoClient.connect(this.mongoUri, getMongoClientOptions());
        }
        const client = await this.clientPromise;
        return client.db(this.dbName).collection(this.collectionName);
      })().catch((error) => {
        this.resetConnectionState();
        throw error;
      });
    }

    return this.collectionPromise;
  }

  async ensureIndexes() {
    if (!this.isEnabled()) {
      return;
    }

    const collection = await withTimeout(this.getCollection(), "Telegram subscriber store initialization");
    await collection.createIndex({ chatId: 1 }, { unique: true, name: "chatId_unique" });
    await collection.createIndex({ subscribed: 1 }, { name: "subscribed_idx" });
  }

  async init() {
    await this.ensureIndexes();
    return this;
  }

  async findByChatId(chatId) {
    if (!this.isEnabled()) {
      return null;
    }

    const normalizedChatId = sanitizeChatId(chatId);
    if (!normalizedChatId) {
      return null;
    }

    const collection = await withTimeout(this.getCollection(), "Telegram subscriber lookup");
    return collection.findOne({ chatId: normalizedChatId });
  }

  async subscribe(chatId) {
    if (!this.isEnabled()) {
      throw new Error("MongoDB is not configured for Telegram subscribers.");
    }

    const normalizedChatId = sanitizeChatId(chatId);
    if (!normalizedChatId) {
      throw new Error("A valid Telegram chat id is required.");
    }

    const collection = await withTimeout(this.getCollection(), "Telegram subscriber subscribe");
    await collection.updateOne(
      { chatId: normalizedChatId },
      {
        $set: {
          subscribed: true,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          chatId: normalizedChatId,
          preferences: defaultPreferences(),
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    return this.findByChatId(normalizedChatId);
  }

  async unsubscribe(chatId) {
    if (!this.isEnabled()) {
      return null;
    }

    const normalizedChatId = sanitizeChatId(chatId);
    if (!normalizedChatId) {
      return null;
    }

    const collection = await withTimeout(this.getCollection(), "Telegram subscriber unsubscribe");
    await collection.updateOne(
      { chatId: normalizedChatId },
      {
        $set: {
          subscribed: false,
          updatedAt: new Date(),
        },
      }
    );

    return this.findByChatId(normalizedChatId);
  }

  async updatePreferences(chatId, patch = {}) {
    if (!this.isEnabled()) {
      return null;
    }

    const normalizedChatId = sanitizeChatId(chatId);
    if (!normalizedChatId) {
      return null;
    }

    const current = (await this.findByChatId(normalizedChatId)) || {
      chatId: normalizedChatId,
      subscribed: true,
      preferences: defaultPreferences(),
    };

    const nextPreferences = {
      ...defaultPreferences(),
      ...(current.preferences || {}),
      ...Object.fromEntries(
        Object.entries(patch || {}).map(([key, value]) => [key, value !== false])
      ),
    };

    const collection = await withTimeout(this.getCollection(), "Telegram subscriber preferences update");
    await collection.updateOne(
      { chatId: normalizedChatId },
      {
        $set: {
          subscribed: current.subscribed !== false,
          preferences: nextPreferences,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          chatId: normalizedChatId,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    return this.findByChatId(normalizedChatId);
  }

  async togglePreference(chatId, preferenceKey) {
    const allowed = new Set(["binance", "bybit", "dailyProfit"]);
    if (!allowed.has(String(preferenceKey || "").trim())) {
      throw new Error("Unknown Telegram alert preference.");
    }

    const current = (await this.findByChatId(chatId)) || {
      chatId: sanitizeChatId(chatId),
      subscribed: true,
      preferences: defaultPreferences(),
    };
    const key = String(preferenceKey).trim();

    return this.updatePreferences(chatId, {
      [key]: !(current.preferences || defaultPreferences())[key],
    });
  }

  async listSubscribed() {
    if (!this.isEnabled()) {
      return [];
    }

    const collection = await withTimeout(this.getCollection(), "Telegram subscriber list");
    return collection
      .find({ subscribed: true })
      .sort({ createdAt: 1 })
      .toArray();
  }
}

module.exports = {
  SubscriberModel,
  defaultPreferences,
};
