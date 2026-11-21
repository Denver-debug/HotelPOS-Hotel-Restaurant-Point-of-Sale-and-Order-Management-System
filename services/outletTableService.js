// Each outlet's tables (or bar seats, treatment rooms…): the list the POS location dropdown
// shows. Tables are deactivated, never deleted, because past orders point at them.
import { QueryTypes } from "sequelize";
import { sequelize, Outlet, OutletTable } from "../models/index.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit, diff } from "./auditService.js";

const ORDER = [["sortOrder", "ASC"], ["label", "ASC"]];

export const tableDto = (t) => ({ id: t.id, label: t.label, area: t.area ?? null, seats: t.seats ?? null, sortOrder: t.sortOrder, status: t.status });

export async function listTables(outletId, { activeOnly = false } = {}) {
  const where = { outletId };
  if (activeOnly) where.status = "ACTIVE";
  return OutletTable.findAll({ where, order: ORDER });
}

// Tables with the number of unsettled orders currently on each (for the outlet page).
export async function tablesWithOpenOrders(outletId) {
  const rows = await listTables(outletId);
  const counts = await sequelize.query(
    `SELECT outlet_table_id AS id, COUNT(*) AS n FROM orders
      WHERE outlet_id = ? AND outlet_table_id IS NOT NULL AND status IN ('OPEN','IN_PROGRESS','AWAITING_SETTLEMENT','SETTLING','CHARGE_FAILED')
      GROUP BY outlet_table_id`,
    { replacements: [outletId], type: QueryTypes.SELECT }
  );
  const byId = new Map(counts.map((c) => [Number(c.id), Number(c.n)]));
  return rows.map((t) => ({ ...t.get({ plain: true }), openOrders: byId.get(t.id) || 0 }));
}

const parse = (body) => ({
  label: v.str(body.label, "Table name", { required: true, max: 30 }),
  area: v.str(body.area, "Area", { max: 40 }),
  seats: v.int(body.seats, "Seats", { required: false, min: 1, max: 999 }),
  sortOrder: v.int(body.sortOrder || "0", "Order", { min: 0, max: 9999 }),
  status: v.oneOf(body.status, "Status", ["ACTIVE", "INACTIVE"], { required: false, fallback: "ACTIVE" }),
});

const assertUniqueLabel = async (outletId, label, exceptId, transaction) => {
  const clash = await OutletTable.findOne({ where: { outletId, label }, transaction });
  if (clash && clash.id !== exceptId) throw new AppError(`This outlet already has a table called “${label}”.`, 409, "DUPLICATE");
};

export async function createTable(req, outletId, body) {
  const outlet = await Outlet.findByPk(outletId);
  if (!outlet) throw notFound("Outlet");
  const data = parse(body);
  return sequelize.transaction(async (transaction) => {
    await assertUniqueLabel(outlet.id, data.label, null, transaction);
    const table = await OutletTable.create({ ...data, outletId: outlet.id }, { transaction });
    await audit({ req, action: "OUTLET_TABLE_CREATED", entityType: "outlet", entityId: outlet.id, newValues: tableDto(table), transaction });
    return table;
  });
}

export async function updateTable(req, outletId, tableId, body) {
  const data = parse(body);
  return sequelize.transaction(async (transaction) => {
    const table = await OutletTable.findOne({ where: { id: tableId, outletId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!table) throw notFound("Table");
    await assertUniqueLabel(table.outletId, data.label, table.id, transaction);
    const before = table.get({ plain: true });
    await table.update(data, { transaction });
    const { oldValues, newValues } = diff(before, table);
    await audit({ req, action: "OUTLET_TABLE_UPDATED", entityType: "outlet", entityId: table.outletId, oldValues: { tableId: table.id, ...oldValues }, newValues, transaction });
    return table;
  });
}
