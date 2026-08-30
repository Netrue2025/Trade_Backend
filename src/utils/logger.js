function createLogger(scope = "app") {
  function write(level, args) {
    const prefix = `[${new Date().toISOString()}] [${scope}] [${level}]`;
    console[level === "debug" ? "log" : level](prefix, ...args);
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

module.exports = {
  createLogger,
};
