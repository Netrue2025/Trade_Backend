const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const socketService = fs.readFileSync(path.join(__dirname, "..", "src", "services", "socketSignalService.js"), "utf8");

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
  assert.doesNotMatch(server, /LIVE_STATE_WS_PATH|liveStateWss|\/ws\/live-state/);
  assert.match(server, /digital-services\/pending-status[\s\S]*?requireAuth\(req, res\)/);
  assert.match(server, /digital-services\\\/orders\\\/\(\[\^\/\]\+\)\\\/status\$\/\)[\s\S]*?requireAuth\(req, res\)/);
});

test("one authenticated Socket.IO namespace scopes private realtime events by user", () => {
  assert.match(socketService, /this\.namespace = this\.io\.of\("\/signals"\)/);
  assert.match(socketService, /this\.namespace\.use\(\(socket, next\)/);
  assert.match(socketService, /socket\.join\(`user:\$\{user\.id\}`\)/);
  assert.match(socketService, /this\.namespace\.to\(`user:\$\{userId\}`\)\.emit/);
  assert.match(server, /emitToUser\(userId, "live_state_changed", \{ version: liveStateVersion \}\)/);
  assert.doesNotMatch(socketService, /signals:snapshot", payload/);
});

test("private realtime event payloads contain identifiers and status metadata only", () => {
  assert.match(server, /"order_ready", \{ orderId: current\.orderReady\.id, status: current\.orderReady\.status \}/);
  assert.match(server, /"otp_ready", \{ orderId: current\.otpReady\.id \}/);
  const otpEvent = server.match(/emitToUser\(userId, "otp_ready", \{[^}]+\}\)/)?.[0] || "";
  assert.equal(otpEvent, 'emitToUser(userId, "otp_ready", { orderId: current.otpReady.id })');
  assert.doesNotMatch(server, /emitToUser\([^\n]*(password|apiKey|delivery|secret)/i);
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

test("admin user and trade participant reads are paginated, authorized, and persistence-free", () => {
  const usersRoute = server.match(/if \(req\.method === "GET" && url\.pathname === "\/api\/admin\/users"\)[\s\S]*?const adminTradeParticipantsMatch/)?.[0] || "";
  assert.match(usersRoute, /requireAuth\(req, res, "admin"\)/);
  assert.match(usersRoute, /url\.searchParams\.get\("page"\)/);
  assert.match(usersRoute, /url\.searchParams\.get\("limit"\)/);
  assert.match(usersRoute, /url\.searchParams\.get\("search"\)/);
  assert.match(usersRoute, /hasMore:/);
  assert.doesNotMatch(usersRoute, /persist\(|saveDb|scanDuplicateUserReviews/);

  const participantsRoute = server.match(/const adminTradeParticipantsMatch[\s\S]*?const adminUserFinanceMatch/)?.[0] || "";
  assert.match(participantsRoute, /requireAuth\(req, res, "admin"\)/);
  assert.match(participantsRoute, /getTradeJoinedUsersSummary\(trade\)/);
  assert.match(participantsRoute, /participants: summary\.users/);
  assert.doesNotMatch(participantsRoute, /persist\(|saveDb/);
});

test("trade settlement persists financial state before creating its success notification", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function settleTradeInvestment");
  const end = source.indexOf("async function settleInactiveTradeInvestmentsForUsers", start);
  const settlement = source.slice(start, end);
  const requiredSave = settlement.indexOf("fields: [\"meta\", \"tradeInvestments\", \"wallets\", \"transactions\"]");
  const notification = settlement.indexOf("financialService.createNotification");
  const bestEffortSave = settlement.indexOf("persist({ bestEffort: true })", notification);

  assert.ok(requiredSave >= 0);
  assert.ok(notification > requiredSave);
  assert.ok(bestEffortSave > notification);
  assert.doesNotMatch(settlement.slice(0, requiredSave), /createNotification/);
});
