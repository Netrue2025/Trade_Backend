const REQUIRED_DEPOSIT_APPROVAL_FIELDS = Object.freeze(["meta", "users", "deposits", "wallets", "transactions"]);
const OPTIONAL_DEPOSIT_APPROVAL_FIELDS = Object.freeze(["notifications", "auditLogs"]);

class DepositApprovalService {
  constructor({ financialService, withUserFinancialLock, markFinancialMutation, persist, completeDurableMutation } = {}) {
    this.financialService = financialService;
    this.withUserFinancialLock = withUserFinancialLock;
    this.markFinancialMutation = markFinancialMutation;
    this.persist = persist;
    this.completeDurableMutation = completeDurableMutation;
  }

  async approve(admin, depositId, input = {}, requestMeta = {}) {
    const current = this.financialService.getDeposit(depositId);
    return this.withUserFinancialLock(current.userId, async () => {
      const approval = this.financialService.mutateDepositApproval(admin, depositId, input);
      if (approval.duplicate) return approval;
      const wallet = this.financialService.ensureWallet(approval.deposit.userId, approval.deposit.currency);
      this.markFinancialMutation(wallet, "DEPOSIT_APPROVAL", approval.deposit.id);
      await this.persist({
        required: true,
        operation: { reason: "DEPOSIT_APPROVAL", reference: approval.deposit.id, userId: approval.deposit.userId },
        fields: REQUIRED_DEPOSIT_APPROVAL_FIELDS,
      });
      this.completeDurableMutation();
      this.financialService.recordDepositApprovalSideEffects(admin, approval.deposit, requestMeta);
      void Promise.resolve(this.persist({
        bestEffort: true,
        operation: { reason: "DEPOSIT_APPROVAL_SIDE_EFFECTS", reference: approval.deposit.id },
        fields: OPTIONAL_DEPOSIT_APPROVAL_FIELDS,
      })).catch(() => undefined);
      return approval;
    });
  }
}

module.exports = { DepositApprovalService, REQUIRED_DEPOSIT_APPROVAL_FIELDS, OPTIONAL_DEPOSIT_APPROVAL_FIELDS };
