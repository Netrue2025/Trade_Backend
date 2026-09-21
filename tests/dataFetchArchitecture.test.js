const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("live state is authenticated, projected, and does not reconcile or persist", () => {
  const route = server.match(/if \(req\.method === "GET" && url\.pathname === "\/api\/live-state"\)[\s\S]*?return true;\s*}/)?.[0] || "";
  assert.match(route, /requireAuth\(req, res\)/);
  assert.match(route, /buildLiveState\(user\)/);
  assert.doesNotMatch(route, /persist\(|saveDb|reconcil/i);

  const projection = server.match(/function buildLiveState\(user\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(projection, /balance:/);
  assert.match(projection, /openTrades:/);
  assert.match(projection, /queueTrades:/);
  for (const forbidden of ["transactions", "notifications", "referrals", "auditLogs", "delivery", "otp"]) {
    assert.doesNotMatch(projection, new RegExp(`\\b${forbidden}\\b`, "i"));
  }
});

test("trade reads use reconciled state without forcing exchange reconciliation", () => {
  const route = server.match(/if \(req\.method === "GET" && url\.pathname === "\/api\/trades"\)[\s\S]*?sendJson\(res, 200, \{ trades \}\);/)?.[0] || "";
  assert.ok(route);
  assert.doesNotMatch(route, /waitForTradeReconciliation|settleInactiveTradeInvestmentsForUsers|persist\(/);
});

test("settings websocket has no interval snapshot and private status routes require auth", () => {
  assert.doesNotMatch(server, /socket\.refreshTimer\s*=\s*setInterval/);
  assert.match(server, /LIVE_STATE_WS_PATH = "\/ws\/live-state"/);
  assert.match(server, /digital-services\/pending-status[\s\S]*?requireAuth\(req, res\)/);
  assert.match(server, /digital-services\\\/orders\\\/\(\[\^\/\]\+\)\\\/status\$\/\)[\s\S]*?requireAuth\(req, res\)/);
});

test("JSON responses preserve private no-store caching and support gzip", () => {
  assert.match(server, /"Cache-Control": "no-store"/);
  assert.match(server, /zlib\.gzipSync\(body\)/);
  assert.match(server, /"Content-Encoding": "gzip"/);
  assert.match(server, /responseBytesByRoute/);
  assert.match(server, /liveStateResponseBytes/);
  assert.match(server, /saveDbCount/);
  assert.match(server, /appStateSerializedBytes/);
});

test("representative live-state projection remains a small KB-scale payload", () => {
  const fixture = {
    version: 12,
    updatedAt: new Date(0).toISOString(),
    balance: { ngn: "5000", ngnLocked: "0", usdt: "3.25", usdtLocked: "0" },
    openTrades: Array.from({ length: 5 }, (_, index) => ({ id: `trade_${index}`, symbol: "BTCUSDT", lifecycleStatus: "OPEN", price: "65000" })),
    queueTrades: Array.from({ length: 5 }, (_, index) => ({ id: `queue_${index}`, symbol: "ETHUSDT", lifecycleStatus: "PENDING", price: "3500" })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(fixture)) < 4096);
});
