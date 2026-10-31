// HTTP adapter for the Front Desk / PMS REST API, following the Sequence Diagram (F12):
//   GET  /rooms/{roomNo}/active-folio
//   POST /folios/{folioId}/charges            (Idempotency-Key header)
// The remaining endpoints and all response field names are ASSUMPTIONS until the PMS
// team publishes its contract; adjust the mapping functions below, not the services.
// This adapter has not been tested against a real PMS.
import { requestJson } from "../httpClient.js";
import { IntegrationError } from "../integrationLogger.js";

const REASONS = { ROOM_NOT_FOUND: "ROOM_NOT_FOUND", ROOM_VACANT: "ROOM_VACANT", NO_ACTIVE_FOLIO: "NO_ACTIVE_FOLIO", NOT_ELIGIBLE: "NOT_ELIGIBLE" };

export class HttpPmsAdapter {
  name = "HttpPmsAdapter";
  isMock = false;

  constructor(cfg) {
    this.cfg = cfg;
  }

  call(method, path, body, idempotencyKey) {
    return requestJson({ baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, timeoutMs: this.cfg.timeoutMs, method, path, body, idempotencyKey });
  }

  async getActiveFolio(roomNumber) {
    const res = await this.call("GET", `rooms/${encodeURIComponent(roomNumber)}/active-folio`);
    const d = res.data || {};
    if (res.httpStatus === 404) return { found: false, reason: REASONS[d.code] || "ROOM_NOT_FOUND", httpStatus: 404 };
    if (res.httpStatus === 409 || res.httpStatus === 422) return { found: false, reason: REASONS[d.code] || "NO_ACTIVE_FOLIO", httpStatus: res.httpStatus };
    if (!res.ok) throw new IntegrationError("REJECTED", `PMS returned HTTP ${res.httpStatus}.`, { httpStatus: res.httpStatus, response: d });
    if (d.chargeAllowed === false) return { found: false, reason: "NOT_ELIGIBLE", httpStatus: res.httpStatus };
    return {
      found: true,
      httpStatus: res.httpStatus,
      room: { id: String(d.room?.id ?? d.roomId), number: String(d.room?.number ?? roomNumber) },
      guest: { id: String(d.guest?.id ?? d.guestId), displayName: d.guest?.name ?? d.guestName ?? "Guest" },
      folio: { id: String(d.folio?.id ?? d.folioId), status: d.folio?.status ?? "OPEN" },
      stay: { checkIn: d.checkIn ?? d.stay?.checkIn ?? null, checkOut: d.checkOut ?? d.stay?.checkOut ?? null },
      chargeAllowed: true,
    };
  }

  async postCharge({ folioId, roomId, guestId, amount, currency, description, reference, idempotencyKey }) {
    const res = await this.call("POST", `folios/${encodeURIComponent(folioId)}/charges`, { amount, currency, description, reference, roomId, guestId }, idempotencyKey);
    if (res.ok && res.data?.transactionId) return { status: "POSTED", transactionId: String(res.data.transactionId), httpStatus: res.httpStatus };
    if (res.httpStatus >= 500) throw new IntegrationError("REJECTED", `PMS error HTTP ${res.httpStatus}.`, { httpStatus: res.httpStatus, response: res.data });
    return { status: "REJECTED", reason: res.data?.message || `PMS rejected the charge (HTTP ${res.httpStatus}).`, httpStatus: res.httpStatus };
  }

  async getChargeStatus(idempotencyKey) {
    const res = await this.call("GET", `charges?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
    if (res.httpStatus === 404) return { status: "NOT_FOUND", httpStatus: 404 };
    if (!res.ok) throw new IntegrationError("REJECTED", `PMS returned HTTP ${res.httpStatus}.`, { httpStatus: res.httpStatus, response: res.data });
    const d = res.data || {};
    if (d.status === "POSTED") return { status: "POSTED", transactionId: String(d.transactionId), httpStatus: res.httpStatus };
    if (d.status === "REJECTED") return { status: "REJECTED", reason: d.message || "Rejected by PMS.", httpStatus: res.httpStatus };
    return { status: "NOT_FOUND", httpStatus: res.httpStatus };
  }

  async reverseCharge({ folioId, transactionId, amount, reason, idempotencyKey }) {
    const res = await this.call("POST", `folios/${encodeURIComponent(folioId)}/charges/${encodeURIComponent(transactionId)}/reversal`, { amount, reason }, idempotencyKey);
    if (res.ok) return { status: "REVERSED", transactionId: String(res.data?.transactionId ?? ""), httpStatus: res.httpStatus };
    return { status: "REJECTED", reason: res.data?.message || `PMS rejected the reversal (HTTP ${res.httpStatus}).`, httpStatus: res.httpStatus };
  }

  async postAdjustment({ folioId, amount, reason, reference, idempotencyKey }) {
    const res = await this.call("POST", `folios/${encodeURIComponent(folioId)}/adjustments`, { amount, reason, reference }, idempotencyKey);
    if (res.ok) return { status: "POSTED", transactionId: String(res.data?.transactionId ?? ""), httpStatus: res.httpStatus };
    return { status: "REJECTED", reason: res.data?.message || `PMS rejected the adjustment (HTTP ${res.httpStatus}).`, httpStatus: res.httpStatus };
  }
}
