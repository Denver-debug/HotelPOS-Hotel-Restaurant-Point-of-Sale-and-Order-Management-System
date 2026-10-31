// Cashier shifts: open with a cash float, close with a cash count, reconcile.
// Expected cash = opening cash + captured cash payments − processed cash refunds.
import { Op, QueryTypes } from "sequelize";
import { sequelize, Shift, Outlet, User } from "../models/index.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toCents, fromCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";

export async function getOpenShift(userId, transaction) {
  return Shift.findOne({ where: { userId, status: "OPEN" }, transaction });
}

export async function openShift(req, body) {
  const outletId = v.id(body.outletId, "Outlet");
  const openingCash = v.money(body.openingCash, "Opening cash", { min: 0 });
  const openingNotes = v.str(body.openingNotes, "Notes", { max: 255 });
  if (!req.user.outletIds.includes(outletId)) throw forbidden("You are not assigned to this outlet.");

  return sequelize.transaction(async (transaction) => {
    const outlet = await Outlet.findByPk(outletId, { transaction });
    if (!outlet || outlet.status !== "ACTIVE") throw new AppError("The selected outlet is not active.", 422);
    const existing = await getOpenShift(req.user.id, transaction);
    if (existing) throw new AppError(`You already have an open shift (${existing.shiftNumber}). Close it before opening another.`, 409);
    const shift = await Shift.create(
      { shiftNumber: await nextNumber("shift", transaction), userId: req.user.id, outletId, openingCash, openingNotes, openedAt: new Date() },
      { transaction }
    );
    await audit({ req, action: "SHIFT_OPENED", entityType: "shift", entityId: shift.id, newValues: { shiftNumber: shift.shiftNumber, outletId, openingCash }, transaction });
    return shift;
  });
}

export async function expectedCash(shift, transaction) {
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN payment_methods m ON m.id = p.payment_method_id
         WHERE p.shift_id = :id AND m.is_cash = 1 AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')) AS cash_in,
       (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r JOIN payment_methods m ON m.id = r.refund_method_id
         WHERE r.shift_id = :id AND m.is_cash = 1 AND r.status = 'PROCESSED') AS cash_out`,
    { replacements: { id: shift.id }, type: QueryTypes.SELECT, transaction }
  );
  const expected = toCents(shift.openingCash) + toCents(row.cash_in) - toCents(row.cash_out);
  return { cashIn: fromCents(toCents(row.cash_in)), cashOut: fromCents(toCents(row.cash_out)), expected: fromCents(expected) };
}

// Shift reconciliation report data.
export async function shiftSummary(shift) {
  const id = shift.id;
  const q = (sql) => sequelize.query(sql, { replacements: { id }, type: QueryTypes.SELECT });
  const [byMethod, orders, roomCharges, refunds, discounts, cash] = await Promise.all([
    q(`SELECT m.name, m.is_cash, COUNT(*) AS count, SUM(p.amount) AS amount
         FROM payments p JOIN payment_methods m ON m.id = p.payment_method_id
        WHERE p.shift_id = :id AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')
        GROUP BY m.id ORDER BY m.sort_order`),
    q(`SELECT status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount FROM orders WHERE shift_id = :id GROUP BY status`),
    q(`SELECT COUNT(*) AS count, COALESCE(SUM(gc.amount), 0) AS amount FROM guest_charges gc JOIN orders o ON o.id = gc.order_id
        WHERE o.shift_id = :id AND gc.status IN ('POSTED','PARTIALLY_REVERSED','REVERSED')`),
    q(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM refunds WHERE shift_id = :id AND status = 'PROCESSED'`),
    q(`SELECT COUNT(*) AS count, COALESCE(SUM(od.amount), 0) AS amount FROM order_discounts od JOIN orders o ON o.id = od.order_id
        WHERE o.shift_id = :id AND o.status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')`),
    expectedCash(shift),
  ]);
  const completed = orders.filter((o) => ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(o.status));
  return {
    byMethod,
    orders,
    completedCount: completed.reduce((s, o) => s + Number(o.count), 0),
    grossSales: fromCents(completed.reduce((s, o) => s + toCents(o.amount), 0)),
    roomCharges: roomCharges[0],
    refunds: refunds[0],
    discounts: discounts[0],
    cash,
  };
}

const assertCanActOn = (req, shift) => {
  if (shift.userId !== req.user.id && !req.permissions.has("shifts.manage")) {
    throw forbidden("Only a supervisor can close another cashier's shift.");
  }
};

export async function closeShift(req, id, body) {
  const actualCash = v.money(body.actualCash, "Actual cash count", { min: 0 });
  const closingNotes = v.str(body.closingNotes, "Notes", { max: 255 });

  return sequelize.transaction(async (transaction) => {
    const shift = await Shift.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!shift) throw notFound("Shift");
    assertCanActOn(req, shift);
    if (shift.status !== "OPEN") throw new AppError("This shift is already closed.", 409);

    const [{ inflight }] = await sequelize.query(
      `SELECT (SELECT COUNT(*) FROM payments WHERE shift_id = :id AND status = 'PENDING')
            + (SELECT COUNT(*) FROM orders WHERE shift_id = :id AND status = 'SETTLING') AS inflight`,
      { replacements: { id }, type: QueryTypes.SELECT, transaction }
    );
    if (Number(inflight) > 0) {
      throw new AppError("This shift has payments or room charges still being processed. Resolve them before closing.", 409);
    }

    const { expected } = await expectedCash(shift, transaction);
    const variance = fromCents(toCents(actualCash) - toCents(expected));
    await shift.update(
      { status: "CLOSED", closedAt: new Date(), expectedCash: expected, actualCash, cashVariance: variance, closingNotes, closedBy: req.user.id },
      { transaction }
    );
    await audit({ req, action: "SHIFT_CLOSED", entityType: "shift", entityId: id, newValues: { expectedCash: expected, actualCash, cashVariance: variance }, transaction });
    return shift;
  });
}

export async function reconcileShift(req, id) {
  return sequelize.transaction(async (transaction) => {
    const shift = await Shift.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!shift) throw notFound("Shift");
    if (shift.status !== "CLOSED") throw new AppError("Only closed shifts can be reconciled.", 409);
    if (shift.userId === req.user.id) throw forbidden("A different supervisor must reconcile your own shift.");
    await shift.update({ status: "RECONCILED", reconciledBy: req.user.id, reconciledAt: new Date() }, { transaction });
    await audit({ req, action: "SHIFT_RECONCILED", entityType: "shift", entityId: id, newValues: { cashVariance: shift.cashVariance }, transaction });
    return shift;
  });
}

export async function listShifts(req, { outletId, userId, status, start, end }, { limit, offset }) {
  const where = { openedAt: { [Op.gte]: start, [Op.lt]: end } };
  if (status) where.status = status;
  if (outletId) where.outletId = outletId;
  if (!req.user.allOutlets) where.outletId = outletId && req.user.outletIds.includes(Number(outletId)) ? outletId : req.user.outletIds;
  // Cashiers without shifts.manage only see their own shifts.
  if (!req.permissions.has("shifts.manage") && !req.permissions.has("reports.view")) where.userId = req.user.id;
  else if (userId) where.userId = userId;
  return Shift.findAndCountAll({
    where,
    include: [
      { model: Outlet, as: "outlet", attributes: ["code", "name"] },
      { model: User, as: "cashier", attributes: ["id", "fullName"] },
    ],
    order: [["openedAt", "DESC"]],
    limit,
    offset,
  });
}

export async function getShift(req, id) {
  const shift = await Shift.findByPk(id, {
    include: [
      { model: Outlet, as: "outlet" },
      { model: User, as: "cashier", attributes: ["id", "fullName", "username"] },
      { model: User, as: "closer", attributes: ["fullName"] },
      { model: User, as: "reconciler", attributes: ["fullName"] },
    ],
  });
  if (!shift) throw notFound("Shift");
  const privileged = req.permissions.has("shifts.manage") || req.permissions.has("reports.view");
  if (shift.userId !== req.user.id && !(privileged && req.user.outletIds.includes(shift.outletId))) throw forbidden();
  return shift;
}
