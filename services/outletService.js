// Hotel-operated outlets (restaurant, bar, room service, minibar, spa, …).
import { QueryTypes } from "sequelize";
import { sequelize, Outlet, StockLocation, User, UserOutlet, Role } from "../models/index.js";
import { OUTLET_TYPES } from "../models/catalogModel.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit, diff } from "./auditService.js";

export async function listOutlets() {
  return sequelize.query(
    `SELECT o.*,
       (SELECT COUNT(*) FROM user_outlets uo WHERE uo.outlet_id = o.id) AS user_count,
       (SELECT COUNT(*) FROM product_prices pp WHERE pp.outlet_id = o.id AND pp.effective_to IS NULL) AS product_count,
       (SELECT COUNT(*) FROM shifts s WHERE s.outlet_id = o.id AND s.status = 'OPEN') AS open_shifts
     FROM outlets o ORDER BY o.status, o.name`,
    { type: QueryTypes.SELECT }
  );
}

export async function getOutlet(id) {
  const outlet = await Outlet.findByPk(id, {
    include: [
      { model: StockLocation, as: "stockLocations" },
      { model: User, as: "users", through: { attributes: [] }, include: [{ model: Role, as: "role", attributes: ["name"] }] },
    ],
  });
  if (!outlet) throw notFound("Outlet");
  return outlet;
}

const parse = (body) => ({
  code: v.code(body.code, "Outlet code", { required: true, max: 20 }),
  name: v.str(body.name, "Outlet name", { required: true, max: 100 }),
  outletType: v.oneOf(body.outletType, "Outlet type", OUTLET_TYPES),
  description: v.str(body.description, "Description", { max: 2000 }),
  location: v.str(body.location, "Location", { max: 150 }),
  serviceChargeRate: v.percent(body.serviceChargeRate || "0", "Service charge rate"),
  allowsRoomCharge: v.bool(body.allowsRoomCharge),
  status: v.oneOf(body.status, "Status", ["ACTIVE", "INACTIVE"], { required: false, fallback: "ACTIVE" }),
});

export async function createOutlet(req, body) {
  const data = parse(body);
  return sequelize.transaction(async (transaction) => {
    const outlet = await Outlet.create(data, { transaction });
    // Every outlet gets a default stock location that sales deduct from.
    await StockLocation.create(
      { outletId: outlet.id, code: `${outlet.code}-STORE`, name: `${outlet.name} storeroom`, isDefault: true },
      { transaction }
    );
    await audit({ req, action: "OUTLET_CREATED", entityType: "outlet", entityId: outlet.id, newValues: outlet, transaction });
    return outlet;
  });
}

export async function updateOutlet(req, id, body) {
  const data = parse(body);
  const outlet = await Outlet.findByPk(id);
  if (!outlet) throw notFound("Outlet");
  if (data.status === "INACTIVE" && outlet.status === "ACTIVE") {
    const [{ n }] = await sequelize.query("SELECT COUNT(*) AS n FROM shifts WHERE outlet_id = ? AND status = 'OPEN'", { replacements: [id], type: QueryTypes.SELECT });
    if (Number(n) > 0) throw new AppError("Close all open cashier shifts at this outlet before deactivating it.", 409);
  }
  return sequelize.transaction(async (transaction) => {
    const before = outlet.get({ plain: true });
    await outlet.update(data, { transaction });
    const { oldValues, newValues } = diff(before, outlet);
    await audit({ req, action: "OUTLET_UPDATED", entityType: "outlet", entityId: outlet.id, oldValues, newValues, transaction });
    return outlet;
  });
}

export async function setAssignedUsers(req, id, userIds) {
  const outlet = await Outlet.findByPk(id);
  if (!outlet) throw notFound("Outlet");
  const ids = v.idList(userIds);
  return sequelize.transaction(async (transaction) => {
    const before = (await UserOutlet.findAll({ where: { outletId: id }, transaction })).map((r) => r.userId).sort((a, b) => a - b);
    if (ids.length && (await User.count({ where: { id: ids }, transaction })) !== ids.length) throw new AppError("Unknown user selected.", 422);
    await UserOutlet.destroy({ where: { outletId: id }, transaction });
    await UserOutlet.bulkCreate(ids.map((userId) => ({ userId, outletId: id })), { transaction });
    await audit({ req, action: "OUTLET_USERS_UPDATED", entityType: "outlet", entityId: id, oldValues: { userIds: before }, newValues: { userIds: [...ids].sort((a, b) => a - b) }, transaction });
  });
}

export async function outletProducts(outletId) {
  return sequelize.query(
    `SELECT p.id, p.code, p.name, p.status, c.name AS category, pp.price, pp.is_available, pp.effective_from
     FROM product_prices pp JOIN products p ON p.id = pp.product_id JOIN categories c ON c.id = p.category_id
     WHERE pp.outlet_id = ? AND pp.effective_to IS NULL ORDER BY c.sort_order, p.name`,
    { replacements: [outletId], type: QueryTypes.SELECT }
  );
}
