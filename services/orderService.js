// Order management: creation, line items, totals, settlement requests and voids.
// Every mutation locks the order row (SELECT … FOR UPDATE) and recomputes totals on
// the server from database prices — client-supplied amounts are never trusted.
import { Op } from "sequelize";
import {
  sequelize, Order, OrderItem, OrderDiscount, Outlet, Product, ProductPrice, Tax, User,
  Payment, PaymentMethod, GuestCharge, Refund, Receipt, Shift,
} from "../models/index.js";
import { ORDER_TYPES } from "../models/salesModel.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toMilli, fromMilli, toCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { priceOrder } from "./pricingService.js";
import { assertTransition, EDITABLE_STATUSES, VOIDABLE_STATUSES } from "./orderStateMachine.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { findShortages } from "./inventoryService.js";
import { authorizeSupervisor } from "./authService.js";

const DEFAULT_ORDER_TYPE = { ROOM_SERVICE: "ROOM_SERVICE", MINIBAR: "MINIBAR", SPA: "SPA", RESTAURANT: "DINE_IN", BAR: "DINE_IN", OTHER: "OTHER" };

export const ORDER_DETAIL_INCLUDE = [
  { model: Outlet, as: "outlet", attributes: ["id", "code", "name", "outletType", "allowsRoomCharge", "serviceChargeRate"] },
  { model: User, as: "creator", attributes: ["id", "fullName"] },
  { model: User, as: "voider", attributes: ["id", "fullName"] },
  { model: Shift, as: "shift", attributes: ["id", "shiftNumber"] },
  { model: OrderItem, as: "items" },
  { model: OrderDiscount, as: "discounts" },
  { model: Payment, as: "payments", include: [{ model: PaymentMethod, as: "method", attributes: ["code", "name", "isCash"] }] },
  { model: GuestCharge, as: "guestCharges" },
  { model: Refund, as: "refunds" },
  { model: Receipt, as: "receipts", attributes: ["id", "receiptNumber", "receiptType", "refundId", "generatedAt"] },
];

export async function getOrder(req, id, transaction) {
  const order = await Order.findByPk(id, {
    include: ORDER_DETAIL_INCLUDE,
    order: [[{ model: OrderItem, as: "items" }, "id", "ASC"], [{ model: Payment, as: "payments" }, "id", "ASC"]],
    transaction,
  });
  if (!order) throw notFound("Order");
  if (req && !req.user.outletIds.includes(order.outletId)) throw forbidden("You are not assigned to this order's outlet.");
  return order;
}

// Locks the order row for the rest of the transaction and checks outlet access.
export async function lockOrder(req, id, transaction) {
  const order = await Order.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw notFound("Order");
  if (req && !req.user.outletIds.includes(order.outletId)) throw forbidden("You are not assigned to this order's outlet.");
  return order;
}

// Serialized view of an order for the POS terminal.
export function toDto(order) {
  const o = order.get ? order.get({ plain: true }) : order;
  const activeCharge = (o.guestCharges || []).find((g) => ["PENDING", "UNKNOWN", "POSTED", "PARTIALLY_REVERSED"].includes(g.status));
  const balance = Math.max(0, toCents(o.totalAmount) - toCents(o.amountPaid));
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    outletId: o.outletId,
    outlet: o.outlet,
    orderType: o.orderType,
    status: o.status,
    settlementType: o.settlementType,
    tableOrLocation: o.tableOrLocation,
    guestCount: o.guestCount,
    notes: o.notes,
    serviceChargeRate: o.serviceChargeRate,
    subtotal: o.subtotal,
    discountAmount: o.discountAmount,
    taxAmount: o.taxAmount,
    serviceChargeAmount: o.serviceChargeAmount,
    totalAmount: o.totalAmount,
    amountPaid: o.amountPaid,
    balanceDue: (balance / 100).toFixed(2),
    version: o.version,
    items: (o.items || []).map((i) => ({
      id: i.id, productId: i.productId, productCode: i.productCode, productName: i.productName, unit: i.unit,
      quantity: i.quantity, unitPrice: i.unitPrice, grossAmount: i.grossAmount, discountAmount: i.discountAmount,
      taxAmount: i.taxAmount, lineTotal: i.lineTotal, notes: i.notes,
    })),
    discounts: (o.discounts || []).map((d) => ({
      id: d.id, orderItemId: d.orderItemId, code: d.discountCode, name: d.discountName, type: d.discountType, value: d.discountValue, amount: d.amount,
    })),
    payments: (o.payments || []).map((p) => ({
      id: p.id, paymentNumber: p.paymentNumber, method: p.method?.name, amount: p.amount, tenderedAmount: p.tenderedAmount,
      changeAmount: p.changeAmount, status: p.status, reference: p.reference, isMock: p.isMock, failureReason: p.failureReason,
    })),
    guestCharge: activeCharge
      ? { id: activeCharge.id, chargeNumber: activeCharge.chargeNumber, roomNumber: activeCharge.roomNumber, status: activeCharge.status, pmsTransactionId: activeCharge.pmsTransactionId, amount: activeCharge.amount, attempts: activeCharge.attempts, lastError: activeCharge.lastError, isMock: activeCharge.isMock }
      : null,
    receipts: o.receipts || [],
    editable: EDITABLE_STATUSES.includes(o.status) && toCents(o.amountPaid) === 0,
  };
}

const parseHeader = (body, outlet) => ({
  orderType: v.oneOf(body.orderType, "Order type", ORDER_TYPES, { required: false, fallback: DEFAULT_ORDER_TYPE[outlet.outletType] || "OTHER" }),
  tableOrLocation: v.str(body.tableOrLocation, "Table / location", { max: 60 }),
  guestCount: v.int(body.guestCount, "Guest count", { required: false, min: 1, max: 999 }),
  notes: v.str(body.notes, "Order notes", { max: 500 }),
});

export async function createOrder(req, body) {
  const outletId = v.id(body.outletId, "Outlet");
  if (!req.user.outletIds.includes(outletId)) throw forbidden("You are not assigned to this outlet.");
  return sequelize.transaction(async (transaction) => {
    const outlet = await Outlet.findByPk(outletId, { transaction });
    if (!outlet || outlet.status !== "ACTIVE") throw new AppError("This outlet is not active.", 422);
    const header = parseHeader(body, outlet);
    const shiftId = req.openShift && req.openShift.outletId === outletId ? req.openShift.id : null;
    const order = await Order.create(
      {
        orderNumber: await nextNumber("order", transaction),
        outletId,
        shiftId,
        createdBy: req.user.id,
        ...header,
        serviceChargeRate: outlet.serviceChargeRate,
        status: "OPEN",
      },
      { transaction }
    );
    await audit({ req, action: "ORDER_CREATED", entityType: "order", entityId: order.id, newValues: { orderNumber: order.orderNumber, outletId, ...header }, transaction });
    return order;
  });
}

// Recomputes every line, discount allocation and order total from stored data.
export async function recalculate(order, transaction) {
  const items = await OrderItem.findAll({ where: { orderId: order.id }, order: [["id", "ASC"]], transaction });
  const discounts = await OrderDiscount.findAll({ where: { orderId: order.id }, transaction });
  const orderDiscount = discounts.find((d) => !d.orderItemId);
  const itemDiscounts = new Map(discounts.filter((d) => d.orderItemId).map((d) => [String(d.orderItemId), d]));

  const result = priceOrder(
    items.map((i) => {
      const d = itemDiscounts.get(String(i.id));
      return {
        key: i.id, unitPrice: i.unitPrice, quantity: i.quantity, taxRate: i.taxRate, taxInclusive: i.taxInclusive,
        discount: d ? { type: d.discountType, value: d.discountValue } : null,
      };
    }),
    orderDiscount ? { type: orderDiscount.discountType, value: orderDiscount.discountValue } : null,
    order.serviceChargeRate
  );

  for (const line of result.lines) {
    const item = items.find((i) => i.id === line.key);
    await item.update(
      { grossAmount: line.grossAmount, discountAmount: line.discountAmount, taxAmount: line.taxAmount, netAmount: line.netAmount, lineTotal: line.lineTotal },
      { transaction }
    );
    const d = itemDiscounts.get(String(item.id));
    if (d) await d.update({ amount: line.itemDiscountAmount }, { transaction });
  }
  if (orderDiscount) await orderDiscount.update({ amount: result.orderDiscountAmount }, { transaction });

  await order.update(
    {
      subtotal: result.subtotal,
      discountAmount: result.discountAmount,
      taxAmount: result.taxAmount,
      serviceChargeAmount: result.serviceChargeAmount,
      totalAmount: result.totalAmount,
      version: order.version + 1,
    },
    { transaction }
  );
  return result;
}

// Editing moves an order back to IN_PROGRESS (F13 editOrder()); not allowed once money is collected.
function assertEditable(order) {
  if (!EDITABLE_STATUSES.includes(order.status)) {
    throw new AppError(`Order ${order.orderNumber} is ${order.status.replace(/_/g, " ").toLowerCase()} and can no longer be edited.`, 409, "NOT_EDITABLE");
  }
  if (toCents(order.amountPaid) > 0) throw new AppError("A payment has already been collected for this order; it can no longer be edited.", 409, "NOT_EDITABLE");
}

async function markEdited(order, transaction) {
  if (order.status === "OPEN" || order.status === "AWAITING_SETTLEMENT") {
    assertTransition(order.status, "IN_PROGRESS");
    await order.update({ status: "IN_PROGRESS" }, { transaction });
  }
}

async function currentPrice(order, productId, transaction) {
  const product = await Product.findByPk(productId, { include: [{ model: Tax, as: "tax" }], transaction });
  if (!product || product.status !== "AVAILABLE") throw new AppError("This product is not available.", 422, "UNAVAILABLE");
  const price = await ProductPrice.findOne({ where: { productId, outletId: order.outletId, effectiveTo: null }, transaction });
  if (!price || !price.isAvailable) throw new AppError(`${product.name} is not sold at this outlet.`, 422, "UNAVAILABLE");
  const tax = product.tax && product.tax.status === "ACTIVE" ? product.tax : null;
  return { product, price, tax };
}

export async function addItem(req, orderId, body) {
  const productId = v.id(body.productId, "Product");
  const quantity = v.quantity(body.quantity || "1", "Quantity", { max: 9999 });
  const notes = v.str(body.notes, "Item notes", { max: 255 });
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    assertEditable(order);
    const { product, price, tax } = await currentPrice(order, productId, transaction);

    // Same product with the same notes is merged into one line.
    const existing = await OrderItem.findOne({ where: { orderId: order.id, productId, notes: notes ?? null }, transaction });
    if (existing) {
      await existing.update({ quantity: fromMilli(toMilli(existing.quantity) + toMilli(quantity)) }, { transaction });
    } else {
      // Snapshot of product name, code, price and tax at the time of sale.
      await OrderItem.create(
        {
          orderId: order.id,
          productId,
          productCode: product.code,
          productName: product.name,
          itemType: product.itemType,
          unit: product.unit,
          quantity,
          unitPrice: price.price,
          taxRate: tax ? tax.rate : "0",
          taxInclusive: tax ? tax.isInclusive : true,
          notes,
        },
        { transaction }
      );
    }
    await markEdited(order, transaction);
    await recalculate(order, transaction);
    await audit({ req, action: "ORDER_ITEM_ADDED", entityType: "order", entityId: order.id, newValues: { productId, productName: product.name, quantity, unitPrice: price.price }, transaction });
    return order.id;
  });
}

export async function updateItem(req, orderId, itemId, body) {
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    assertEditable(order);
    const item = await OrderItem.findOne({ where: { id: itemId, orderId: order.id }, transaction });
    if (!item) throw notFound("Order item");
    const before = { quantity: item.quantity, notes: item.notes };
    const changes = {};
    if (body.quantity !== undefined) changes.quantity = v.quantity(body.quantity, "Quantity", { allowZero: true, max: 9999 });
    if (body.notes !== undefined) changes.notes = v.str(body.notes, "Item notes", { max: 255 });

    if (changes.quantity !== undefined && toMilli(changes.quantity) === 0) {
      await OrderDiscount.destroy({ where: { orderItemId: item.id }, transaction });
      await item.destroy({ transaction });
      await audit({ req, action: "ORDER_ITEM_REMOVED", entityType: "order", entityId: order.id, oldValues: { itemId: item.id, productName: item.productName, ...before }, transaction });
    } else {
      await item.update(changes, { transaction });
      await audit({ req, action: "ORDER_ITEM_UPDATED", entityType: "order", entityId: order.id, oldValues: { itemId: item.id, ...before }, newValues: changes, transaction });
    }
    await markEdited(order, transaction);
    await recalculate(order, transaction);
    return order.id;
  });
}

export const removeItem = (req, orderId, itemId) => updateItem(req, orderId, itemId, { quantity: "0" });

export async function updateHeader(req, orderId, body) {
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (!EDITABLE_STATUSES.includes(order.status)) throw new AppError("This order can no longer be edited.", 409);
    const outlet = await Outlet.findByPk(order.outletId, { transaction });
    const header = parseHeader({ orderType: order.orderType, ...body }, outlet);
    const before = { orderType: order.orderType, tableOrLocation: order.tableOrLocation, guestCount: order.guestCount, notes: order.notes };
    await order.update({ ...header, version: order.version + 1 }, { transaction });
    await audit({ req, action: "ORDER_UPDATED", entityType: "order", entityId: order.id, oldValues: before, newValues: header, transaction });
    return order.id;
  });
}

// F13 requestSettlement(): locks the items and checks stock before any money moves.
export async function requestSettlement(req, orderId) {
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (order.status === "AWAITING_SETTLEMENT") return order.id;
    assertTransition(order.status, "AWAITING_SETTLEMENT");
    const items = await OrderItem.findAll({ where: { orderId: order.id }, transaction });
    if (!items.length) throw new AppError("Add at least one item before settling the order.", 422, "EMPTY_ORDER");
    const shortages = await findShortages(order.outletId, items, transaction);
    if (shortages.length) {
      const list = shortages.map((s) => `${s.name} (need ${Number(s.required)}, have ${Number(s.available)})`).join(", ");
      throw new AppError(`Not enough stock: ${list}.`, 409, "INSUFFICIENT_STOCK", { shortages });
    }
    await order.update({ status: "AWAITING_SETTLEMENT", version: order.version + 1 }, { transaction });
    await audit({ req, action: "ORDER_SETTLEMENT_REQUESTED", entityType: "order", entityId: order.id, newValues: { totalAmount: order.totalAmount }, transaction });
    return order.id;
  });
}

// F13 editOrder(): unlock items again.
export async function reopenForEdit(req, orderId) {
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    assertEditable(order);
    await markEdited(order, transaction);
    await order.update({ version: order.version + 1 }, { transaction });
    return order.id;
  });
}

// Void [supervisor] — only before any money was collected or a room charge posted.
export async function voidOrder(req, orderId, body) {
  const reason = v.str(body.reason, "Void reason", { required: true, max: 255 });
  let approver = { id: req.user.id };
  if (!req.permissions.has("orders.void")) {
    approver = await authorizeSupervisor(req, body.supervisorUsername, body.supervisorPassword, "orders.void");
  }
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (!VOIDABLE_STATUSES.includes(order.status)) throw new AppError(`A ${order.status.replace(/_/g, " ").toLowerCase()} order cannot be voided. Use a refund instead.`, 409);
    if (toCents(order.amountPaid) > 0) throw new AppError("Payments were collected on this order; process a refund instead of a void.", 409);
    const activeCharge = await GuestCharge.count({ where: { orderId: order.id, status: { [Op.in]: ["PENDING", "UNKNOWN", "POSTED"] } }, transaction });
    if (activeCharge) throw new AppError("A room charge is pending or posted for this order; it cannot be voided.", 409);

    assertTransition(order.status, "VOIDED");
    const before = order.status;
    await order.update(
      { status: "VOIDED", voidReason: reason, voidRequestedBy: req.user.id, voidedBy: approver.id, voidedAt: new Date(), version: order.version + 1 },
      { transaction }
    );
    await audit({ req, action: "ORDER_VOIDED", entityType: "order", entityId: order.id, oldValues: { status: before }, newValues: { status: "VOIDED", reason, approvedBy: approver.id, total: order.totalAmount }, transaction });
    return order.id;
  });
}

// ── Lists ────────────────────────────────────────────────────────────────

export async function listOrders(req, { search, outletId, status, orderType, settlementType, cashierId, start, end }, { limit, offset }) {
  const where = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
  if (search) where.orderNumber = { [Op.like]: `%${search}%` };
  if (status) where.status = status;
  if (orderType) where.orderType = orderType;
  if (settlementType) where.settlementType = settlementType;
  if (cashierId) where.createdBy = cashierId;
  where.outletId = outletId ? (req.user.outletIds.includes(Number(outletId)) ? outletId : 0) : req.user.outletIds.length ? req.user.outletIds : [0];
  return Order.findAndCountAll({
    where,
    include: [
      { model: Outlet, as: "outlet", attributes: ["code", "name"] },
      { model: User, as: "creator", attributes: ["fullName"] },
    ],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
}

export async function openOrders(req, outletId) {
  if (!req.user.outletIds.includes(Number(outletId))) throw forbidden();
  const rows = await Order.findAll({
    where: { outletId, status: { [Op.in]: ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "SETTLING", "CHARGE_FAILED"] } },
    include: [{ model: User, as: "creator", attributes: ["fullName"] }],
    order: [["createdAt", "DESC"]],
    limit: 50,
  });
  return rows.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, status: o.status, orderType: o.orderType, tableOrLocation: o.tableOrLocation,
    totalAmount: o.totalAmount, createdAt: o.createdAt, createdBy: o.creator?.fullName,
  }));
}
