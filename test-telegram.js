const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const { createSignalConfig } = require("./src/config/signalConfig");
const { SignalTelegramService } = require("./src/services/telegramService");

async function testTelegram() {
  const signalTelegramService = new SignalTelegramService({
    config: createSignalConfig(),
  });
  const testSignal = {
    symbol: "BTCUSDT",
    strategy: "EMA_RSI",
    entry: 67200,
    stopLoss: 66500,
    takeProfit: 69000,
    timeframe: "15m",
    confidence: 72,
  };

  await signalTelegramService.sendWithRetry(
    signalTelegramService.config.telegram.chatId,
    signalTelegramService.formatSignalMessage(testSignal)
  );
  console.log("Telegram test result:", { ok: true });
}

testTelegram().catch((error) => {
  console.error("Telegram test failed:", error.message);
  process.exit(1);
});
