const fs = require("node:fs");
const path = require("node:path");

const { parseEnvFileValue, getEnvValue } = require("../lib/env");
const { getMongoCollectionByName } = require("../lib/db");

function loadEnvFile() {
  for (const envPath of [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", "..", ".env")]) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#")) {
        continue;
      }
      const index = line.indexOf("=");
      if (index === -1) {
        continue;
      }
      const key = line.slice(0, index).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = parseEnvFileValue(line.slice(index + 1));
      }
    }
    break;
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "n/a";
  }
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toISOString();
}

async function safeCount(collection) {
  try {
    return await collection.estimatedDocumentCount();
  } catch {
    return await collection.countDocuments();
  }
}

async function safeStats(db, collectionName) {
  try {
    return await db.command({ collStats: collectionName });
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function getAppStateSize(appCollection) {
  try {
    const rows = await appCollection.aggregate([
      { $match: { _id: "trade-mvp-state" } },
      { $project: { _id: 1, bsonSize: { $bsonSize: "$$ROOT" } } },
    ]).toArray();
    return rows[0]?.bsonSize || 0;
  } catch {
    return 0;
  }
}

async function getBackupSummary(backupCollection) {
  const [totalCount, count, newest, oldest] = await Promise.all([
    backupCollection.estimatedDocumentCount(),
    backupCollection.countDocuments({ appStateId: "trade-mvp-state" }),
    backupCollection.find({ appStateId: "trade-mvp-state" }, { projection: { _id: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).toArray(),
    backupCollection.find({ appStateId: "trade-mvp-state" }, { projection: { _id: 1, createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).toArray(),
  ]);
  return {
    totalCount,
    count,
    newest: newest[0]?.createdAt || "",
    oldest: oldest[0]?.createdAt || "",
  };
}

async function main() {
  loadEnvFile();
  const appCollectionName = getEnvValue("MONGODB_COLLECTION") || "app_state";
  const backupCollectionName = getEnvValue("MONGODB_BACKUP_COLLECTION") || `${appCollectionName}_backups`;
  const appCollection = await getMongoCollectionByName(appCollectionName);
  if (!appCollection) {
    throw new Error("MongoDB is not configured.");
  }

  const db = appCollection.db;
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const appStateSize = await getAppStateSize(appCollection);
  const backupSummary = await getBackupSummary(db.collection(backupCollectionName)).catch((error) => ({
    totalCount: "unavailable",
    count: "unavailable",
    newest: "",
    oldest: "",
    error: error.message || String(error),
  }));

  console.log("----------------------------------------");
  console.log("MONGODB STORAGE REPORT - READ ONLY");
  console.log("----------------------------------------");
  console.log(`Database: ${db.databaseName}`);
  console.log(`Collections: ${collections.length}`);
  console.log(`app_state BSON size: ${formatBytes(appStateSize)}`);
  console.log(`app_state_backups total count: ${backupSummary.totalCount}`);
  console.log(`app_state_backups valid trade-mvp-state count: ${backupSummary.count}`);
  console.log(`app_state_backups newest: ${formatDate(backupSummary.newest)}`);
  console.log(`app_state_backups oldest: ${formatDate(backupSummary.oldest)}`);
  if (backupSummary.error) {
    console.log(`app_state_backups summary error: ${backupSummary.error}`);
  }
  console.log("");

  for (const collectionInfo of collections.sort((left, right) => left.name.localeCompare(right.name))) {
    const collection = db.collection(collectionInfo.name);
    const [count, stats] = await Promise.all([
      safeCount(collection),
      safeStats(db, collectionInfo.name),
    ]);
    const storage = stats.error ? `stats unavailable: ${stats.error}` : `size=${formatBytes(stats.size)} storage=${formatBytes(stats.storageSize)}`;
    console.log(`- ${collectionInfo.name}: count=${count} ${storage}`);
  }

  for (const collectionName of ["trade_learning_trades", "signal_trade_learning"]) {
    if (!collections.some((item) => item.name === collectionName)) {
      console.log(`- ${collectionName}: not found`);
    }
  }
  console.log("----------------------------------------");
  console.log("No documents were printed. No writes were performed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`Storage report failed: ${error.message || error}`);
    process.exit(1);
  }
);
