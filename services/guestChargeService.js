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
// Only external guest/room/folio IDs are stored (TC-09); the guest name is never persisted.
import crypto from "crypto";
import { Op } from "sequelize";
import { sequelize, GuestCharge, Order, Outlet, User } from "../models/index.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toCents } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { audit } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { getSetting } from "./settingsService.js";
import { lockOrder, completeOrder } from "./orderService.js";
import { resolveShift } from "./paymentService.js";
import { assertTransition, SETTLEABLE_STATUSES } from "./orderStateMachine.js";
import { getPmsGateway } from "../integrations/pms/pmsGateway.js";
import { logged, IntegrationError } from "../integrations/integrationLogger.js";

const VALIDATION_TTL_MS = 5 * 60 * 1000;

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
  if (toCents(order.amountPaid) > 0) throw new AppError("Part of this order was already paid directly; settle the balance by direct payment.", 409);
  if (toCents(order.totalAmount) <= 0) throw new AppError("There is nothing to charge.", 422);
  const outlet = await Outlet.findByPk(order.outletId, { transaction });
  if (!outlet.allowsRoomCharge) throw new AppError(`${outlet.name} does not allow charges to guest rooms.`, 409);
  const active = await GuestCharge.findOne({ where: { orderId: order.id, status: { [Op.in]: ["PENDING", "UNKNOWN", "POSTED"] } }, transaction });
  if (active) throw new AppError(`Room charge ${active.chargeNumber} is already ${active.status.toLowerCase()} for this order.`, 409);
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

  const token = crypto.randomBytes(16).toString("hex");
  req.session.roomValidations = req.session.roomValidations || {};
  req.session.roomValidations[order.id] = {
    token,
    roomNumber: result.room.number,
    externalRoomId: result.room.id,
    externalGuestId: result.guest.id,
    externalFolioId: result.folio.id,
    amount: order.totalAmount,
    version: order.version,
    isMock: pms.isMock,
    expiresAt: Date.now() + VALIDATION_TTL_MS,
  };
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

// Records the PMS answer for a charge and moves the order accordingly.
async function applyPmsResult(req, chargeId, result) {
  return sequelize.transaction(async (transaction) => {
    const charge = await GuestCharge.findByPk(chargeId, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await lockOrder(null, charge.orderId, transaction);
    if (!["PENDING", "UNKNOWN"].includes(charge.status)) return { charge, order };

    if (result.status === "POSTED") {
      await charge.update({ status: "POSTED", pmsTransactionId: result.transactionId, postedAt: new Date(), lastError: null }, { transaction });
      await order.update({ amountPaid: order.totalAmount, settlementType: "ROOM_CHARGE" }, { transaction });
      await audit({
        req, action: "ROOM_CHARGE_POSTED", entityType: "order", entityId: order.id,
        newValues: { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, externalFolioId: charge.externalFolioId, pmsTransactionId: result.transactionId, amount: charge.amount },
        transaction,
      });
      await completeOrder(order, { req, userId: req.user.id, settledExternally: true }, transaction);
      return { charge, order };
    }

    // REJECTED (or NOT_FOUND with no attempts left)
    const reason = (result.reason || "The PMS rejected the charge.").slice(0, 500);
    await charge.update({ status: "FAILED", lastError: reason }, { transaction });
    assertTransition(order.status, "CHARGE_FAILED");
    await order.update({ status: "CHARGE_FAILED", version: order.version + 1 }, { transaction });
    await audit({ req, action: "ROOM_CHARGE_REJECTED", entityType: "order", entityId: order.id, newValues: { chargeNumber: charge.chargeNumber, roomNumber: charge.roomNumber, reason }, transaction });
    return { charge, order };
  });
}

async function markUnknown(req, chargeId, err) {
  const charge = await GuestCharge.findByPk(chargeId);
  await charge.update({ status: "UNKNOWN", lastError: String(err.message).slice(0, 500) });
  await audit({ req, action: "ROOM_CHARGE_UNKNOWN", entityType: "order", entityId: charge.orderId, newValues: { chargeNumber: charge.chargeNumber, error: err.message } });
  return charge;
}

const outcomeOf = (charge) =>
  charge.status === "POSTED" ? "POSTED" : charge.status === "FAILED" ? "FAILED" : ["PENDING", "UNKNOWN"].includes(charge.status) ? "UNKNOWN" : charge.status;

async function sendToPms(req, charge) {
  const pms = getPmsGateway();
  const order = await Order.findByPk(charge.orderId, { attributes: ["orderNumber"], include: [{ model: Outlet, as: "outlet", attributes: ["name"] }] });
  try {
    const result = await logged(
      {
        system: "PMS", operation: "postCharge", isMock: pms.isMock, idempotencyKey: charge.idempotencyKey,
        referenceType: "guest_charge", referenceId: charge.id, userId: req.user.id,
        request: { folioId: charge.externalFolioId, roomId: charge.externalRoomId, guestId: charge.externalGuestId, amount: charge.amount, reference: order.orderNumber },
      },
      () =>
        pms.postCharge({
          folioId: charge.externalFolioId,
          roomId: charge.externalRoomId,
          guestId: charge.externalGuestId,
          amount: charge.amount,
          currency: "PHP",
          description: `${order.outlet.name} ${order.orderNumber}`,
          reference: order.orderNumber,
          idempotencyKey: charge.idempotencyKey,
        })
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
};

const respond = (charge) => {
  const outcome = outcomeOf(charge);
  return { outcome, charge, message: (MESSAGES[outcome] || (() => ""))(charge) };
};

export async function postRoomCharge(req, orderId, body) {
  const validationToken = v.str(body.validationToken, "Validation", { required: true, max: 64 });
  const idempotencyKey = v.str(body.idempotencyKey, "Idempotency key", { required: true, min: 8, max: 100 });

  // Duplicate submission (double click / network retry): report the original charge.
  const existing = await GuestCharge.findOne({ where: { idempotencyKey } });
  if (existing) {
    if (String(existing.orderId) !== String(orderId)) throw new AppError("This charge key belongs to another order.", 409);
    return { ...respond(existing), duplicate: true };
  }

  const validation = req.session.roomValidations?.[orderId];
  if (!validation || validation.token !== validationToken || validation.expiresAt < Date.now()) {
    throw new AppError("The room validation has expired. Validate the room with the PMS again.", 409, "VALIDATION_EXPIRED");
  }

  const charge = await sequelize.transaction(async (transaction) => {
    const order = await lockOrder(req, orderId, transaction);
    await assertChargeable(req, order, transaction);
    if (order.version !== validation.version || order.totalAmount !== validation.amount) {
      throw new AppError("The order changed after the room was validated. Validate the room again.", 409, "ORDER_CHANGED");
    }
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
  delete req.session.roomValidations[orderId]; // single use

  const result = await sendToPms(req, charge);
  return respond(await GuestCharge.findByPk(result.charge.id));
}

// Resolves PENDING/UNKNOWN charges by asking the PMS — never by blindly re-posting.
export async function verifyCharge(req, chargeId) {
  const charge = await GuestCharge.findByPk(chargeId, { include: [{ model: Order, as: "order", attributes: ["outletId"] }] });
  if (!charge) throw notFound("Room charge");
  if (!req.user.outletIds.includes(charge.order.outletId)) throw forbidden();
  if (!["PENDING", "UNKNOWN"].includes(charge.status)) return respond(charge);

  const pms = getPmsGateway();
  let status;
  try {
    status = await logged(
      { system: "PMS", operation: "getChargeStatus", isMock: pms.isMock, idempotencyKey: charge.idempotencyKey, referenceType: "guest_charge", referenceId: charge.id, userId: req.user.id },
      () => pms.getChargeStatus(charge.idempotencyKey)
    );
  } catch (err) {
    if (!(err instanceof IntegrationError)) throw err;
    throw new AppError(`The PMS is still not responding (${err.message}). Try again shortly; do not charge the guest another way yet.`, 503, "PMS_UNAVAILABLE");
  }

  if (status.status === "POSTED" || status.status === "REJECTED") {
    await applyPmsResult(req, charge.id, status);
    return respond(await GuestCharge.findByPk(charge.id));
  }

  // NOT_FOUND: the PMS never received it, so a re-post with the SAME key is safe.
  const maxAttempts = Number(await getSetting("room_charge_max_attempts", 3)) || 3;
  if (charge.attempts >= maxAttempts) {
    await applyPmsResult(req, charge.id, { status: "REJECTED", reason: `The PMS has no record of the charge after ${charge.attempts} attempts.` });
    return respond(await GuestCharge.findByPk(charge.id));
  }
  await charge.update({ attempts: charge.attempts + 1, status: "PENDING" });
  await audit({ req, action: "ROOM_CHARGE_RETRY", entityType: "order", entityId: charge.orderId, newValues: { chargeNumber: charge.chargeNumber, attempt: charge.attempts } });
  await sendToPms(req, charge);
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
