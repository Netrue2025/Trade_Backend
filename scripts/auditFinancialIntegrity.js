const fs = require("fs");
const path = require("path");
const { auditFinancialIntegrity } = require("../lib/financialIntegrity");

const fileArgument = process.argv.find((value) => value.startsWith("--file="));
if (!fileArgument) {
  console.error("Read-only audit requires --file=<local-app-state.json>. No database connection is opened.");
  process.exitCode = 2;
} else {
  const filePath = path.resolve(process.cwd(), fileArgument.slice("--file=".length));
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  console.log(JSON.stringify(auditFinancialIntegrity(state), null, 2));
}
