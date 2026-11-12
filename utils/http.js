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

const UNIQUE_LABELS = {
  uq_outlets_code: "outlet code",
  uq_users_username: "username",
  uq_users_email: "email",
  uq_users_external_employee: "HR employee ID",
  uq_roles_code: "role code",
  uq_categories_name: "category name",
  uq_products_code: "product code",
  uq_taxes_code: "tax code",
  uq_discounts_code: "discount code",
  uq_inventory_items_sku: "SKU",
  uq_stock_locations_code: "location code",
  uq_payment_methods_code: "payment method code",
};

// Friendly message for a Sequelize UniqueConstraintError.
export const duplicateMessage = (err) => {
  const key = Object.keys(err.fields || {})[0] || "";
  const label = UNIQUE_LABELS[key] || key.replace(/^uq_/, "").replace(/_/g, " ") || "value";
  return `A record with this ${label} already exists.`;
};

export const clientIp = (req) => (req ? req.ip || req.socket?.remoteAddress || null : null);

// Full path of the current request, including the router's mount prefix. Inside a router
// mounted at /orders, req.path is "/" — links built from it would point at the site root.
export const fullPath = (req) => (req.baseUrl + req.path).replace(/(.)\/$/, "$1") || "/";

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
