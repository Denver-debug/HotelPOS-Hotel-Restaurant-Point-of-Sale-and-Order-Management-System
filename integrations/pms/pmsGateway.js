// Front Desk / PMS integration contract (Class diagram: PMSGateway; Sequence diagram F12).
// The PMS owns guests, rooms, reservations and folios. HotelPOS sends a room number as a
// lookup input and keeps only the external IDs the PMS returns.
//
// interface PmsGateway {
//   name: string; isMock: boolean;
//   getActiveFolio(roomNumber) -> {
//     found: boolean,
//     reason?: "ROOM_NOT_FOUND" | "ROOM_VACANT" | "NO_ACTIVE_FOLIO" | "NOT_ELIGIBLE",
//     room?: { id, number }, guest?: { id, displayName }, folio?: { id, status },
//     stay?: { checkIn, checkOut }, chargeAllowed?: boolean
//   }
//   postCharge({ folioId, roomId, guestId, roomNumber, amount, currency, description, reference, idempotencyKey, order })
//       -> { status: "POSTED", transactionId } | { status: "REJECTED", reason }
//        | { status: "SUBMITTED", transactionId }  (Frontdesk: queued for front-desk review; the
//          review outcome comes later through getChargeStatus or the PosOrderReviewed webhook)
//       throws IntegrationError("TIMEOUT" | "NETWORK") when the outcome is unknown
//   getChargeStatus(idempotencyKey, { restaurantId, externalOrderId })
//       -> { status: "POSTED" | "SUBMITTED", transactionId } | { status: "REJECTED", reason } | { status: "NOT_FOUND" }
//   reverseCharge({ folioId, transactionId, amount, reason, idempotencyKey, ...postCharge args }) -> { status: "REVERSED", transactionId } | { status: "REJECTED", reason }
//   postAdjustment({ folioId, amount, reason, reference, idempotencyKey }) -> { status: "POSTED", transactionId } | { status: "REJECTED", reason }
// }
import { config } from "../../config/env.js";
import { MockPmsAdapter } from "./mockPmsAdapter.js";
import { HttpPmsAdapter } from "./httpPmsAdapter.js";
import { FrontdeskPmsAdapter } from "./frontdeskPmsAdapter.js";

const ADAPTERS = { http: HttpPmsAdapter, frontdesk: FrontdeskPmsAdapter };

let instance;

export function getPmsGateway() {
  if (!instance) {
    const cfg = config.integrations.pms;
    instance = ADAPTERS[cfg.adapter] ? new ADAPTERS[cfg.adapter](cfg) : new MockPmsAdapter(cfg);
  }
  return instance;
}

// Test hook: swap the adapter (e.g. a fresh mock) without touching business code.
export function setPmsGateway(adapter) {
  instance = adapter;
}
