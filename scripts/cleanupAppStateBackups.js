const fs = require("node:fs");
const path = require("node:path");

const { parseEnvFileValue, getEnvValue } = require("../lib/env");
const { getMongoCollectionByName } = require("../lib/db");
const {
  DEFAULT_APP_STATE_ID,
  DEFAULT_KEEP_COUNT,
  DELETE_CONFIRMATION,
  estimateReclaimableBytes,
  getBackupIdText,
  getExecutionDecision,
  normalizeKeep,
  planAppStateBackupCleanup,
} = require("../lib/appStateBackupMaintenance");

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

function parseArgs(argv = process.argv.slice(2)) {
  const args = { execute: false, keep: DEFAULT_KEEP_COUNT, confirm: "" };
  for (const arg of argv) {
    if (arg === "--execute") {
      args.execute = true;
    } else if (arg.startsWith("--keep=")) {
      args.keep = normalizeKeep(arg.slice("--keep=".length));
    } else if (arg.startsWith("--confirm=")) {
      args.confirm = arg.slice("--confirm=".length);
    }
  }
  return args;
}

function formatDate(value) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toISOString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "unknown";
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

async function getAppStateSummary(appCollection) {
  const rows = await appCollection.aggregate([
    { $match: { _id: DEFAULT_APP_STATE_ID } },
    {
      $project: {
        _id: 1,
        usersIsArray: { $isArray: "$users" },
        walletsIsArray: { $isArray: "$wallets" },
        transactionsIsArray: { $isArray: "$transactions" },
        depositsIsArray: { $isArray: "$deposits" },
        withdrawalsIsArray: { $isArray: "$withdrawals" },
        systemSettingsType: { $type: "$systemSettings" },
      },
    },
  ]).toArray();
  const summary = rows[0] || null;
  if (!summary) {
    return null;
  }
  return {
    _id: summary._id,
    users: summary.usersIsArray ? [] : null,
    wallets: summary.walletsIsArray ? [] : null,
    transactions: summary.transactionsIsArray ? [] : null,
    deposits: summary.depositsIsArray ? [] : null,
    withdrawals: summary.withdrawalsIsArray ? [] : null,
    systemSettings: summary.systemSettingsType === "object" ? {} : null,
  };
}

async function getBackupMetadata(backupCollection) {
  const backups = await backupCollection.find(
    {},
    {
      projection: {
        _id: 1,
        appStateId: 1,
        sourceCollection: 1,
        createdAt: 1,
        "snapshot._id": 1,
      },
    }
  ).sort({ createdAt: -1 }).toArray();

  try {
    const sizes = await backupCollection.aggregate([
      { $project: { _id: 1, bsonSize: { $bsonSize: "$$ROOT" } } },
    ]).toArray();
    const sizeById = new Map(sizes.map((item) => [String(item._id), item.bsonSize]));
    for (const backup of backups) {
      backup.bsonSize = sizeById.get(String(backup._id)) || 0;
    }
  } catch (error) {
    console.warn(`Backup size estimate unavailable: ${error.message || error}`);
  }

  return backups;
}

function printPlan({ dbName, backupCollectionName, plan, decision, execute }) {
  const reclaimableBytes = estimateReclaimableBytes(plan.eligibleForDeletion);
  console.log("----------------------------------------");
  console.log(`APP STATE BACKUP CLEANUP - ${execute && decision.canDelete ? "EXECUTE" : "DRY RUN"}`);
  console.log("----------------------------------------");
  console.log(`Database: ${dbName}`);
  console.log(`Collection: ${backupCollectionName}`);
  console.log("");
  console.log(`Total backups: ${plan.totalBackups}`);
  console.log(`Valid backups: ${plan.validBackups.length}`);
  console.log(`Missing appStateId: ${plan.missingAppStateIdBackups.length}`);
  console.log(`Unexpected appStateId: ${plan.unexpectedAppStateIdBackups.length}`);
  console.log(`Malformed backups: ${plan.malformedBackups.length}`);
  console.log(`Keeping newest: ${plan.keep}`);
  console.log(`Eligible for deletion: ${plan.eligibleForDeletion.length}`);
  console.log(`Estimated reclaimable data: ${formatBytes(reclaimableBytes)}`);
  console.log("");
  console.log(`Newest: ${formatDate(plan.newestBackup?.createdAt)}`);
  console.log(`Oldest: ${formatDate(plan.oldestBackup?.createdAt)}`);
  console.log("");
  console.log("IDs eligible for deletion:");
  if (plan.eligibleForDeletion.length) {
    for (const backup of plan.eligibleForDeletion) {
      console.log(`- ${getBackupIdText(backup)} (${formatDate(backup.createdAt)})`);
    }
  } else {
    console.log("- none");
  }
  if (decision.reasons.length) {
    console.log("");
    console.log("Deletion blocked:");
    for (const reason of decision.reasons) {
      console.log(`- ${reason}`);
    }
  }
  console.log("");
  console.log(execute && decision.canDelete ? "Only the exact eligible _id values were deleted." : "NO DATA HAS BEEN DELETED.");
  console.log(`To perform cleanup, all flags are required: --execute --keep=${DEFAULT_KEEP_COUNT} --confirm=${DELETE_CONFIRMATION}`);
  console.log("----------------------------------------");
}

async function main() {
  loadEnvFile();
  const args = parseArgs();
  const appCollectionName = getEnvValue("MONGODB_COLLECTION") || "app_state";
  const backupCollectionName = getEnvValue("MONGODB_BACKUP_COLLECTION") || `${appCollectionName}_backups`;
  const appCollection = await getMongoCollectionByName(appCollectionName);
  if (!appCollection) {
    throw new Error("MongoDB is not configured.");
  }
  const db = appCollection.db;
  const backupCollection = db.collection(backupCollectionName);
  const [appState, backups] = await Promise.all([
    getAppStateSummary(appCollection),
    getBackupMetadata(backupCollection),
  ]);
  const plan = planAppStateBackupCleanup(backups, { keep: args.keep });
  const decision = getExecutionDecision({
    execute: args.execute,
    keep: args.keep,
    confirm: args.confirm,
    appState,
    plan,
  });

  if (args.execute && decision.canDelete && plan.eligibleIds.length) {
    await backupCollection.deleteMany({ _id: { $in: plan.eligibleIds } });
  }

  printPlan({
    dbName: db.databaseName,
    backupCollectionName,
    plan,
    decision,
    execute: args.execute,
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`Cleanup failed: ${error.message || error}`);
    process.exit(1);
  }
);
