// Date helpers that respect the configured business timezone (APP_TIMEZONE, e.g. +08:00).
import { config } from "../config/env.js";

const offsetMinutes = (() => {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(config.timezone);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
})();

const shift = (date) => new Date(date.getTime() + offsetMinutes * 60000);
const pad = (n, w = 2) => String(n).padStart(w, "0");

// YYYYMMDD in business time.
export const businessDateKey = (date = new Date()) => {
  const d = shift(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

// YYYY-MM-DD in business time (for <input type="date"> values).
export const businessDateString = (date = new Date()) => {
  const d = shift(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

// Converts a YYYY-MM-DD business date to the UTC instant of its local midnight.
export const startOfBusinessDay = (dateString) => {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - offsetMinutes * 60000);
};

export const addDays = (date, days) => new Date(date.getTime() + days * 86400000);

// Parses ?from=YYYY-MM-DD&to=YYYY-MM-DD into [start, endExclusive) instants; defaults to `defaultDays` back.
export const parseDateRange = (query, defaultDays = 0) => {
  const valid = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const today = businessDateString();
  const to = valid(query.to) ? query.to : today;
  const from = valid(query.from) ? query.from : businessDateString(addDays(startOfBusinessDay(to), -defaultDays));
  const start = startOfBusinessDay(from);
  const end = addDays(startOfBusinessDay(to), 1);
  return start < end ? { from, to, start, end } : { from: to, to, start: startOfBusinessDay(to), end };
};

export const formatDateTime = (value) => {
  if (!value) return "";
  const d = shift(new Date(value));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export const formatDate = (value) => (value ? formatDateTime(value).slice(0, 10) : "");

// Value for <input type="datetime-local"> in business time.
export const toDateTimeLocal = (value) => (value ? formatDateTime(value).replace(" ", "T") : "");

// Parses a datetime-local string as business time.
export const fromDateTimeLocal = (value) => {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetMinutes * 60000);
};
