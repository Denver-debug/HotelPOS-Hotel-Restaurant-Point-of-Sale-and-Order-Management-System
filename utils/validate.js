// Small backend validators. Each returns the cleaned value or throws a 422 AppError.
import { AppError } from "./http.js";
import { toCents, fromCents, toMilli, fromMilli } from "./money.js";

const fail = (message, field) => {
  throw new AppError(message, 422, "VALIDATION_ERROR", field ? { field } : undefined);
};

export const str = (value, label, { required = false, max = 255, min = 0, pattern, patternMessage } = {}) => {
  const v = value === undefined || value === null ? "" : String(value).trim();
  if (!v) {
    if (required) fail(`${label} is required.`);
    return null;
  }
  if (v.length > max) fail(`${label} must be at most ${max} characters.`);
  if (v.length < min) fail(`${label} must be at least ${min} characters.`);
  if (pattern && !pattern.test(v)) fail(patternMessage || `${label} has an invalid format.`);
  return v;
};

export const code = (value, label, opts = {}) =>
  str(value, label, {
    max: 40,
    ...opts,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    patternMessage: `${label} may only contain letters, numbers, dots, dashes and underscores.`,
  })?.toUpperCase() ?? null;

export const email = (value, label = "Email", opts = {}) =>
  str(value, label, { max: 160, ...opts, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMessage: "Enter a valid email address." });

// Returns a 2-decimal string.
export const money = (value, label, { required = true, min = 0, max = 99999999.99 } = {}) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const cents = toCents(value);
  if (cents === null) fail(`${label} must be a valid amount.`);
  if (cents < toCents(min)) fail(`${label} must be at least ${fromCents(toCents(min))}.`);
  if (cents > toCents(max)) fail(`${label} is too large.`);
  return fromCents(cents);
};

// Returns a 3-decimal string.
export const quantity = (value, label = "Quantity", { required = true, allowZero = false, allowNegative = false, max = 99999 } = {}) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const milli = toMilli(value);
  if (milli === null) fail(`${label} must be a number.`);
  if (!allowNegative && milli < 0) fail(`${label} cannot be negative.`);
  if (!allowZero && milli === 0) fail(`${label} must not be zero.`);
  if (Math.abs(milli) > max * 1000) fail(`${label} is too large.`);
  return fromMilli(milli);
};

export const percent = (value, label, { required = true } = {}) => {
  const v = money(value, label, { required, min: 0, max: 100 });
  return v;
};

export const int = (value, label, { required = true, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} is invalid.`);
  return n;
};

export const id = (value, label = "ID", opts = {}) => int(value, label, { min: 1, ...opts });

export const oneOf = (value, label, allowed, { required = true, fallback = null } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${label} is required.`);
    return fallback;
  }
  const v = String(value).toUpperCase();
  if (!allowed.includes(v)) fail(`${label} must be one of: ${allowed.join(", ")}.`);
  return v;
};

export const bool = (value) => ["1", "true", "on", "yes"].includes(String(value ?? "").toLowerCase()) || value === true;

export const date = (value, label, { required = false } = {}) => {
  if (!value) {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${label} is not a valid date.`);
  return d;
};

// Accepts a single value or array (from repeated form fields) and returns unique positive ints.
export const idList = (value) => {
  const arr = Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value];
  return [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
};
