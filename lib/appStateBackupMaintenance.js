const DEFAULT_APP_STATE_ID = "trade-mvp-state";
const DEFAULT_KEEP_COUNT = 5;
const DELETE_CONFIRMATION = "DELETE_OLD_APP_STATE_BACKUPS";

function normalizeKeep(value, fallback = DEFAULT_KEEP_COUNT) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < DEFAULT_KEEP_COUNT) {
    return fallback;
  }
  return Math.min(numeric, 500);
}

function normalizeCreatedAt(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function getBackupId(backup = {}) {
  return backup._id === undefined || backup._id === null ? "" : backup._id;
}

function getBackupIdText(backup = {}) {
  return String(getBackupId(backup));
}

function getBackupSortValue(backup = {}) {
  const createdAt = normalizeCreatedAt(backup.createdAt);
  if (createdAt) {
    return createdAt;
  }
  const objectIdTimestamp = backup._id?.getTimestamp?.();
  const objectIdTime = objectIdTimestamp ? Date.parse(objectIdTimestamp) : 0;
  return Number.isFinite(objectIdTime) ? objectIdTime : 0;
}

function classifyBackup(backup = {}, appStateId = DEFAULT_APP_STATE_ID) {
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
    return "malformed";
  }
  if (!Object.prototype.hasOwnProperty.call(backup, "appStateId")) {
    return "missingAppStateId";
  }
  if (backup.appStateId !== appStateId) {
    return "unexpectedAppStateId";
  }
  if (!backup.snapshot || typeof backup.snapshot !== "object" || Array.isArray(backup.snapshot)) {
    return "malformed";
  }
  return "valid";
}

function planAppStateBackupCleanup(backups = [], { keep = DEFAULT_KEEP_COUNT, appStateId = DEFAULT_APP_STATE_ID } = {}) {
  const keepCount = normalizeKeep(keep);
  const groups = {
    valid: [],
    missingAppStateId: [],
    unexpectedAppStateId: [],
    malformed: [],
  };

  for (const backup of Array.isArray(backups) ? backups : []) {
    const category = classifyBackup(backup, appStateId);
    groups[category].push(backup);
  }

  const validSorted = [...groups.valid].sort((left, right) => getBackupSortValue(right) - getBackupSortValue(left));
  const keepBackups = validSorted.slice(0, keepCount);
  const eligibleForDeletion = validSorted.slice(keepCount);
  const keepIds = new Set(keepBackups.map(getBackupIdText));

  return {
    appStateId,
    keep: keepCount,
    totalBackups: Array.isArray(backups) ? backups.length : 0,
    validBackups: validSorted,
    missingAppStateIdBackups: groups.missingAppStateId,
    unexpectedAppStateIdBackups: groups.unexpectedAppStateId,
    malformedBackups: groups.malformed,
    keepBackups,
    eligibleForDeletion,
    eligibleIds: eligibleForDeletion.map(getBackupId),
    newestBackup: validSorted[0] || null,
    oldestBackup: validSorted[validSorted.length - 1] || null,
    newestKeptBackup: keepBackups[0] || null,
    oldestKeptBackup: keepBackups[keepBackups.length - 1] || null,
    newestFiveProtected: eligibleForDeletion.every((backup) => !keepIds.has(getBackupIdText(backup))),
  };
}

function validateAppStateDocument(appState = {}, appStateId = DEFAULT_APP_STATE_ID) {
  const errors = [];
  if (!appState || typeof appState !== "object" || Array.isArray(appState)) {
    return { ok: false, errors: ["app_state document is missing or invalid."] };
  }
  if (appState._id !== appStateId) {
    errors.push(`app_state _id must be ${appStateId}.`);
  }
  for (const field of ["users", "wallets", "transactions", "deposits", "withdrawals"]) {
    if (!Array.isArray(appState[field])) {
      errors.push(`app_state.${field} must be an array.`);
    }
  }
  if (!appState.systemSettings || typeof appState.systemSettings !== "object" || Array.isArray(appState.systemSettings)) {
    errors.push("app_state.systemSettings must be an object.");
  }
  return { ok: errors.length === 0, errors };
}

function getExecutionDecision({ execute = false, keep = DEFAULT_KEEP_COUNT, confirm = "", appState = null, plan = null } = {}) {
  const reasons = [];
  const keepCount = normalizeKeep(keep);
  if (!execute) {
    reasons.push("Dry run only. --execute was not provided.");
  }
  if (keepCount !== DEFAULT_KEEP_COUNT) {
    reasons.push(`--keep must be exactly ${DEFAULT_KEEP_COUNT} for execution.`);
  }
  if (confirm !== DELETE_CONFIRMATION) {
    reasons.push(`--confirm must equal ${DELETE_CONFIRMATION}.`);
  }
  const appStateValidation = validateAppStateDocument(appState);
  if (!appStateValidation.ok) {
    reasons.push(...appStateValidation.errors);
  }
  if (!plan || !Array.isArray(plan.validBackups)) {
    reasons.push("Backup cleanup plan is missing.");
  } else {
    if (plan.validBackups.length < DEFAULT_KEEP_COUNT) {
      reasons.push(`At least ${DEFAULT_KEEP_COUNT} valid backups are required before cleanup.`);
    }
    if (!plan.keepBackups?.[0]?.snapshot) {
      reasons.push("Newest kept backup must contain a valid snapshot.");
    }
    if (!plan.newestFiveProtected) {
      reasons.push("Newest protected backups were selected for deletion.");
    }
  }
  return {
    canDelete: reasons.length === 0,
    reasons,
  };
}

function estimateReclaimableBytes(backups = []) {
  return (Array.isArray(backups) ? backups : []).reduce((sum, backup) => {
    const size = Number(backup.bsonSize || backup.size || backup.storageSize || 0);
    return Number.isFinite(size) && size > 0 ? sum + size : sum;
  }, 0);
}

module.exports = {
  DEFAULT_APP_STATE_ID,
  DEFAULT_KEEP_COUNT,
  DELETE_CONFIRMATION,
  classifyBackup,
  estimateReclaimableBytes,
  getBackupIdText,
  getExecutionDecision,
  normalizeKeep,
  planAppStateBackupCleanup,
  validateAppStateDocument,
};
