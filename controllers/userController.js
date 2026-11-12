import { Role, Outlet } from "../models/index.js";
import * as userService from "../services/userService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { handleForm } from "../utils/forms.js";
import { notFound } from "../utils/http.js";

const formOptions = async () => ({
  roles: (await Role.findAll({ order: [["name", "ASC"]] })).map((r) => r.get({ plain: true })),
  outlets: (await Outlet.findAll({ order: [["name", "ASC"]] })).map((o) => o.get({ plain: true })),
});

const crumbs = (label) => [{ label: "Users", href: "/users" }, ...(label ? [{ label }] : [])];

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const filters = filtersFrom(req.query, ["search", "roleId", "status"]);
  const { rows, count } = await userService.listUsers(filters, page);
  res.render("users/index", {
    title: "Users",
    breadcrumbs: crumbs(),
    users: rows.map((u) => u.get({ plain: true })),
    filters,
    roles: (await formOptions()).roles,
    pagination: buildPagination(req, count, page),
  });
};

export const newForm = async (req, res) => {
  res.render("users/form", { title: "New user", breadcrumbs: crumbs("New"), user: { status: "ACTIVE", outletIds: [] }, ...(await formOptions()) });
};

export const create = async (req, res) => {
  const user = await handleForm(res, () => userService.createUser(req, req.body), {
    view: "users/form",
    locals: async () => ({ title: "New user", breadcrumbs: crumbs("New"), user: { ...req.body, outletIds: [].concat(req.body.outletIds || []) }, ...(await formOptions()) }),
  });
  if (!user) return;
  req.flash("success_msg", `User ${user.username} was created.`);
  res.redirect("/users");
};

export const editForm = async (req, res) => {
  const user = (await userService.getUser(req.params.id)).get({ plain: true });
  user.outletIds = user.outlets.map((o) => o.id);
  res.render("users/form", { title: `Edit ${user.username}`, breadcrumbs: crumbs(user.username), user, editing: true, ...(await formOptions()) });
};

export const update = async (req, res) => {
  const user = await handleForm(res, () => userService.updateUser(req, req.params.id, req.body), {
    view: "users/form",
    locals: async () => ({
      title: "Edit user",
      breadcrumbs: crumbs("Edit"),
      user: { ...req.body, id: req.params.id, outletIds: [].concat(req.body.outletIds || []) },
      editing: true,
      ...(await formOptions()),
    }),
  });
  if (!user) return;
  req.flash("success_msg", `User ${user.username} was updated.`);
  res.redirect("/users");
};

// ── Roles ────────────────────────────────────────────────────────────────

export const rolesIndex = async (req, res) => {
  res.render("roles/index", { title: "Roles & Permissions", breadcrumbs: [{ label: "Roles & Permissions" }], roles: await userService.listRoles() });
};

export const roleForm = async (req, res) => {
  const role = req.params.id ? (await Role.findByPk(req.params.id))?.get({ plain: true }) : {};
  if (req.params.id && !role) throw notFound("Role");
  res.render("roles/form", {
    title: role.id ? `Role: ${role.name}` : "New role",
    breadcrumbs: [{ label: "Roles & Permissions", href: "/roles" }, { label: role.name || "New" }],
    role,
    matrix: await userService.permissionMatrix(role.id),
  });
};

export const saveRole = async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  const role = await handleForm(res, () => userService.saveRole(req, id, req.body), {
    view: "roles/form",
    locals: async () => {
      const selected = new Set([].concat(req.body.permissionIds || []).map(Number));
      const matrix = (await userService.permissionMatrix(null)).map((m) => ({
        ...m,
        permissions: m.permissions.map((p) => ({ ...p, granted: selected.has(p.id) })),
      }));
      return { title: "Role", breadcrumbs: [{ label: "Roles & Permissions", href: "/roles" }], role: { ...req.body, id }, matrix };
    },
  });
  if (!role) return;
  req.flash("success_msg", `Role ${role.name} was saved.`);
  res.redirect("/roles");
};
