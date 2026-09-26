const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FinancialService } = require("../services/financialService");
const { DepositApprovalService, REQUIRED_DEPOSIT_APPROVAL_FIELDS, OPTIONAL_DEPOSIT_APPROVAL_FIELDS } = require("../services/depositApprovalService");
const { FinancialIntegrityState, createUserFinancialLock } = require("../lib/financialIntegrity");

function harness({ failRequired = false, failOptional = false } = {}) {
  let id = 0; const calls = []; const timeline = []; const integrity = new FinancialIntegrityState(); integrity.registerAuthoritativeState();
  const db = { meta: { stateRevision: 0 }, users: [{ id: "admin", role: "admin" }, { id: "user", role: "user", pnlLots: [{ amount: "1" }] }] };
  const financialService = new FinancialService({ db, persist: () => undefined, idGenerator: () => `id-${++id}`, clock: () => "2026-09-25T10:00:00.000Z" }); financialService.ensureState();
  const user = db.users[1], admin = db.users[0]; financialService.ensureWallet(user.id, "NGN").availableBalance = "1000";
  const deposit = financialService.createDeposit(user, { amount: "5000", currency: "NGN", depositorName: "Ada" }, { idempotencyKey: "submit-once" });
  const persist = async (options) => {
    calls.push(options); timeline.push(options.required ? "required" : "optional");
    if (options.required && failRequired) { integrity.freeze("required failed", options.operation); throw new Error("required failed"); }
    if (options.bestEffort && failOptional) throw new Error("optional failed");
  };
  const lock = createUserFinancialLock();
  const service = new DepositApprovalService({ financialService, withUserFinancialLock: async (userId, operation) => { integrity.assertWritable(); return lock(userId, operation); }, markFinancialMutation: (wallet) => { wallet.revision = Number(wallet.revision || 0) + 1; db.meta.stateRevision = Number(db.meta.stateRevision || 0) + 1; }, persist, completeDurableMutation: () => timeline.push("durable-complete") });
  return { admin, calls, db, deposit, financialService, integrity, service, timeline };
}

test("deposit approval persists one canonical financial state before side effects", async () => {
  const h = harness(); const result = await h.service.approve(h.admin, h.deposit.id);
  assert.equal(result.deposit.status, "APPROVED"); assert.equal(h.financialService.ensureWallet("user", "NGN").availableBalance, "6000");
  const credits = h.db.transactions.filter((item) => item.type === "DEPOSIT" && item.reference === h.deposit.id); assert.equal(credits.length, 1); assert.equal(credits[0].balanceBefore, "1000"); assert.equal(credits[0].balanceAfter, "6000");
  assert.deepEqual(h.calls[0].fields, REQUIRED_DEPOSIT_APPROVAL_FIELDS); assert.deepEqual(h.calls[1].fields, OPTIONAL_DEPOSIT_APPROVAL_FIELDS);
  assert.deepEqual(h.timeline, ["required", "durable-complete", "optional"]); assert.equal(h.db.notifications.length > 0, true); assert.equal(h.db.auditLogs.some((item) => item.action === "DEPOSIT_APPROVED"), true);
});

test("double click concurrent approval and request retry credit exactly once", async () => {
  const h = harness(); const [first, second] = await Promise.all([h.service.approve(h.admin, h.deposit.id), h.service.approve(h.admin, h.deposit.id)]); const retry = await h.service.approve(h.admin, h.deposit.id);
  assert.equal(first.deposit.status, "APPROVED"); assert.equal(second.duplicate, true); assert.equal(retry.duplicate, true);
  assert.equal(h.db.transactions.filter((item) => item.type === "DEPOSIT" && item.reference === h.deposit.id).length, 1); assert.equal(h.financialService.ensureWallet("user", "NGN").availableBalance, "6000"); assert.equal(h.calls.filter((item) => item.required).length, 1);
});

test("required failure reports failure, freezes, and emits no success side effects", async () => {
  const h = harness({ failRequired: true }); await assert.rejects(() => h.service.approve(h.admin, h.deposit.id), /required failed/);
  assert.equal(h.integrity.getStatus().persistenceFrozen, true); assert.equal(h.db.notifications.some((item) => item.title === "Deposit approved"), false); assert.equal(h.db.auditLogs.some((item) => item.action === "DEPOSIT_APPROVED"), false);
  await assert.rejects(() => h.service.approve(h.admin, h.deposit.id), /temporarily unavailable/);
});

test("optional post-durability failure cannot undo or duplicate approval", async () => {
  const h = harness({ failOptional: true }); const result = await h.service.approve(h.admin, h.deposit.id); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.deposit.status, "APPROVED"); assert.equal(h.integrity.getStatus().persistenceFrozen, false); assert.equal(h.db.transactions.filter((item) => item.reference === h.deposit.id).length, 1); assert.equal((await h.service.approve(h.admin, h.deposit.id)).duplicate, true);
});

test("deposit submission and push persistence are explicitly scoped", () => {
  const financial = fs.readFileSync(path.join(__dirname, "..", "services", "financialService.js"), "utf8"); const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(financial, /this\.persist\(\{ fields: \["deposits", "idempotencyKeys"\] \}\)/);
  assert.match(server, /bestEffort: true, operation: \{ reason: "PUSH_NOTIFICATION" \}, fields: \["pushSubscriptions", "pushNotificationEvents"\]/);
  assert.match(server, /requestState\.lastMutation = null/);
  assert.match(server, /requestState\.pending\.delete\(saveOperation\);\s*completeRequestDurableMutation\(\)/);
});
