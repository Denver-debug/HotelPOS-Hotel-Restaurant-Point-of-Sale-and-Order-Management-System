// Direct payments: cash, and the GCash / Maya e-wallets (SUPPORTED_PAYMENT_METHODS).
// Cash and reference-only methods are captured locally in one DB transaction.
// Gateway methods follow F13: Payment Processing (PENDING, order SETTLING) → provider →
// Paid (CAPTURED) or declined() back to Awaiting Settlement. A lost response leaves the
// payment PENDING until it is verified with the provider — it is never blindly re-sent.
// With a hosted checkout (PayMongo) the provider first answers AWAITING_CUSTOMER: the POS
// shows the checkout link as a QR code and the payment stays PENDING until the guest
// approves it on their phone (verify / webhook), declines it, or the cashier cancels it.
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, Order, Payment, PaymentMethod, GuestCharge, Outlet, User, Receipt } from "../models/index.js";
import { SUPPORTED_PAYMENT_METHODS } from "../models/salesModel.js";
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
import { config } from "../config/env.js";
import { recordEvent } from "../integrations/events/eventPublisher.js";

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
// req is null for a provider webhook: the cashier who took the payment is the actor.
async function applyCapture(req, order, payment, { externalTransactionId, settledExternally }, transaction) {
  const userId = req?.user?.id ?? payment.processedBy;
  await payment.update({ status: "CAPTURED", externalTransactionId: externalTransactionId ?? payment.externalTransactionId, capturedAt: new Date() }, { transaction });
  const paid = toCents(order.amountPaid) + toCents(payment.amount);
  await order.update({ amountPaid: fromCents(paid), settlementType: "DIRECT_PAYMENT", version: order.version + 1 }, { transaction });
  await audit({ req, userId, action: "PAYMENT_CAPTURED", entityType: "order", entityId: order.id, newValues: { paymentNumber: payment.paymentNumber, amount: payment.amount, isMock: payment.isMock }, transaction });
  const method = await PaymentMethod.findByPk(payment.paymentMethodId, { attributes: ["code", "name", "isCash"], transaction });
  await recordEvent(
    "PaymentCaptured",
    "order",
    order.id,
    {
      paymentNumber: payment.paymentNumber, orderId: order.id, orderNumber: order.orderNumber, outletId: order.outletId, shiftId: payment.shiftId ?? null,
      method: method?.code ?? null, isCash: Boolean(method?.isCash), currency: config.currencyCode, amount: payment.amount,
      tenderedAmount: payment.tenderedAmount ?? null, changeAmount: payment.changeAmount, reference: payment.reference ?? null,
      externalTransactionId: payment.externalTransactionId ?? null, isMock: Boolean(payment.isMock), capturedAt: payment.capturedAt, processedBy: payment.processedBy,
    },
    transaction
  );

  if (paid >= toCents(order.totalAmount)) {
    if (order.status === "AWAITING_SETTLEMENT" || order.status === "CHARGE_FAILED") {
      assertTransition(order.status === "CHARGE_FAILED" ? "CHARGE_FAILED" : "AWAITING_SETTLEMENT", "SETTLING");
      await order.update({ status: "SETTLING" }, { transaction });
    }
    return completeOrder(order, { req, userId, settledExternally }, transaction);
  }
  // Partial payment: remain awaiting settlement for the balance.
  if (order.status !== "AWAITING_SETTLEMENT") await order.update({ status: "AWAITING_SETTLEMENT" }, { transaction });
  return null;
}

// A repeated idempotency key returns the original outcome, in the same shape as the first
// response: captured → ok with the receipt, declined → 402, still pending → 409.
async function replayPayment(previous, orderId) {
  if (String(previous.orderId) !== String(orderId)) throw new AppError("This payment key belongs to another order.", 409, "IDEMPOTENCY_CONFLICT");
  if (previous.status === "FAILED") return { payment: previous, duplicate: true, declined: true, reason: previous.failureReason || "Payment was declined." };
  if (previous.status === "PENDING" && previous.checkoutUrl) return { payment: previous, duplicate: true, awaiting: true };
  if (previous.status === "PENDING") {
    throw new AppError(
      `Payment ${previous.paymentNumber} with this key is still being processed. Verify it before trying again.`,
      409,
      "SETTLEMENT_IN_PROGRESS",
      { paymentId: previous.id }
    );
  }
  const receipt = await Receipt.findOne({ where: { orderId: previous.orderId, refundId: null } });
  return { payment: previous, duplicate: true, receipt };
}

export async function processPayment(req, orderId, body) {
  const paymentMethodId = v.id(body.paymentMethodId, "Payment method");
  const amount = v.money(body.amount, "Amount", { min: 0.01 });
  const reference = v.str(body.reference, "Reference", { max: 100 });
  const idempotencyKey = v.str(body.idempotencyKey, "Idempotency key", { required: true, min: 8, max: 100 });

  // A repeated submission returns the original result instead of charging twice.
  const previous = await Payment.findOne({ where: { idempotencyKey } });
  if (previous) return replayPayment(previous, orderId);

  const method = await PaymentMethod.findByPk(paymentMethodId);
  if (!method || method.status !== "ACTIVE" || !SUPPORTED_PAYMENT_METHODS.includes(method.code)) {
    throw new AppError("Select an active payment method: Cash, GCash or Maya.", 422, "PAYMENT_METHOD_INACTIVE");
  }
  const gateway = method.usesGateway ? getPaymentGateway() : null;
  if (method.requiresReference && !gateway?.hostedCheckout && !reference) throw new AppError(`${method.name} requires a reference number.`, 422, "REFERENCE_REQUIRED");

  // Step 1: validate and record the payment (and capture it if it is local).
  let step1;
  try {
    step1 = await sequelize.transaction(async (transaction) => {
      const order = await lockOrder(req, orderId, transaction);
      // A retry with the same key may have committed while this request waited for the lock.
      const raced = await Payment.findOne({ where: { idempotencyKey }, transaction });
      if (raced) return { raced };
      if (order.status === "SETTLING") {
        throw new AppError("A payment or room charge for this order is still being processed. Verify it before trying again.", 409, "SETTLEMENT_IN_PROGRESS");
      }
      if (!SETTLEABLE_STATUSES.includes(order.status)) {
        throw new AppError(`Order ${order.orderNumber} is ${order.status.replace(/_/g, " ").toLowerCase()}; request settlement first.`, 409, "NOT_SETTLEABLE");
      }
      const pendingCharge = await GuestCharge.count({ where: { orderId: order.id, status: { [Op.in]: ["PENDING", "UNKNOWN", "POSTED", "AWAITING_REVIEW"] } }, transaction });
      if (pendingCharge) throw new AppError("A room charge is in progress or posted for this order.", 409, "ROOM_CHARGE_IN_PROGRESS");
      const pendingPayment = await Payment.count({ where: { orderId: order.id, status: "PENDING" }, transaction });
      if (pendingPayment) throw new AppError("Another payment for this order is still being processed. Verify it first.", 409, "SETTLEMENT_IN_PROGRESS");

      const shift = await resolveShift(req, order.outletId);
      const balance = toCents(order.totalAmount) - toCents(order.amountPaid);
      if (balance <= 0) throw new AppError("This order is already fully paid.", 409, "ALREADY_PAID");
      if (toCents(amount) > balance) throw new AppError(`Amount exceeds the balance due (${fromCents(balance)}).`, 422, "AMOUNT_EXCEEDS_BALANCE");

      let tenderedAmount = null;
      let changeAmount = "0.00";
      if (method.isCash) {
        tenderedAmount = v.money(body.tenderedAmount ?? amount, "Cash received");
        if (toCents(tenderedAmount) < toCents(amount)) throw new AppError("Cash received is less than the amount to apply.", 422, "INSUFFICIENT_TENDER");
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
      return { payment, orderNumber: order.orderNumber, done: false };
    });
  } catch (err) {
    // Same key used for two different orders at once: the unique index decides.
    if (err instanceof UniqueConstraintError && JSON.stringify(err.fields || {}).includes("idempotency")) {
      return replayPayment(await Payment.findOne({ where: { idempotencyKey } }), orderId);
    }
    throw err;
  }
  if (step1.raced) return replayPayment(step1.raced, orderId);
  if (step1.done) return step1;

  // Step 2: call the provider outside the DB transaction (no row locks held during I/O).
  let result;
  try {
    result = await logged(
      {
        system: "PAYMENT", operation: "authorizeAndCapture", isMock: gateway.isMock, idempotencyKey,
        referenceType: "payment", referenceId: step1.payment.id, request: { amount, methodCode: method.code, reference }, userId: req.user.id,
      },
      () =>
        gateway.authorizeAndCapture({
          amount, currency: config.currencyCode, methodCode: method.code, reference, idempotencyKey,
          description: `${config.appName} ${step1.orderNumber} (${step1.payment.paymentNumber})`,
          metadata: { paymentNumber: step1.payment.paymentNumber, orderNumber: step1.orderNumber },
        })
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

// Step 3: record the provider's answer (used by the first attempt, verify(), cancel() and
// webhooks; req is null for a webhook).
async function finalizeGatewayResult(req, paymentId, result) {
  return sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await lockOrder(req, payment.orderId, transaction);
    const userId = req?.user?.id ?? payment.processedBy;
    if (payment.status !== "PENDING") {
      // Paid at the provider after HotelPOS gave up on it: the money has to go back by hand.
      if (payment.status === "FAILED" && result.status === "CAPTURED" && !payment.externalTransactionId) {
        await payment.update({ externalTransactionId: result.transactionId }, { transaction });
        await audit({ req, userId, action: "PAYMENT_PAID_AFTER_FAILURE", entityType: "order", entityId: order.id, newValues: { paymentNumber: payment.paymentNumber, transactionId: result.transactionId, amount: payment.amount }, transaction });
      }
      return { payment, done: payment.status === "CAPTURED" };
    }
    if (result.providerReference && !payment.providerReference) await payment.update({ providerReference: result.providerReference }, { transaction });

    if (result.status === "AWAITING_CUSTOMER") {
      if (result.checkoutUrl || result.expiresAt) {
        await payment.update({ checkoutUrl: result.checkoutUrl ?? payment.checkoutUrl, checkoutExpiresAt: result.expiresAt ?? payment.checkoutExpiresAt }, { transaction });
      }
      return { payment, awaiting: true, processing: Boolean(result.processing) };
    }
    if (result.status === "CAPTURED") {
      const receipt = await applyCapture(req, order, payment, { externalTransactionId: result.transactionId, settledExternally: true }, transaction);
      return { payment, receipt, done: true };
    }
    const reason = result.status === "NOT_FOUND" ? "Provider has no record of this payment." : result.reason || "Payment was declined.";
    await payment.update({ status: "FAILED", failureReason: reason.slice(0, 255) }, { transaction });
    if (order.status === "SETTLING") await order.update({ status: "AWAITING_SETTLEMENT", version: order.version + 1 }, { transaction });
    await audit({ req, userId, action: result.cancelled ? "PAYMENT_CANCELLED" : "PAYMENT_DECLINED", entityType: "order", entityId: order.id, newValues: { paymentNumber: payment.paymentNumber, reason }, transaction });
    return { payment, declined: true, reason };
  });
}

export async function getPayment(req, paymentId) {
  const payment = await Payment.findByPk(paymentId, { include: [{ model: Order, as: "order", attributes: ["outletId"] }] });
  if (!payment) throw notFound("Payment");
  if (!req.user.outletIds.includes(payment.order.outletId)) throw forbidden();
  return payment;
}

// Asks the provider that took the payment (PAYMENT_ADAPTER may have been switched since).
// req is null for a webhook.
async function askProvider(req, payment, operation, request) {
  const gateway = getPaymentGateway();
  if (payment.gateway && payment.gateway !== gateway.name) {
    throw new AppError(`Payment ${payment.paymentNumber} went through ${payment.gateway}, but HotelPOS now uses ${gateway.name}. Check it in that provider's dashboard.`, 409, "PAYMENT_GATEWAY_CHANGED");
  }
  const ref = { idempotencyKey: payment.idempotencyKey, providerReference: payment.providerReference };
  try {
    return await logged(
      { system: "PAYMENT", operation, isMock: gateway.isMock, idempotencyKey: payment.idempotencyKey, referenceType: "payment", referenceId: payment.id, request, userId: req?.user?.id ?? null },
      () => (operation === "cancel" ? gateway.cancel(ref) : gateway.getStatus(ref))
    );
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    throw new AppError(`The payment provider is still not responding (${err.message}). Try again shortly; do not take the payment another way yet.`, 504, "PAYMENT_UNKNOWN", { paymentId: payment.id });
  }
}

export async function verifyPayment(req, paymentId) {
  const payment = await getPayment(req, paymentId);
  if (payment.status !== "PENDING") return { payment, done: payment.status === "CAPTURED" };
  return finalizeGatewayResult(req, payment.id, await askProvider(req, payment, "getStatus"));
}

// The guest walked away or wants to pay another way. A payment the provider already took is
// recorded as paid instead; one it is still processing cannot be cancelled yet.
export async function cancelPayment(req, paymentId) {
  const payment = await getPayment(req, paymentId);
  if (payment.status !== "PENDING") return { payment, done: payment.status === "CAPTURED" };
  const result = await finalizeGatewayResult(req, payment.id, await askProvider(req, payment, "cancel"));
  if (result.awaiting) {
    throw new AppError(`The guest has already approved ${payment.paymentNumber} and the provider is processing it. Wait a moment, then check it again.`, 409, "PAYMENT_PROCESSING", { paymentId: payment.id });
  }
  return result;
}

// Provider webhook (POST /webhooks/paymongo). The event only names the payment; its outcome
// is read back from the provider. Events for unknown payments are acknowledged and ignored.
export async function handleWebhook(rawBody, signatureHeader) {
  const gateway = getPaymentGateway();
  if (!gateway.parseWebhook) throw notFound("Webhook");
  let event;
  try {
    event = gateway.parseWebhook(rawBody, signatureHeader);
  } catch (err) {
    if (err instanceof IntegrationError) throw new AppError(err.message, 503, "WEBHOOK_NOT_CONFIGURED");
    throw new AppError("The webhook body is not valid JSON.", 400);
  }
  if (!event) throw new AppError("Invalid webhook signature.", 401, "INVALID_SIGNATURE");
  const payment = event.providerReference ? await Payment.findOne({ where: { providerReference: event.providerReference } }) : null;
  if (!payment) return { ignored: true, event };
  const result = await askProvider(null, payment, "getStatus", { webhookEvent: event.type, eventId: event.eventId });
  return { event, ...(await finalizeGatewayResult(null, payment.id, result)) };
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
