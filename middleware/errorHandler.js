// 404 and error handling. JSON for API calls; flash + redirect for failed form posts;
// an error page otherwise.
import { UniqueConstraintError, ValidationError, ForeignKeyConstraintError } from "sequelize";
import { AppError, wantsJson, backUrl, duplicateMessage } from "../utils/http.js";
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
  return null;
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const known = normalize(err);
  const status = known?.status || 500;
  const message = known?.message || "An unexpected error occurred. Please try again.";
  if (!known) console.error("❌ Unhandled error:", err);

  if (wantsJson(req)) {
    return res.status(status).json({ ok: false, error: message, code: known?.code || "SERVER_ERROR", details: known?.details });
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
    stack: !config.isProduction && !known ? err.stack : null,
  });
};
