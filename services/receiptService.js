// Receipts are generated once from a snapshot of the order, so reprints always show
// exactly what was issued even if products, prices or settings change later.
import { Op } from "sequelize";
import {
  Receipt, Order, OrderItem, OrderDiscount, Payment, PaymentMethod, GuestCharge, Outlet, User, Refund, RefundItem,
} from "../models/index.js";
import { notFound, forbidden } from "../utils/http.js";
import { config } from "../config/env.js";
import { getSettings } from "./settingsService.js";
import { nextNumber } from "./numberingService.js";
import { audit } from "./auditService.js";

async function header() {
  const settings = await getSettings();
  return { hotelName: config.hotelName, header: settings.receipt_header || "", footer: settings.receipt_footer || "" };
}

export async function generateSaleReceipt(orderId, { userId }, transaction) {
  const existing = await Receipt.findOne({ where: { orderId, refundId: null }, transaction });
  if (existing) return existing;

  const order = await Order.findByPk(orderId, {
    include: [
      { model: Outlet, as: "outlet" },
      { model: User, as: "creator", attributes: ["fullName"] },
      { model: OrderItem, as: "items" },
      { model: OrderDiscount, as: "discounts" },
      { model: Payment, as: "payments", where: { status: "CAPTURED" }, required: false, include: [{ model: PaymentMethod, as: "method" }] },
      { model: GuestCharge, as: "guestCharges", where: { status: "POSTED" }, required: false },
    ],
    order: [[{ model: OrderItem, as: "items" }, "id", "ASC"]],
    transaction,
  });
  const cashier = await User.findByPk(userId, { attributes: ["fullName"], transaction });
  const charge = order.guestCharges[0];
  const roomCharge = order.settlementType === "ROOM_CHARGE" && charge;

  const snapshot = {
    ...(await header()),
    outlet: { code: order.outlet.code, name: order.outlet.name, location: order.outlet.location },
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    tableOrLocation: order.tableOrLocation,
    transactionAt: (order.completedAt || new Date()).toISOString(),
    cashier: cashier?.fullName || order.creator?.fullName,
    items: order.items.map((i) => ({
      name: i.productName, code: i.productCode, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice,
      grossAmount: i.grossAmount, discountAmount: i.discountAmount, lineTotal: i.lineTotal, notes: i.notes,
    })),
    discounts: order.discounts.map((d) => ({ code: d.discountCode, name: d.discountName, amount: d.amount })),
    subtotal: order.subtotal,
    discountAmount: order.discountAmount,
    taxAmount: order.taxAmount,
    taxInclusive: order.items.every((i) => i.taxInclusive),
    serviceChargeRate: order.serviceChargeRate,
    serviceChargeAmount: order.serviceChargeAmount,
    totalAmount: order.totalAmount,
    settlementType: order.settlementType,
    payments: order.payments.map((p) => ({
      method: p.method.name, amount: p.amount, tendered: p.tenderedAmount, change: p.changeAmount, reference: p.reference, isMock: p.isMock,
    })),
    roomCharge: roomCharge
      ? { roomNumber: charge.roomNumber, folio: charge.externalFolioId, pmsTransactionId: charge.pmsTransactionId, status: charge.status, isMock: charge.isMock }
      : null,
  };

  return Receipt.create(
    {
      receiptNumber: await nextNumber("receipt", transaction),
      orderId,
      receiptType: roomCharge ? "ROOM_CHARGE" : "SALE",
      snapshot,
      generatedBy: userId,
      generatedAt: new Date(),
    },
    { transaction }
  );
}

export async function generateRefundReceipt(refundId, { userId }, transaction) {
  const existing = await Receipt.findOne({ where: { refundId }, transaction });
  if (existing) return existing;
  const refund = await Refund.findByPk(refundId, {
    include: [
      { model: Order, as: "order", include: [{ model: Outlet, as: "outlet" }] },
      { model: RefundItem, as: "items", include: [{ model: OrderItem, as: "orderItem" }] },
      { model: PaymentMethod, as: "refundMethod" },
      { model: GuestCharge, as: "guestCharge" },
    ],
    transaction,
  });
  const cashier = await User.findByPk(userId, { attributes: ["fullName"], transaction });
  const snapshot = {
    ...(await header()),
    outlet: { code: refund.order.outlet.code, name: refund.order.outlet.name, location: refund.order.outlet.location },
    orderNumber: refund.order.orderNumber,
    refundNumber: refund.refundNumber,
    refundType: refund.refundType,
    reason: refund.reason,
    transactionAt: (refund.processedAt || new Date()).toISOString(),
    cashier: cashier?.fullName,
    items: refund.items.map((ri) => ({ name: ri.orderItem.productName, quantity: ri.quantity, unit: ri.orderItem.unit, lineTotal: ri.amount })),
    totalAmount: refund.amount,
    settlementType: refund.settlementType,
    refundMethod: refund.refundMethod?.name || null,
    externalReference: refund.externalReference,
    roomCharge: refund.guestCharge ? { roomNumber: refund.guestCharge.roomNumber, folio: refund.guestCharge.externalFolioId } : null,
  };
  return Receipt.create(
    { receiptNumber: await nextNumber("receipt", transaction), orderId: refund.orderId, refundId, receiptType: "REFUND", snapshot, generatedBy: userId, generatedAt: new Date() },
    { transaction }
  );
}

export async function getReceipt(req, id) {
  const receipt = await Receipt.findByPk(id, { include: [{ model: Order, as: "order", attributes: ["id", "outletId", "orderNumber", "status"] }] });
  if (!receipt) throw notFound("Receipt");
  if (!req.user.outletIds.includes(receipt.order.outletId)) throw forbidden();
  return receipt;
}

export async function markPrinted(req, id) {
  const receipt = await getReceipt(req, id);
  await receipt.update({ printCount: receipt.printCount + 1, lastPrintedAt: new Date() });
  if (receipt.printCount > 1) {
    await audit({ req, action: "RECEIPT_REPRINTED", entityType: "receipt", entityId: id, newValues: { receiptNumber: receipt.receiptNumber, printCount: receipt.printCount } });
  }
  return receipt;
}

export async function listReceipts(req, { search, type, start, end }, { limit, offset }) {
  const where = { generatedAt: { [Op.gte]: start, [Op.lt]: end } };
  if (search) where.receiptNumber = { [Op.like]: `%${search}%` };
  if (type) where.receiptType = type;
  return Receipt.findAndCountAll({
    where,
    attributes: { exclude: ["snapshot"] },
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "totalAmount", "outletId"], where: { outletId: req.user.outletIds.length ? req.user.outletIds : [0] } },
      { model: User, as: "generator", attributes: ["fullName"] },
    ],
    order: [["generatedAt", "DESC"]],
    limit,
    offset,
  });
}
