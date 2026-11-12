// Discounts and promotions: definition, eligibility, application to orders
// (with supervisor authorization when required) and usage history.
import { Op, QueryTypes } from "sequelize";
import { sequelize, Discount, DiscountProduct, DiscountOutlet, OrderDiscount, OrderItem, Product, Outlet } from "../models/index.js";
import { AppError, notFound } from "../utils/http.js";
import { toCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { fromDateTimeLocal } from "../utils/dates.js";
import { audit, diff } from "./auditService.js";
import { lockOrder, recalculate } from "./orderService.js";
import { EDITABLE_STATUSES } from "./orderStateMachine.js";
import { authorizeSupervisor } from "./authService.js";

export async function listDiscounts({ status }) {
  const rows = await Discount.findAll({
    where: status ? { status } : { status: { [Op.ne]: "ARCHIVED" } },
    include: [
      { model: Outlet, as: "outlets", attributes: ["id", "code"], through: { attributes: [] } },
      { model: Product, as: "products", attributes: ["id", "code"], through: { attributes: [] } },
    ],
    order: [["status", "ASC"], ["name", "ASC"]],
  });
  return rows.map((d) => d.get({ plain: true }));
}

export async function getDiscount(id) {
  const d = await Discount.findByPk(id, {
    include: [
      { model: Outlet, as: "outlets", through: { attributes: [] } },
      { model: Product, as: "products", through: { attributes: [] } },
    ],
  });
  if (!d) throw notFound("Discount");
  return d;
}

const parse = (body) => {
  const discountType = v.oneOf(body.discountType, "Discount type", ["PERCENTAGE", "FIXED"]);
  const value = v.money(body.value, "Value", { min: 0.01, max: discountType === "PERCENTAGE" ? 100 : 99999999 });
  const validFrom = fromDateTimeLocal(body.validFrom);
  const validTo = fromDateTimeLocal(body.validTo);
  if (validFrom && validTo && validTo <= validFrom) throw new AppError("The end of the validity period must be after its start.", 422);
  return {
    code: v.code(body.code, "Discount code", { required: true, max: 30 }),
    name: v.str(body.name, "Name", { required: true, max: 100 }),
    description: v.str(body.description, "Description", { max: 255 }),
    discountType,
    value,
    scope: v.oneOf(body.scope, "Applies to", ["ORDER", "ITEM"]),
    requiresAuthorization: v.bool(body.requiresAuthorization),
    minOrderAmount: v.money(body.minOrderAmount, "Minimum order amount", { required: false }),
    validFrom,
    validTo,
    maxUses: v.int(body.maxUses, "Maximum uses", { required: false, min: 1 }),
    status: v.oneOf(body.status, "Status", ["ACTIVE", "INACTIVE", "ARCHIVED"], { required: false, fallback: "ACTIVE" }),
    productIds: v.idList(body.productIds),
    outletIds: v.idList(body.outletIds),
  };
};

export async function saveDiscount(req, id, body) {
  const { productIds, outletIds, ...data } = parse(body);
  return sequelize.transaction(async (transaction) => {
    let discount;
    let before = null;
    if (id) {
      discount = await Discount.findByPk(id, { transaction });
      if (!discount) throw notFound("Discount");
      before = discount.get({ plain: true });
      await discount.update(data, { transaction });
    } else {
      discount = await Discount.create({ ...data, createdBy: req.user.id }, { transaction });
    }
    await DiscountProduct.destroy({ where: { discountId: discount.id }, transaction });
    await DiscountProduct.bulkCreate(productIds.map((productId) => ({ discountId: discount.id, productId })), { transaction });
    await DiscountOutlet.destroy({ where: { discountId: discount.id }, transaction });
    await DiscountOutlet.bulkCreate(outletIds.map((outletId) => ({ discountId: discount.id, outletId })), { transaction });
    const changes = before ? diff(before, discount) : { oldValues: null, newValues: discount.get({ plain: true }) };
    await audit({
      req, action: id ? "DISCOUNT_UPDATED" : "DISCOUNT_CREATED", entityType: "discount", entityId: discount.id,
      oldValues: changes.oldValues, newValues: { ...changes.newValues, productIds, outletIds }, transaction,
    });
    return discount;
  });
}

// Discounts that may currently be used at the order's outlet.
async function eligibleDiscounts(order, transaction) {
  const now = new Date();
  const rows = await Discount.findAll({
    where: {
      status: "ACTIVE",
      [Op.and]: [
        { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: now } }] },
        { [Op.or]: [{ validTo: null }, { validTo: { [Op.gt]: now } }] },
        { [Op.or]: [{ maxUses: null }, sequelize.where(sequelize.col("times_used"), Op.lt, sequelize.col("max_uses"))] },
      ],
    },
    include: [
      { model: Outlet, as: "outlets", attributes: ["id"], through: { attributes: [] } },
      { model: Product, as: "products", attributes: ["id"], through: { attributes: [] } },
    ],
    order: [["name", "ASC"]],
    transaction,
  });
  return rows.filter((d) => !d.outlets.length || d.outlets.some((o) => o.id === order.outletId));
}

export async function availableForOrder(req, orderId) {
  const order = await sequelize.transaction((t) => lockOrder(req, orderId, t));
  const list = await eligibleDiscounts(order);
  return list
    .filter((d) => !d.minOrderAmount || toCents(order.subtotal) >= toCents(d.minOrderAmount))
    .map((d) => ({
      id: d.id, code: d.code, name: d.name, description: d.description, type: d.discountType, value: d.value,
      scope: d.scope, requiresAuthorization: d.requiresAuthorization, productIds: d.products.map((p) => p.id),
    }));
}

export async function applyDiscount(req, orderId, body) {
  const discountId = v.id(body.discountId, "Discount");
  const orderItemId = v.id(body.orderItemId, "Order item", { required: false });
  const discount = await Discount.findByPk(discountId, { include: [{ model: Product, as: "products", attributes: ["id"], through: { attributes: [] } }] });
  if (!discount) throw notFound("Discount");

  // Restricted discounts need someone holding discounts.authorize (use case: Authorize Discount).
  let authorizedBy = null;
  if (discount.requiresAuthorization) {
    authorizedBy = req.permissions.has("discounts.authorize")
      ? req.user.id
      : (await authorizeSupervisor(req, body.supervisorUsername, body.supervisorPassword, "discounts.authorize")).id;
  }

  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (!EDITABLE_STATUSES.includes(order.status) || toCents(order.amountPaid) > 0) throw new AppError("Discounts can only be applied before payment.", 409, "NOT_EDITABLE");
    const eligible = await eligibleDiscounts(order, transaction);
    if (!eligible.some((d) => d.id === discount.id)) throw new AppError(`${discount.name} is not valid at this outlet right now.`, 409, "DISCOUNT_NOT_ELIGIBLE");
    if (discount.minOrderAmount && toCents(order.subtotal) < toCents(discount.minOrderAmount)) {
      throw new AppError(`${discount.name} requires a minimum order of ${discount.minOrderAmount}.`, 409, "DISCOUNT_NOT_ELIGIBLE");
    }

    let item = null;
    if (discount.scope === "ITEM") {
      if (!orderItemId) throw new AppError("Select the item to discount.", 422);
      item = await OrderItem.findOne({ where: { id: orderItemId, orderId: order.id }, transaction });
      if (!item) throw notFound("Order item");
      if (discount.products.length && !discount.products.some((p) => p.id === item.productId)) {
        throw new AppError(`${discount.name} does not apply to ${item.productName}.`, 409, "DISCOUNT_NOT_ELIGIBLE");
      }
      if (await OrderDiscount.count({ where: { orderItemId: item.id }, transaction })) throw new AppError(`${item.productName} already has a discount.`, 409, "DISCOUNT_ALREADY_APPLIED");
    } else if (await OrderDiscount.count({ where: { orderId: order.id, orderItemId: null }, transaction })) {
      throw new AppError("This order already has an order-level discount. Remove it first.", 409, "DISCOUNT_ALREADY_APPLIED");
    }

    const applied = await OrderDiscount.create(
      {
        orderId: order.id,
        orderItemId: item?.id ?? null,
        discountId: discount.id,
        discountCode: discount.code,
        discountName: discount.name,
        discountType: discount.discountType,
        discountValue: discount.value,
        appliedBy: req.user.id,
        authorizedBy,
      },
      { transaction }
    );
    await recalculate(order, transaction);
    await applied.reload({ transaction });
    await audit({
      req, action: "DISCOUNT_APPLIED", entityType: "order", entityId: order.id,
      newValues: { code: discount.code, amount: applied.amount, item: item?.productName ?? null, authorizedBy },
      transaction,
    });
    return order.id;
  });
}

export async function removeDiscount(req, orderId, orderDiscountId) {
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (!EDITABLE_STATUSES.includes(order.status) || toCents(order.amountPaid) > 0) throw new AppError("Discounts can only be changed before payment.", 409, "NOT_EDITABLE");
    const applied = await OrderDiscount.findOne({ where: { id: orderDiscountId, orderId: order.id }, transaction });
    if (!applied) throw notFound("Applied discount");
    await applied.destroy({ transaction });
    await recalculate(order, transaction);
    await audit({ req, action: "DISCOUNT_REMOVED", entityType: "order", entityId: order.id, oldValues: { code: applied.discountCode, amount: applied.amount }, transaction });
    return order.id;
  });
}

// Usage history: only orders that were actually completed.
export async function usageHistory(discountId) {
  return sequelize.query(
    `SELECT od.id, od.amount, od.created_at, o.id AS order_id, o.order_number, o.status, o.completed_at,
            ot.code AS outlet_code, ua.full_name AS applied_by, uz.full_name AS authorized_by
       FROM order_discounts od
       JOIN orders o ON o.id = od.order_id
       JOIN outlets ot ON ot.id = o.outlet_id
       JOIN users ua ON ua.id = od.applied_by
       LEFT JOIN users uz ON uz.id = od.authorized_by
      WHERE od.discount_id = ? AND o.status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
      ORDER BY o.completed_at DESC LIMIT 200`,
    { replacements: [discountId], type: QueryTypes.SELECT }
  );
}
