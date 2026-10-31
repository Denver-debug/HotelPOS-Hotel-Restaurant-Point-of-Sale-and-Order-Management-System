// User accounts, role assignment and outlet assignment.
import bcrypt from "bcrypt";
import { Op } from "sequelize";
import { sequelize, User, Role, Permission, Outlet, UserOutlet, RolePermission } from "../models/index.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit, diff } from "./auditService.js";
import { BCRYPT_ROUNDS, validatePasswordStrength, verifyEmployee } from "./authService.js";
import { IntegrationError } from "../integrations/integrationLogger.js";

export async function listUsers({ search, roleId, status }, { limit, offset }) {
  const where = {};
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [{ username: like }, { fullName: like }, { email: like }, { externalEmployeeId: like }];
  }
  if (roleId) where.roleId = roleId;
  if (status) where.status = status;
  return User.findAndCountAll({
    where,
    include: [
      { model: Role, as: "role", attributes: ["id", "code", "name"] },
      { model: Outlet, as: "outlets", attributes: ["id", "code"], through: { attributes: [] } },
    ],
    order: [["fullName", "ASC"]],
    limit,
    offset,
    distinct: true,
  });
}

export async function getUser(id) {
  const user = await User.findByPk(id, {
    include: [
      { model: Role, as: "role" },
      { model: Outlet, as: "outlets", through: { attributes: [] } },
    ],
  });
  if (!user) throw notFound("User");
  return user;
}

const parseUserInput = (body, { creating }) => ({
  username: v.str(body.username, "Username", {
    required: true, min: 3, max: 50, pattern: /^[a-z0-9._-]+$/i, patternMessage: "Username may contain letters, numbers, dots, dashes and underscores.",
  })?.toLowerCase(),
  fullName: v.str(body.fullName, "Full name", { required: true, max: 120 }),
  email: v.email(body.email)?.toLowerCase() ?? null,
  roleId: v.id(body.roleId, "Role"),
  externalEmployeeId: v.str(body.externalEmployeeId, "Employee ID", { max: 50 })?.toUpperCase() ?? null,
  status: v.oneOf(body.status, "Status", ["ACTIVE", "INACTIVE", "LOCKED"], { required: false, fallback: "ACTIVE" }),
  outletIds: v.idList(body.outletIds),
  password: creating || body.password ? String(body.password || "") : null,
  confirmPassword: String(body.confirmPassword || ""),
});

// Verifies the employee reference with HR (owner of employee master data).
async function checkEmployee(req, employeeId) {
  if (!employeeId) return;
  try {
    const emp = await verifyEmployee(employeeId, { userId: req.user.id });
    if (!emp.found) throw new AppError(`HR has no employee with ID ${employeeId}.`, 422, "HR_NOT_FOUND");
    if (!emp.active) throw new AppError(`HR reports employee ${employeeId} is not active.`, 422, "HR_INACTIVE");
  } catch (err) {
    if (err instanceof IntegrationError) {
      throw new AppError(`The HR system could not verify employee ${employeeId}: ${err.message}`, 503, "HR_UNAVAILABLE");
    }
    throw err;
  }
}

async function assertRoleAndOutlets(roleId, outletIds, transaction) {
  if (!(await Role.findByPk(roleId, { transaction }))) throw new AppError("Selected role does not exist.", 422);
  if (outletIds.length) {
    const count = await Outlet.count({ where: { id: outletIds }, transaction });
    if (count !== outletIds.length) throw new AppError("One or more selected outlets do not exist.", 422);
  }
}

export async function createUser(req, body) {
  const data = parseUserInput(body, { creating: true });
  if (data.password !== data.confirmPassword) throw new AppError("Passwords do not match.", 422);
  validatePasswordStrength(data.password);
  await checkEmployee(req, data.externalEmployeeId);

  return sequelize.transaction(async (transaction) => {
    await assertRoleAndOutlets(data.roleId, data.outletIds, transaction);
    const user = await User.create(
      {
        username: data.username,
        fullName: data.fullName,
        email: data.email,
        roleId: data.roleId,
        externalEmployeeId: data.externalEmployeeId,
        status: data.status,
        passwordHash: await bcrypt.hash(data.password, BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
      },
      { transaction }
    );
    await UserOutlet.bulkCreate(data.outletIds.map((outletId) => ({ userId: user.id, outletId })), { transaction });
    const { passwordHash, ...safe } = user.get({ plain: true });
    await audit({ req, action: "USER_CREATED", entityType: "user", entityId: user.id, newValues: { ...safe, outletIds: data.outletIds }, transaction });
    return user;
  });
}

export async function updateUser(req, id, body) {
  const data = parseUserInput(body, { creating: false });
  const user = await getUser(id);

  if (user.id === req.user.id && data.status !== "ACTIVE") throw new AppError("You cannot deactivate your own account.", 422);
  if (user.id === req.user.id && data.roleId !== user.roleId) throw new AppError("You cannot change your own role.", 422);
  if (data.externalEmployeeId && data.externalEmployeeId !== user.externalEmployeeId) await checkEmployee(req, data.externalEmployeeId);
  if (data.password) {
    if (data.password !== data.confirmPassword) throw new AppError("Passwords do not match.", 422);
    validatePasswordStrength(data.password);
  }

  return sequelize.transaction(async (transaction) => {
    await assertRoleAndOutlets(data.roleId, data.outletIds, transaction);
    const before = { ...user.get({ plain: true }), outletIds: user.outlets.map((o) => o.id).sort() };
    const changes = {
      username: data.username,
      fullName: data.fullName,
      email: data.email,
      roleId: data.roleId,
      externalEmployeeId: data.externalEmployeeId,
      status: data.status,
    };
    if (data.status === "ACTIVE" && user.status === "LOCKED") Object.assign(changes, { failedLoginCount: 0, lockedUntil: null });
    if (data.password) Object.assign(changes, { passwordHash: await bcrypt.hash(data.password, BCRYPT_ROUNDS), passwordChangedAt: new Date() });
    await user.update(changes, { transaction });

    await UserOutlet.destroy({ where: { userId: user.id }, transaction });
    await UserOutlet.bulkCreate(data.outletIds.map((outletId) => ({ userId: user.id, outletId })), { transaction });

    const after = { ...user.get({ plain: true }), outletIds: [...data.outletIds].sort() };
    const { oldValues, newValues } = diff(before, after);
    if (data.password) newValues.password = "(reset)";
    await audit({ req, action: "USER_UPDATED", entityType: "user", entityId: user.id, oldValues, newValues, transaction });
    return user;
  });
}

// ── Roles & permissions ───────────────────────────────────────────────────

export async function listRoles() {
  const roles = await Role.findAll({
    include: [{ model: Permission, as: "permissions", attributes: ["id"], through: { attributes: [] } }],
    order: [["name", "ASC"]],
  });
  const counts = await User.findAll({
    attributes: ["roleId", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
    group: ["roleId"],
    raw: true,
  });
  const userCount = Object.fromEntries(counts.map((c) => [c.roleId, Number(c.n)]));
  return roles.map((r) => ({ ...r.get({ plain: true }), permissionCount: r.permissions.length, userCount: userCount[r.id] || 0 }));
}

export async function permissionMatrix(roleId) {
  const permissions = await Permission.findAll({ order: [["module", "ASC"], ["code", "ASC"]] });
  const granted = roleId ? new Set((await RolePermission.findAll({ where: { roleId } })).map((rp) => rp.permissionId)) : new Set();
  const modules = new Map();
  for (const p of permissions) {
    if (!modules.has(p.module)) modules.set(p.module, []);
    modules.get(p.module).push({ id: p.id, code: p.code, description: p.description, granted: granted.has(p.id) });
  }
  return [...modules.entries()].map(([module, perms]) => ({ module, permissions: perms }));
}

export async function saveRole(req, id, body) {
  const name = v.str(body.name, "Role name", { required: true, max: 80 });
  const description = v.str(body.description, "Description", { max: 255 });
  const permissionIds = v.idList(body.permissionIds);

  return sequelize.transaction(async (transaction) => {
    let role;
    let before = null;
    if (id) {
      role = await Role.findByPk(id, { transaction });
      if (!role) throw notFound("Role");
      before = { name: role.name, description: role.description, permissionIds: (await RolePermission.findAll({ where: { roleId: id }, transaction })).map((r) => r.permissionId).sort((a, b) => a - b) };
      if (role.code === "SYSTEM_ADMIN" && permissionIds.length < (await Permission.count({ transaction }))) {
        throw new AppError("The System Administrator role must keep every permission.", 422);
      }
      await role.update({ name, description }, { transaction });
    } else {
      const code = v.code(body.code, "Role code", { required: true });
      role = await Role.create({ code, name, description, isSystem: false }, { transaction });
    }
    const valid = await Permission.count({ where: { id: permissionIds }, transaction });
    if (valid !== permissionIds.length) throw new AppError("Unknown permission selected.", 422);

    await RolePermission.destroy({ where: { roleId: role.id }, transaction });
    await RolePermission.bulkCreate(permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })), { transaction });
    await audit({
      req,
      action: id ? "ROLE_UPDATED" : "ROLE_CREATED",
      entityType: "role",
      entityId: role.id,
      oldValues: before,
      newValues: { name, description, permissionIds: [...permissionIds].sort((a, b) => a - b) },
      transaction,
    });
    return role;
  });
}
