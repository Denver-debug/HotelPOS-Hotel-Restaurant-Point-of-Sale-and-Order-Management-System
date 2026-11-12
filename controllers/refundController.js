import { paymentMethods } from "../services/lookupService.js";
import * as refundService from "../services/refundService.js";
import { getOrder } from "../services/orderService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { handleForm } from "../utils/forms.js";
import { fromCents } from "../utils/money.js";
import { can } from "../middleware/auth.js";

const crumbs = (label) => [{ label: "Refunds & Voids", href: "/refunds" }, ...(label ? [{ label }] : [])];

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const range = parseDateRange(req.query, 30);
  const tab = req.query.tab === "voids" ? "voids" : "refunds";
  const filters = { ...filtersFrom(req.query, ["status"]), from: range.from, to: range.to, tab };
  const { rows, count } =
    tab === "voids"
      ? await refundService.listVoids(req, { start: range.start, end: range.end }, page)
      : await refundService.listRefunds(req, { status: filters.status, start: range.start, end: range.end }, page);
  res.render("refunds/index", {
    title: "Refunds & Voids",
    breadcrumbs: crumbs(),
    tab,
    rows: rows.map((r) => r.get({ plain: true })),
    filters,
    pagination: buildPagination(req, count, page),
  });
};

const formLocals = async (req, orderId, extra = {}) => {
  await getOrder(req, orderId); // access check
  const { order, items, refundable } = await refundService.refundableState(orderId);
  const methods = await paymentMethods({ activeOnly: true });
  return {
    title: `Refund ${order.orderNumber}`,
    breadcrumbs: [{ label: "Orders", href: "/orders" }, { label: order.orderNumber, href: `/orders/${order.id}` }, { label: "Refund" }],
    order: order.get({ plain: true }),
    items,
    refundable: fromCents(refundable),
    methods,
    originalMethodIds: order.payments.map((p) => p.paymentMethodId),
    form: { refundType: "PARTIAL", restock: true, ...extra.form },
    ...extra,
  };
};

export const newForm = async (req, res) => {
  res.render("refunds/new", await formLocals(req, req.query.orderId));
};

export const create = async (req, res) => {
  const refund = await handleForm(res, () => refundService.requestRefund(req, req.body.orderId, req.body), {
    view: "refunds/new",
    locals: () => formLocals(req, req.body.orderId, { form: req.body }),
  });
  if (!refund) return;
  req.flash("success_msg", `Refund ${refund.refundNumber} for ${refund.amount} was requested and awaits supervisor approval.`);
  res.redirect(`/refunds/${refund.id}`);
};

export const show = async (req, res) => {
  const refund = (await refundService.getRefund(req, req.params.id)).get({ plain: true });
  const isRequester = refund.requestedBy === req.user.id;
  const receipt = (await getOrder(req, refund.orderId)).receipts.find((r) => r.refundId === refund.id);
  res.render("refunds/show", {
    title: `Refund ${refund.refundNumber}`,
    breadcrumbs: crumbs(refund.refundNumber),
    refund,
    receipt,
    canDecide: can(req, "refunds.approve") && !isRequester && ["REQUESTED", "FAILED"].includes(refund.status),
    needsReference: refund.settlementType === "DIRECT_PAYMENT" && !refund.paymentId && refund.refundMethod && !refund.refundMethod.isCash,
  });
};

export const approve = async (req, res) => {
  const refund = await refundService.approveAndProcess(req, req.params.id, req.body);
  req.flash("success_msg", `Refund ${refund.refundNumber} was approved and processed.`);
  res.redirect(`/refunds/${refund.id}`);
};

export const reject = async (req, res) => {
  const refund = await refundService.rejectRefund(req, req.params.id, req.body);
  req.flash("success_msg", `Refund ${refund.refundNumber} was rejected.`);
  res.redirect(`/refunds/${refund.id}`);
};
