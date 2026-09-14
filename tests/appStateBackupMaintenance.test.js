const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DELETE_CONFIRMATION,
  getExecutionDecision,
  planAppStateBackupCleanup,
} = require("../lib/appStateBackupMaintenance");

function backup(index, patch = {}) {
  return {
    _id: `backup-${index}`,
    appStateId: "trade-mvp-state",
    createdAt: new Date(Date.UTC(2026, 0, index)).toISOString(),
    snapshot: { _id: "trade-mvp-state" },
    ...patch,
  };
}

function backups(count) {
  return Array.from({ length: count }, (_, index) => backup(index + 1));
}

function validAppState() {
  return {
    _id: "trade-mvp-state",
    users: [],
    wallets: [],
    transactions: [],
    deposits: [],
    withdrawals: [],
    systemSettings: {},
  };
}

async function maybeDelete({ plan, decision, deleteMany }) {
  if (!decision.canDelete || !plan.eligibleIds.length) {
    return { deletedCount: 0 };
  }
  return deleteMany({ _id: { $in: plan.eligibleIds } });
}

test("3 backups -> deletes 0", () => {
  const plan = planAppStateBackupCleanup(backups(3), { keep: 3 });
  assert.equal(plan.eligibleForDeletion.length, 0);
});

test("6 backups -> identifies oldest 3", () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  assert.deepEqual(plan.keepBackups.map((item) => item._id), ["backup-6", "backup-5", "backup-4"]);
  assert.deepEqual(plan.eligibleIds, ["backup-3", "backup-2", "backup-1"]);
});

test("4 backups -> identifies oldest 1", () => {
  const plan = planAppStateBackupCleanup(backups(4), { keep: 3 });
  assert.deepEqual(plan.eligibleIds, ["backup-1"]);
});

test("101 backups -> identifies oldest 98", () => {
  const plan = planAppStateBackupCleanup(backups(101), { keep: 3 });
  assert.equal(plan.eligibleForDeletion.length, 98);
  assert.equal(plan.eligibleIds[0], "backup-98");
  assert.equal(plan.eligibleIds.at(-1), "backup-1");
});

test("newest 3 are never selected for deletion", () => {
  const plan = planAppStateBackupCleanup(backups(12), { keep: 3 });
  assert.equal(plan.newestProtected, true);
  assert.deepEqual(plan.keepBackups.map((item) => item._id), ["backup-12", "backup-11", "backup-10"]);
  assert.equal(plan.eligibleIds.includes("backup-12"), false);
  assert.equal(plan.eligibleIds.includes("backup-10"), false);
});

test("dry-run performs zero deletes", async () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  const decision = getExecutionDecision({ execute: false, keep: 3, confirm: DELETE_CONFIRMATION, appState: validAppState(), plan });
  let deleteCalls = 0;
  await maybeDelete({
    plan,
    decision,
    deleteMany: async () => {
      deleteCalls += 1;
      return { deletedCount: 1 };
    },
  });
  assert.equal(deleteCalls, 0);
});

test("missing confirmation flag performs zero deletes", async () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  const decision = getExecutionDecision({ execute: true, keep: 3, confirm: "", appState: validAppState(), plan });
  let deleteCalls = 0;
  await maybeDelete({
    plan,
    decision,
    deleteMany: async () => {
      deleteCalls += 1;
      return { deletedCount: 1 };
    },
  });
  assert.equal(decision.canDelete, false);
  assert.equal(deleteCalls, 0);
});

test("wrong confirmation string performs zero deletes", async () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  const decision = getExecutionDecision({ execute: true, keep: 3, confirm: "DELETE", appState: validAppState(), plan });
  let deleteCalls = 0;
  await maybeDelete({
    plan,
    decision,
    deleteMany: async () => {
      deleteCalls += 1;
      return { deletedCount: 1 };
    },
  });
  assert.equal(decision.canDelete, false);
  assert.equal(deleteCalls, 0);
});

test("execute with confirmation deletes only exact eligible backup ids", async () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  const decision = getExecutionDecision({ execute: true, keep: 3, confirm: DELETE_CONFIRMATION, appState: validAppState(), plan });
  let deleteQuery = null;
  const result = await maybeDelete({
    plan,
    decision,
    deleteMany: async (query) => {
      deleteQuery = query;
      return { deletedCount: query._id.$in.length };
    },
  });
  assert.equal(decision.canDelete, true);
  assert.deepEqual(deleteQuery, { _id: { $in: ["backup-3", "backup-2", "backup-1"] } });
  assert.equal(result.deletedCount, 3);
});

test("missing app_state aborts cleanup", () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  const decision = getExecutionDecision({ execute: true, keep: 3, confirm: DELETE_CONFIRMATION, appState: null, plan });
  assert.equal(decision.canDelete, false);
  assert.match(decision.reasons.join(" "), /app_state document is missing/i);
});

test("malformed backups are reported but not deleted", () => {
  const rows = [...backups(6), { _id: "bad", appStateId: "trade-mvp-state", createdAt: "2026-02-01T00:00:00.000Z" }];
  const plan = planAppStateBackupCleanup(rows, { keep: 3 });
  assert.equal(plan.malformedBackups.length, 1);
  assert.equal(plan.eligibleIds.includes("bad"), false);
});

test("missing or malformed timestamps are reported but not deleted", () => {
  const rows = [
    ...backups(6),
    backup(99, { _id: "missing-created-at", createdAt: undefined }),
    backup(100, { _id: "bad-created-at", createdAt: "not-a-date" }),
  ];
  const plan = planAppStateBackupCleanup(rows, { keep: 3 });
  assert.equal(plan.malformedBackups.some((item) => item._id === "missing-created-at"), true);
  assert.equal(plan.malformedBackups.some((item) => item._id === "bad-created-at"), true);
  assert.equal(plan.eligibleIds.includes("missing-created-at"), false);
  assert.equal(plan.eligibleIds.includes("bad-created-at"), false);
});

test("retention keeps newest three valid backups and preserves unknown backup documents", () => {
  const rows = [
    ...backups(6),
    backup(99, { _id: "other-state", appStateId: "other-state" }),
    { _id: "missing-app-state-id", createdAt: "2026-09-14T00:00:00.000Z", snapshot: { _id: "trade-mvp-state" } },
    backup(100, { _id: "bad-timestamp", createdAt: "invalid" }),
    { _id: "unknown-document", appStateId: "trade-mvp-state", createdAt: "2026-09-15T00:00:00.000Z" },
  ];
  const plan = planAppStateBackupCleanup(rows, { keep: 3 });
  assert.deepEqual(plan.keepBackups.map((item) => item._id), ["backup-6", "backup-5", "backup-4"]);
  assert.deepEqual(plan.eligibleIds, ["backup-3", "backup-2", "backup-1"]);
  assert.equal(plan.unexpectedAppStateIdBackups.some((item) => item._id === "other-state"), true);
  assert.equal(plan.missingAppStateIdBackups.some((item) => item._id === "missing-app-state-id"), true);
  assert.equal(plan.malformedBackups.some((item) => item._id === "bad-timestamp"), true);
  assert.equal(plan.malformedBackups.some((item) => item._id === "unknown-document"), true);
});

test("backups with unexpected appStateId are not deleted", () => {
  const rows = [...backups(6), backup(99, { _id: "other", appStateId: "other-state" })];
  const plan = planAppStateBackupCleanup(rows, { keep: 3 });
  assert.equal(plan.unexpectedAppStateIdBackups.length, 1);
  assert.equal(plan.eligibleIds.includes("other"), false);
});

test("normal saveDb state can proceed while backup cleanup planning is throttled separately", () => {
  const appState = validAppState();
  const before = JSON.stringify(appState);
  const plan = planAppStateBackupCleanup(backups(6), { keep: 3 });
  assert.equal(plan.eligibleIds.length, 3);
  assert.equal(JSON.stringify(appState), before);
});

test("financial app_state data is unchanged by backup cleanup planning", () => {
  const appState = {
    ...validAppState(),
    wallets: [{ userId: "user-1", currency: "NGN", availableBalance: "1000" }],
    transactions: [{ id: "txn-1", amount: "-100" }],
    deposits: [{ id: "dep-1", amount: "1000" }],
    withdrawals: [{ id: "wd-1", amount: "100" }],
  };
  const before = JSON.stringify(appState);
  const plan = planAppStateBackupCleanup(backups(101), { keep: 3 });
  const decision = getExecutionDecision({ execute: false, keep: 3, confirm: DELETE_CONFIRMATION, appState, plan });
  assert.equal(decision.canDelete, false);
  assert.equal(JSON.stringify(appState), before);
});
