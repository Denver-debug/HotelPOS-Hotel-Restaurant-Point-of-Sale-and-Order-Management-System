// Charge to Room through the PMS (Figures 11–16, spec §4.9).
//
//  1. validateRoom: room number → PMS active folio (no charge is assumed from a room number)
//  2. cashier confirms the PMS-validated guest/room/folio (single-use, short-lived token)
//  3. postRoomCharge: guest_charge PENDING + order SETTLING are committed BEFORE calling the PMS,
//     with a unique idempotency key; the PMS response then decides:
//       POSTED   → charge POSTED with PMS transaction id → order completed (stock, receipt, event)
//       REJECTED → charge FAILED, order CHARGE_FAILED (cashier may try another room or pay directly)
//       timeout  → charge UNKNOWN; nothing is re-sent until verifyCharge() asks the PMS for the
//                  status by idempotency key. Only a NOT_FOUND answer allows a re-post (same key,
//                  max attempts from settings).
// With the Frontdesk PMS (PMS_ADAPTER=frontdesk) a receptionist reviews each charge first:
//       SUBMITTED → charge AWAITING_REVIEW → order completed (the guest has left the table)
//       then, by webhook (/webhooks/pms), polling or "Check status":
//         ADDED_TO_FOLIO → charge POSTED;   REJECTED → charge REJECTED: collect from the guest
// Only external guest/room/folio IDs are stored (TC-09); the guest name is never persisted.
import crypto from "crypto";
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, GuestCharge, Order, OrderItem, Outlet, User, RoomChargeValidation } from "../models/index.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toCents, toMilli, formatQty } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { getSetting } from "./settingsService.js";
import { lockOrder, completeOrder } from "./orderService.js";
import { resolveShift } from "./paymentService.js";
import { assertTransition, SETTLEABLE_STATUSES } from "./orderStateMachine.js";
import { getPmsGateway } from "../integrations/pms/pmsGateway.js";
import { chargeResultFromOrder } from "../integrations/pms/frontdeskPmsAdapter.js";
import { logged, IntegrationError } from "../integrations/integrationLogger.js";
import { config } from "../config/env.js";
import { recordEvent } from "../integrations/events/eventPublisher.js";

const VALIDATION_TTL_MS = 5 * 60 * 1000;
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

const REASON_MESSAGES = {
  ROOM_NOT_FOUND: (room) => `Room ${room} does not exist in the PMS.`,
  ROOM_VACANT: (room) => `Room ${room} has no checked-in guest.`,
  NO_ACTIVE_FOLIO: (room) => `Room ${room} has no active folio. Ask the Front Desk, or settle by direct payment.`,
  NOT_ELIGIBLE: (room) => `The guest in room ${room} is not allowed to charge to the room. Please settle by direct payment.`,
};

async function assertChargeable(req, order, transaction) {
  if (!SETTLEABLE_STATUSES.includes(order.status)) {
    throw new AppError(
      order.status === "SETTLING"
        ? "A payment or room charge for this order is still being processed."
        : `Order ${order.orderNumber} is ${order.status.replace(/_/g, " ").toLowerCase()}; request settlement first.`,
      409,
      "NOT_SETTLEABLE"
    );
  }
  if (toCents(order.amountPaid) > 0) throw new AppError("Part of this order was already paid directly; settle the balance by direct payment.", 409, "PARTIALLY_PAID");
  if (toCents(order.totalAmount) <= 0) throw new AppError("There is nothing to charge.", 422, "NOTHING_TO_CHARGE");
  const outlet = await Outlet.findByPk(order.outletId, { transaction });
  if (!outlet.allowsRoomCharge) throw new AppError(`${outlet.name} does not allow charges to guest rooms.`, 409, "ROOM_CHARGE_NOT_ALLOWED");
  const active = await GuestCharge.findOne({ where: { orderId: order.id, status: { [Op.in]: ["PENDING", "UNKNOWN", "POSTED"] } }, transaction });
  if (active) throw new AppError(`Room charge ${active.chargeNumber} is already ${active.status.toLowerCase()} for this order.`, 409, "ROOM_CHARGE_IN_PROGRESS");
  await resolveShift(req, order.outletId);
}

export async function validateRoom(req, orderId, body) {
  const roomNumber = v.str(body.roomNumber, "Room number", { required: true, max: 20, pattern: /^[A-Za-z0-9-]+$/, patternMessage: "Enter a valid room number." });
  const order = await sequelize.transaction(async (transaction) => {
    const o = await lockOrder(req, orderId, transaction);
    await assertChargeable(req, o, transaction);
    return o;
  });

  const pms = getPmsGateway();
  let result;
  try {
    result = await logged(
      { system: "PMS", operation: "getActiveFolio", isMock: pms.isMock, referenceType: "order", referenceId: order.id, request: { roomNumber }, userId: req.user.id },
      () => pms.getActiveFolio(roomNumber)
    );
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    throw new AppError(`The PMS could not be reached (${err.message}). Settle by direct payment or try again.`, 503, "PMS_UNAVAILABLE");
  }

  if (!result.found) {
    await audit({ req, action: "ROOM_VALIDATION_FAILED", entityType: "order", entityId: order.id, newValues: { roomNumber, reason: result.reason } });
    const message = (REASON_MESSAGES[result.reason] || REASON_MESSAGES.ROOM_NOT_FOUND)(roomNumber);
    throw new AppError(message, 422, result.reason || "ROOM_NOT_FOUND");
  }

  // Single-use token, stored as a hash in the database (not the session) so API clients and
  // several app instances can complete the charge. The guest name is returned, never stored.
  const token = crypto.randomBytes(24).toString("hex");
  await RoomChargeValidation.create({
    tokenHash: hashToken(token),
    orderId: order.id,
    userId: req.user.id,
    roomNumber: result.room.number,
    externalRoomId: result.room.id,
    externalGuestId: result.guest.id,
    externalFolioId: result.folio.id,
    amount: order.totalAmount,
    orderVersion: order.version,
    isMock: pms.isMock,
    expiresAt: new Date(Date.now() + VALIDATION_TTL_MS),
  });
  await audit({ req, action: "ROOM_VALIDATED", entityType: "order", entityId: order.id, newValues: { roomNumber, externalFolioId: result.folio.id } });

  return {
    token,
    roomNumber: result.room.number,
    guestName: result.guest.displayName, // displayed for confirmation only, never stored
    folioId: result.folio.id,
    checkIn: result.stay?.checkIn ?? null,
    checkOut: result.stay?.checkOut ?? null,
    isMock: pms.isMock,
  };
}

const chargeEvent = (charge, order) => ({
  chargeNumber: charge.chargeNumber, orderId: order.id, orderNumber: order.orderNumber, outletId: order.outletId, roomNumber: charge.roomNumber,
  externalGuestId: charge.externalGuestId, externalRoomId: charge.externalRoomId, externalFolioId: charge.externalFolioId,
  currency: config.currencyCode, amount: charge.amount, pmsTransactionId: charge.pmsTransactionId, isMock: Boolean(charge.isMock), postedAt: charge.postedAt,
});

// What the Frontdesk identifies an order by: the outlet (restaurant_id) and the charge number,
// which is new for every attempt, so a retry after a rejection is never an ORDER_CONFLICT.
export const frontdeskRef = (charge, outlet) => ({
  restaurantId: config.integrations.pms.restaurantId || outlet.code,
  externalOrderId: charge.chargeNumber,
});

// The order as the Frontdesk expects it: whole quantities, and totals that reconcile
// (subtotal = Σ qty × unit price; total = subtotal + service charge + tax − discount).
// Prices already include inclusive tax, so only exclusive tax is sent as `tax`.
export async function frontdeskOrder(charge, transaction) {
  const order = await Order.findByPk(charge.orderId, {
    include: [{ model: Outlet, as: "outlet", attributes: ["code", "name"] }, { model: OrderItem, as: "items" }],
    transaction,
  });
  const amount = (cents) => cents / 100;
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const items = order.items.map((i) => {
    const gross = toCents(i.grossAmount);
    subtotal += gross;
    discount += toCents(i.discountAmount);
    if (!i.taxInclusive) tax += toCents(i.taxAmount);
    const milli = toMilli(i.quantity);
    // 1.5 kg of something is sent as one line of its gross amount.
    const whole = milli % 1000 === 0 && milli <= 1000 * 1000;
    const line = {
      sku: i.productCode,
      name: (whole ? i.productName : `${i.productName} (${formatQty(i.quantity)} ${i.unit})`).slice(0, 100),
      quantity: whole ? milli / 1000 : 1,
      unit_price: amount(whole ? toCents(i.unitPrice) : gross),
    };
    if (i.notes) line.description = i.notes.slice(0, 255);
    return line;
  });
  const serviceCharge = toCents(order.serviceChargeAmount);
  const total = toCents(order.totalAmount);
  if (subtotal + serviceCharge + tax - discount !== total) {
    throw new AppError(`Order ${order.orderNumber} totals do not reconcile for the Frontdesk.`, 500, "TOTALS_MISMATCH");
  }
  return {
    ...frontdeskRef(charge, order.outlet),
    outletName: order.outlet.name.slice(0, 80),
    orderNumber: order.orderNumber,
    items,
    subtotal: amount(subtotal),
    serviceCharge: amount(serviceCharge),
    tax: amount(tax),
    discount: amount(discount),
    total: amount(total),
    orderedAt: new Date(order.createdAt).toISOString(),
  };
}

// Records the PMS answer for a charge and moves the order accordingly. `req` is null when the
// answer arrives by webhook or polling; the cashier who requested the charge is then the actor.
async function applyPmsResult(req, chargeId, result) {
  return sequelize.transaction(async (transaction) => {
    const charge = await GuestCharge.findByPk(chargeId, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await lockOrder(null, charge.orderId, transaction);
    if (!["PENDING", "UNKNOWN"].includes(charge.status)) return { charge, order };
    const userId = req?.user?.id ?? charge.requestedBy;

    // SUBMITTED: the Frontdesk accepted it for review. The sale completes now, like a posting;
    // the charge becomes POSTED (or REJECTED) when the front desk has reviewed it.
    if (result.status === "POSTED" || result.status === "SUBMITTED") {
      const posted = result.status === "POSTED";
      await charge.update(
        { status: posted ? "POSTED" : "AWAITING_REVIEW", pmsTransactionId: result.transactionId, postedAt: posted ? new Date() : null, lastError: null },
        { transaction }
      );
      await order.update({ amountPaid: order.totalAmount, settlementType: "ROOM_CHARGE" }, { transaction });
      await audit({
        req, userId, action: posted ? "ROOM_CHARGE_POSTED" : "ROOM_CHARGE_AWAITING_REVIEW", entityType: "order", entityId: order.id,
        newValues: { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, externalFolioId: charge.externalFolioId, pmsTransactionId: result.transactionId, amount: charge.amount, verificationReasons: result.verificationReasons },
        transaction,
      });
      await recordEvent(posted ? "RoomChargePosted" : "RoomChargeSubmitted", "order", order.id, chargeEvent(charge, order), transaction);
      await completeOrder(order, { req, userId, settledExternally: true }, transaction);
      return { charge, order };
    }

    // REJECTED (or NOT_FOUND with no attempts left)
    const reason = (result.reason || "The PMS rejected the charge.").slice(0, 500);
    await charge.update({ status: "FAILED", lastError: reason }, { transaction });
    assertTransition(order.status, "CHARGE_FAILED");
    await order.update({ status: "CHARGE_FAILED", version: order.version + 1 }, { transaction });
    await audit({ req, userId, action: "ROOM_CHARGE_REJECTED", entityType: "order", entityId: order.id, newValues: { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, reason }, transaction });
    return { charge, order };
  });
}

// The front desk's review of a charge that is AWAITING_REVIEW (the sale is already complete).
// Repeated answers (webhook retries, polling) change nothing once the charge is reviewed.
export async function applyFrontDeskReview(req, chargeId, result) {
  const current = await GuestCharge.findByPk(chargeId);
  if (["PENDING", "UNKNOWN"].includes(current.status)) return applyPmsResult(req, chargeId, result);
  if (current.status !== "AWAITING_REVIEW" || !["POSTED", "REJECTED"].includes(result.status)) return { charge: current };

  return sequelize.transaction(async (transaction) => {
    const charge = await GuestCharge.findByPk(chargeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (charge.status !== "AWAITING_REVIEW") return { charge };
    const order = await Order.findByPk(charge.orderId, { transaction });
    const userId = req?.user?.id ?? charge.requestedBy;
    if (result.status === "POSTED") {
      await charge.update({ status: "POSTED", pmsTransactionId: result.transactionId || charge.pmsTransactionId, postedAt: new Date(), lastError: null }, { transaction });
      await audit({ req, userId, action: "ROOM_CHARGE_POSTED", entityType: "order", entityId: order.id, newValues: { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, pmsTransactionId: charge.pmsTransactionId, amount: charge.amount, reviewedBy: "FRONT_DESK" }, transaction });
      await recordEvent("RoomChargePosted", "order", order.id, chargeEvent(charge, order), transaction);
    } else {
      const reason = (result.reason || "Rejected by the front desk.").slice(0, 500);
      await charge.update({ status: "REJECTED", lastError: reason }, { transaction });
      await audit({ req, userId, action: "ROOM_CHARGE_REJECTED_BY_FRONT_DESK", entityType: "order", entityId: order.id, newValues: { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, amount: charge.amount, reason }, transaction });
      await recordEvent("RoomChargeRejected", "order", order.id, { ...chargeEvent(charge, order), reason }, transaction);
    }
    return { charge, order };
  });
}

async function askFrontDesk(req, charge) {
  const pms = getPmsGateway();
  const order = await Order.findByPk(charge.orderId, { attributes: ["id"], include: [{ model: Outlet, as: "outlet", attributes: ["code"] }] });
  return logged(
    { system: "PMS", operation: "getChargeStatus", isMock: pms.isMock, idempotencyKey: charge.idempotencyKey, referenceType: "guest_charge", referenceId: charge.id, userId: req?.user?.id ?? null },
    () => pms.getChargeStatus(charge.idempotencyKey, frontdeskRef(charge, order.outlet))
  );
}

// Background fallback for a missed webhook: asks the Frontdesk about charges still awaiting review.
export async function reconcileAwaitingReview({ limit = 25, olderThanMs = 60 * 1000 } = {}) {
  const charges = await GuestCharge.findAll({
    where: { status: "AWAITING_REVIEW", updatedAt: { [Op.lt]: new Date(Date.now() - olderThanMs) } },
    order: [["updatedAt", "ASC"]],
    limit,
  });
  let reviewed = 0;
  for (const charge of charges) {
    try {
      const status = await askFrontDesk(null, charge);
      if (["POSTED", "REJECTED"].includes(status.status)) {
        await applyFrontDeskReview(null, charge.id, status);
        reviewed += 1;
      } else {
        charge.changed("updatedAt", true); // moves it to the back of the queue
        await charge.save();
      }
    } catch (err) {
      if (!(err instanceof IntegrationError)) throw err;
      break; // the Frontdesk is unreachable; try again next round
    }
  }
  return { checked: charges.length, reviewed };
}

// POST /webhooks/pms: events from the Frontdesk, signed with PMS_WEBHOOK_SECRET as
// X-PMS-Signature = sha256=HMAC(secret, `${X-PMS-Timestamp}.${raw body}`).
export async function handlePmsWebhook(rawBody, timestamp, signature) {
  const secret = config.integrations.pms.webhookSecret;
  if (!secret) throw new AppError("PMS webhooks are not configured (PMS_WEBHOOK_SECRET).", 503, "NOT_CONFIGURED");
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = String(signature || "");
  const valid = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!valid) throw new AppError("Invalid webhook signature.", 401, "INVALID_SIGNATURE");
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) < 300)) throw new AppError("Webhook timestamp is too old.", 401, "SIGNATURE_EXPIRED");

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new AppError("Webhook body is not JSON.", 400, "INVALID_JSON");
  }
  // GuestCheckedIn / GuestCheckedOut need no action: every charge is checked live with the PMS.
  if (event.event !== "PosOrderReviewed") return { ignored: true };

  const charge = await GuestCharge.findOne({ where: { chargeNumber: String(event.external_order_id || "") } });
  if (!charge) return { ignored: true };
  const result = chargeResultFromOrder(event);
  await logged(
    { system: "PMS", operation: "webhook:PosOrderReviewed", isMock: false, referenceType: "guest_charge", referenceId: charge.id, request: { event_id: event.event_id, status: event.status } },
    async () => result
  );
  await applyFrontDeskReview(null, charge.id, result);
  return { ignored: false };
}

async function markUnknown(req, chargeId, err) {
  return sequelize.transaction(async (transaction) => {
    const charge = await GuestCharge.findByPk(chargeId, { transaction, lock: transaction.LOCK.UPDATE });
    // A concurrent verify may already have resolved it; never move a final charge back.
    if (!["PENDING", "UNKNOWN"].includes(charge.status)) return charge;
    await charge.update({ status: "UNKNOWN", lastError: String(err.message).slice(0, 500) }, { transaction });
    await audit({ req, action: "ROOM_CHARGE_UNKNOWN", entityType: "order", entityId: charge.orderId, newValues: { chargeNumber: charge.chargeNumber, error: err.message }, transaction });
    return charge;
  });
}

const OUTCOMES = { POSTED: "POSTED", FAILED: "FAILED", PENDING: "UNKNOWN", UNKNOWN: "UNKNOWN", AWAITING_REVIEW: "SUBMITTED", REJECTED: "REJECTED" };
const outcomeOf = (charge) => OUTCOMES[charge.status] || charge.status;

// The arguments every adapter receives for a posting (and the Frontdesk again for a void).
export async function pmsChargeArgs(charge, transaction) {
  const order = await frontdeskOrder(charge, transaction);
  return {
    folioId: charge.externalFolioId,
    roomId: charge.externalRoomId,
    guestId: charge.externalGuestId,
    roomNumber: charge.roomNumber,
    amount: charge.amount,
    currency: config.currencyCode,
    description: `${order.outletName} ${order.orderNumber}`,
    reference: order.orderNumber,
    idempotencyKey: charge.idempotencyKey,
    order,
  };
}

async function sendToPms(req, charge) {
  const pms = getPmsGateway();
  const args = await pmsChargeArgs(charge);
  try {
    const result = await logged(
      {
        system: "PMS", operation: "postCharge", isMock: pms.isMock, idempotencyKey: charge.idempotencyKey,
        referenceType: "guest_charge", referenceId: charge.id, userId: req.user.id,
        request: { folioId: charge.externalFolioId, roomId: charge.externalRoomId, guestId: charge.externalGuestId, amount: charge.amount, reference: args.reference },
      },
      () => pms.postCharge(args)
    );
    return await applyPmsResult(req, charge.id, result);
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    return { charge: await markUnknown(req, charge.id, err), unknown: true };
  }
}

const MESSAGES = {
  POSTED: (c) => `Charged to room ${c.roomNumber}. PMS reference ${c.pmsTransactionId}.`,
  FAILED: (c) => `${c.lastError} The order was not charged; use another room or a direct payment.`,
  UNKNOWN: () => "The PMS did not confirm the charge in time. It has NOT been sent again. Check its status with the PMS before doing anything else.",
  SUBMITTED: (c) => `Sent to the front desk for room ${c.roomNumber} (reference ${c.pmsTransactionId}). It is added to the guest's bill once a receptionist reviews it.`,
  REJECTED: (c) => `The front desk rejected this room charge: ${c.lastError} Collect the payment from the guest directly.`,
};

const respond = (charge) => {
  const outcome = outcomeOf(charge);
  return { outcome, charge, message: (MESSAGES[outcome] || (() => ""))(charge) };
};

// The original outcome for a repeated idempotency key (double click, network retry).
function replayCharge(existing, orderId) {
  if (String(existing.orderId) !== String(orderId)) throw new AppError("This charge key belongs to another order.", 409, "IDEMPOTENCY_CONFLICT");
  return { ...respond(existing), duplicate: true };
}

export async function postRoomCharge(req, orderId, body) {
  const validationToken = v.str(body.validationToken, "Validation", { required: true, max: 64 });
  const idempotencyKey = v.str(body.idempotencyKey, "Idempotency key", { required: true, min: 8, max: 100 });

  const existing = await GuestCharge.findOne({ where: { idempotencyKey } });
  if (existing) return replayCharge(existing, orderId);

  let charge;
  try {
    charge = await sequelize.transaction(async (transaction) => {
      const order = await lockOrder(req, orderId, transaction);
      // A retry with the same key may have committed while this request waited for the lock.
      const raced = await GuestCharge.findOne({ where: { idempotencyKey }, transaction });
      if (raced) return { raced };

      // The validation is consumed in this transaction, so it can back exactly one charge.
      const validation = await RoomChargeValidation.findOne({
        where: { tokenHash: hashToken(validationToken), orderId: order.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!validation || validation.usedAt || validation.userId !== req.user.id || new Date(validation.expiresAt) < new Date()) {
        throw new AppError("The room validation has expired or was already used. Validate the room with the PMS again.", 409, "VALIDATION_EXPIRED");
      }
      await assertChargeable(req, order, transaction);
      if (order.version !== validation.orderVersion || order.totalAmount !== validation.amount) {
        throw new AppError("The order changed after the room was validated. Validate the room again.", 409, "ORDER_CHANGED");
      }
      await validation.update({ usedAt: new Date() }, { transaction });
      const created = await GuestCharge.create(
        {
          chargeNumber: await nextNumber("guestCharge", transaction),
          orderId: order.id,
          roomNumber: validation.roomNumber,
          externalGuestId: validation.externalGuestId,
          externalRoomId: validation.externalRoomId,
          externalFolioId: validation.externalFolioId,
          amount: order.totalAmount,
          status: "PENDING",
          idempotencyKey,
          attempts: 1,
          isMock: validation.isMock,
          requestedBy: req.user.id,
        },
        { transaction }
      );
      assertTransition(order.status, "SETTLING");
      await order.update({ status: "SETTLING", settlementType: "ROOM_CHARGE", version: order.version + 1 }, { transaction });
      await audit({
        req, action: "ROOM_CHARGE_SUBMITTED", entityType: "order", entityId: order.id,
        newValues: { chargeNumber: created.chargeNumber, roomNumber: created.roomNumber, externalFolioId: created.externalFolioId, amount: created.amount },
        transaction,
      });
      return created;
    });
  } catch (err) {
    // Two requests with the same key for different orders: the unique index decides.
    if (err instanceof UniqueConstraintError && JSON.stringify(err.fields || {}).includes("idempotency")) {
      return replayCharge(await GuestCharge.findOne({ where: { idempotencyKey } }), orderId);
    }
    throw err;
  }
  if (charge.raced) return replayCharge(charge.raced, orderId);

  const result = await sendToPms(req, charge);
  return respond(await GuestCharge.findByPk(result.charge.id));
}

// Resolves PENDING/UNKNOWN charges by asking the PMS — never by blindly re-posting.
export async function verifyCharge(req, chargeId) {
  const charge = await GuestCharge.findByPk(chargeId, { include: [{ model: Order, as: "order", attributes: ["outletId"] }] });
  if (!charge) throw notFound("Room charge");
  if (!req.user.outletIds.includes(charge.order.outletId)) throw forbidden();
  if (!["PENDING", "UNKNOWN", "AWAITING_REVIEW"].includes(charge.status)) return respond(charge);

  let status;
  try {
    status = await askFrontDesk(req, charge);
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    throw new AppError(`The PMS is still not responding (${err.message}). Try again shortly; do not charge the guest another way yet.`, 503, "PMS_UNAVAILABLE");
  }

  if (["POSTED", "REJECTED", "SUBMITTED"].includes(status.status)) {
    await applyFrontDeskReview(req, charge.id, status);
    return respond(await GuestCharge.findByPk(charge.id));
  }
  // Accepted for review but now unknown to the PMS: leave it for the front desk to explain.
  if (charge.status === "AWAITING_REVIEW") return respond(charge);

  // NOT_FOUND: the PMS never received it, so a re-post with the SAME key is safe.
  const maxAttempts = Number(await getSetting("room_charge_max_attempts", 3)) || 3;
  if (charge.attempts >= maxAttempts) {
    await applyPmsResult(req, charge.id, { status: "REJECTED", reason: `The PMS has no record of the charge after ${charge.attempts} attempts.` });
    return respond(await GuestCharge.findByPk(charge.id));
  }
  // Claim the retry under a row lock so two verifies can't both re-post.
  const claimed = await sequelize.transaction(async (transaction) => {
    const locked = await GuestCharge.findByPk(charge.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (locked.status !== "UNKNOWN" || locked.attempts !== charge.attempts) return null;
    await locked.update({ attempts: locked.attempts + 1, status: "PENDING" }, { transaction });
    await audit({ req, action: "ROOM_CHARGE_RETRY", entityType: "order", entityId: locked.orderId, newValues: { chargeNumber: locked.chargeNumber, attempt: locked.attempts }, transaction });
    return locked;
  });
  if (claimed) await sendToPms(req, claimed);
  return respond(await GuestCharge.findByPk(charge.id));
}

export async function listCharges(req, { search, status, outletId, start, end }, { limit, offset }) {
  const where = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
  if (status) where.status = status;
  if (search) where[Op.or] = [{ roomNumber: search }, { chargeNumber: { [Op.like]: `%${search}%` } }, { pmsTransactionId: { [Op.like]: `%${search}%` } }];
  const orderWhere = { outletId: outletId && req.user.outletIds.includes(Number(outletId)) ? outletId : req.user.outletIds.length ? req.user.outletIds : [0] };
  return GuestCharge.findAndCountAll({
    where,
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "outletId"], where: orderWhere, include: [{ model: Outlet, as: "outlet", attributes: ["code"] }] },
      { model: User, as: "requester", attributes: ["fullName"] },
    ],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });
}

export async function getCharge(req, id) {
  const charge = await GuestCharge.findByPk(id, {
    include: [
      { model: Order, as: "order", include: [{ model: Outlet, as: "outlet", attributes: ["code", "name"] }] },
      { model: User, as: "requester", attributes: ["fullName"] },
    ],
  });
  if (!charge) throw notFound("Room charge");
  if (!req.user.outletIds.includes(charge.order.outletId)) throw forbidden();
  return charge;
}
