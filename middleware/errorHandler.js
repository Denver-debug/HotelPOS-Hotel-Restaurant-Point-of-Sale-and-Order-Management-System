// 404 and error handling. JSON for API calls; flash + redirect for failed form posts;
// an error page otherwise. Every JSON error has the same shape:
//   { ok: false, error: "<message for people>", code: "<STABLE_CODE>", details?, requestId }
import { UniqueConstraintError, ValidationError, ForeignKeyConstraintError } from "sequelize";
import { AppError, wantsJson, backUrl, duplicateMessage } from "../utils/http.js";
import { IntegrationError } from "../integrations/integrationLogger.js";
import { config } from "../config/env.js";

export const notFoundHandler = (req, res, next) => next(new AppError("The page you requested does not exist.", 404, "NOT_FOUND"));

const normalize = (err) => {
  if (err instanceof AppError) return err;
  if (err instanceof UniqueConstraintError) return new AppError(duplicateMessage(err), 409, "DUPLICATE");
  if (err instanceof ForeignKeyConstraintError) {
    return new AppError("This record is referenced by other records and cannot be changed this way.", 409, "IN_USE");
  }
  if (err instanceof ValidationError) {
    return new AppError(err.errors?.map((e) => e.message).join(" ") || "Invalid data.", 422, "VALIDATION_ERROR");
  }
  // An external system (PMS, payment provider, HR) failed and the service didn't handle it:
  // that is a gateway problem, not an unexpected HotelPOS error.
  if (err instanceof IntegrationError) {
    if (err.kind === "TIMEOUT") return new AppError(`An external system did not respond in time (${err.message}). Try again shortly.`, 504, "UPSTREAM_TIMEOUT");
    if (err.kind === "NOT_CONFIGURED") return new AppError(`An external system is not configured: ${err.message}`, 503, "SERVICE_UNAVAILABLE");
    return new AppError(`An external system returned an error (${err.message}).`, 502, "UPSTREAM_ERROR");
  }
  // Malformed JSON body (express.json) or an oversized payload.
  if (err?.type === "entity.parse.failed") return new AppError("The request body is not valid JSON.", 400, "BAD_REQUEST");
  if (err?.type === "entity.too.large") return new AppError("The request body is too large.", 413, "PAYLOAD_TOO_LARGE");
  return null;
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const known = normalize(err);
  const status = known?.status || 500;
  const message = known?.message || "An unexpected error occurred. Please try again.";
  if (!known) console.error(`❌ Unhandled error [${req.id || "-"}]:`, err);

  if (wantsJson(req)) {
    return res.status(status).json({ ok: false, error: message, code: known?.code || "SERVER_ERROR", details: known?.details, requestId: req.id });
  }

  if (req.method !== "GET" && status < 500 && status !== 401 && req.session) {
    req.flash("error_msg", message);
    return res.redirect(backUrl(req));
  }

  res.status(status).render("errors/error", {
    layout: req.user ? "layouts/main" : "layouts/auth",
    title: status === 404 ? "Not found" : status === 403 ? "Access denied" : "Error",
    status,
    message,
    requestId: req.id,
    stack: !config.isProduction && !known ? err.stack : null,
  });
};
