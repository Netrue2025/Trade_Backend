const { add, compare, multiplyRatio } = require("../lib/money");
const { randomId } = require("../lib/security");

function cleanText(value, limit = 160) {
  return String(value || "").trim().slice(0, limit);
}

class NairaExchangeService {
  constructor({ db, financialService }) {
    this.db = db;
    this.financialService = financialService;
  }

  assertNigeriaAccount(user) {
    if (user?.role !== "user" || user.countryCode !== "NG") {
      const error = new Error("Naira exchange is available only to accounts registered in Nigeria. Enable location in Settings if you are in Nigeria.");
      error.statusCode = 403;
      throw error;
    }
  }

  getSettings(user) {
    this.assertNigeriaAccount(user);
    const settings = this.financialService.getSettings();
    const rate = String(settings.exchangeRate?.usdtToNgn || "0");
    return {
      rate,
      bank: {
        bankName: cleanText(settings.deposit?.bankName),
        accountName: cleanText(settings.deposit?.accountName),
        accountNumber: cleanText(settings.deposit?.accountNumber),
      },
      wallet: {
        address: cleanText(settings.deposit?.usdtAddress),
        network: cleanText(settings.deposit?.usdtNetwork || "TRC20"),
      },
    };
  }

  list(user) {
    this.assertNigeriaAccount(user);
    return (this.db.exchangeRequests || []).filter((item) => item.userId === user.id).map((item) => ({ ...item }));
  }

  listAdmin() {
    return (this.db.exchangeRequests || []).map((item) => ({
      ...item,
      userName: this.db.users.find((user) => user.id === item.userId)?.name || "User",
    }));
  }

  create(user, input = {}) {
    const quote = this.getSettings(user);
    const side = cleanText(input.side, 8).toUpperCase();
    if (!["BUY", "SELL"].includes(side)) throw new Error("Choose Buy or Sell USDT.");
    const amount = cleanText(input.amount, 32).replace(/,/g, "");
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(amount) || compare(amount, "0") <= 0) {
      throw new Error("Enter a valid amount greater than zero.");
    }
    if (compare(quote.rate, "0") <= 0) throw new Error("The exchange rate has not been configured by an admin.");
    const settings = this.financialService.getSettings();
    const min = side === "BUY" ? settings.deposit?.minNgn || "1000" : settings.deposit?.minUsdt || "1";
    const max = side === "BUY" ? settings.deposit?.maxNgn || "1000000000" : settings.deposit?.maxUsdt || "1000000";
    if (compare(amount, min) < 0 || compare(amount, max) > 0) throw new Error(`Amount must be between ${min} and ${max} ${side === "BUY" ? "NGN" : "USDT"}.`);
    const paymentDestination = side === "BUY" ? quote.bank : quote.wallet;
    if (side === "BUY" && (!paymentDestination.bankName || !paymentDestination.accountNumber || !paymentDestination.accountName)) {
      throw new Error("The receiving bank account has not been configured by an admin.");
    }
    if (side === "SELL" && (!paymentDestination.address || !paymentDestination.network)) {
      throw new Error("The receiving USDT wallet has not been configured by an admin.");
    }
    const clientRequestId = cleanText(input.clientRequestId, 80);
    const duplicate = clientRequestId && (this.db.exchangeRequests || []).find((item) => item.userId === user.id && item.clientRequestId === clientRequestId);
    if (duplicate) return { ...duplicate };
    const receiveAmount = side === "BUY"
      ? multiplyRatio(amount, "1", quote.rate)
      : multiplyRatio(amount, quote.rate, "1");
    if (compare(receiveAmount, "0") <= 0) throw new Error("Amount is too small at the current rate.");
    const request = {
      id: randomId(12), userId: user.id, clientRequestId, side, amount,
      payCurrency: side === "BUY" ? "NGN" : "USDT",
      receiveAmount, receiveCurrency: side === "BUY" ? "USDT" : "NGN",
      rate: quote.rate, paymentDestination, paymentReference: "",
      status: "AWAITING_PAYMENT", createdAt: new Date().toISOString(),
      submittedAt: null, reviewedAt: null, reviewedBy: null, adminNote: "",
    };
    this.db.exchangeRequests.unshift(request);
    return { ...request };
  }

  submitPayment(user, requestId, input = {}) {
    this.assertNigeriaAccount(user);
    const request = (this.db.exchangeRequests || []).find((item) => item.id === requestId && item.userId === user.id);
    if (!request) throw Object.assign(new Error("Exchange request not found."), { statusCode: 404 });
    if (request.status === "PENDING" && request.paymentReference === cleanText(input.paymentReference, 160)) return { ...request };
    if (request.status !== "AWAITING_PAYMENT") throw new Error("This exchange request can no longer accept payment details.");
    const paymentReference = cleanText(input.paymentReference, 160);
    if (paymentReference.length < 6) throw new Error("Enter the bank transfer reference or USDT transaction hash.");
    if ((this.db.exchangeRequests || []).some((item) => item.id !== request.id && item.paymentReference && item.paymentReference.toLowerCase() === paymentReference.toLowerCase())) {
      throw new Error("This payment reference has already been submitted.");
    }
    request.paymentReference = paymentReference;
    request.status = "PENDING";
    request.submittedAt = new Date().toISOString();
    this.financialService.notifyAdmins({
      type: "EXCHANGE", category: "adminEvents", title: "USDT exchange payment",
      message: `${user.name || user.email} submitted ${request.amount} ${request.payCurrency} for ${request.side === "BUY" ? "buying" : "selling"} USDT. Verify the payment before approval.`,
      entityType: "Exchange", entityId: request.id, route: "/dashboard?tab=home",
      dedupeKey: `admin:exchange:${request.id}`,
    });
    return { ...request };
  }

  approve(admin, requestId, input = {}) {
    const request = (this.db.exchangeRequests || []).find((item) => item.id === requestId);
    if (!request) throw Object.assign(new Error("Exchange request not found."), { statusCode: 404 });
    if (request.status === "APPROVED") return { request: { ...request }, wallet: null, duplicate: true };
    if (request.status !== "PENDING" || !request.paymentReference) throw new Error("Only paid requests awaiting review can be approved.");
    if (this.db.transactions.some((item) => item.reference === request.id && item.type === `EXCHANGE_${request.side}`)) {
      throw new Error("This exchange request already has a wallet credit and needs review.");
    }
    const wallet = this.financialService.ensureWallet(request.userId, request.receiveCurrency);
    const balanceBefore = wallet.availableBalance;
    wallet.availableBalance = add(balanceBefore, request.receiveAmount);
    wallet.updatedAt = new Date().toISOString();
    request.status = "APPROVED";
    request.reviewedAt = wallet.updatedAt;
    request.reviewedBy = admin.id;
    request.adminNote = cleanText(input.adminNote, 500);
    this.db.transactions.unshift({
      id: randomId(12), userId: request.userId, type: `EXCHANGE_${request.side}`,
      currency: request.receiveCurrency, amount: request.receiveAmount,
      balanceBefore, balanceAfter: wallet.availableBalance, reference: request.id,
      status: "APPROVED", description: `${request.side === "BUY" ? "Bought" : "Sold"} USDT at ${request.rate} NGN per USDT.`,
      createdBy: admin.id, createdAt: wallet.updatedAt,
      metadata: { exchangeRequestId: request.id, rate: request.rate, payAmount: request.amount, payCurrency: request.payCurrency, principalCredit: true },
    });
    this.financialService.createNotification({ userId: request.userId, type: "EXCHANGE", title: "Exchange approved", message: `${request.receiveAmount} ${request.receiveCurrency} has been added to your balance.`, entityType: "Exchange", entityId: request.id, route: "/dashboard?tab=exchange" });
    return { request: { ...request }, wallet, duplicate: false };
  }

  reject(admin, requestId, input = {}) {
    const request = (this.db.exchangeRequests || []).find((item) => item.id === requestId);
    if (!request) throw Object.assign(new Error("Exchange request not found."), { statusCode: 404 });
    if (request.status !== "PENDING") throw new Error("Only requests awaiting review can be rejected.");
    request.status = "REJECTED";
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = admin.id;
    request.adminNote = cleanText(input.adminNote, 500);
    this.financialService.createNotification({ userId: request.userId, type: "EXCHANGE", title: "Exchange request declined", message: request.adminNote || "Your payment could not be verified. Contact support if you have already paid.", entityType: "Exchange", entityId: request.id, route: "/dashboard?tab=exchange" });
    return { ...request };
  }
}

module.exports = { NairaExchangeService };
