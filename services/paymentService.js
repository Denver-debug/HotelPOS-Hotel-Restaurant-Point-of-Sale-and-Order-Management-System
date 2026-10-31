// Direct payments (cash, card, e-wallet, bank transfer, other).
// Cash and reference-only methods are captured locally in one DB transaction.
// Gateway methods follow F13: Payment Processing (PENDING, order SETTLING) → provider →
// Paid (CAPTURED) or declined() back to Awaiting Settlement. A lost response leaves the
// payment PENDING until it is verified with the provider — it is never blindly re-sent.
import { Op } from "sequelize";
import { sequelize, Order, Payment, PaymentMethod, GuestCharge, Outlet, User } from "../models/index.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toCents, fromCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { getSetting } from "./settingsService.js";
import { lockOrder, completeOrder } from "./orderService.js";
import { assertTransition, SETTLEABLE_STATUSES } from "./orderStateMachine.js";
import { getPaymentGateway } from "../integrations/payments/paymentGateway.js";
import { logged, IntegrationError } from "../integrations/integrationLogger.js";

export async function resolveShift(req, outletId) {
  const required = await getSetting("require_shift_for_settlement", true);
  const shift = req.openShift && req.openShift.outletId === Number(outletId) ? req.openShift : null;
  if (required && !shift) {
    throw new AppError(
      req.openShift ? "Your open shift belongs to another outlet." : "Open a cashier shift at this outlet before taking payments.",
      409,
      "SHIFT_REQUIRED"
    );
  }
  return shift;
}

// Applies a captured payment to the order; completes the order when fully paid.
async function applyCapture(req, order, payment, { externalTransactionId, settledExternally }, transaction) {
  await payment.update({ status: "CAPTURED", externalTransactionId: externalTransactionId ?? payment.externalTransactionId, capturedAt: new Date() }, { transaction });
  const paid = toCents(order.amountPaid) + toCents(payment.amount);
  await order.update({ amountPaid: fromCents(paid), settlementType: "DIRECT_PAYMENT", version: order.version + 1 }, { transaction });
  await audit({ req, action: "PAYMENT_CAPTURED", entityType: "order", entityId: order.id, newValues: { paymentNumber: payment.paymentNumber, amount: payment.amount, isMock: payment.isMock }, transaction });

  if (paid >= toCents(order.totalAmount)) {
    if (order.status === "AWAITING_SETTLEMENT" || order.status === "CHARGE_FAILED") {
      assertTransition(order.status === "CHARGE_FAILED" ? "CHARGE_FAILED" : "AWAITING_SETTLEMENT", "SETTLING");
      await order.update({ status: "SETTLING" }, { transaction });
    }
    return completeOrder(order, { req, userId: req.user.id, settledExternally }, transaction);
  }
  // Partial payment: remain awaiting settlement for the balance.
  if (order.status !== "AWAITING_SETTLEMENT") await order.update({ status: "AWAITING_SETTLEMENT" }, { transaction });
  return null;
}

export async function processPayment(req, orderId, body) {
  const paymentMethodId = v.id(body.paymentMethodId, "Payment method");
  const amount = v.money(body.amount, "Amount", { min: 0.01 });
  const reference = v.str(body.reference, "Reference", { max: 100 });
  const idempotencyKey = v.str(body.idempotencyKey, "Idempotency key", { required: true, min: 8, max: 100 });

  // A repeated submission returns the original result instead of charging twice.
  const previous = await Payment.findOne({ where: { idempotencyKey } });
  if (previous) {
    if (String(previous.orderId) !== String(orderId)) throw new AppError("This payment key belongs to another order.", 409);
    return { payment: previous, duplicate: true };
  }

  const method = await PaymentMethod.findByPk(paymentMethodId);
  if (!method || method.status !== "ACTIVE") throw new AppError("Select an active payment method.", 422);
  if (method.requiresReference && !reference) throw new AppError(`${method.name} requires a reference number.`, 422);

  const gateway = method.usesGateway ? getPaymentGateway() : null;

  // Step 1: validate and record the payment (and capture it if it is local).
  const step1 = await sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    if (order.status === "SETTLING") {
      throw new AppError("A payment or room charge for this order is still being processed. Verify it before trying again.", 409, "SETTLEMENT_IN_PROGRESS");
    }
    if (!SETTLEABLE_STATUSES.includes(order.status)) {
      throw new AppError(`Order ${order.orderNumber} is ${order.status.replace(/_/g, " ").toLowerCase()}; request settlement first.`, 409, "NOT_SETTLEABLE");
    }
    const pendingCharge = await GuestCharge.count({ where: { orderId: order.id, status: { [Op.in]: ["PENDING", "UNKNOWN", "POSTED"] } }, transaction });
    if (pendingCharge) throw new AppError("A room charge is in progress or posted for this order.", 409);
    const pendingPayment = await Payment.count({ where: { orderId: order.id, status: "PENDING" }, transaction });
    if (pendingPayment) throw new AppError("Another payment for this order is still being processed. Verify it first.", 409);

    const shift = await resolveShift(req, order.outletId);
    const balance = toCents(order.totalAmount) - toCents(order.amountPaid);
    if (balance <= 0) throw new AppError("This order is already fully paid.", 409);
    if (toCents(amount) > balance) throw new AppError(`Amount exceeds the balance due (${fromCents(balance)}).`, 422);

    let tenderedAmount = null;
    let changeAmount = "0.00";
    if (method.isCash) {
      tenderedAmount = v.money(body.tenderedAmount ?? amount, "Cash received");
      if (toCents(tenderedAmount) < toCents(amount)) throw new AppError("Cash received is less than the amount to apply.", 422);
      changeAmount = fromCents(toCents(tenderedAmount) - toCents(amount));
    }

    const payment = await Payment.create(
      {
        paymentNumber: await nextNumber("payment", transaction),
        orderId: order.id,
        shiftId: shift?.id ?? null,
        paymentMethodId: method.id,
        amount,
        tenderedAmount,
        changeAmount,
        reference,
        status: "PENDING",
        gateway: gateway?.name ?? null,
        idempotencyKey,
        isMock: Boolean(gateway?.isMock),
        processedBy: req.user.id,
      },
      { transaction }
    );

    if (!gateway) {
      const receipt = await applyCapture(req, order, payment, { settledExternally: false }, transaction);
      return { payment, receipt, done: true };
    }
    assertTransition(order.status, "SETTLING");
    await order.update({ status: "SETTLING", version: order.version + 1 }, { transaction });
    await audit({ req, action: "PAYMENT_SUBMITTED", entityType: "order", entityId: order.id, newValues: { paymentNumber: payment.paymentNumber, amount, method: method.code, isMock: gateway.isMock }, transaction });
    return { payment, done: false };
  });
  if (step1.done) return step1;

  // Step 2: call the provider outside the DB transaction (no row locks held during I/O).
  let result;
  try {
    result = await logged(
      {
        system: "PAYMENT", operation: "authorizeAndCapture", isMock: gateway.isMock, idempotencyKey,
        referenceType: "payment", referenceId: step1.payment.id, request: { amount, methodCode: method.code, reference }, userId: req.user.id,
      },
      () => gateway.authorizeAndCapture({ amount, currency: "PHP", methodCode: method.code, reference, idempotencyKey })
    );
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    await audit({ req, action: "PAYMENT_OUTCOME_UNKNOWN", entityType: "order", entityId: orderId, newValues: { paymentNumber: step1.payment.paymentNumber, error: err.message } });
    throw new AppError(
      `The payment provider did not confirm ${step1.payment.paymentNumber} (${err.message}). It was not retried. Use “Verify” on the Payments page before trying again.`,
      504,
      "PAYMENT_UNKNOWN",
      { paymentId: step1.payment.id }
    );
  }
  return finalizeGatewayResult(req, step1.payment.id, result);
}

// Step 3: record the provider's answer (used by the first attempt and by verify()).
async function finalizeGatewayResult(req, paymentId, result) {
  return sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await lockOrder(req, payment.orderId, transaction);
    if (payment.status !== "PENDING") return { payment, done: payment.status === "CAPTURED" };

    if (result.status === "CAPTURED") {
      const receipt = await applyCapture(req, order, payment, { externalTransactionId: result.transactionId, settledExternally: true }, transaction);
      return { payment, receipt, done: true };
    }
    const reason = result.status === "NOT_FOUND" ? "Provider has no record of this payment." : result.reason || "Payment was declined.";
    await payment.update({ status: "FAILED", failureReason: reason.slice(0, 255) }, { transaction });
    if (order.status === "SETTLING") await order.update({ status: "AWAITING_SETTLEMENT", version: order.version + 1 }, { transaction });
    await audit({ req, action: "PAYMENT_DECLINED", entityType: "order", entityId: order.id, newValues: { paymentNumber: payment.paymentNumber, reason }, transaction });
    return { payment, declined: true, reason };
  });
}

export async function verifyPayment(req, paymentId) {
  const payment = await Payment.findByPk(paymentId, { include: [{ model: Order, as: "order", attributes: ["outletId"] }] });
  if (!payment) throw notFound("Payment");
  if (!req.user.outletIds.includes(payment.order.outletId)) throw forbidden();
  if (payment.status !== "PENDING") return { payment, done: payment.status === "CAPTURED" };
  const gateway = getPaymentGateway();
  const result = await logged(
    { system: "PAYMENT", operation: "getStatus", isMock: gateway.isMock, idempotencyKey: payment.idempotencyKey, referenceType: "payment", referenceId: payment.id, userId: req.user.id },
    () => gateway.getStatus(payment.idempotencyKey)
  );
  return finalizeGatewayResult(req, payment.id, result);
}

export async function listPayments(req, { search, outletId, methodId, status, cashierId, start, end }, { limit, offset }) {
  const where = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
  if (search) where.paymentNumber = { [Op.like]: `%${search}%` };
  if (methodId) where.paymentMethodId = methodId;
  if (status) where.status = status;
  if (cashierId) where.processedBy = cashierId;
  const orderWhere = { outletId: outletId && req.user.outletIds.includes(Number(outletId)) ? outletId : req.user.outletIds.length ? req.user.outletIds : [0] };
  return Payment.findAndCountAll({
    where,
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "outletId"], where: orderWhere, include: [{ model: Outlet, as: "outlet", attributes: ["code"] }] },
      { model: PaymentMethod, as: "method", attributes: ["name", "usesGateway"] },
      { model: User, as: "processor", attributes: ["fullName"] },
    ],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
}
