// Sales, settlement, refund, shift and inventory analytics. All figures come from the
// database (no sample values). Filters: [start, end) business-time instants + outlets.
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { toCents, fromCents } from "../utils/money.js";
import { businessDateString, addDays, startOfBusinessDay } from "../utils/dates.js";

const SALE_STATUSES = "('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')";
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

// Builds "o.outlet_id IN (:outletIds)" plus optional extra filters.
function scope({ start, end, outletIds, outletId, cashierId, productId, methodId }, dateColumn = "o.completed_at") {
  const ids = outletId ? [Number(outletId)].filter((id) => outletIds.includes(id)) : outletIds;
  const where = [`${dateColumn} >= :start`, `${dateColumn} < :end`, "o.outlet_id IN (:outletIds)"];
  const params = { start, end, outletIds: ids.length ? ids : [0] };
  if (cashierId) { where.push("o.completed_by = :cashierId"); params.cashierId = cashierId; }
  if (productId) params.productId = productId;
  if (methodId) params.methodId = methodId;
  return { where: where.join(" AND "), params };
}

export async function salesSummary(filters) {
  const s = scope(filters);
  const [sales] = await q(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_amount),0) AS gross, COALESCE(SUM(o.tax_amount),0) AS tax,
            COALESCE(SUM(o.discount_amount),0) AS discounts, COALESCE(SUM(o.service_charge_amount),0) AS service
       FROM orders o WHERE o.status IN ${SALE_STATUSES} AND ${s.where}`,
    s.params
  );
  const p = scope(filters, "p.captured_at");
  const [direct] = await q(
    `SELECT COUNT(*) AS count, COALESCE(SUM(p.amount),0) AS amount FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED') AND ${p.where}`,
    p.params
  );
  const g = scope(filters, "g.posted_at");
  const [room] = await q(
    `SELECT COUNT(*) AS count, COALESCE(SUM(g.amount),0) AS amount FROM guest_charges g JOIN orders o ON o.id = g.order_id
      WHERE g.status IN ('POSTED','PARTIALLY_REVERSED','REVERSED') AND ${g.where}`,
    g.params
  );
  const r = scope(filters, "r.processed_at");
  const [refunds] = await q(
    `SELECT COUNT(*) AS count, COALESCE(SUM(r.amount),0) AS amount FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE r.status = 'PROCESSED' AND ${r.where}`,
    r.params
  );
  const v = scope(filters, "o.voided_at");
  const [voids] = await q(`SELECT COUNT(*) AS count, COALESCE(SUM(o.total_amount),0) AS amount FROM orders o WHERE o.status = 'VOIDED' AND ${v.where}`, v.params);
  const orders = Number(sales.orders);
  return {
    orders,
    grossSales: fromCents(toCents(sales.gross)),
    netSales: fromCents(toCents(sales.gross) - toCents(refunds.amount)),
    taxAmount: fromCents(toCents(sales.tax)),
    discountAmount: fromCents(toCents(sales.discounts)),
    serviceChargeAmount: fromCents(toCents(sales.service)),
    averageTicket: orders ? fromCents(Math.round(toCents(sales.gross) / orders)) : "0.00",
    directPayments: { count: Number(direct.count), amount: fromCents(toCents(direct.amount)) },
    roomCharges: { count: Number(room.count), amount: fromCents(toCents(room.amount)) },
    refunds: { count: Number(refunds.count), amount: fromCents(toCents(refunds.amount)) },
    voids: { count: Number(voids.count), amount: fromCents(toCents(voids.amount)) },
  };
}

export async function salesByOutlet(filters) {
  const s = scope(filters);
  return q(
    `SELECT ot.id, ot.code, ot.name, COUNT(*) AS orders, SUM(o.total_amount) AS amount
       FROM orders o JOIN outlets ot ON ot.id = o.outlet_id
      WHERE o.status IN ${SALE_STATUSES} AND ${s.where}
      GROUP BY ot.id ORDER BY amount DESC`,
    s.params
  );
}

export async function salesByProduct(filters, { limit = 1000, orderBy = "amount" } = {}) {
  const s = scope(filters);
  const productFilter = filters.productId ? "AND oi.product_id = :productId" : "";
  return q(
    `SELECT oi.product_id, oi.product_code AS code, MAX(oi.product_name) AS name, c.name AS category,
            SUM(oi.quantity - oi.quantity_refunded) AS quantity, SUM(oi.gross_amount) AS gross,
            SUM(oi.discount_amount) AS discounts, SUM(oi.line_total) AS amount, COUNT(DISTINCT o.id) AS orders
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id
      WHERE o.status IN ${SALE_STATUSES} AND ${s.where} ${productFilter}
      GROUP BY oi.product_id, oi.product_code, c.name
      ORDER BY ${orderBy === "quantity" ? "quantity" : "amount"} DESC LIMIT ${Number(limit)}`,
    s.params
  );
}

// Direct payment methods plus room charges, so the breakdown covers all settlement.
export async function paymentBreakdown(filters) {
  const p = scope(filters, "p.captured_at");
  const methodFilter = filters.methodId ? "AND p.payment_method_id = :methodId" : "";
  const methods = await q(
    `SELECT m.name AS method, COUNT(*) AS count, SUM(p.amount) AS amount, SUM(p.refunded_amount) AS refunded
       FROM payments p JOIN payment_methods m ON m.id = p.payment_method_id JOIN orders o ON o.id = p.order_id
      WHERE p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED') AND ${p.where} ${methodFilter}
      GROUP BY m.id ORDER BY amount DESC`,
    p.params
  );
  if (!filters.methodId) {
    const g = scope(filters, "g.posted_at");
    const [room] = await q(
      `SELECT COUNT(*) AS count, COALESCE(SUM(g.amount),0) AS amount, COALESCE(SUM(g.reversed_amount),0) AS refunded
         FROM guest_charges g JOIN orders o ON o.id = g.order_id
        WHERE g.status IN ('POSTED','PARTIALLY_REVERSED','REVERSED') AND ${g.where}`,
      g.params
    );
    if (Number(room.count) > 0) methods.push({ method: "Charge to room", ...room });
    methods.sort((a, b) => toCents(b.amount) - toCents(a.amount));
  }
  return methods;
}

// Daily (or weekly/monthly) sales series, filling empty days with zero.
export async function salesTrend(filters, granularity = "day") {
  const s = scope(filters);
  const fmt = { day: "%Y-%m-%d", week: "%x-W%v", month: "%Y-%m" }[granularity] || "%Y-%m-%d";
  const rows = await q(
    `SELECT DATE_FORMAT(o.completed_at, '${fmt}') AS period, COUNT(*) AS orders, SUM(o.total_amount) AS amount
       FROM orders o WHERE o.status IN ${SALE_STATUSES} AND ${s.where}
      GROUP BY period ORDER BY period`,
    s.params
  );
  if (granularity !== "day") return rows.map((r) => ({ ...r, amount: fromCents(toCents(r.amount)), orders: Number(r.orders) }));
  const byDay = new Map(rows.map((r) => [r.period, r]));
  const out = [];
  for (let d = filters.start; d < filters.end; d = addDays(d, 1)) {
    const key = businessDateString(d);
    const r = byDay.get(key);
    out.push({ period: key, orders: r ? Number(r.orders) : 0, amount: r ? fromCents(toCents(r.amount)) : "0.00" });
  }
  return out;
}

export async function recentTransactions(filters, limit = 10) {
  const s = scope({ ...filters, start: new Date(0), end: new Date(Date.now() + 86400000) }, "o.updated_at");
  return q(
    `SELECT o.id, o.order_number, o.status, o.settlement_type, o.total_amount, o.completed_at, o.updated_at, ot.code AS outlet_code,
            (SELECT g.room_number FROM guest_charges g WHERE g.order_id = o.id AND g.status IN ('POSTED','PARTIALLY_REVERSED','REVERSED') LIMIT 1) AS room_number
       FROM orders o JOIN outlets ot ON ot.id = o.outlet_id
      WHERE o.status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED','VOIDED') AND ${s.where}
      ORDER BY o.updated_at DESC LIMIT ${Number(limit)}`,
    s.params
  );
}

export async function cashierPerformance(filters) {
  const s = scope(filters);
  return q(
    `SELECT u.id, u.full_name AS cashier, COUNT(*) AS orders, SUM(o.total_amount) AS amount,
            AVG(o.total_amount) AS average, SUM(o.discount_amount) AS discounts,
            SUM(CASE WHEN o.settlement_type = 'ROOM_CHARGE' THEN 1 ELSE 0 END) AS room_charges
       FROM orders o JOIN users u ON u.id = o.completed_by
      WHERE o.status IN ${SALE_STATUSES} AND ${s.where}
      GROUP BY u.id ORDER BY amount DESC`,
    s.params
  );
}

export async function roomChargeReport(filters) {
  const g = scope(filters, "g.created_at");
  return q(
    `SELECT g.id, g.charge_number, g.room_number, g.external_folio_id, g.pms_transaction_id, g.amount, g.reversed_amount, g.status,
            g.created_at, g.posted_at, o.id AS order_id, o.order_number, ot.code AS outlet_code, u.full_name AS requested_by
       FROM guest_charges g JOIN orders o ON o.id = g.order_id JOIN outlets ot ON ot.id = o.outlet_id JOIN users u ON u.id = g.requested_by
      WHERE ${g.where} ORDER BY g.created_at DESC`,
    g.params
  );
}

export async function refundVoidReport(filters) {
  const r = scope(filters, "r.created_at");
  const refunds = await q(
    `SELECT r.id, r.refund_number, r.refund_type, r.settlement_type, r.amount, r.reason, r.status, r.created_at, r.processed_at,
            o.id AS order_id, o.order_number, ot.code AS outlet_code, ur.full_name AS requested_by, ua.full_name AS approved_by
       FROM refunds r JOIN orders o ON o.id = r.order_id JOIN outlets ot ON ot.id = o.outlet_id
       JOIN users ur ON ur.id = r.requested_by LEFT JOIN users ua ON ua.id = r.approved_by
      WHERE ${r.where} ORDER BY r.created_at DESC`,
    r.params
  );
  const v = scope(filters, "o.voided_at");
  const voids = await q(
    `SELECT o.id AS order_id, o.order_number, o.total_amount, o.void_reason, o.voided_at, ot.code AS outlet_code,
            uc.full_name AS created_by, uv.full_name AS voided_by
       FROM orders o JOIN outlets ot ON ot.id = o.outlet_id JOIN users uc ON uc.id = o.created_by LEFT JOIN users uv ON uv.id = o.voided_by
      WHERE o.status = 'VOIDED' AND ${v.where} ORDER BY o.voided_at DESC`,
    v.params
  );
  return { refunds, voids };
}

export async function shiftReport(filters) {
  const ids = filters.outletId ? [Number(filters.outletId)].filter((id) => filters.outletIds.includes(id)) : filters.outletIds;
  const where = ["s.opened_at >= :start", "s.opened_at < :end", "s.outlet_id IN (:outletIds)"];
  const params = { start: filters.start, end: filters.end, outletIds: ids.length ? ids : [0] };
  if (filters.cashierId) { where.push("s.user_id = :cashierId"); params.cashierId = filters.cashierId; }
  return q(
    `SELECT s.id, s.shift_number, s.status, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash, s.actual_cash, s.cash_variance,
            u.full_name AS cashier, ot.code AS outlet_code,
            (SELECT COUNT(*) FROM orders o2 WHERE o2.shift_id = s.id AND o2.status IN ${SALE_STATUSES}) AS orders,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.shift_id = s.id AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')) AS collections
       FROM shifts s JOIN users u ON u.id = s.user_id JOIN outlets ot ON ot.id = s.outlet_id
      WHERE ${where.join(" AND ")} ORDER BY s.opened_at DESC`,
    params
  );
}

export async function inventoryMovementReport(filters) {
  const where = ["t.created_at >= :start", "t.created_at < :end", "l.outlet_id IN (:outletIds)"];
  const ids = filters.outletId ? [Number(filters.outletId)].filter((id) => filters.outletIds.includes(id)) : filters.outletIds;
  const params = { start: filters.start, end: filters.end, outletIds: ids.length ? ids : [0] };
  return q(
    `SELECT i.sku, i.name, i.unit, ot.code AS outlet_code,
            SUM(CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END) AS qty_in,
            SUM(CASE WHEN t.quantity < 0 THEN -t.quantity ELSE 0 END) AS qty_out,
            SUM(CASE WHEN t.transaction_type = 'SALE' THEN -t.quantity ELSE 0 END) AS sold,
            SUM(CASE WHEN t.transaction_type IN ('DAMAGE','WASTE') THEN -t.quantity ELSE 0 END) AS lost,
            SUM(t.quantity) AS net, COUNT(*) AS movements
       FROM inventory_transactions t JOIN inventory_items i ON i.id = t.inventory_item_id
       JOIN stock_locations l ON l.id = t.stock_location_id JOIN outlets ot ON ot.id = l.outlet_id
      WHERE ${where.join(" AND ")}
      GROUP BY i.id, ot.id ORDER BY ot.code, i.name`,
    params
  );
}

export async function lowStockReport(outletIds) {
  return q(
    `SELECT i.sku, i.name, i.unit, ot.code AS outlet_code, ot.name AS outlet_name, sl.quantity, sl.reorder_level
       FROM stock_levels sl JOIN inventory_items i ON i.id = sl.inventory_item_id
       JOIN stock_locations l ON l.id = sl.stock_location_id JOIN outlets ot ON ot.id = l.outlet_id
      WHERE sl.quantity <= sl.reorder_level AND l.outlet_id IN (:outletIds) AND i.status = 'ACTIVE'
      ORDER BY (sl.quantity - sl.reorder_level) ASC`,
    { outletIds: outletIds.length ? outletIds : [0] }
  );
}

// Helper: a business-day range ending at `to` covering `days` days.
export function dayRange(to, days) {
  const end = addDays(startOfBusinessDay(to), 1);
  return { start: addDays(end, -days), end };
}
