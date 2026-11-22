// Adapter for the Hotel Frontdesk / PMS (Member 2, e.g. https://frontdesk.dineai.site), following
// its "Restaurant POS → Frontdesk" guide (POS_ORDERS.docx) and docs/INTEGRATIONS.md §4 of that repo:
//   GET  /pos/in-house?room_number=                    who is in the room (masked name, reservation)
//   POST /pos/orders                                   send a completed order for front-desk review
//   GET  /pos/orders/{restaurant_id}/{external_order}  review status (polling fallback)
// PMS_BASE_URL is https://<frontdesk-host>/api/v1/integrations.
//
// The Frontdesk does not post a POS charge straight to the folio: a receptionist reviews it and
// adds it to the guest's bill (ADDED_TO_FOLIO) or rejects it (REJECTED). postCharge therefore
// answers SUBMITTED, and the outcome arrives later as a PosOrderReviewed webhook or by polling.
//
// Frontdesk has no room or folio ids on the in-house lookup, so the external ids HotelPOS keeps are:
//   folio.id = reservation_code (RSV-0007), guest.id = reservation_id (7), room.id = stay_id.
import crypto from "crypto";
import { requestJson } from "../httpClient.js";
import { IntegrationError } from "../integrationLogger.js";

// Frontdesk order status → PmsGateway charge status.
export function chargeResultFromOrder(d) {
  const transactionId = d.order_ref ? String(d.order_ref) : null;
  switch (d.status) {
    case "ADDED_TO_FOLIO":
      return { status: "POSTED", transactionId, chargeId: d.charge_id ?? null };
    case "PENDING_REVIEW":
    case "NEEDS_GUEST_VERIFICATION":
      return { status: "SUBMITTED", transactionId, reviewStatus: d.status, verificationReasons: d.verification_reasons || [] };
    case "REJECTED":
      return { status: "REJECTED", transactionId, reason: d.rejection_reason || "Rejected by the front desk." };
    case "ALREADY_PAID":
      return { status: "REJECTED", transactionId, reason: "The Frontdesk recorded this order as paid at the restaurant, not billed to the room." };
    default:
      throw new IntegrationError("INVALID_RESPONSE", `Unknown Frontdesk order status "${d.status}".`, { response: d });
  }
}

const errorOf = (res) => res.data?.error || {};
const describe = (res) => {
  const e = errorOf(res);
  return `${e.message || `Frontdesk returned HTTP ${res.httpStatus}.`}${e.code ? ` (${e.code})` : ""}`;
};

export class FrontdeskPmsAdapter {
  name = "FrontdeskPmsAdapter";
  isMock = false;

  constructor(cfg) {
    this.cfg = cfg;
  }

  // Writes are signed when the Frontdesk administrator issued an inbound secret (POS_INBOUND_SECRET there).
  call(method, path, body, idempotencyKey) {
    const headers = {};
    let rawBody;
    if (body !== undefined) {
      rawBody = JSON.stringify(body);
      if (this.cfg.inboundSecret) {
        const ts = Math.floor(Date.now() / 1000).toString();
        headers["X-Timestamp"] = ts;
        headers["X-Signature"] = "sha256=" + crypto.createHmac("sha256", this.cfg.inboundSecret).update(`${ts}.${rawBody}`).digest("hex");
      }
    }
    return requestJson({ baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, timeoutMs: this.cfg.timeoutMs, method, path, rawBody, headers, idempotencyKey });
  }

  async getActiveFolio(roomNumber) {
    const res = await this.call("GET", `pos/in-house?room_number=${encodeURIComponent(roomNumber)}`);
    const code = errorOf(res).code;
    if (res.httpStatus === 404) return { found: false, reason: code === "ROOM_NOT_FOUND" ? "ROOM_NOT_FOUND" : "ROOM_VACANT", httpStatus: 404 };
    if (!res.ok) throw new IntegrationError("REJECTED", describe(res), { httpStatus: res.httpStatus, response: res.data });
    const d = res.data?.data || {};
    const room = { id: String(d.stay_id), number: String(d.room_number ?? roomNumber) };
    if (d.folio_open === false) return { found: false, reason: "NO_ACTIVE_FOLIO", room, httpStatus: res.httpStatus };
    return {
      found: true,
      httpStatus: res.httpStatus,
      room,
      guest: { id: String(d.reservation_id), displayName: d.guest_display_name || "Guest" },
      folio: { id: String(d.reservation_code), status: "OPEN" },
      stay: { checkIn: d.checked_in_at ?? null, checkOut: d.expected_check_out_date ?? null },
      chargeAllowed: true,
    };
  }

  // `order` comes from guestChargeService.frontdeskOrder(): ids, items and totals that reconcile.
  orderBody({ folioId, guestId, roomNumber, currency, order }, orderStatus) {
    return {
      external_order_id: order.externalOrderId,
      restaurant_id: order.restaurantId,
      outlet_name: order.outletName,
      reservation_code: folioId,
      reservation_id: Number(guestId),
      room_number: roomNumber,
      items: order.items,
      subtotal: order.subtotal,
      service_charge: order.serviceCharge,
      tax: order.tax,
      discount: order.discount,
      total: order.total,
      currency,
      ordered_at: order.orderedAt,
      payment_status: "CHARGE_TO_ROOM",
      order_status: orderStatus,
    };
  }

  async sendOrder(args, orderStatus) {
    const { order } = args;
    const res = await this.call("POST", "pos/orders", this.orderBody(args, orderStatus), `pos-${order.restaurantId}-${order.externalOrderId}-${orderStatus}`);
    if (res.ok && res.data?.data) return { result: chargeResultFromOrder(res.data.data), res };
    // 5xx and "first request still running": the outcome is unknown, so verify before re-sending.
    if (res.httpStatus >= 500 || errorOf(res).code === "REQUEST_IN_PROGRESS") {
      throw new IntegrationError("REJECTED", describe(res), { httpStatus: res.httpStatus, response: res.data });
    }
    // Any other 4xx (validation, key, signature, conflict, rate limit): nothing was recorded.
    return { result: { status: "REJECTED", reason: describe(res) }, res };
  }

  async postCharge(args) {
    const { result, res } = await this.sendOrder(args, "COMPLETED");
    return { ...result, httpStatus: res.httpStatus };
  }

  async getChargeStatus(idempotencyKey, { restaurantId, externalOrderId }) {
    const res = await this.call("GET", `pos/orders/${encodeURIComponent(restaurantId)}/${encodeURIComponent(externalOrderId)}`);
    if (res.httpStatus === 404) return { status: "NOT_FOUND", httpStatus: 404 };
    if (!res.ok) throw new IntegrationError("REJECTED", describe(res), { httpStatus: res.httpStatus, response: res.data });
    return { ...chargeResultFromOrder(res.data?.data || {}), httpStatus: res.httpStatus };
  }

  // A full refund voids the order: before review the Frontdesk rejects it; after it was added
  // to the folio, the front desk is told to correct the bill (it does not change automatically).
  async reverseCharge(args) {
    const { res } = await this.sendOrder(args, "VOIDED");
    if (res.ok) return { status: "REVERSED", transactionId: `${res.data.data.order_ref}-VOID`, httpStatus: res.httpStatus };
    return { status: "REJECTED", reason: describe(res), httpStatus: res.httpStatus };
  }

  async postAdjustment() {
    return {
      status: "REJECTED",
      reason: "The Frontdesk has no API for partial corrections of a room charge. Refund the whole charge, or ask the front desk to post a bill adjustment.",
    };
  }
}
