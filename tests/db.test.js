const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeMongoSnapshots } = require("../lib/db");

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
