import { PaymentMethod, User } from "../models/index.js";
import { PAYMENT_STATUSES } from "../models/salesModel.js";
import * as paymentService from "../services/paymentService.js";
import * as orderService from "../services/orderService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { can } from "../middleware/auth.js";

// POST /api/orders/:id/payments
export const apiPay = async (req, res) => {
  const result = await paymentService.processPayment(req, req.params.id, req.body);
  const order = orderService.toDto(await orderService.getOrder(req, req.params.id));
  const payment = result.payment.get({ plain: true });
  if (result.declined) {
    return res.status(402).json({ ok: false, error: result.reason, code: "PAYMENT_DECLINED", order, payment });
  }
  res.json({ ok: true, order, payment, receiptId: result.receipt?.id ?? null, duplicate: Boolean(result.duplicate) });
};

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const range = parseDateRange(req.query, 0);
  const filters = { ...filtersFrom(req.query, ["search", "outletId", "methodId", "status", "cashierId"]), from: range.from, to: range.to };
  const { rows, count } = await paymentService.listPayments(req, { ...filters, start: range.start, end: range.end }, page);
  res.render("payments/index", {
    title: "Payments",
    breadcrumbs: [{ label: "Payments" }],
    payments: rows.map((p) => p.get({ plain: true })),
    filters,
    outlets: req.outlets,
    methods: (await PaymentMethod.findAll({ order: [["sortOrder", "ASC"]] })).map((m) => m.get({ plain: true })),
    statuses: PAYMENT_STATUSES,
    cashiers: (await User.findAll({ attributes: ["id", "fullName"], order: [["fullName", "ASC"]] })).map((u) => u.get({ plain: true })),
    canVerify: can(req, "payments.process"),
    pagination: buildPagination(req, count, page),
  });
};

export const verify = async (req, res) => {
  const result = await paymentService.verifyPayment(req, req.params.id);
  if (result.done) req.flash("success_msg", `Payment ${result.payment.paymentNumber} was confirmed by the provider.`);
  else if (result.declined) req.flash("error_msg", `Payment ${result.payment.paymentNumber} failed: ${result.reason}`);
  else req.flash("success_msg", `Payment ${result.payment.paymentNumber} is ${result.payment.status.toLowerCase()}.`);
  res.redirect(req.get("referer")?.includes("/payments") ? req.get("referer") : "/payments");
};
