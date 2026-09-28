"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PushNotificationService } = require("../services/pushNotificationService");

function withVapidEnv(run) {
  const previous = {
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  };
  process.env.VAPID_PUBLIC_KEY = "public-test-key";
  process.env.VAPID_PRIVATE_KEY = "private-test-key";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeHarness(sendNotification) {
  const db = {
    users: [{ id: "u1", role: "user", notificationPreferences: { tradingSignals: true } }],
    pushSubscriptions: [
      { id: "s1", userId: "u1", endpoint: "https://push.test/one", keys: { p256dh: "p1", auth: "a1" }, enabled: true },
      { id: "s2", userId: "u1", endpoint: "https://push.test/two", keys: { p256dh: "p2", auth: "a2" }, enabled: true },
    ],
    pushNotificationEvents: [],
  };
  const persisted = [];
  const service = new PushNotificationService({
    db,
    persist: () => persisted.push(true),
    logger: { warn() {} },
    webPushClient: { setVapidDetails() {}, sendNotification },
  });
  return { db, persisted, service };
}

test("failed push delivery remains retryable without changing the notification key", async () => {
  await withVapidEnv(async () => {
    let attempts = 0;
    const { db, service } = makeHarness(async () => {
      attempts += 1;
      if (attempts <= 4) throw new Error("temporary push outage");
    });
    const options = { category: "tradingSignals", dedupeKey: "trade-open:t1:u1" };

    assert.deepEqual(await service.sendToUser("u1", { title: "Trade opened" }, options), { sent: 0, failed: 2, retryable: true });
    assert.equal(db.pushNotificationEvents.length, 1);
    assert.equal(db.pushNotificationEvents[0].failed, 2);

    const result = await service.sendToUser("u1", { title: "Trade opened" }, options);
    assert.deepEqual(result, { sent: 2, failed: 0, retryable: false });
    assert.equal(attempts, 6);
    assert.equal(db.pushNotificationEvents.length, 1);
    assert.equal(db.pushNotificationEvents[0].sent, 2);
    assert.equal(db.pushNotificationEvents[0].failed, 0);
  });
});

test("partial retries target only endpoints that have not succeeded", async () => {
  await withVapidEnv(async () => {
    const attempts = new Map();
    const { db, service } = makeHarness(async ({ endpoint }) => {
      attempts.set(endpoint, (attempts.get(endpoint) || 0) + 1);
      if (endpoint.endsWith("/two") && attempts.get(endpoint) === 1) {
        throw new Error("temporary endpoint outage");
      }
    });
    const options = { category: "tradingSignals", dedupeKey: "trade-open:t2:u1" };

    assert.deepEqual(await service.sendToUser("u1", {}, options), { sent: 2, failed: 0, retryable: false });
    assert.deepEqual(db.pushNotificationEvents[0].deliveredEndpoints, ["https://push.test/one", "https://push.test/two"]);
    assert.equal(attempts.get("https://push.test/one"), 1);
    assert.equal(attempts.get("https://push.test/two"), 2);
    assert.deepEqual(await service.sendToUser("u1", {}, options), { sent: 0, failed: 0, skipped: true, duplicate: true });
    assert.equal(attempts.get("https://push.test/one"), 1);
    assert.equal(attempts.get("https://push.test/two"), 2);
  });
});

test("concurrent sends for the same notification are coalesced", async () => {
  await withVapidEnv(async () => {
    let attempts = 0;
    const { service } = makeHarness(async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const options = { category: "tradingSignals", dedupeKey: "trade-open:t3:u1" };
    const results = await Promise.all([
      service.sendToUser("u1", {}, options),
      service.sendToUser("u1", {}, options),
    ]);
    assert.equal(attempts, 2);
    assert.deepEqual(results[0], results[1]);
  });
});

test("disabled preference and missing subscriptions do not create false delivery events", async () => {
  await withVapidEnv(async () => {
    let attempts = 0;
    const { db, service } = makeHarness(async () => { attempts += 1; });
    db.users[0].notificationPreferences.tradingSignals = false;
    assert.equal((await service.sendToUser("u1", {}, { category: "tradingSignals", dedupeKey: "disabled" })).preference, "tradingSignals");
    db.users[0].notificationPreferences.tradingSignals = true;
    db.pushSubscriptions = [];
    assert.equal((await service.sendToUser("u1", {}, { category: "tradingSignals", dedupeKey: "no-subs" })).reason, "no_active_subscriptions");
    assert.equal(attempts, 0);
    assert.equal(db.pushNotificationEvents.length, 0);
  });
});
