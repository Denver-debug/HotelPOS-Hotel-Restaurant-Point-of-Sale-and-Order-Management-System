// Query parameters and paging shared by every API list endpoint, so they all behave the same:
//
//   ?limit=50&offset=0          page size (1–200) and start
//   ?updatedSince=<ISO time>    incremental sync: rows changed at or after T, OLDEST FIRST
//   ?from=YYYY-MM-DD&to=…       date window on creation time (business days, `to` inclusive),
//                               NEWEST FIRST; full ISO date-times are accepted too
//
// Response: { ok: true, <resource>: [...], pagination: { limit, offset, total, hasMore, nextOffset } }
import { Op } from "sequelize";
import { AppError } from "./http.js";
import { startOfBusinessDay, addDays } from "./dates.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function instant(value, name, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (DATE_ONLY.test(text)) return endOfDay ? addDays(startOfBusinessDay(text), 1) : startOfBusinessDay(text);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(`${name} must be a date (2026-11-12) or an ISO-8601 date-time (2026-11-12T08:00:00+08:00).`, 422, "VALIDATION_ERROR");
  }
  return d;
}

export function listQuery(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
  return {
    limit,
    offset,
    updatedSince: instant(query.updatedSince, "updatedSince"),
    from: instant(query.from, "from"),
    to: instant(query.to, "to", { endOfDay: true }),
  };
}

// Sequelize where/order for the time filters. Sync order is stable: (updated_at, id).
export function timeFilter({ updatedSince, from, to }, { created = "createdAt", updated = "updatedAt" } = {}) {
  const where = {};
  if (updatedSince) where[updated] = { [Op.gte]: updatedSince };
  if (from || to) where[created] = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lt]: to } : {}) };
  const order = updatedSince ? [[updated, "ASC"], ["id", "ASC"]] : [[created, "DESC"], ["id", "DESC"]];
  return { where, order };
}

export const pageInfo = (total, { limit, offset }) => ({
  limit,
  offset,
  total,
  hasMore: offset + limit < total,
  nextOffset: offset + limit < total ? offset + limit : null,
});

// Optional numeric id filter (?outletId=3); 422 when present but not a positive integer.
export function optionalId(value, name) {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} must be a positive integer.`, 422, "VALIDATION_ERROR");
  return n;
}

// Restricts an outlet filter to the caller's outlets (an outlet they can't see matches nothing).
export const outletFilter = (req, requested) => {
  if (requested) return req.user.outletIds.includes(requested) ? requested : -1;
  return { [Op.in]: req.user.outletIds.length ? req.user.outletIds : [-1] };
};
