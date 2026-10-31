// Synchronizer-token CSRF protection. Forms send `_csrf`; fetch() sends `X-CSRF-Token`.
// Multipart forms pass the token in the query string because the body is parsed later by multer.
import crypto from "crypto";
import { AppError } from "../utils/http.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const tokensMatch = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export const csrfProtection = (req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.locals.csrfToken = req.session.csrfToken;
  if (SAFE_METHODS.has(req.method)) return next();

  const supplied = req.get("x-csrf-token") || req.body?._csrf || req.query?._csrf;
  if (!supplied || !tokensMatch(supplied, req.session.csrfToken)) {
    return next(new AppError("Your session form token is invalid or expired. Reload the page and try again.", 403, "CSRF"));
  }
  next();
};
