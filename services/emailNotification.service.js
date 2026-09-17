const { getEnvValue } = require("../lib/env");

class EmailNotificationService {
  constructor({ fetchImpl = global.fetch, logger = console } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.apiKey = String(getEnvValue("RESEND_API_KEY") || "").trim();
    this.from = String(getEnvValue("EMAIL_FROM") || "").trim();
    this.adminRecipient = String(getEnvValue("ADMIN_NOTIFICATION_EMAIL") || "netruefi@gmail.com").trim();
  }

  isConfigured() {
    return !!(this.apiKey && this.from && this.adminRecipient && this.fetchImpl);
  }

  async sendAdminOtpRequest({ productName = "Digital product", orderReference = "", customer = "", requestedAt = "" } = {}) {
    if (!this.isConfigured()) return { sent: false, reason: "not_configured" };
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [this.adminRecipient],
        subject: "NetrueFi - OTP Requested",
        text: `OTP Requested\n\nProduct: ${productName}\nOrder: ${orderReference}\nCustomer: ${customer}\nRequested: ${requestedAt}\n\nOpen NetrueFi Admin to respond.`,
      }),
    });
    if (!response.ok) throw new Error(`Admin email delivery failed with HTTP ${response.status}.`);
    return { sent: true };
  }
}

module.exports = { EmailNotificationService };
