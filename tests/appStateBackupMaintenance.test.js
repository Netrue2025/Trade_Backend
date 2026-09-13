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

test("5 backups -> deletes 0", () => {
  const plan = planAppStateBackupCleanup(backups(5), { keep: 5 });
  assert.equal(plan.eligibleForDeletion.length, 0);
});

test("6 backups -> identifies oldest 1", () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  assert.deepEqual(plan.eligibleIds, ["backup-1"]);
});

test("101 backups -> identifies oldest 96", () => {
  const plan = planAppStateBackupCleanup(backups(101), { keep: 5 });
  assert.equal(plan.eligibleForDeletion.length, 96);
  assert.equal(plan.eligibleIds[0], "backup-96");
  assert.equal(plan.eligibleIds[95], "backup-1");
});

test("newest 5 are never selected for deletion", () => {
  const plan = planAppStateBackupCleanup(backups(12), { keep: 5 });
  assert.equal(plan.newestFiveProtected, true);
  assert.deepEqual(plan.keepBackups.map((item) => item._id), ["backup-12", "backup-11", "backup-10", "backup-9", "backup-8"]);
  assert.equal(plan.eligibleIds.includes("backup-12"), false);
  assert.equal(plan.eligibleIds.includes("backup-8"), false);
});

test("dry-run performs zero deletes", async () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  const decision = getExecutionDecision({ execute: false, keep: 5, confirm: DELETE_CONFIRMATION, appState: validAppState(), plan });
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
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  const decision = getExecutionDecision({ execute: true, keep: 5, confirm: "", appState: validAppState(), plan });
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
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  const decision = getExecutionDecision({ execute: true, keep: 5, confirm: "DELETE", appState: validAppState(), plan });
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
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  const decision = getExecutionDecision({ execute: true, keep: 5, confirm: DELETE_CONFIRMATION, appState: validAppState(), plan });
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
  assert.deepEqual(deleteQuery, { _id: { $in: ["backup-1"] } });
  assert.equal(result.deletedCount, 1);
});

test("missing app_state aborts cleanup", () => {
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  const decision = getExecutionDecision({ execute: true, keep: 5, confirm: DELETE_CONFIRMATION, appState: null, plan });
  assert.equal(decision.canDelete, false);
  assert.match(decision.reasons.join(" "), /app_state document is missing/i);
});

test("malformed backups are reported but not deleted", () => {
  const rows = [...backups(6), { _id: "bad", appStateId: "trade-mvp-state", createdAt: "2026-02-01T00:00:00.000Z" }];
  const plan = planAppStateBackupCleanup(rows, { keep: 5 });
  assert.equal(plan.malformedBackups.length, 1);
  assert.equal(plan.eligibleIds.includes("bad"), false);
});

test("backups with unexpected appStateId are not deleted", () => {
  const rows = [...backups(6), backup(99, { _id: "other", appStateId: "other-state" })];
  const plan = planAppStateBackupCleanup(rows, { keep: 5 });
  assert.equal(plan.unexpectedAppStateIdBackups.length, 1);
  assert.equal(plan.eligibleIds.includes("other"), false);
});

test("normal saveDb state can proceed while backup cleanup planning is throttled separately", () => {
  const appState = validAppState();
  const before = JSON.stringify(appState);
  const plan = planAppStateBackupCleanup(backups(6), { keep: 5 });
  assert.equal(plan.eligibleIds.length, 1);
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
  const plan = planAppStateBackupCleanup(backups(101), { keep: 5 });
  const decision = getExecutionDecision({ execute: false, keep: 5, confirm: DELETE_CONFIRMATION, appState, plan });
  assert.equal(decision.canDelete, false);
  assert.equal(JSON.stringify(appState), before);
});
