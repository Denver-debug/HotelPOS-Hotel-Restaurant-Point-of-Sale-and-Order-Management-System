// Exact money/quantity arithmetic. Money is handled as integer centavos and
// quantities as integer thousandths so no floating point rounding leaks into totals.

const parseScaled = (value, scale) => {
  if (value === null || value === undefined || value === "") return null;
  const str = typeof value === "number" ? value.toFixed(scale + 2) : String(value).trim().replace(/,/g, "");
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(str);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;
  const sign = match[1] ? -1 : 1;
  const whole = match[2] || "0";
  const frac = (match[3] || "").padEnd(scale + 1, "0");
  let scaled = Number(whole) * 10 ** scale + Number(frac.slice(0, scale) || 0);
  if (Number(frac[scale]) >= 5) scaled += 1; // round half up on the next digit
  return sign * scaled;
};

export const toCents = (value) => parseScaled(value, 2);
export const toMilli = (value) => parseScaled(value, 3);

const formatScaled = (scaled, scale) => {
  const sign = scaled < 0 ? "-" : "";
  const abs = Math.abs(Math.round(scaled));
  const base = 10 ** scale;
  return `${sign}${Math.floor(abs / base)}.${String(abs % base).padStart(scale, "0")}`;
};

export const fromCents = (cents) => formatScaled(cents, 2);
export const fromMilli = (milli) => formatScaled(milli, 3);

// Round a (possibly fractional) cent value to whole cents, half away from zero.
export const roundCents = (value) => (value < 0 ? -Math.round(-value) : Math.round(value));

export const formatMoney = (value, symbol = "₱") => {
  const cents = toCents(value ?? 0) ?? 0;
  const [whole, frac] = fromCents(cents).replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}${symbol}${grouped}.${frac}`;
};

// Formats a decimal quantity without trailing zeros (2.000 -> "2", 1.250 -> "1.25").
export const formatQty = (value) => {
  const milli = toMilli(value ?? 0) ?? 0;
  return fromMilli(milli).replace(/\.?0+$/, "");
};
