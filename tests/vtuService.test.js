const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { FinancialService } = require("../services/financialService");
const { VtuService } = require("../services/vtuService");

function createHarness(fetchImpl) {
  let id = 0;
  const now = new Date().toISOString();
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const db = {
    users: [
      {
        id: "admin-1",
        name: "Admin",
        email: "admin@example.com",
        role: "admin",
      },
    ],
  };
  const financialService = new FinancialService({
    db,
    persist: () => undefined,
    idGenerator: () => `id-${++id}`,
    clock: () => now,
  });
  financialService.ensureState();
  financialService.updateVtuSettings(db.users[0], {
    username: "vtu@example.com",
    password: "secret-password",
    pin: "4321",
    airtimeEnabled: true,
    dataEnabled: true,
  });
  return {
    db,
    financialService,
    restoreEnv() {
      if (previousKey === undefined) {
        delete process.env.SETTINGS_ENCRYPTION_KEY;
      } else {
        process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
      }
    },
    service: new VtuService({
      financialService,
      fetchImpl,
      clock: () => now,
      logger: { warn: () => undefined, error: () => undefined },
    }),
  };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("VTU JWT is cached and reused for balance checks", async () => {
  const calls = [];
  const harness = createHarness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/jwt-auth/v1/token")) {
      return jsonResponse({ token: "jwt-one" });
    }
    assert.equal(options.headers.Authorization, "Bearer jwt-one");
    return jsonResponse({ code: "success", data: { balance: 24500 } });
  });

  try {
    const first = await harness.service.getWalletBalance();
    const second = await harness.service.getWalletBalance();

    assert.equal(first.balance, 24500);
    assert.equal(second.balance, 24500);
    assert.equal(calls.filter((call) => call.url.endsWith("/jwt-auth/v1/token")).length, 1);
    assert.equal(harness.financialService.getSettings().vtu.tokenCached, true);
  } finally {
    harness.restoreEnv();
  }
});

test("VTU authenticated request refreshes token once after auth failure", async () => {
  const calls = [];
  let tokenIndex = 0;
  let rejectedOldToken = false;
  const harness = createHarness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/jwt-auth/v1/token")) {
      tokenIndex += 1;
      return jsonResponse({ token: `jwt-${tokenIndex}` });
    }
    if (!rejectedOldToken) {
      rejectedOldToken = true;
      return jsonResponse({ message: "Expired token" }, { ok: false, status: 401 });
    }
    assert.equal(options.headers.Authorization, "Bearer jwt-2");
    return jsonResponse({ code: "success", data: { balance: 1000 } });
  });

  try {
    const result = await harness.service.getWalletBalance();

    assert.equal(result.balance, 1000);
    assert.equal(calls.filter((call) => call.url.endsWith("/jwt-auth/v1/token")).length, 2);
    assert.equal(calls.filter((call) => call.url.endsWith("/api/v2/balance")).length, 2);
  } finally {
    harness.restoreEnv();
  }
});

test("VTU data plans expose only active variation ids with reseller pricing", async () => {
  const harness = createHarness(async (url) => {
    assert.equal(url.includes("/api/v2/variations/data?service_id=mtn"), true);
    return jsonResponse({
      code: "success",
      data: [
        {
          variation_id: 2682,
          service_id: "mtn",
          service_name: "MTN",
          data_plan: "1GB - 30 Days",
          price: "799",
          reseller_price: "769.00",
          availability: "Unavailable",
        },
        {
          variation_id: 2676,
          service_id: "mtn",
          service_name: "MTN",
          data_plan: "1GB + 5 mins - 7 Days",
          price: "819",
          reseller_price: "799.00",
          availability: "Available",
        },
      ],
    });
  });

  try {
    const plans = await harness.service.getDataPlans({ network: "mtn", markupPercent: 10 });

    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, "2676");
    assert.equal(plans[0].variationId, "2676");
    assert.equal(plans[0].providerCost, "799");
    assert.equal(plans[0].sellingPrice, "878.9");
    assert.equal(plans[0].available, true);
  } finally {
    harness.restoreEnv();
  }
});
