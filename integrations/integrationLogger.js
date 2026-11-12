// Wraps every call to an external Hotel ERP subsystem: measures it, masks secrets
// and writes an `integration_logs` row whether the call succeeds or fails.
import crypto from "crypto";
import { IntegrationLog } from "../models/index.js";
import { currentRequestId, outboundContext } from "../utils/requestContext.js";

export class IntegrationError extends Error {
  // kind: TIMEOUT | NETWORK | REJECTED | INVALID_RESPONSE | NOT_CONFIGURED
  constructor(kind, message, { httpStatus, response } = {}) {
    super(message);
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.response = response;
  }
}

const SECRET_KEY = /(key|token|secret|password|authorization|card_?number|cvv|pin)/i;
// Personal data owned by other subsystems (PMS guests, HR employees) is never stored here;
// the PMS returns the guest's name for on-screen confirmation only.
const PERSONAL_KEY = /^(display_?name|full_?name|guest_?name|first_?name|last_?name|name_on_card|email|phone|mobile)$/i;
const MAX_DEPTH = 5;

export const mask = (value, depth = 0) => {
  if (value === null || value === undefined) return value ?? null;
  // Deeper structures are summarised, never written unmasked.
  if (depth > MAX_DEPTH) return typeof value === "object" ? "[truncated]" : value;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) || PERSONAL_KEY.test(k) ? "***" : mask(v, depth + 1)])
    );
  }
  return value;
};

const statusFor = (err) => {
  if (!err) return "SUCCESS";
  if (err.kind === "TIMEOUT") return "TIMEOUT";
  if (err.kind === "REJECTED") return "FAILED";
  return "ERROR";
};

/**
 * @param {object} meta  { system, operation, isMock, idempotencyKey, referenceType, referenceId, request, userId }
 * @param {Function} fn  async () => response object
 */
export async function logged(meta, fn) {
  const started = Date.now();
  // The inbound request id links this call to the POS request that caused it; adapters send
  // it as X-Correlation-Id (httpClient reads it from outboundContext).
  const correlationId = currentRequestId() || crypto.randomUUID();
  let response;
  let error;
  try {
    response = await outboundContext.run({ correlationId }, () => fn(correlationId));
    return response;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    try {
      await IntegrationLog.create({
        systemName: meta.system,
        operation: meta.operation,
        status: statusFor(error),
        httpStatus: error?.httpStatus ?? response?.httpStatus ?? null,
        durationMs: Date.now() - started,
        correlationId,
        idempotencyKey: meta.idempotencyKey ?? null,
        referenceType: meta.referenceType ?? null,
        referenceId: meta.referenceId === undefined || meta.referenceId === null ? null : String(meta.referenceId),
        requestPayload: mask(meta.request ?? null),
        responsePayload: mask(error ? error.response ?? null : response ?? null),
        errorMessage: error ? String(error.message).slice(0, 500) : null,
        isMock: Boolean(meta.isMock),
        createdBy: meta.userId ?? null,
      });
    } catch (logErr) {
      console.error("⚠️  Failed to write integration log:", logErr.message);
    }
  }
}
