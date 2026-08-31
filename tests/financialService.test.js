const test = require("node:test");
const assert = require("node:assert/strict");

const { FinancialService } = require("../services/financialService");

function createHarness() {
  let id = 0;
  const db = {
    users: [
      {
        id: "admin-1",
        name: "Admin",
        email: "admin@example.com",
        role: "admin",
      },
      {
        id: "user-1",
        name: "Ada User",
        email: "ada@example.com",
        role: "user",
      },
    ],
  };
  const service = new FinancialService({
    db,
    persist: () => undefined,
    idGenerator: () => `id-${++id}`,
    clock: () => "2026-08-30T10:00:00.000Z",
  });
  service.ensureState();
  return {
    admin: db.users[0],
    db,
    service,
    user: db.users[1],
  };
}

function setWallet(service, userId, currency, availableBalance, lockedBalance = "0") {
  const wallet = service.ensureWallet(userId, currency);
  wallet.availableBalance = String(availableBalance);
  wallet.lockedBalance = String(lockedBalance);
  return wallet;
}

test("deposit approval credits once and second approval is rejected", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const deposit = service.createDeposit(user, { amount: "50", transactionHash: "0xabc" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");

  service.approveDeposit(admin, deposit.id);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "150");
  assert.throws(() => service.approveDeposit(admin, deposit.id), /no longer pending/i);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "150");
});

test("naira deposit approval credits NGN wallet", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "NGN", "2500");

  const deposit = service.createDeposit(user, {
    amount: "5000",
    currency: "NGN",
    transactionHash: "bank-ref-1",
    depositorName: "Ada User",
  });

  assert.equal(deposit.currency, "NGN");
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "2500");

  service.approveDeposit(admin, deposit.id);
  assert.equal(service.ensureWallet(user.id, "NGN").availableBalance, "7500");
});

test("withdrawal completion reserves funds and clears locked balance", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const withdrawal = service.createWithdrawal(user, {
    amount: "20",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "80");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "20");

  service.completeWithdrawal(admin, withdrawal.id, { transactionHash: "0xdef" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "80");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "0");
});

test("withdrawal rejection refunds reserved funds", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const withdrawal = service.createWithdrawal(user, {
    amount: "20",
    currency: "USDT",
    destination: {
      address: "TUserWalletAddress",
      network: "TRC20",
    },
  });

  service.rejectWithdrawal(admin, withdrawal.id, { adminNote: "Invalid destination" });
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100");
  assert.equal(service.ensureWallet(user.id, "USDT").lockedBalance, "0");
});

test("daily performance compounds from current eligible balance and does not double apply", () => {
  const { admin, service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  const dayOne = service.createDailyPerformance(admin, {
    date: "2026-08-30",
    startingCapital: "2000",
    endingCapital: "2040",
  });
  const firstApply = service.applyDailyPerformance(admin, dayOne.id);
  assert.equal(firstApply.appliedCount, 1);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "102");

  const duplicateApply = service.applyDailyPerformance(admin, dayOne.id);
  assert.equal(duplicateApply.appliedCount, 0);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "102");

  const dayTwo = service.createDailyPerformance(admin, {
    date: "2026-08-31",
    startingCapital: "2000",
    endingCapital: "1980",
  });
  const secondApply = service.applyDailyPerformance(admin, dayTwo.id);
  assert.equal(secondApply.appliedCount, 1);
  assert.equal(service.ensureWallet(user.id, "USDT").availableBalance, "100.98");
});

test("daily withdrawal limit is enforced", () => {
  const { service, user } = createHarness();
  setWallet(service, user.id, "USDT", "100");

  for (let index = 0; index < 2; index += 1) {
    service.createWithdrawal(user, {
      amount: "10",
      currency: "USDT",
      destination: {
        address: `TUserWalletAddress${index}`,
        network: "TRC20",
      },
    });
  }

  assert.throws(
    () =>
      service.createWithdrawal(user, {
        amount: "10",
        currency: "USDT",
        destination: {
          address: "TUserWalletAddress3",
          network: "TRC20",
        },
      }),
    /daily withdrawal limit/i
  );
});
