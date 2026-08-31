class SignalController {
  constructor({ signalEngine, logger = console } = {}) {
    this.signalEngine = signalEngine;
    this.logger = logger;
  }

  async getSnapshot() {
    await this.signalEngine.refreshSnapshot();
    return this.signalEngine.getSnapshot();
  }

  async getChart({ pair, signalId }) {
    return this.signalEngine.getChartSnapshot(pair, signalId);
  }

  async deleteSignals(signalIds = []) {
    return this.signalEngine.deleteSignals(signalIds);
  }

  async updateTimeframe(timeframe) {
    return this.signalEngine.setTimeframe(timeframe);
  }

  async receiveSignal(payload) {
    return this.signalEngine.receiveSignal(payload);
  }
}

module.exports = {
  SignalController,
};
