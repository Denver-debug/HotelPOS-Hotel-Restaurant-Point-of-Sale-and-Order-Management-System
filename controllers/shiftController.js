import { staffOptions } from "../services/lookupService.js";
import * as shiftService from "../services/shiftService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { handleForm } from "../utils/forms.js";
import { can } from "../middleware/auth.js";

const crumbs = (label) => [{ label: "Cashier Shifts", href: "/shifts" }, ...(label ? [{ label }] : [])];

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const range = parseDateRange(req.query, 30);
  const filters = { ...filtersFrom(req.query, ["outletId", "userId", "status"]), from: range.from, to: range.to };
  const { rows, count } = await shiftService.listShifts(req, { ...filters, start: range.start, end: range.end }, page);
  const canSeeOthers = can(req, "shifts.manage") || can(req, "reports.view");
  res.render("shifts/index", {
    title: "Cashier Shifts",
    breadcrumbs: crumbs(),
    shifts: rows.map((s) => s.get({ plain: true })),
    filters,
    outlets: req.outlets,
    cashiers: canSeeOthers ? await staffOptions() : [],
    canSeeOthers,
    pagination: buildPagination(req, count, page),
  });
};

export const openForm = (req, res) => {
  if (req.openShift) return res.redirect(`/shifts/${req.openShift.id}`);
  // ?next=pos&outletId= comes from the POS header ("No open shift"): preselect and return there.
  const shift = { openingCash: "0.00", next: req.query.next === "pos" ? "pos" : "", outletId: Number(req.query.outletId) || undefined };
  res.render("shifts/open", { title: "Open shift", breadcrumbs: crumbs("Open shift"), outlets: req.outlets, shift });
};

export const open = async (req, res) => {
  const shift = await handleForm(res, () => shiftService.openShift(req, req.body), {
    view: "shifts/open",
    locals: { title: "Open shift", breadcrumbs: crumbs("Open shift"), outlets: req.outlets, shift: req.body },
  });
  if (!shift) return;
  req.flash("success_msg", `Shift ${shift.shiftNumber} is open. You can now take payments.`);
  res.redirect(req.body.next === "pos" ? `/pos/terminal?outletId=${shift.outletId}` : `/shifts/${shift.id}`);
};

export const show = async (req, res) => {
  const shift = (await shiftService.getShift(req, req.params.id)).get({ plain: true });
  const summary = await shiftService.shiftSummary(shift);
  const isOwner = shift.userId === req.user.id;
  res.render("shifts/show", {
    title: `Shift ${shift.shiftNumber}`,
    breadcrumbs: crumbs(shift.shiftNumber),
    shift,
    summary,
    canClose: shift.status === "OPEN" && (isOwner || can(req, "shifts.manage")),
    canReconcile: shift.status === "CLOSED" && !isOwner && can(req, "shifts.manage"),
    print: req.query.print === "1",
  });
};

export const close = async (req, res) => {
  const shift = await shiftService.closeShift(req, req.params.id, req.body);
  const variance = Number(shift.cashVariance);
  req.flash("success_msg", `Shift ${shift.shiftNumber} closed. Cash variance: ${variance === 0 ? "none" : shift.cashVariance}.`);
  res.redirect(`/shifts/${shift.id}`);
};

export const reconcile = async (req, res) => {
  const shift = await shiftService.reconcileShift(req, req.params.id);
  req.flash("success_msg", `Shift ${shift.shiftNumber} was reconciled.`);
  res.redirect(`/shifts/${shift.id}`);
};
