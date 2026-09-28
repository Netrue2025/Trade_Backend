"use strict";

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const mongoEnvKeys = [
  "MONGODB_URI", "MONGO_URI", "MONGO_URL", "DATABASE_URL",
  "mongodb_URI", "mongodb_uri", "mongo_URI", "mongo_uri",
  "mongo_URL", "mongo_url", "database_URL", "database_url",
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Timed out waiting for local health endpoint.")));
  });
}

function waitForOutput(child, pattern, output) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup output did not include ${pattern}.\n${output.value}`)), 8000);
    const check = () => {
      if (pattern.test(output.value)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before health check (code=${code}, signal=${signal}).\n${output.value}`));
    });
    check();
  });
}

test("minimal core production entrypoint boots without Mongo writes or optional workers", async (t) => {
  const port = await getFreePort();
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    FINANCIAL_RECOVERY_MODE: "true",
    FINANCIAL_RECOVERY_ALLOW_DEPOSITS: "false",
    FINANCIAL_RECOVERY_ALLOW_WITHDRAWALS: "false",
  };
  delete env.NODE_TEST_CONTEXT;
  for (const key of mongoEnvKeys) env[key] = "";

  const output = { value: "" };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  });

  await waitForOutput(child, /minimal core active; optional workers are disabled/, output);
  const health = await getJson(`http://127.0.0.1:${port}/api/health`);
  const payload = JSON.parse(health.body);

  assert.equal(health.status, 200);
  assert.equal(payload.storage, "local-json");
  assert.equal(payload.minimalCoreMode, true);
  assert.equal(payload.authoritativeStateLoaded, true);
  assert.equal(payload.startupBarrierPassed, true);
  assert.equal(payload.financialIntegrity.persistenceFrozen, false);
  assert.doesNotMatch(output.value, /Signal receiver is ready|Telegram trade listener is running|Telegram bot polling mode active|save started/);
});
