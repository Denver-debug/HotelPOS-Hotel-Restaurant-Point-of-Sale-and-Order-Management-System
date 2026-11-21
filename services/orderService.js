// Order management: creation, line items, totals, settlement requests and voids.
// Every mutation locks the order row (SELECT … FOR UPDATE) and recomputes totals on
// the server from database prices — client-supplied amounts are never trusted.
// Every order records where it is served: dine-in orders one of the outlet's tables, room
// service and minibar orders an occupied guest room checked with the PMS.
import { Op, UniqueConstraintError } from "sequelize";
import {
  sequelize, Order, OrderItem, OrderDiscount, Outlet, OutletTable, Product, ProductPrice, Tax, User,
  Payment, PaymentMethod, GuestCharge, Refund, Receipt, Shift, Discount,
} from "../models/index.js";
import { ORDER_TYPES, ROOM_ORDER_TYPES, TABLE_ORDER_TYPES } from "../models/salesModel.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toMilli, fromMilli, toCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { priceOrder } from "./pricingService.js";
import { assertTransition, EDITABLE_STATUSES, VOIDABLE_STATUSES } from "./orderStateMachine.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { findShortages, deductForOrder } from "./inventoryService.js";
import { authorizeSupervisor } from "./authService.js";
import { generateSaleReceipt } from "./receiptService.js";
import { recordEvent } from "../integrations/events/eventPublisher.js";
import { getPmsGateway } from "../integrations/pms/pmsGateway.js";
import { logged, IntegrationError } from "../integrations/integrationLogger.js";
import { config } from "../config/env.js";

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
    externalReference: o.externalReference ?? null,
    outletId: o.outletId,
    outlet: o.outlet,
    shiftId: o.shiftId ?? null,
    createdBy: o.creator ? { id: o.creator.id, fullName: o.creator.fullName } : null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    completedAt: o.completedAt ?? null,
    voidedAt: o.voidedAt ?? null,
    voidReason: o.voidReason ?? null,
    orderType: o.orderType,
    status: o.status,
    settlementType: o.settlementType,
    tableOrLocation: o.tableOrLocation,
    tableId: o.outletTableId ?? null,
    roomNumber: o.roomNumber ?? null,
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
      externalTransactionId: p.externalTransactionId ?? null,
      // An e-wallet checkout the guest has not approved yet (QR code on the POS).
      checkout: p.status === "PENDING" && p.checkoutUrl ? { url: p.checkoutUrl, qrCodeUrl: `/api/payments/${p.id}/qr.svg`, expiresAt: p.checkoutExpiresAt } : null,
    })),
    guestCharge: activeCharge
      ? { id: activeCharge.id, chargeNumber: activeCharge.chargeNumber, roomNumber: activeCharge.roomNumber, status: activeCharge.status, pmsTransactionId: activeCharge.pmsTransactionId, amount: activeCharge.amount, attempts: activeCharge.attempts, lastError: activeCharge.lastError, isMock: activeCharge.isMock }
      : null,
    receipts: o.receipts || [],
    editable: EDITABLE_STATUSES.includes(o.status) && toCents(o.amountPaid) === 0,
  };
}

// On an update (`current` given) a field that is not sent keeps its value.
const parseHeader = (body, outlet, current = null) => ({
  orderType: v.oneOf(body.orderType, "Order type", ORDER_TYPES, { required: false, fallback: current?.orderType ?? (DEFAULT_ORDER_TYPE[outlet.outletType] || "OTHER") }),
  guestCount: current && body.guestCount === undefined ? current.guestCount : v.int(body.guestCount, "Guest count", { required: false, min: 1, max: 999 }),
  notes: current && body.notes === undefined ? current.notes : v.str(body.notes, "Order notes", { max: 500 }),
});

// ── Where the order is served ────────────────────────────────────────────

const parseRoom = (value) => v.str(value, "Room number", { max: 20, pattern: /^[A-Za-z0-9-]+$/, patternMessage: "Enter a valid room number." });
// Older API clients sent the room as free text in tableOrLocation ("Room 205").
const roomFromText = (text) => parseRoom(text ? String(text).trim().replace(/^(room|rm)\.?\s*/i, "") : null);
const typeName = (orderType) => orderType.replace(/_/g, " ").toLowerCase();

// What the request asks for; undefined = not sent (an update keeps the current value).
function locationInput(body) {
  return {
    tableId: body.tableId === undefined ? undefined : body.tableId === null || body.tableId === "" ? null : v.id(body.tableId, "Table"),
    roomNumber: body.roomNumber === undefined ? undefined : parseRoom(body.roomNumber),
    text: body.tableOrLocation === undefined ? undefined : v.str(body.tableOrLocation, "Table / location", { max: 60 }),
  };
}

// The guest must be checked in. A guest without an active folio, or not allowed to charge to
// the room, can still order: they pay directly at settlement.
const ROOM_REJECTED = {
  ROOM_NOT_FOUND: (room) => `Room ${room} does not exist in the PMS. Check the room number.`,
  ROOM_VACANT: (room) => `Room ${room} has no checked-in guest. Check the room number.`,
};

async function checkGuestRoom(req, roomNumber, orderId) {
  const pms = getPmsGateway();
  let result;
  try {
    result = await logged(
      { system: "PMS", operation: "getActiveFolio", isMock: pms.isMock, referenceType: "order", referenceId: orderId ?? null, request: { roomNumber }, userId: req.user.id },
      () => pms.getActiveFolio(roomNumber)
    );
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    throw new AppError(`The PMS could not be reached to check room ${roomNumber} (${err.message}). Try again.`, 503, "PMS_UNAVAILABLE");
  }
  if (result.found || ["NO_ACTIVE_FOLIO", "NOT_ELIGIBLE"].includes(result.reason)) return result.room?.number || roomNumber;
  const code = result.reason === "ROOM_VACANT" ? "ROOM_VACANT" : "ROOM_NOT_FOUND";
  throw new AppError(ROOM_REJECTED[code](roomNumber), 422, code, { field: "roomNumber" });
}

// Runs before the order transaction: a room that is sent is checked with the PMS (no row
// locks are held during the call).
async function prepareLocation(req, orderType, body, orderId) {
  const input = locationInput(body);
  if (ROOM_ORDER_TYPES.includes(orderType)) {
    const room = input.roomNumber !== undefined ? input.roomNumber : input.text !== undefined ? roomFromText(input.text) : undefined;
    input.roomNumber = room ? await checkGuestRoom(req, room, orderId) : room;
  }
  return input;
}

// → { outletTableId, roomNumber, tableOrLocation } for the order row. `current` is the order
// being edited (null on create).
async function resolveLocation(outlet, orderType, input, current, transaction) {
  if (ROOM_ORDER_TYPES.includes(orderType)) {
    const roomNumber = input.roomNumber !== undefined ? input.roomNumber : current?.roomNumber ?? null;
    if (!roomNumber) throw new AppError(`Enter the guest's room number for this ${typeName(orderType)} order.`, 422, "ROOM_REQUIRED", { field: "roomNumber" });
    return { outletTableId: null, roomNumber, tableOrLocation: `Room ${roomNumber}` };
  }

  let tableId = input.tableId !== undefined ? input.tableId : current?.outletTableId ?? null;
  if (input.tableId === undefined && input.text !== undefined) {
    // Older API clients sent the table's name as text.
    tableId = null;
    if (input.text) {
      const named = await OutletTable.findOne({ where: { outletId: outlet.id, label: input.text, status: "ACTIVE" }, transaction });
      if (!named) throw new AppError(`“${input.text}” is not a table at ${outlet.name}. Choose one from the outlet's table list.`, 422, "TABLE_NOT_FOUND", { field: "tableId" });
      tableId = named.id;
    }
  }
  if (!tableId) {
    if (TABLE_ORDER_TYPES.includes(orderType)) {
      const tables = await OutletTable.count({ where: { outletId: outlet.id, status: "ACTIVE" }, transaction });
      throw new AppError(
        tables ? `Choose the table this ${typeName(orderType)} order is for.` : `${outlet.name} has no tables set up yet. Add them under Outlets → ${outlet.name} → Tables.`,
        422,
        "TABLE_REQUIRED",
        { field: "tableId" }
      );
    }
    return { outletTableId: null, roomNumber: null, tableOrLocation: null };
  }
  const table = await OutletTable.findOne({ where: { id: tableId, outletId: outlet.id }, transaction });
  if (!table) throw new AppError(`That table is not part of ${outlet.name}.`, 422, "TABLE_NOT_FOUND", { field: "tableId" });
  // A table switched off later stays valid on the orders already seated at it.
  if (table.status !== "ACTIVE" && table.id !== current?.outletTableId) throw new AppError(`Table ${table.label} is no longer in use.`, 422, "TABLE_INACTIVE", { field: "tableId" });
  return { outletTableId: table.id, roomNumber: null, tableOrLocation: table.label };
}

const parseLine = (body, label = "Item") => ({
  productId: v.id(body.productId, `${label} product`),
  quantity: v.quantity(body.quantity ?? "1", `${label} quantity`, { max: 9999 }),
  notes: v.str(body.notes, `${label} notes`, { max: 255 }),
});

const MAX_LINES_PER_CREATE = 100;

/**
 * Creates an order, optionally with its lines, in ONE transaction: either the whole order
 * exists or nothing does. Lines come from `items: [{ productId, quantity, notes }]` or, for the
 * POS terminal, a single `productId`/`quantity`.
 *
 * `idempotencyKey` (body or Idempotency-Key header) makes a retried create return the order
 * that was already created; `externalReference` stores the caller's own order id.
 * Returns { order, duplicate }.
 */
export async function createOrder(req, body) {
  const outletId = v.id(body.outletId, "Outlet");
  if (!req.user.outletIds.includes(outletId)) throw forbidden("You are not assigned to this outlet.");
  const idempotencyKey = v.str(body.idempotencyKey, "Idempotency key", { min: 8, max: 100 });
  const externalReference = v.str(body.externalReference, "External reference", { max: 100 });
  const rawLines = Array.isArray(body.items) ? body.items : body.productId !== undefined && body.productId !== "" ? [body] : [];
  if (rawLines.length > MAX_LINES_PER_CREATE) throw new AppError(`An order can be created with at most ${MAX_LINES_PER_CREATE} lines.`, 422);
  const lines = rawLines.map((l, i) => parseLine(l || {}, rawLines.length > 1 ? `Line ${i + 1}` : "Item"));

  const replay = async () => {
    const existing = await Order.findOne({ where: { idempotencyKey } });
    if (!existing) return null;
    if (existing.outletId !== outletId || existing.createdBy !== req.user.id) {
      throw new AppError("This idempotency key was already used for a different order.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { order: existing, duplicate: true };
  };
  if (idempotencyKey) {
    const previous = await replay();
    if (previous) return previous;
  }

  const outlet = await Outlet.findByPk(outletId);
  if (!outlet || outlet.status !== "ACTIVE") throw new AppError("This outlet is not active.", 422, "OUTLET_INACTIVE");
  const header = parseHeader(body, outlet);
  const location = await prepareLocation(req, header.orderType, body, null);

  try {
    const order = await sequelize.transaction(async (transaction) => {
      Object.assign(header, await resolveLocation(outlet, header.orderType, location, null, transaction));
      const shiftId = req.openShift && req.openShift.outletId === outletId ? req.openShift.id : null;
      const created = await Order.create(
        {
          orderNumber: await nextNumber("order", transaction),
          outletId,
          shiftId,
          createdBy: req.user.id,
          ...header,
          idempotencyKey,
          externalReference,
          serviceChargeRate: outlet.serviceChargeRate,
          status: "OPEN",
        },
        { transaction }
      );
      await audit({ req, action: "ORDER_CREATED", entityType: "order", entityId: created.id, newValues: { orderNumber: created.orderNumber, outletId, externalReference, ...header }, transaction });
      for (const line of lines) await addLine(req, created, line, transaction);
      return created;
    });
    return { order, duplicate: false };
  } catch (err) {
    // A concurrent retry with the same key won the race: return its order.
    if (idempotencyKey && err instanceof UniqueConstraintError) {
      const previous = await replay();
      if (previous) return previous;
    }
    throw err;
  }
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
  if (!product || product.status !== "AVAILABLE") throw new AppError("This product is not available.", 422, "PRODUCT_UNAVAILABLE");
  const price = await ProductPrice.findOne({ where: { productId, outletId: order.outletId, effectiveTo: null }, transaction });
  if (!price || !price.isAvailable) throw new AppError(`${product.name} is not sold at this outlet.`, 422, "PRODUCT_UNAVAILABLE");
  const tax = product.tax && product.tax.status === "ACTIVE" ? product.tax : null;
  return { product, price, tax };
}

export async function addItem(req, orderId, body) {
  const line = { productId: v.id(body.productId, "Product"), quantity: v.quantity(body.quantity || "1", "Quantity", { max: 9999 }), notes: v.str(body.notes, "Item notes", { max: 255 }) };
  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    await addLine(req, order, line, transaction);
    return order.id;
  });
}

// Adds (or merges) one line inside the caller's transaction; the order row is already locked.
async function addLine(req, order, { productId, quantity, notes }, transaction) {
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

// PATCH semantics: only the fields sent are changed.
export async function updateHeader(req, orderId, body) {
  const current = await Order.findByPk(orderId);
  if (!current) throw notFound("Order");
  if (!req.user.outletIds.includes(current.outletId)) throw forbidden("You are not assigned to this order's outlet.");
  const outlet = await Outlet.findByPk(current.outletId);
  const location = await prepareLocation(req, parseHeader(body, outlet, current).orderType, body, current.id);

  return sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (!EDITABLE_STATUSES.includes(order.status)) throw new AppError("This order can no longer be edited.", 409, "NOT_EDITABLE");
    const header = parseHeader(body, outlet, order);
    Object.assign(header, await resolveLocation(outlet, header.orderType, location, order, transaction));
    const before = {
      orderType: order.orderType, tableOrLocation: order.tableOrLocation, outletTableId: order.outletTableId, roomNumber: order.roomNumber,
      guestCount: order.guestCount, notes: order.notes,
    };
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
    if (!VOIDABLE_STATUSES.includes(order.status)) throw new AppError(`A ${order.status.replace(/_/g, " ").toLowerCase()} order cannot be voided. Use a refund instead.`, 409, "NOT_VOIDABLE");
    if (toCents(order.amountPaid) > 0) throw new AppError("Payments were collected on this order; process a refund instead of a void.", 409, "NOT_VOIDABLE");
    const activeCharge = await GuestCharge.count({ where: { orderId: order.id, status: { [Op.in]: ["PENDING", "UNKNOWN", "POSTED"] } }, transaction });
    if (activeCharge) throw new AppError("A room charge is pending or posted for this order; it cannot be voided.", 409, "NOT_VOIDABLE");

    assertTransition(order.status, "VOIDED");
    const before = order.status;
    await order.update(
      { status: "VOIDED", voidReason: reason, voidRequestedBy: req.user.id, voidedBy: approver.id, voidedAt: new Date(), version: order.version + 1 },
      { transaction }
    );
    await audit({ req, action: "ORDER_VOIDED", entityType: "order", entityId: order.id, oldValues: { status: before }, newValues: { status: "VOIDED", reason, approvedBy: approver.id, total: order.totalAmount }, transaction });
    await recordEvent(
      "OrderVoided",
      "order",
      order.id,
      { orderNumber: order.orderNumber, externalReference: order.externalReference ?? null, outletId: order.outletId, previousStatus: before, totalAmount: order.totalAmount, reason, requestedBy: req.user.id, approvedBy: approver.id, voidedAt: order.voidedAt },
      transaction
    );
    return order.id;
  });
}

/**
 * Post-sale steps once settlement is confirmed (F13 Paid/Charged to Room → Completed,
 * F15 fork: inventory ∥ receipt, then OrderCompleted). Runs inside the caller's
 * transaction with the order row already locked, so it can only happen once.
 */
export async function completeOrder(order, { req, userId, settledExternally }, transaction) {
  assertTransition(order.status, "COMPLETED");
  const items = await OrderItem.findAll({ where: { orderId: order.id }, transaction });
  await deductForOrder(order, items, { userId, settledExternally, req }, transaction);

  await order.update({ status: "COMPLETED", completedAt: new Date(), completedBy: userId, version: order.version + 1 }, { transaction });

  const discounts = await OrderDiscount.findAll({ where: { orderId: order.id }, transaction });
  for (const d of discounts) await Discount.increment("timesUsed", { by: 1, where: { id: d.discountId }, transaction });

  const receipt = await generateSaleReceipt(order.id, { userId }, transaction);
  const charge = order.settlementType === "ROOM_CHARGE" ? await GuestCharge.findOne({ where: { orderId: order.id, status: "POSTED" }, transaction }) : null;
  const payments = await Payment.findAll({ where: { orderId: order.id, status: "CAPTURED" }, include: [{ model: PaymentMethod, as: "method", attributes: ["code", "isCash"] }], order: [["id", "ASC"]], transaction });
  // Everything an accounting/GL or BI system needs to post the sale without calling back.
  await recordEvent(
    "OrderCompleted",
    "order",
    order.id,
    {
      orderNumber: order.orderNumber,
      externalReference: order.externalReference ?? null,
      outletId: order.outletId,
      shiftId: order.shiftId ?? null,
      orderType: order.orderType,
      tableOrLocation: order.tableOrLocation ?? null,
      tableId: order.outletTableId ?? null,
      roomNumber: order.roomNumber ?? null,
      settlementType: order.settlementType,
      currency: config.currencyCode,
      subtotal: order.subtotal,
      discountAmount: order.discountAmount,
      taxAmount: order.taxAmount,
      serviceChargeAmount: order.serviceChargeAmount,
      totalAmount: order.totalAmount,
      createdBy: order.createdBy,
      completedBy: userId,
      completedAt: order.completedAt,
      receiptNumber: receipt.receiptNumber,
      lines: items.map((i) => ({
        orderItemId: i.id, productId: i.productId, productCode: i.productCode, productName: i.productName, itemType: i.itemType, unit: i.unit,
        quantity: i.quantity, unitPrice: i.unitPrice, grossAmount: i.grossAmount, discountAmount: i.discountAmount,
        taxRate: i.taxRate, taxInclusive: Boolean(i.taxInclusive), taxAmount: i.taxAmount, netAmount: i.netAmount, lineTotal: i.lineTotal,
      })),
      discounts: discounts.map((d) => ({ code: d.discountCode, name: d.discountName, type: d.discountType, value: d.discountValue, amount: d.amount, orderItemId: d.orderItemId ?? null })),
      payments: payments.map((p) => ({ paymentNumber: p.paymentNumber, method: p.method?.code ?? null, isCash: Boolean(p.method?.isCash), amount: p.amount, externalTransactionId: p.externalTransactionId ?? null })),
      guestCharge: charge
        ? { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, externalFolioId: charge.externalFolioId, externalGuestId: charge.externalGuestId, externalRoomId: charge.externalRoomId, pmsTransactionId: charge.pmsTransactionId, amount: charge.amount }
        : null,
    },
    transaction
  );
  await audit({ req, userId, action: "ORDER_COMPLETED", entityType: "order", entityId: order.id, newValues: { totalAmount: order.totalAmount, settlementType: order.settlementType, receiptNumber: receipt.receiptNumber }, transaction });
  return receipt;
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
    tableId: o.outletTableId ?? null, roomNumber: o.roomNumber ?? null, totalAmount: o.totalAmount, createdAt: o.createdAt, createdBy: o.creator?.fullName,
  }));
}
