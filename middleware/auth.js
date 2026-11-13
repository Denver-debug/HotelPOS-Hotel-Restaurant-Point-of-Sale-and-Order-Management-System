// Session authentication and permission-based authorization (enforced server-side).
import { Op } from "sequelize";
import { User, Role, Permission, Outlet, Shift } from "../models/index.js";
import { buildNavigation } from "../config/navigation.js";
import { AppError, forbidden, wantsJson } from "../utils/http.js";

// The request context every service relies on: req.user, req.permissions, req.outlets and
// req.openShift. Built the same way for a browser session and for an API key (whose service
// account is a normal user row), so authorization and outlet scoping never differ.
export async function loadUserContext(userId) {
  const user = await User.findByPk(userId, {
    include: [
      { model: Role, as: "role", include: [{ model: Permission, as: "permissions", through: { attributes: [] } }] },
      { model: Outlet, as: "outlets", through: { attributes: [] }, where: { status: "ACTIVE" }, required: false },
    ],
  });
  if (!user || user.status !== "ACTIVE") return null;

  const permissions = new Set(user.role.permissions.map((p) => p.code));
  const allOutlets = permissions.has("outlets.all_access");
  const outlets = allOutlets
    ? await Outlet.findAll({ where: { status: "ACTIVE" }, order: [["name", "ASC"]] })
    : user.outlets.sort((a, b) => a.name.localeCompare(b.name));
  const shift = await Shift.findOne({
    where: { userId: user.id, status: "OPEN" },
    include: [{ model: Outlet, as: "outlet", attributes: ["id", "code", "name"] }],
  });
  return {
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      roleCode: user.role.code,
      roleName: user.role.name,
      externalEmployeeId: user.externalEmployeeId,
      isServiceAccount: Boolean(user.isServiceAccount),
      allOutlets,
      outletIds: outlets.map((o) => o.id),
    },
    permissions,
    outlets: outlets.map((o) => o.get({ plain: true })),
    openShift: shift ? shift.get({ plain: true }) : null,
  };
}

export function applyUserContext(req, ctx) {
  req.user = ctx.user;
  req.permissions = ctx.permissions;
  req.outlets = ctx.outlets;
  req.openShift = ctx.openShift;
}

// Loads the signed-in user, permissions, accessible outlets and open shift for every request.
export const loadCurrentUser = async (req, res, next) => {
  res.locals.currentPath = req.path;
  if (req.apiClient) return next(); // authenticated by API key (middleware/apiAuth.js)
  req.permissions = new Set();
  if (!req.session.userId) return next();

  try {
    const ctx = await loadUserContext(req.session.userId);
    if (!ctx || ctx.user.isServiceAccount) {
      req.session.userId = null;
      return next();
    }
    applyUserContext(req, ctx);

    res.locals.currentUser = req.user;
    res.locals.userPermissions = [...req.permissions];
    res.locals.openShift = req.openShift;
    res.locals.navigation = buildNavigation(req.permissions, req.path);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (req, res, next) => {
  if (req.user) return next();
  if (wantsJson(req)) {
    const message = req.originalUrl.startsWith("/api/v1")
      ? "Authentication required. Send an API key as \"Authorization: Bearer <key>\"."
      : "Your session has expired. Please sign in again.";
    return next(new AppError(message, 401, "UNAUTHENTICATED"));
  }
  req.flash("warning_msg", "Please sign in to continue.");
  const nextUrl = req.method === "GET" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
  res.redirect(`/login${nextUrl}`);
};

// Passes when the user holds ANY of the listed permissions.
export const requirePermission = (...codes) => [
  requireAuth,
  (req, res, next) => (codes.some((c) => req.permissions.has(c)) ? next() : next(forbidden())),
];

export const can = (req, code) => req.permissions?.has(code) ?? false;

export const canAccessOutlet = (req, outletId) => req.user?.outletIds.includes(Number(outletId)) ?? false;

export const assertOutletAccess = (req, outletId) => {
  if (!canAccessOutlet(req, outletId)) throw forbidden("You are not assigned to this outlet.");
};

// Sequelize `where` fragment restricting a query to the user's outlets.
export const outletScope = (req, column = "outletId") =>
  req.user.allOutlets ? {} : { [column]: { [Op.in]: req.user.outletIds.length ? req.user.outletIds : [0] } };
