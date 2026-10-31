// MOCK Front Desk / PMS for local development and tests. It does NOT talk to a real PMS.
//
// Scenarios (by room number):
//   205  occupied, guest J. Tan, folio F-88213, eligible          (Figure 5 / 12 example)
//   207  occupied, guest P. Santos, folio F-88207, eligible
//   310  occupied, guest R. Dela Rosa, folio F-88310, eligible
//   101  vacant (no checked-in guest)
//   102  occupied but no active folio
//   103  occupied, guest not allowed to charge to the room
//   404  valid folio, but the PMS rejects the posted charge (credit limit)
//   306  valid folio; the charge IS posted but the response times out
//   anything else: room does not exist
// Posted charges are remembered by idempotency key, so duplicates return the original result.
import { IntegrationError } from "../integrationLogger.js";
import { MockLedger } from "../mockLedger.js";

const ROOMS = {
  205: { room: { id: "R-205", number: "205" }, guest: { id: "G-1001", displayName: "J. Tan" }, folio: { id: "F-88213", status: "OPEN" }, stay: { checkIn: "2026-10-29", checkOut: "2026-11-02" }, chargeAllowed: true },
  207: { room: { id: "R-207", number: "207" }, guest: { id: "G-1007", displayName: "P. Santos" }, folio: { id: "F-88207", status: "OPEN" }, stay: { checkIn: "2026-10-30", checkOut: "2026-11-01" }, chargeAllowed: true },
  310: { room: { id: "R-310", number: "310" }, guest: { id: "G-1310", displayName: "R. Dela Rosa" }, folio: { id: "F-88310", status: "OPEN" }, stay: { checkIn: "2026-10-31", checkOut: "2026-11-03" }, chargeAllowed: true },
  101: { room: { id: "R-101", number: "101" }, vacant: true },
  102: { room: { id: "R-102", number: "102" }, guest: { id: "G-1002", displayName: "M. Reyes" }, folio: null, stay: { checkIn: "2026-10-31", checkOut: "2026-11-01" } },
  103: { room: { id: "R-103", number: "103" }, guest: { id: "G-1003", displayName: "A. Cruz" }, folio: { id: "F-88300", status: "OPEN" }, stay: { checkIn: "2026-10-30", checkOut: "2026-11-02" }, chargeAllowed: false },
  404: { room: { id: "R-404", number: "404" }, guest: { id: "G-1004", displayName: "K. Lim" }, folio: { id: "F-88404", status: "OPEN" }, stay: { checkIn: "2026-10-28", checkOut: "2026-11-04" }, chargeAllowed: true, rejectCharges: "Folio credit limit exceeded." },
  306: { room: { id: "R-306", number: "306" }, guest: { id: "G-1006", displayName: "S. Garcia" }, folio: { id: "F-88306", status: "OPEN" }, stay: { checkIn: "2026-10-30", checkOut: "2026-11-02" }, chargeAllowed: true, timeoutAfterPost: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockPmsAdapter {
  name = "MockPmsAdapter";
  isMock = true;

  constructor(cfg = {}) {
    this.delayMs = cfg.mockDelayMs || 0;
    this.ledger = new MockLedger("mock-pms-ledger");
  }

  async getActiveFolio(roomNumber) {
    await sleep(this.delayMs);
    const r = ROOMS[String(roomNumber).trim()];
    if (!r) return { found: false, reason: "ROOM_NOT_FOUND" };
    if (r.vacant) return { found: false, reason: "ROOM_VACANT", room: r.room };
    if (!r.folio) return { found: false, reason: "NO_ACTIVE_FOLIO", room: r.room };
    if (!r.chargeAllowed) return { found: false, reason: "NOT_ELIGIBLE", room: r.room };
    return { found: true, room: r.room, guest: r.guest, folio: r.folio, stay: r.stay, chargeAllowed: true };
  }

  roomByFolio(folioId) {
    return Object.values(ROOMS).find((r) => r.folio?.id === folioId);
  }

  nextTransactionId() {
    const count = this.ledger.values().filter((e) => e.transactionId).length;
    return `PMS-TX-${77120 + count}`;
  }

  async postCharge({ folioId, amount, idempotencyKey }) {
    await sleep(this.delayMs);
    const previous = this.ledger.get(idempotencyKey);
    if (previous) return previous; // duplicate request: original result, no second posting

    const room = this.roomByFolio(folioId);
    if (!room) return this.ledger.set(idempotencyKey, { status: "REJECTED", reason: "Folio not found or closed." });
    if (room.rejectCharges) return this.ledger.set(idempotencyKey, { status: "REJECTED", reason: room.rejectCharges });
    const posted = this.ledger.set(idempotencyKey, { status: "POSTED", transactionId: this.nextTransactionId(), folioId, amount });
    if (room.timeoutAfterPost) throw new IntegrationError("TIMEOUT", "PMS did not respond in time (mock).");
    return posted;
  }

  async getChargeStatus(idempotencyKey) {
    await sleep(this.delayMs);
    return this.ledger.get(idempotencyKey) || { status: "NOT_FOUND" };
  }

  async reverseCharge({ folioId, transactionId, amount, idempotencyKey }) {
    await sleep(this.delayMs);
    const previous = this.ledger.get(`reverse:${idempotencyKey}`);
    if (previous) return previous;
    const original = this.ledger.values().find((e) => e.transactionId === transactionId);
    if (!original) return { status: "REJECTED", reason: "Original folio transaction not found." };
    return this.ledger.set(`reverse:${idempotencyKey}`, { status: "REVERSED", transactionId: this.nextTransactionId(), folioId, amount, reverses: transactionId });
  }

  async postAdjustment({ folioId, amount, idempotencyKey }) {
    await sleep(this.delayMs);
    const previous = this.ledger.get(`adjust:${idempotencyKey}`);
    if (previous) return previous;
    if (!this.roomByFolio(folioId)) return { status: "REJECTED", reason: "Folio not found or closed." };
    return this.ledger.set(`adjust:${idempotencyKey}`, { status: "POSTED", transactionId: this.nextTransactionId(), folioId, amount });
  }
}
