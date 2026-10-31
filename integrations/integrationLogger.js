// Wraps every call to an external Hotel ERP subsystem: measures it, masks secrets
// and writes an `integration_logs` row whether the call succeeds or fails.
import crypto from "crypto";
import { IntegrationLog } from "../models/index.js";

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

export const mask = (value, depth = 0) => {
  if (value === null || value === undefined || depth > 5) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "***" : mask(v, depth + 1)]));
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
  const correlationId = crypto.randomUUID();
  let response;
  let error;
  try {
    response = await fn(correlationId);
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
