// Refunds (full or partial) with approval workflow. Nothing is deleted: payments get
// refunded amounts, posted room charges get a PMS reversal (full) or adjustment (partial),
// and the order moves to PARTIALLY_REFUNDED / REFUNDED.
//
// Flow: request (refunds.request) → approve & process by a different user (refunds.approve)
//       → external refund (payment provider / PMS, idempotent by key) → local finalisation
//       (amounts, item quantities, optional restock, refund receipt, event, audit).
import crypto from "crypto";
import { Op } from "sequelize";
import {
  sequelize, Refund, RefundItem, Order, OrderItem, Payment, PaymentMethod, GuestCharge, Outlet, User,
} from "../models/index.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toCents, fromCents, toMilli, fromMilli, roundCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { lockOrder } from "./orderService.js";
import { assertTransition, FINAL_SALE_STATUSES } from "./orderStateMachine.js";
import { returnForRefund } from "./inventoryService.js";
import { generateRefundReceipt } from "./receiptService.js";
import { recordEvent } from "../integrations/events/eventPublisher.js";
import { config } from "../config/env.js";
import { getPaymentGateway } from "../integrations/payments/paymentGateway.js";
import { getPmsGateway } from "../integrations/pms/pmsGateway.js";
import { logged, IntegrationError } from "../integrations/integrationLogger.js";

const OPEN_REFUND_STATUSES = ["REQUESTED", "APPROVED", "FAILED"];

// What is still refundable on an order, accounting for refunds already in progress.
export async function refundableState(orderId, transaction) {
  const order = await Order.findByPk(orderId, {
    include: [
      { model: OrderItem, as: "items" },
      { model: Payment, as: "payments", where: { status: { [Op.in]: ["CAPTURED", "PARTIALLY_REFUNDED"] } }, required: false, include: [{ model: PaymentMethod, as: "method" }] },
      { model: GuestCharge, as: "guestCharges", where: { status: { [Op.in]: ["POSTED", "PARTIALLY_REVERSED"] } }, required: false },
      { model: Outlet, as: "outlet", attributes: ["id", "code", "name"] },
    ],
    order: [[{ model: OrderItem, as: "items" }, "id", "ASC"]],
    transaction,
  });
  if (!order) throw notFound("Order");
  const openRefunds = await Refund.findAll({ where: { orderId, status: OPEN_REFUND_STATUSES }, include: [{ model: RefundItem, as: "items" }], transaction });
  const pendingQty = new Map();
  let pendingAmount = 0;
  for (const r of openRefunds) {
    pendingAmount += toCents(r.amount);
    for (const ri of r.items) pendingQty.set(String(ri.orderItemId), (pendingQty.get(String(ri.orderItemId)) || 0) + toMilli(ri.quantity));
  }
  const items = order.items.map((i) => {
    const remaining = toMilli(i.quantity) - toMilli(i.quantityRefunded) - (pendingQty.get(String(i.id)) || 0);
    return { ...i.get({ plain: true }), refundableQty: fromMilli(Math.max(0, remaining)) };
  });
  const refundable = toCents(order.amountPaid) - toCents(order.amountRefunded) - pendingAmount;
  return { order, items, refundable: Math.max(0, refundable), openRefunds };
}

// Amount for refunding `qty` of a line, including its share of the service charge.
function lineRefundCents(order, item, qtyMilli) {
  const lineCents = roundCents((toCents(item.lineTotal) * qtyMilli) / toMilli(item.quantity));
  const itemsTotal = order.items.reduce((s, i) => s + toCents(i.lineTotal), 0);
  const scShare = itemsTotal > 0 ? roundCents((toCents(order.serviceChargeAmount) * lineCents) / itemsTotal) : 0;
  return lineCents + scShare;
}

export async function requestRefund(req, rawOrderId, body) {
  const orderId = v.id(rawOrderId, "Order");
  const refundType = v.oneOf(body.refundType, "Refund type", ["FULL", "PARTIAL"]);
  const reason = v.str(body.reason, "Reason", { required: true, max: 255 });
  const restock = v.bool(body.restock);
  const refundMethodId = v.id(body.refundMethodId, "Refund method", { required: false });

  return sequelize.transaction(async (transaction) => {
    await lockOrder(req, orderId, transaction);
    const { order, items, refundable } = await refundableState(orderId, transaction);
    if (!FINAL_SALE_STATUSES.includes(order.status) || order.status === "REFUNDED") {
      throw new AppError("Only completed orders can be refunded. Use a void for unsettled orders.", 409, "NOT_REFUNDABLE");
    }
    if (refundable <= 0) throw new AppError("Nothing is left to refund on this order (including pending requests).", 409, "NOTHING_TO_REFUND");

    // Lines to refund
    let lines;
    if (refundType === "FULL") {
      lines = items.filter((i) => toMilli(i.refundableQty) > 0).map((i) => ({ item: i, qtyMilli: toMilli(i.refundableQty) }));
    } else {
      // Keys are "item_<orderItemId>" (numeric keys would be parsed as array indexes).
      const qtys = body.quantities && typeof body.quantities === "object" ? body.quantities : {};
      lines = items
        .map((i) => ({ item: i, qtyMilli: toMilli(v.quantity(qtys[`item_${i.id}`] || "0", `Quantity for ${i.productName}`, { allowZero: true })) }))
        .filter((l) => l.qtyMilli > 0);
      if (!lines.length) throw new AppError("Enter the quantity to refund for at least one item.", 422);
    }
    for (const l of lines) {
      if (l.qtyMilli > toMilli(l.item.refundableQty)) throw new AppError(`Only ${Number(l.item.refundableQty)} of ${l.item.productName} can still be refunded.`, 422);
    }
    let amount = refundType === "FULL" ? refundable : lines.reduce((s, l) => s + lineRefundCents(order, l.item, l.qtyMilli), 0);
    amount = Math.min(amount, refundable);
    if (amount <= 0) throw new AppError("The refund amount must be greater than zero.", 422);

    // Where the money goes back to
    let paymentId = null;
    let guestChargeId = null;
    let methodId = null;
    if (order.settlementType === "ROOM_CHARGE") {
      const charge = order.guestCharges[0];
      if (!charge) throw new AppError("No posted room charge found for this order.", 409, "NOTHING_TO_REFUND");
      guestChargeId = charge.id;
    } else {
      const method = refundMethodId ? await PaymentMethod.findByPk(refundMethodId, { transaction }) : null;
      const original = order.payments.filter((p) => toCents(p.amount) - toCents(p.refundedAmount) > 0);
      if (!original.length) throw new AppError("No refundable payment found on this order.", 409, "NOTHING_TO_REFUND");
      const chosen = method || original[0].method;
      if (chosen.usesGateway) {
        const payment = original.find((p) => p.paymentMethodId === chosen.id && toCents(p.amount) - toCents(p.refundedAmount) >= amount);
        if (!payment) throw new AppError(`Refunds to ${chosen.name} must go back to an original ${chosen.name} payment with enough remaining balance.`, 422, "REFUND_METHOD_MISMATCH");
        paymentId = payment.id;
      }
      methodId = chosen.id;
    }

    const refund = await Refund.create(
      {
        refundNumber: await nextNumber("refund", transaction),
        orderId: order.id,
        refundType: amount === toCents(order.amountPaid) - toCents(order.amountRefunded) ? "FULL" : refundType,
        settlementType: order.settlementType,
        amount: fromCents(amount),
        reason,
        restock,
        refundMethodId: methodId,
        paymentId,
        guestChargeId,
        idempotencyKey: crypto.randomUUID(),
        requestedBy: req.user.id,
      },
      { transaction }
    );
    await RefundItem.bulkCreate(
      lines.map((l) => ({
        refundId: refund.id, orderItemId: l.item.id, quantity: fromMilli(l.qtyMilli),
        amount: fromCents(roundCents((toCents(l.item.lineTotal) * l.qtyMilli) / toMilli(l.item.quantity))), restock,
      })),
      { transaction }
    );
    await audit({ req, action: "REFUND_REQUESTED", entityType: "order", entityId: order.id, newValues: { refundNumber: refund.refundNumber, amount: refund.amount, reason, restock }, transaction });
    return refund;
  });
}

async function loadRefund(req, id, transaction, lock = false) {
  const refund = await Refund.findByPk(id, {
    include: [{ model: Order, as: "order", attributes: ["id", "outletId", "orderNumber"] }],
    transaction,
    lock: lock ? transaction.LOCK.UPDATE : undefined,
  });
  if (!refund) throw notFound("Refund");
  if (!req.user.outletIds.includes(refund.order.outletId)) throw forbidden();
  return refund;
}

export async function rejectRefund(req, id, body) {
  const rejectionReason = v.str(body.rejectionReason, "Rejection reason", { required: true, max: 255 });
  return sequelize.transaction(async (transaction) => {
    const refund = await loadRefund(req, id, transaction, true);
    if (refund.status !== "REQUESTED") throw new AppError("Only pending refund requests can be rejected.", 409, "INVALID_REFUND_STATE");
    await refund.update({ status: "REJECTED", rejectionReason, approvedBy: req.user.id, approvedAt: new Date() }, { transaction });
    await audit({ req, action: "REFUND_REJECTED", entityType: "order", entityId: refund.orderId, newValues: { refundNumber: refund.refundNumber, rejectionReason }, transaction });
    return refund;
  });
}

// Approves (if still requested) and processes the refund. Also used to retry FAILED refunds.
export async function approveAndProcess(req, id, body = {}) {
  const externalReference = v.str(body.externalReference, "Reference", { max: 100 });

  const refund = await sequelize.transaction(async (transaction) => {
    const r = await loadRefund(req, id, transaction, true);
    if (!["REQUESTED", "FAILED", "APPROVED"].includes(r.status)) throw new AppError(`This refund is already ${r.status.toLowerCase()}.`, 409, "INVALID_REFUND_STATE");
    if (r.requestedBy === req.user.id) throw forbidden("A different supervisor must approve your own refund request.");
    if (r.status === "REQUESTED") {
      await r.update({ status: "APPROVED", approvedBy: req.user.id, approvedAt: new Date() }, { transaction });
      await audit({ req, action: "REFUND_APPROVED", entityType: "order", entityId: r.orderId, newValues: { refundNumber: r.refundNumber, amount: r.amount }, transaction });
    }
    return r;
  });

  // External refund first (idempotent by the refund's key), outside any DB lock.
  let externalRef = externalReference;
  try {
    if (refund.settlementType === "ROOM_CHARGE") {
      externalRef = await reverseRoomCharge(req, refund);
    } else if (refund.paymentId) {
      externalRef = await refundToGateway(req, refund);
    } else {
      const method = await PaymentMethod.findByPk(refund.refundMethodId);
      if (!method?.isCash && !externalRef) throw new AppError(`Enter the ${method?.name ?? "bank"} refund reference before processing.`, 422, "REFERENCE_REQUIRED");
    }
  } catch (err) {
    const message = err instanceof IntegrationError ? `${err.message} (safe to retry: the request is idempotent)` : err.message;
    if (err instanceof IntegrationError || err.code === "EXTERNAL_REJECTED") {
      await refund.update({ status: "FAILED", failureReason: message.slice(0, 255) });
      await audit({ req, action: "REFUND_FAILED", entityType: "order", entityId: refund.orderId, newValues: { refundNumber: refund.refundNumber, error: message } });
      throw new AppError(`Refund ${refund.refundNumber} failed: ${message}`, 502, "REFUND_FAILED");
    }
    throw err;
  }

  return finalizeRefund(req, refund.id, externalRef);
}

async function refundToGateway(req, refund) {
  const payment = await Payment.findByPk(refund.paymentId);
  const gateway = getPaymentGateway();
  const result = await logged(
    { system: "PAYMENT", operation: "refund", isMock: gateway.isMock, idempotencyKey: refund.idempotencyKey, referenceType: "refund", referenceId: refund.id, request: { transactionId: payment.externalTransactionId, amount: refund.amount }, userId: req.user.id },
    () => gateway.refund({ transactionId: payment.externalTransactionId, amount: refund.amount, idempotencyKey: refund.idempotencyKey })
  );
  if (result.status !== "REFUNDED") throw new AppError(result.reason || "The payment provider rejected the refund.", 502, "EXTERNAL_REJECTED");
  return result.refundId;
}

// Full refunds reverse the folio charge; partial refunds post a negative adjustment.
async function reverseRoomCharge(req, refund) {
  const charge = await GuestCharge.findByPk(refund.guestChargeId);
  const remaining = toCents(charge.amount) - toCents(charge.reversedAmount);
  const pms = getPmsGateway();
  const full = toCents(refund.amount) === remaining && toCents(charge.reversedAmount) === 0;
  const result = full
    ? await logged(
        { system: "PMS", operation: "reverseCharge", isMock: pms.isMock, idempotencyKey: refund.idempotencyKey, referenceType: "refund", referenceId: refund.id, request: { folioId: charge.externalFolioId, transactionId: charge.pmsTransactionId, amount: refund.amount }, userId: req.user.id },
        () => pms.reverseCharge({ folioId: charge.externalFolioId, transactionId: charge.pmsTransactionId, amount: refund.amount, reason: refund.reason, idempotencyKey: refund.idempotencyKey })
      )
    : await logged(
        { system: "PMS", operation: "postAdjustment", isMock: pms.isMock, idempotencyKey: refund.idempotencyKey, referenceType: "refund", referenceId: refund.id, request: { folioId: charge.externalFolioId, amount: `-${refund.amount}` }, userId: req.user.id },
        () => pms.postAdjustment({ folioId: charge.externalFolioId, amount: `-${refund.amount}`, reason: refund.reason, reference: refund.refundNumber, idempotencyKey: refund.idempotencyKey })
      );
  if (!["REVERSED", "POSTED"].includes(result.status)) throw new AppError(result.reason || "The PMS rejected the reversal.", 502, "EXTERNAL_REJECTED");
  return result.transactionId;
}

async function finalizeRefund(req, refundId, externalReference) {
  return sequelize.transaction(async (transaction) => {
    const refund = await Refund.findByPk(refundId, { include: [{ model: RefundItem, as: "items" }], transaction, lock: transaction.LOCK.UPDATE });
    if (refund.status === "PROCESSED") return refund;
    const order = await lockOrder(req, refund.orderId, transaction);
    const method = refund.refundMethodId ? await PaymentMethod.findByPk(refund.refundMethodId, { transaction }) : null;

    // Cash refunds leave the processor's drawer, so they belong to an open shift at this outlet.
    let shiftId = null;
    if (method?.isCash) {
      if (!req.openShift || req.openShift.outletId !== order.outletId) {
        throw new AppError("Open a cashier shift at this outlet to pay out a cash refund.", 409, "SHIFT_REQUIRED");
      }
      shiftId = req.openShift.id;
    }

    const amount = toCents(refund.amount);
    if (refund.paymentId) {
      const payment = await Payment.findByPk(refund.paymentId, { transaction, lock: transaction.LOCK.UPDATE });
      const refunded = toCents(payment.refundedAmount) + amount;
      await payment.update({ refundedAmount: fromCents(refunded), status: refunded >= toCents(payment.amount) ? "REFUNDED" : "PARTIALLY_REFUNDED" }, { transaction });
    }
    let charge = null;
    if (refund.guestChargeId) {
      charge = await GuestCharge.findByPk(refund.guestChargeId, { transaction, lock: transaction.LOCK.UPDATE });
      const reversed = toCents(charge.reversedAmount) + amount;
      await charge.update({ reversedAmount: fromCents(reversed), status: reversed >= toCents(charge.amount) ? "REVERSED" : "PARTIALLY_REVERSED" }, { transaction });
    }

    const lines = [];
    const refundedLines = [];
    for (const ri of refund.items) {
      const item = await OrderItem.findByPk(ri.orderItemId, { transaction });
      refundedLines.push({ orderItemId: item.id, productId: item.productId, productCode: item.productCode, productName: item.productName, quantity: ri.quantity, amount: ri.amount, restock: Boolean(ri.restock) });
      await item.update({ quantityRefunded: fromMilli(toMilli(item.quantityRefunded) + toMilli(ri.quantity)) }, { transaction });
      if (ri.restock) lines.push({ productId: item.productId, quantity: ri.quantity, refundItemId: ri.id, refundId: refund.id, refundNumber: refund.refundNumber });
    }
    if (lines.length) await returnForRefund(order, lines, { userId: req.user.id }, transaction);

    const totalRefunded = toCents(order.amountRefunded) + amount;
    const nextStatus = totalRefunded >= toCents(order.amountPaid) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    assertTransition(order.status, nextStatus);
    await order.update({ amountRefunded: fromCents(totalRefunded), status: nextStatus, version: order.version + 1 }, { transaction });

    await refund.update(
      { status: "PROCESSED", processedBy: req.user.id, processedAt: new Date(), shiftId, externalReference: externalReference ?? refund.externalReference, failureReason: null },
      { transaction }
    );
    const receipt = await generateRefundReceipt(refund.id, { userId: req.user.id }, transaction);
    if (charge) {
      await recordEvent(
        "RoomChargeReversed",
        "order",
        order.id,
        {
          chargeNumber: charge.chargeNumber, orderId: order.id, orderNumber: order.orderNumber, outletId: order.outletId, refundNumber: refund.refundNumber,
          externalFolioId: charge.externalFolioId, externalGuestId: charge.externalGuestId, pmsTransactionId: charge.pmsTransactionId,
          reversalReference: refund.externalReference ?? null, currency: config.currencyCode, amount: refund.amount, chargeStatus: charge.status,
        },
        transaction
      );
    }
    await recordEvent(
      "OrderRefunded",
      "order",
      order.id,
      {
        orderNumber: order.orderNumber, externalReference: order.externalReference ?? null, outletId: order.outletId, refundNumber: refund.refundNumber,
        refundType: refund.refundType, settlementType: refund.settlementType, reason: refund.reason, currency: config.currencyCode, amount: refund.amount,
        method: method?.code ?? null, paymentId: refund.paymentId ?? null, guestChargeId: refund.guestChargeId ?? null, shiftId,
        refundReference: refund.externalReference ?? null, orderStatus: nextStatus, receiptNumber: receipt.receiptNumber,
        lines: refundedLines, processedBy: req.user.id, processedAt: refund.processedAt,
      },
      transaction
    );
    await audit({
      req, action: "REFUND_PROCESSED", entityType: "order", entityId: order.id,
      newValues: { refundNumber: refund.refundNumber, amount: refund.amount, orderStatus: nextStatus, externalReference: refund.externalReference, receipt: receipt.receiptNumber },
      transaction,
    });
    return refund;
  });
}

export async function listRefunds(req, { status, start, end }, { limit, offset }) {
  const where = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
  if (status) where.status = status;
  return Refund.findAndCountAll({
    where,
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "outletId"], where: { outletId: req.user.outletIds.length ? req.user.outletIds : [0] }, include: [{ model: Outlet, as: "outlet", attributes: ["code"] }] },
      { model: User, as: "requester", attributes: ["fullName"] },
      { model: User, as: "approver", attributes: ["fullName"] },
    ],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
}

export async function listVoids(req, { start, end }, { limit, offset }) {
  return Order.findAndCountAll({
    where: { status: "VOIDED", voidedAt: { [Op.gte]: start, [Op.lt]: end }, outletId: req.user.outletIds.length ? req.user.outletIds : [0] },
    include: [
      { model: Outlet, as: "outlet", attributes: ["code"] },
      { model: User, as: "creator", attributes: ["fullName"] },
      { model: User, as: "voider", attributes: ["fullName"] },
    ],
    order: [["voidedAt", "DESC"]],
    limit,
    offset,
  });
}

export async function getRefund(req, id) {
  const refund = await Refund.findByPk(id, {
    include: [
      { model: Order, as: "order", include: [{ model: Outlet, as: "outlet", attributes: ["code", "name"] }] },
      { model: RefundItem, as: "items", include: [{ model: OrderItem, as: "orderItem" }] },
      { model: PaymentMethod, as: "refundMethod" },
      { model: Payment, as: "payment" },
      { model: GuestCharge, as: "guestCharge" },
      { model: User, as: "requester", attributes: ["id", "fullName"] },
      { model: User, as: "approver", attributes: ["fullName"] },
      { model: User, as: "processor", attributes: ["fullName"] },
    ],
  });
  if (!refund) throw notFound("Refund");
  if (!req.user.outletIds.includes(refund.order.outletId)) throw forbidden();
  return refund;
}
