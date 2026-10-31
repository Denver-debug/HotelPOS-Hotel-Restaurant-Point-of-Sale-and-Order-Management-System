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
//   postCharge({ folioId, roomId, guestId, amount, currency, description, reference, idempotencyKey })
//       -> { status: "POSTED", transactionId } | { status: "REJECTED", reason }
//       throws IntegrationError("TIMEOUT" | "NETWORK") when the outcome is unknown
//   getChargeStatus(idempotencyKey) -> { status: "POSTED", transactionId } | { status: "REJECTED", reason } | { status: "NOT_FOUND" }
//   reverseCharge({ folioId, transactionId, amount, reason, idempotencyKey }) -> { status: "REVERSED", transactionId } | { status: "REJECTED", reason }
//   postAdjustment({ folioId, amount, reason, reference, idempotencyKey }) -> { status: "POSTED", transactionId } | { status: "REJECTED", reason }
// }
import { config } from "../../config/env.js";
import { MockPmsAdapter } from "./mockPmsAdapter.js";
import { HttpPmsAdapter } from "./httpPmsAdapter.js";

let instance;

export function getPmsGateway() {
  if (!instance) {
    const cfg = config.integrations.pms;
    instance = cfg.adapter === "http" ? new HttpPmsAdapter(cfg) : new MockPmsAdapter(cfg);
  }
  return instance;
}

// Test hook: swap the adapter (e.g. a fresh mock) without touching business code.
export function setPmsGateway(adapter) {
  instance = adapter;
}
