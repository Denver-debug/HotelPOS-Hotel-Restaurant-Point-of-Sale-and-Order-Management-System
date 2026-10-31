import { IntegrationLog } from "../models/index.js";
import { CHARGE_STATUSES } from "../models/salesModel.js";
import * as guestChargeService from "../services/guestChargeService.js";
import * as orderService from "../services/orderService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { can } from "../middleware/auth.js";

const withOrder = async (req, res, result) => {
  const order = orderService.toDto(await orderService.getOrder(req, result.charge.orderId));
  res.json({ ok: true, outcome: result.outcome, message: result.message, charge: result.charge.get({ plain: true }), order, duplicate: Boolean(result.duplicate) });
};

// POST /api/orders/:id/room-charge/validate
export const apiValidate = async (req, res) => {
  res.json({ ok: true, validation: await guestChargeService.validateRoom(req, req.params.id, req.body) });
};

// POST /api/orders/:id/room-charge
export const apiPost = async (req, res) => withOrder(req, res, await guestChargeService.postRoomCharge(req, req.params.id, req.body));

// POST /api/guest-charges/:id/verify
export const apiVerify = async (req, res) => withOrder(req, res, await guestChargeService.verifyCharge(req, req.params.id));

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const range = parseDateRange(req.query, 7);
  const filters = { ...filtersFrom(req.query, ["search", "status", "outletId"]), from: range.from, to: range.to };
  const { rows, count } = await guestChargeService.listCharges(req, { ...filters, start: range.start, end: range.end }, page);
  res.render("guest-charges/index", {
    title: "Guest Room Charges",
    breadcrumbs: [{ label: "Guest Room Charges" }],
    charges: rows.map((c) => c.get({ plain: true })),
    filters,
    outlets: req.outlets,
    statuses: CHARGE_STATUSES,
    pagination: buildPagination(req, count, page),
  });
};

export const show = async (req, res) => {
  const charge = (await guestChargeService.getCharge(req, req.params.id)).get({ plain: true });
  const logs = await IntegrationLog.findAll({
    where: { referenceType: ["guest_charge", "order"], referenceId: [String(charge.id), String(charge.orderId)], systemName: "PMS" },
    order: [["createdAt", "ASC"]],
  });
  res.render("guest-charges/show", {
    title: `Room charge ${charge.chargeNumber}`,
    breadcrumbs: [{ label: "Guest Room Charges", href: "/guest-charges" }, { label: charge.chargeNumber }],
    charge,
    logs: logs.map((l) => l.get({ plain: true })),
    canVerify: can(req, "room_charges.process") && ["PENDING", "UNKNOWN"].includes(charge.status),
  });
};

export const verify = async (req, res) => {
  const result = await guestChargeService.verifyCharge(req, req.params.id);
  req.flash(result.outcome === "FAILED" ? "error_msg" : "success_msg", result.message || `Charge is ${result.charge.status}.`);
  res.redirect(`/guest-charges/${req.params.id}`);
};
