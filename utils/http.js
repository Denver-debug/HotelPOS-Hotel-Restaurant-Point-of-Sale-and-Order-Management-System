// Shared HTTP helpers: application errors and async route wrapping.

export class AppError extends Error {
  constructor(message, status = 400, code = "APP_ERROR", details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = "Record") => new AppError(`${what} not found.`, 404, "NOT_FOUND");
export const forbidden = (message = "You do not have permission to perform this action.") =>
  new AppError(message, 403, "FORBIDDEN");

// Express 4 does not forward rejected promises to the error handler.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const wantsJson = (req) => {
  if (req.originalUrl.startsWith("/api/") || req.xhr) return true;
  const accept = req.get("accept") || "";
  return accept.includes("application/json") && !accept.includes("text/html");
};

export const clientIp = (req) => (req ? req.ip || req.socket?.remoteAddress || null : null);

// Redirect back to the referring page within this app, falling back to a default path.
export const backUrl = (req, fallback = "/dashboard") => {
  const ref = req.get("referer");
  if (!ref) return fallback;
  try {
    const url = new URL(ref);
    return url.host === req.get("host") ? url.pathname + url.search : fallback;
  } catch {
    return fallback;
  }
};
