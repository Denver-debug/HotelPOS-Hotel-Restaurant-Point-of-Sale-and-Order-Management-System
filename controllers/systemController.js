// Audit logs (read-only), integration status/logs/outbox, and POS settings.
import { Op, QueryTypes } from "sequelize";
import { sequelize, AuditLog, User, IntegrationLog, IntegrationEvent, SystemSetting, PaymentMethod, Role, Permission, Outlet } from "../models/index.js";
import { config } from "../config/env.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit } from "../services/auditService.js";
import { invalidateSettings } from "../services/settingsService.js";
import { publishPending } from "../integrations/events/eventPublisher.js";
import { getPmsGateway } from "../integrations/pms/pmsGateway.js";
import { getHrGateway } from "../integrations/hr/hrGateway.js";
import { can } from "../middleware/auth.js";
import * as apiClientService from "../services/apiClientService.js";
import { staffOptions, paymentMethods } from "../services/lookupService.js";

// ── Audit logs (no edit/delete routes exist; the table is append-only in MySQL) ──

export const auditIndex = async (req, res) => {
  const page = parsePage(req.query, 50);
  const range = parseDateRange(req.query, 7);
  const filters = { ...filtersFrom(req.query, ["userId", "action", "entityType", "entityId"]), from: range.from, to: range.to };
  const where = { createdAt: { [Op.gte]: range.start, [Op.lt]: range.end } };
  if (filters.userId) where.userId = filters.userId;
  if (filters.action) where.action = { [Op.like]: `%${filters.action.toUpperCase()}%` };
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    include: [{ model: User, as: "user", attributes: ["fullName", "username"] }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit: page.limit,
    offset: page.offset,
  });
  const entityTypes = await sequelize.query("SELECT DISTINCT entity_type AS t FROM audit_logs ORDER BY t", { type: QueryTypes.SELECT });
  res.render("system/audit", {
    title: "Audit Logs",
    breadcrumbs: [{ label: "Audit Logs" }],
    logs: rows.map((r) => r.get({ plain: true })),
    filters,
    users: await staffOptions(),
    entityTypes: entityTypes.map((e) => e.t),
    pagination: buildPagination(req, count, page),
  });
};

// ── Integrations ─────────────────────────────────────────────────────────

const adapterInfo = () => {
  const { pms, payment, hr } = config.integrations;
  const host = (url) => {
    try {
      return url ? new URL(url).host : null;
    } catch {
      return "invalid URL";
    }
  };
  return [
    { system: "PMS", name: "Front Desk / PMS", adapter: getPmsGateway().name, isMock: getPmsGateway().isMock, endpoint: host(pms.baseUrl), credentials: Boolean(pms.apiKey), timeoutMs: pms.timeoutMs },
    { system: "PAYMENT", name: "Payment provider", adapter: payment.adapter === "mock" ? "MockPaymentAdapter" : payment.adapter, isMock: payment.adapter === "mock", endpoint: host(payment.baseUrl), credentials: Boolean(payment.apiKey), timeoutMs: payment.timeoutMs },
    { system: "HR", name: "HR and Staff Payroll", adapter: getHrGateway().name, isMock: getHrGateway().isMock, endpoint: host(hr.baseUrl), credentials: Boolean(hr.apiKey), timeoutMs: hr.timeoutMs },
    { system: "EVENT", name: "ERP event bus (outbox)", adapter: "LogOnlyPublisher", isMock: true, endpoint: null, credentials: false, timeoutMs: null },
  ];
};

export const integrations = async (req, res) => {
  const page = parsePage(req.query, 30);
  const filters = filtersFrom(req.query, ["system", "status"]);
  const where = {};
  if (filters.system) where.systemName = filters.system;
  if (filters.status) where.status = filters.status;
  const { rows, count } = await IntegrationLog.findAndCountAll({ where, order: [["createdAt", "DESC"], ["id", "DESC"]], limit: page.limit, offset: page.offset });
  const health = await sequelize.query(
    `SELECT system_name, COUNT(*) AS calls, SUM(status = 'SUCCESS') AS ok, SUM(status <> 'SUCCESS') AS failed,
            ROUND(AVG(duration_ms)) AS avg_ms, MAX(created_at) AS last_call
       FROM integration_logs WHERE created_at >= NOW() - INTERVAL 1 DAY GROUP BY system_name`,
    { type: QueryTypes.SELECT }
  );
  const byHealth = Object.fromEntries(health.map((h) => [h.system_name, h]));
  const outbox = await sequelize.query("SELECT status, COUNT(*) AS n FROM integration_events GROUP BY status", { type: QueryTypes.SELECT });
  const events = await IntegrationEvent.findAll({ order: [["id", "DESC"]], limit: 10 });
  res.render("system/integrations", {
    title: "Integrations",
    breadcrumbs: [{ label: "Integrations" }],
    adapters: adapterInfo().map((a) => ({ ...a, health: byHealth[a.system] || null })),
    logs: rows.map((r) => r.get({ plain: true })),
    outbox: Object.fromEntries(outbox.map((o) => [o.status, Number(o.n)])),
    events: events.map((e) => e.get({ plain: true })),
    filters,
    canManage: can(req, "integrations.manage"),
    pagination: buildPagination(req, count, page),
  });
};

export const integrationLog = async (req, res) => {
  const log = await IntegrationLog.findByPk(req.params.id, { include: [{ model: User, as: "user", attributes: ["fullName"] }] });
  if (!log) throw notFound("Integration log");
  res.render("system/integration-log", { title: `Integration call #${log.id}`, breadcrumbs: [{ label: "Integrations", href: "/integrations" }, { label: `#${log.id}` }], log: log.get({ plain: true }) });
};

export const dispatchEvents = async (req, res) => {
  const result = await publishPending({ userId: req.user.id });
  await audit({ req, action: "EVENTS_DISPATCHED", entityType: "integration", entityId: "EVENT", newValues: result });
  req.flash("success_msg", `Dispatched ${result.published} of ${result.attempted} pending event(s) (MOCK publisher — no event bus configured).`);
  res.redirect("/integrations");
};

// ── Settings & payment methods ───────────────────────────────────────────

export const settings = async (req, res) => {
  res.render("system/settings", {
    title: "Settings",
    breadcrumbs: [{ label: "Settings" }],
    posSettings: (await SystemSetting.findAll({ order: [["sortOrder", "ASC"]] })).map((s) => s.get({ plain: true })),
    methods: await paymentMethods(),
    env: { appName: config.appName, timezone: config.timezone, currency: config.currencySymbol, environment: config.env, database: config.db.name },
  });
};

export const saveSettings = async (req, res) => {
  const rows = await SystemSetting.findAll();
  const changes = {};
  await sequelize.transaction(async (transaction) => {
    for (const row of rows) {
      let value;
      if (row.valueType === "boolean") value = v.bool(req.body[row.settingKey]) ? "true" : "false";
      else if (row.valueType === "number") value = String(v.int(req.body[row.settingKey], row.label, { min: 1, max: 100 }));
      else value = v.str(req.body[row.settingKey], row.label, { max: row.valueType === "text" ? 2000 : 255 }) ?? "";
      if (value !== (row.settingValue ?? "")) {
        changes[row.settingKey] = { from: row.settingValue, to: value };
        await row.update({ settingValue: value, updatedBy: req.user.id }, { transaction });
      }
    }
    if (Object.keys(changes).length) {
      await audit({ req, action: "SETTINGS_UPDATED", entityType: "system_settings", oldValues: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.from])), newValues: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])), transaction });
    }
  });
  invalidateSettings();
  req.flash("success_msg", Object.keys(changes).length ? "Settings saved." : "No changes to save.");
  res.redirect("/settings");
};

export const savePaymentMethod = async (req, res) => {
  const method = await PaymentMethod.findByPk(req.params.id);
  if (!method) throw notFound("Payment method");
  const status = v.oneOf(req.body.status, "Status", ["ACTIVE", "INACTIVE"]);
  if (method.isCash && status === "INACTIVE") throw new AppError("Cash cannot be deactivated; it is needed for shift reconciliation.", 422);
  const before = { name: method.name, status: method.status, requiresReference: method.requiresReference, sortOrder: method.sortOrder };
  await method.update({
    name: v.str(req.body.name, "Name", { required: true, max: 60 }),
    status,
    requiresReference: v.bool(req.body.requiresReference),
    sortOrder: v.int(req.body.sortOrder || "0", "Order", { min: 0, max: 999 }),
  });
  await audit({ req, action: "PAYMENT_METHOD_UPDATED", entityType: "payment_method", entityId: method.id, oldValues: before, newValues: { name: method.name, status: method.status, requiresReference: method.requiresReference, sortOrder: method.sortOrder } });
  req.flash("success_msg", `${method.name} was updated.`);
  res.redirect("/settings#payment-methods");
};

// ── API clients (System → Integrations → API clients) ────────────────────

const SAFE_FOR_KEYS = (role) => !role.permissions.some((p) => ["users.manage", "roles.manage", "settings.manage", "integrations.manage"].includes(p.code));

async function apiClientLocals(req, extra = {}) {
  const roles = await Role.findAll({ include: [{ model: Permission, as: "permissions", attributes: ["code"], through: { attributes: [] } }], order: [["name", "ASC"]] });
  return {
    title: "API clients",
    breadcrumbs: [{ label: "Integrations", href: "/integrations" }, { label: "API clients" }],
    clients: await apiClientService.listClients(),
    roles: roles.filter(SAFE_FOR_KEYS).map((r) => ({ id: r.id, code: r.code, name: r.name })),
    outlets: (await Outlet.findAll({ where: { status: "ACTIVE" }, order: [["name", "ASC"]] })).map((o) => o.get({ plain: true })),
    canManage: can(req, "integrations.manage"),
    baseUrl: `${req.protocol}://${req.get("host")}/api/v1`,
    form: { roleCode: "ERP_INTEGRATION" },
    ...extra,
  };
}

export const apiClients = async (req, res) => res.render("system/api-clients", await apiClientLocals(req));

// The new key is rendered in this response only (never flashed: flash lives in the session store).
export const createApiClient = async (req, res) => {
  try {
    const { client, key } = await apiClientService.createClient(req, req.body);
    res.render("system/api-clients", await apiClientLocals(req, { newKey: { key, name: client.name } }));
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    res.status(err.status).render("system/api-clients", await apiClientLocals(req, { formError: err.message, form: { ...req.body, outletIds: [].concat(req.body.outletIds || []).map(Number) } }));
  }
};

export const rotateApiKey = async (req, res) => {
  const { client, key } = await apiClientService.rotateKey(req, req.params.id);
  res.render("system/api-clients", await apiClientLocals(req, { newKey: { key, name: client.name, rotated: true } }));
};

export const revokeApiClient = async (req, res) => {
  const client = await apiClientService.revokeClient(req, req.params.id);
  req.flash("success_msg", `API client “${client.name}” was revoked. Its key no longer works.`);
  res.redirect("/integrations/api-clients");
};

