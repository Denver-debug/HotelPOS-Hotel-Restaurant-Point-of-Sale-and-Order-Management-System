// Session authentication and permission-based authorization (enforced server-side).
import { Op } from "sequelize";
import { User, Role, Permission, Outlet, Shift } from "../models/index.js";
import { buildNavigation } from "../config/navigation.js";
import { AppError, forbidden, wantsJson } from "../utils/http.js";

// Loads the signed-in user, permissions, accessible outlets and open shift for every request.
export const loadCurrentUser = async (req, res, next) => {
  res.locals.currentPath = req.path;
  req.permissions = new Set();
  if (!req.session.userId) return next();

  try {
    const user = await User.findByPk(req.session.userId, {
      include: [
        { model: Role, as: "role", include: [{ model: Permission, as: "permissions", through: { attributes: [] } }] },
        { model: Outlet, as: "outlets", through: { attributes: [] }, where: { status: "ACTIVE" }, required: false },
      ],
    });
    if (!user || user.status !== "ACTIVE") {
      req.session.userId = null;
      return next();
    }

    req.permissions = new Set(user.role.permissions.map((p) => p.code));
    const allOutlets = req.permissions.has("outlets.all_access");
    const outlets = allOutlets
      ? await Outlet.findAll({ where: { status: "ACTIVE" }, order: [["name", "ASC"]] })
      : user.outlets.sort((a, b) => a.name.localeCompare(b.name));

    req.user = {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      roleCode: user.role.code,
      roleName: user.role.name,
      externalEmployeeId: user.externalEmployeeId,
      allOutlets,
      outletIds: outlets.map((o) => o.id),
    };
    req.outlets = outlets.map((o) => o.get({ plain: true }));

    const shift = await Shift.findOne({
      where: { userId: user.id, status: "OPEN" },
      include: [{ model: Outlet, as: "outlet", attributes: ["id", "code", "name"] }],
    });
    req.openShift = shift ? shift.get({ plain: true }) : null;

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
  if (wantsJson(req)) return next(new AppError("Your session has expired. Please sign in again.", 401, "UNAUTHENTICATED"));
  req.flash("error_msg", "Please sign in to continue.");
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
