// Read and sync endpoints for other ERP subsystems (/api/v1/...). Each handler reuses the same
// services and outlet scoping as the web screens; serializers.js defines the JSON shapes and
// utils/apiList.js the paging and time filters. See docs/API.md.
import { createRequire } from "module";
import { Op } from "sequelize";
import {
  sequelize, Outlet, Category, Product, ProductPrice, Tax, Order, Payment, PaymentMethod, GuestCharge, Refund, User, Shift,
} from "../models/index.js";
import { ORDER_DETAIL_INCLUDE, toDto } from "../services/orderService.js";
import * as shiftService from "../services/shiftService.js";
import * as refundService from "../services/refundService.js";
import * as receiptService from "../services/receiptService.js";
import * as guestChargeService from "../services/guestChargeService.js";
import * as inventoryService from "../services/inventoryService.js";
import { REPORTS } from "../services/reportDefinitions.js";
import * as S from "../services/serializers.js";
import { listQuery, timeFilter, pageInfo, optionalId, outletFilter } from "../utils/apiList.js";
import { parseDateRange } from "../utils/dates.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { config } from "../config/env.js";
import { buildOpenApi } from "../config/openapi.js";

const pkg = createRequire(import.meta.url)("../package.json");
const oneOf = (value, allowed, name) => {
  if (value === undefined || value === "") return null;
  if (!allowed.includes(value)) throw new AppError(`${name} must be one of: ${allowed.join(", ")}.`, 422, "VALIDATION_ERROR");
  return value;
};

// ── Service ──────────────────────────────────────────────────────────────

// GET /health — no authentication; for load balancers and the ERP's monitoring.
export const health = async (req, res) => {
  let database = "up";
  try {
    await sequelize.query("SELECT 1");
  } catch {
    database = "down";
  }
  const { pms, payment, hr } = config.integrations;
  const body = {
    ok: database === "up",
    status: database === "up" ? "up" : "degraded",
    app: config.appName,
    version: pkg.version,
    time: new Date().toISOString(),
    database,
    integrations: { pms: pms.adapter, payment: payment.adapter, hr: hr.adapter, events: config.events?.publisher ?? "log" },
  };
  res.status(database === "up" ? 200 : 503).json(database === "up" ? body : { ...body, code: "SERVICE_UNAVAILABLE", error: "The database is not reachable." });
};

// GET /me — who the caller is and what it may do.
export const me = async (req, res) => {
  res.json({
    ok: true,
    user: { id: req.user.id, username: req.user.username, fullName: req.user.fullName, role: req.user.roleCode, isServiceAccount: Boolean(req.user.isServiceAccount) },
    client: req.apiClient ?? null,
    permissions: [...req.permissions].sort(),
    outlets: req.outlets.map((o) => ({ id: o.id, code: o.code, name: o.name })),
    openShift: req.openShift ? { id: req.openShift.id, shiftNumber: req.openShift.shiftNumber, outletId: req.openShift.outletId } : null,
  });
};

// GET /openapi.json — machine-readable contract (OpenAPI 3.1).
export const openapi = (req, res) => res.json(buildOpenApi({ version: pkg.version }));

// ── Reference data ───────────────────────────────────────────────────────

export const outlets = async (req, res) => {
  const rows = await Outlet.findAll({ where: { id: { [Op.in]: req.user.outletIds.length ? req.user.outletIds : [-1] } }, order: [["name", "ASC"]] });
  res.json({ ok: true, outlets: rows.map(S.outlet) });
};

export const categories = async (req, res) => {
  const p = listQuery(req.query, { defaultLimit: 200, maxLimit: 500 });
  const { where, order } = timeFilter(p);
  const status = oneOf(req.query.status, ["ACTIVE", "ARCHIVED"], "status");
  if (status) where.status = status;
  const { rows, count } = await Category.findAndCountAll({ where, order: p.updatedSince ? order : [["sortOrder", "ASC"], ["name", "ASC"]], limit: p.limit, offset: p.offset });
  res.json({ ok: true, categories: rows.map(S.category), pagination: pageInfo(count, p) });
};

export const paymentMethods = async (req, res) => {
  const rows = await PaymentMethod.findAll({ order: [["sortOrder", "ASC"]] });
  res.json({ ok: true, paymentMethods: rows.map(S.paymentMethod) });
};

// GET /products?outletId&categoryId&status&search&updatedSince — with current prices per outlet.
// A price change counts as a product change for updatedSince.
export const products = async (req, res) => {
  const p = listQuery(req.query, { defaultLimit: 100, maxLimit: 500 });
  const outletId = optionalId(req.query.outletId, "outletId");
  const categoryId = optionalId(req.query.categoryId, "categoryId");
  const status = oneOf(req.query.status, ["AVAILABLE", "UNAVAILABLE", "ARCHIVED"], "status");
  const where = {};
  if (categoryId) where.categoryId = categoryId;
  if (status) where.status = status;
  if (req.query.search) where[Op.or] = [{ name: { [Op.like]: `%${req.query.search}%` } }, { code: { [Op.like]: `%${req.query.search}%` } }];
  if (p.updatedSince) {
    where[Op.and] = sequelize.literal(
      `(Product.updated_at >= ${sequelize.escape(p.updatedSince)} OR EXISTS (SELECT 1 FROM product_prices pp WHERE pp.product_id = Product.id AND (pp.effective_from >= ${sequelize.escape(p.updatedSince)} OR pp.effective_to >= ${sequelize.escape(p.updatedSince)})))`
    );
  }
  const { rows, count } = await Product.findAndCountAll({
    where,
    include: [
      { model: Category, as: "category", attributes: ["id", "name"] },
      { model: Tax, as: "tax", attributes: ["code", "rate", "isInclusive"] },
      { model: ProductPrice, as: "prices", required: Boolean(outletId), where: { effectiveTo: null, outletId: outletFilter(req, outletId) }, attributes: ["outletId", "price", "isAvailable", "effectiveFrom"] },
    ],
    distinct: true,
    order: p.updatedSince ? [["updatedAt", "ASC"], ["id", "ASC"]] : [["name", "ASC"]],
    limit: p.limit,
    offset: p.offset,
  });
  res.json({ ok: true, products: rows.map(S.product), pagination: pageInfo(count, p) });
};

// ── Sales ────────────────────────────────────────────────────────────────

const ORDER_STATUSES = ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "SETTLING", "CHARGE_FAILED", "COMPLETED", "VOIDED", "PARTIALLY_REFUNDED", "REFUNDED"];

// GET /orders?outletId&status&settlementType&externalReference&updatedSince|from&to — full order documents.
export const orders = async (req, res) => {
  const p = listQuery(req.query, { defaultLimit: 50, maxLimit: 100 });
  const { where, order } = timeFilter(p);
  where.outletId = outletFilter(req, optionalId(req.query.outletId, "outletId"));
  const status = oneOf(req.query.status, ORDER_STATUSES, "status");
  if (status) where.status = status;
  const settlementType = oneOf(req.query.settlementType, ["DIRECT_PAYMENT", "ROOM_CHARGE"], "settlementType");
  if (settlementType) where.settlementType = settlementType;
  if (req.query.externalReference) where.externalReference = String(req.query.externalReference);
  // Page the ids first, then load each order with its lines, payments and charges.
  const { rows: idRows, count } = await Order.findAndCountAll({ where, order, limit: p.limit, offset: p.offset, attributes: ["id"] });
  const ids = idRows.map((r) => r.id);
  const docs = ids.length ? await Order.findAll({ where: { id: ids }, include: ORDER_DETAIL_INCLUDE }) : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  res.json({ ok: true, orders: ids.map((id) => toDto(byId.get(id))), pagination: pageInfo(count, p) });
};

export const payments = async (req, res) => {
  const p = listQuery(req.query);
  const { where, order } = timeFilter(p);
  const status = oneOf(req.query.status, ["PENDING", "CAPTURED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"], "status");
  if (status) where.status = status;
  const methodId = optionalId(req.query.methodId, "methodId");
  if (methodId) where.paymentMethodId = methodId;
  const { rows, count } = await Payment.findAndCountAll({
    where,
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "outletId"], where: { outletId: outletFilter(req, optionalId(req.query.outletId, "outletId")) } },
      { model: PaymentMethod, as: "method", attributes: ["code", "name"] },
      { model: User, as: "processor", attributes: ["id", "fullName"] },
    ],
    order,
    limit: p.limit,
    offset: p.offset,
  });
  res.json({ ok: true, payments: rows.map(S.payment), pagination: pageInfo(count, p) });
};

export const guestCharges = async (req, res) => {
  const p = listQuery(req.query);
  const { where, order } = timeFilter(p);
  const status = oneOf(req.query.status, ["PENDING", "POSTED", "FAILED", "UNKNOWN", "REVERSED", "PARTIALLY_REVERSED"], "status");
  if (status) where.status = status;
  if (req.query.externalFolioId) where.externalFolioId = String(req.query.externalFolioId);
  const { rows, count } = await GuestCharge.findAndCountAll({
    where,
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "outletId"], where: { outletId: outletFilter(req, optionalId(req.query.outletId, "outletId")) } },
      { model: User, as: "requester", attributes: ["id", "fullName"] },
    ],
    order,
    limit: p.limit,
    offset: p.offset,
  });
  res.json({ ok: true, guestCharges: rows.map(S.guestCharge), pagination: pageInfo(count, p) });
};

export const guestCharge = async (req, res) => {
  res.json({ ok: true, guestCharge: S.guestCharge(await guestChargeService.getCharge(req, req.params.id)) });
};

export const refunds = async (req, res) => {
  const p = listQuery(req.query);
  const { where, order } = timeFilter(p);
  const status = oneOf(req.query.status, ["REQUESTED", "APPROVED", "REJECTED", "PROCESSED", "FAILED"], "status");
  if (status) where.status = status;
  const { rows, count } = await Refund.findAndCountAll({
    where,
    include: [
      { model: Order, as: "order", attributes: ["id", "orderNumber", "outletId"], where: { outletId: outletFilter(req, optionalId(req.query.outletId, "outletId")) } },
      { model: PaymentMethod, as: "refundMethod", attributes: ["id", "code", "name"] },
      { model: User, as: "requester", attributes: ["id", "fullName"] },
      { model: User, as: "approver", attributes: ["id", "fullName"] },
    ],
    order,
    limit: p.limit,
    offset: p.offset,
  });
  res.json({ ok: true, refunds: rows.map(S.refund), pagination: pageInfo(count, p) });
};

export const refund = async (req, res) => {
  res.json({ ok: true, refund: S.refund(await refundService.getRefund(req, req.params.id)) });
};

export const receipt = async (req, res) => {
  res.json({ ok: true, receipt: S.receipt(await receiptService.getReceipt(req, req.params.id)) });
};

// ── Shifts ───────────────────────────────────────────────────────────────

export const shifts = async (req, res) => {
  const p = listQuery(req.query);
  const { where, order } = timeFilter(p, { created: "openedAt" });
  where.outletId = outletFilter(req, optionalId(req.query.outletId, "outletId"));
  const status = oneOf(req.query.status, ["OPEN", "CLOSED", "RECONCILED"], "status");
  if (status) where.status = status;
  // Same rule as the Shifts page: without shifts.manage/reports.view you see only your own.
  if (!req.permissions.has("shifts.manage") && !req.permissions.has("reports.view")) where.userId = req.user.id;
  const { rows, count } = await Shift.findAndCountAll({
    where,
    include: [
      { model: Outlet, as: "outlet", attributes: ["code", "name"] },
      { model: User, as: "cashier", attributes: ["id", "fullName"] },
    ],
    order,
    limit: p.limit,
    offset: p.offset,
  });
  res.json({ ok: true, shifts: rows.map((s) => S.shift(s)), pagination: pageInfo(count, p) });
};

export const shiftShow = async (req, res) => {
  const shift = await shiftService.getShift(req, req.params.id);
  res.json({ ok: true, shift: S.shift(shift, await shiftService.shiftSummary(shift.get({ plain: true }))) });
};

export const shiftCurrent = async (req, res) => {
  if (!req.openShift) return res.json({ ok: true, shift: null });
  const shift = await shiftService.getShift(req, req.openShift.id);
  res.json({ ok: true, shift: S.shift(shift, await shiftService.shiftSummary(shift.get({ plain: true }))) });
};

export const shiftOpen = async (req, res) => {
  const shift = await shiftService.openShift(req, req.body);
  res.status(201).json({ ok: true, shift: S.shift(await shiftService.getShift(req, shift.id)) });
};

export const shiftClose = async (req, res) => {
  const shift = await shiftService.closeShift(req, req.params.id, req.body);
  res.json({ ok: true, shift: S.shift(await shiftService.getShift(req, shift.id)) });
};

// ── Inventory ────────────────────────────────────────────────────────────

export const stockLevels = async (req, res) => {
  const p = listQuery(req.query, { defaultLimit: 100, maxLimit: 500 });
  const outletId = optionalId(req.query.outletId, "outletId");
  if (outletId && !req.user.outletIds.includes(outletId)) throw forbidden("You are not assigned to this outlet.");
  const { rows, count } = await inventoryService.stockLevels(req, { outletId, search: req.query.search, low: req.query.low === "true" || req.query.low === "1" }, p);
  res.json({ ok: true, stockLevels: rows.map(S.stockLevel), pagination: pageInfo(count, p) });
};

// GET /inventory/movements?outletId&itemId&type&from&to — the append-only stock ledger.
export const movements = async (req, res) => {
  const p = listQuery(req.query, { defaultLimit: 100, maxLimit: 500 });
  const range = parseDateRange({}, 30);
  const { rows, count } = await inventoryService.movements(
    req,
    {
      itemId: optionalId(req.query.itemId, "itemId"),
      outletId: optionalId(req.query.outletId, "outletId"),
      type: req.query.type || null,
      start: p.from || range.start,
      end: p.to || new Date(Date.now() + 60000),
    },
    p
  );
  res.json({ ok: true, movements: rows.map(S.movement), pagination: pageInfo(count, p) });
};

// POST /inventory/movements — e.g. goods received from ERP purchasing. Send an Idempotency-Key.
export const movementCreate = async (req, res) => {
  const row = await inventoryService.recordManualMovement(req, req.body);
  res.status(row.duplicate ? 200 : 201).json({ ok: true, movement: S.movement(row), duplicate: Boolean(row.duplicate) });
};

// ── Reports ──────────────────────────────────────────────────────────────

export const reports = (req, res) => {
  res.json({
    ok: true,
    reports: Object.entries(REPORTS).map(([key, def]) => ({
      key,
      title: def.title,
      description: def.description,
      columns: def.columns.map((c) => ({ key: c.key, label: c.label, type: c.type || "text" })),
    })),
  });
};

// GET /reports/:key?from&to&outletId&… — the same figures as the Reports screens, as JSON.
export const report = async (req, res) => {
  const def = REPORTS[req.params.key];
  if (!def) throw notFound("Report");
  const range = parseDateRange(req.query, req.params.key === "sales" ? 6 : 0);
  const filters = {
    start: range.start,
    end: range.end,
    from: range.from,
    to: range.to,
    outletIds: req.user.outletIds,
    outletId: optionalId(req.query.outletId, "outletId"),
    cashierId: optionalId(req.query.cashierId, "cashierId"),
    productId: optionalId(req.query.productId, "productId"),
    methodId: optionalId(req.query.methodId, "methodId"),
    granularity: ["day", "week", "month"].includes(req.query.granularity) ? req.query.granularity : "day",
    sort: req.query.sort === "quantity" ? "quantity" : "amount",
  };
  const data = await def.load(filters);
  res.json({
    ok: true,
    report: { key: req.params.key, title: def.title, from: range.from, to: range.to, outletId: filters.outletId },
    columns: def.columns.map((c) => ({ key: c.key, label: c.label, type: c.type || "text" })),
    rows: data.rows,
    totals: data.totals ?? null,
    summary: data.summary ?? null,
    secondary: def.secondary ? { title: def.secondary.title, columns: def.secondary.columns.map((c) => ({ key: c.key, label: c.label, type: c.type || "text" })), rows: data.secondaryRows || [] } : null,
  });
};
