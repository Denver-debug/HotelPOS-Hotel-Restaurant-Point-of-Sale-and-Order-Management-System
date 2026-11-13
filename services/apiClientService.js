// API clients: one key per connected ERP subsystem. Creating a client also creates its
// service-account user (role + outlets decide what the key may do; it can never sign in).
// The full key is returned exactly once; only its hash is stored.
import crypto from "crypto";
import net from "net";
import bcrypt from "bcrypt";
import { sequelize, ApiClient, User, UserOutlet, Role, Permission, Outlet } from "../models/index.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit } from "./auditService.js";
import { generateApiKey } from "../middleware/apiAuth.js";
import { BCRYPT_ROUNDS } from "./authService.js";

// A key that can change users, roles, settings or other keys would make one leaked secret a
// full takeover; those stay with people who sign in.
const ADMIN_PERMISSIONS = ["users.manage", "roles.manage", "settings.manage", "integrations.manage"];

export async function listClients() {
  const rows = await ApiClient.findAll({
    include: [
      {
        model: User,
        as: "user",
        attributes: ["id", "username", "status"],
        include: [
          { model: Role, as: "role", attributes: ["code", "name"] },
          { model: Outlet, as: "outlets", attributes: ["code"], through: { attributes: [] } },
        ],
      },
      { model: User, as: "creator", attributes: ["fullName"] },
    ],
    order: [["status", "ASC"], ["name", "ASC"]],
  });
  return rows.map((r) => r.get({ plain: true }));
}

const parseIps = (value) => {
  const ips = String(value || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  for (const ip of ips) if (!net.isIP(ip)) throw new AppError(`"${ip}" is not an IP address.`, 422);
  return ips.length ? ips.join(",") : null;
};

async function assertRoleIsSafe(roleId, transaction) {
  const role = await Role.findByPk(roleId, { include: [{ model: Permission, as: "permissions", attributes: ["code"], through: { attributes: [] } }], transaction });
  if (!role) throw new AppError("Select a role.", 422);
  const admin = role.permissions.map((p) => p.code).filter((c) => ADMIN_PERMISSIONS.includes(c));
  if (admin.length) throw new AppError(`API keys cannot hold administration permissions (${admin.join(", ")}). Choose a role without them, such as "ERP Integration (API)".`, 422);
  return role;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "client";

export async function createClient(req, body) {
  const name = v.str(body.name, "Name", { required: true, max: 80 });
  const roleId = v.id(body.roleId, "Role");
  const outletIds = [].concat(body.outletIds || []).map((x) => v.id(x, "Outlet"));
  const allowedIps = parseIps(body.allowedIps);

  return sequelize.transaction(async (transaction) => {
    const role = await assertRoleIsSafe(roleId, transaction);
    if (outletIds.length && (await Outlet.count({ where: { id: outletIds }, transaction })) !== outletIds.length) throw new AppError("Unknown outlet selected.", 422);

    // Service account: random unusable password, flagged so the login page refuses it.
    const user = await User.create(
      {
        username: `svc-${slug(name)}-${crypto.randomBytes(2).toString("hex")}`,
        fullName: `${name} (API)`,
        roleId: role.id,
        status: "ACTIVE",
        isServiceAccount: true,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS),
        passwordChangedAt: new Date(),
      },
      { transaction }
    );
    if (outletIds.length) await UserOutlet.bulkCreate(outletIds.map((outletId) => ({ userId: user.id, outletId })), { transaction });

    const { key, prefix, hash } = generateApiKey();
    const client = await ApiClient.create({ name, keyPrefix: prefix, keyHash: hash, userId: user.id, allowedIps, createdBy: req.user.id }, { transaction });
    await audit({ req, action: "API_CLIENT_CREATED", entityType: "api_client", entityId: client.id, newValues: { name, keyPrefix: prefix, role: role.code, outletIds, allowedIps, serviceAccount: user.username }, transaction });
    return { client, key };
  });
}

export async function rotateKey(req, id) {
  return sequelize.transaction(async (transaction) => {
    const client = await ApiClient.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!client) throw notFound("API client");
    if (client.status !== "ACTIVE") throw new AppError("A revoked client cannot get a new key. Create a new client instead.", 409);
    const { key, prefix, hash } = generateApiKey();
    const oldPrefix = client.keyPrefix;
    await client.update({ keyPrefix: prefix, keyHash: hash }, { transaction });
    await audit({ req, action: "API_KEY_ROTATED", entityType: "api_client", entityId: client.id, oldValues: { keyPrefix: oldPrefix }, newValues: { keyPrefix: prefix }, transaction });
    return { client, key };
  });
}

export async function revokeClient(req, id) {
  return sequelize.transaction(async (transaction) => {
    const client = await ApiClient.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!client) throw notFound("API client");
    if (client.status === "REVOKED") return client;
    await client.update({ status: "REVOKED", revokedAt: new Date(), revokedBy: req.user.id }, { transaction });
    await User.update({ status: "INACTIVE" }, { where: { id: client.userId }, transaction });
    await audit({ req, action: "API_CLIENT_REVOKED", entityType: "api_client", entityId: client.id, newValues: { name: client.name, keyPrefix: client.keyPrefix }, transaction });
    return client;
  });
}
