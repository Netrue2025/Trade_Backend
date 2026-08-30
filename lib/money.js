const SCALE = 8n;
const UNIT = 10n ** SCALE;

function assertDecimalText(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new Error("Amount must be a valid decimal number.");
  }
  return text;
}

function toUnits(value) {
  const text = assertDecimalText(value);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, rawFraction = ""] = unsigned.split(".");

  if (rawFraction.length > Number(SCALE) && /[1-9]/.test(rawFraction.slice(Number(SCALE)))) {
    throw new Error(`Amount supports up to ${SCALE} decimal places.`);
  }

  const fraction = rawFraction.slice(0, Number(SCALE)).padEnd(Number(SCALE), "0");
  const units = BigInt(whole || "0") * UNIT + BigInt(fraction || "0");
  return negative ? -units : units;
}

function fromUnits(units) {
  const value = BigInt(units);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / UNIT;
  const fraction = String(absolute % UNIT).padStart(Number(SCALE), "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function add(a, b) {
  return fromUnits(toUnits(a) + toUnits(b));
}

function subtract(a, b) {
  return fromUnits(toUnits(a) - toUnits(b));
}

function compare(a, b) {
  const left = toUnits(a);
  const right = toUnits(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

function isPositive(value) {
  return compare(value, "0") > 0;
}

function multiplyRatio(amount, numerator, denominator) {
  const denominatorUnits = toUnits(denominator);
  if (denominatorUnits === 0n) {
    throw new Error("Cannot divide by zero.");
  }
  return fromUnits((toUnits(amount) * toUnits(numerator)) / denominatorUnits);
}

function percentChange(starting, ending) {
  const startingUnits = toUnits(starting);
  if (startingUnits === 0n) {
    throw new Error("Starting capital must be greater than zero.");
  }
  const changeUnits = toUnits(ending) - startingUnits;
  return fromUnits((changeUnits * 100n * UNIT) / startingUnits);
}

function clampDebit(amount, available) {
  return compare(amount, available) > 0 ? fromUnits(toUnits(available)) : fromUnits(toUnits(amount));
}

module.exports = {
  add,
  clampDebit,
  compare,
  fromUnits,
  isPositive,
  multiplyRatio,
  percentChange,
  subtract,
  toUnits,
};
