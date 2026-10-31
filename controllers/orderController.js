import { AuditLog, User } from "../models/index.js";
import { ORDER_TYPES, ORDER_STATUSES } from "../models/salesModel.js";
import * as orderService from "../services/orderService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { can } from "../middleware/auth.js";

// ── Pages ────────────────────────────────────────────────────────────────

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const range = parseDateRange(req.query, 0);
  const filters = { ...filtersFrom(req.query, ["search", "outletId", "status", "orderType", "settlementType", "cashierId"]), from: range.from, to: range.to };
  const { rows, count } = await orderService.listOrders(req, { ...filters, start: range.start, end: range.end }, page);
  res.render("orders/index", {
    title: "Orders",
    breadcrumbs: [{ label: "Orders" }],
    orders: rows.map((o) => o.get({ plain: true })),
    filters,
    outlets: req.outlets,
    statuses: ORDER_STATUSES,
    types: ORDER_TYPES,
    cashiers: (await User.findAll({ attributes: ["id", "fullName"], order: [["fullName", "ASC"]] })).map((u) => u.get({ plain: true })),
    pagination: buildPagination(req, count, page),
  });
};

export const show = async (req, res) => {
  const order = (await orderService.getOrder(req, req.params.id)).get({ plain: true });
  const history = await AuditLog.findAll({
    where: { entityType: "order", entityId: String(order.id) },
    include: [{ model: User, as: "user", attributes: ["fullName"] }],
    order: [["createdAt", "ASC"], ["id", "ASC"]],
  });
  const saleReceipt = order.receipts.find((r) => !r.refundId);
  res.render("orders/show", {
    title: `Order ${order.orderNumber}`,
    breadcrumbs: [{ label: "Orders", href: "/orders" }, { label: order.orderNumber }],
    order,
    dto: orderService.toDto(order),
    history: history.map((h) => h.get({ plain: true })),
    saleReceipt,
    canRefund: can(req, "refunds.request") && ["COMPLETED", "PARTIALLY_REFUNDED"].includes(order.status),
    canResume: can(req, "pos.access") && ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "SETTLING", "CHARGE_FAILED"].includes(order.status),
  });
};

// ── JSON API (POS terminal) ──────────────────────────────────────────────

const respond = async (req, res, orderId, status = 200) => {
  const order = await orderService.getOrder(req, orderId);
  res.status(status).json({ ok: true, order: orderService.toDto(order) });
};

export const apiShow = async (req, res) => respond(req, res, req.params.id);

export const apiCreate = async (req, res) => {
  const order = await orderService.createOrder(req, req.body);
  if (req.body.productId) await orderService.addItem(req, order.id, req.body);
  await respond(req, res, order.id, 201);
};

export const apiUpdate = async (req, res) => respond(req, res, await orderService.updateHeader(req, req.params.id, req.body));
export const apiAddItem = async (req, res) => respond(req, res, await orderService.addItem(req, req.params.id, req.body));
export const apiUpdateItem = async (req, res) => respond(req, res, await orderService.updateItem(req, req.params.id, req.params.itemId, req.body));
export const apiRemoveItem = async (req, res) => respond(req, res, await orderService.removeItem(req, req.params.id, req.params.itemId));
export const apiRequestSettlement = async (req, res) => respond(req, res, await orderService.requestSettlement(req, req.params.id));
export const apiReopen = async (req, res) => respond(req, res, await orderService.reopenForEdit(req, req.params.id));
export const apiVoid = async (req, res) => respond(req, res, await orderService.voidOrder(req, req.params.id, req.body));

export const apiOpenOrders = async (req, res) => {
  res.json({ ok: true, orders: await orderService.openOrders(req, req.query.outletId) });
};
