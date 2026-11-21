import { staffOptions, paymentMethods } from "../services/lookupService.js";
import { PAYMENT_STATUSES } from "../models/salesModel.js";
import * as paymentService from "../services/paymentService.js";
import * as orderService from "../services/orderService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { can } from "../middleware/auth.js";
import { backUrl, AppError } from "../utils/http.js";
import { config } from "../config/env.js";
import QRCode from "qrcode";

// A decline is an error response that also carries the updated order and payment, so the
// caller can show the balance without another request. A replayed key returns the same shape.
// A hosted e-wallet checkout answers 202 with `checkout`: show its QR code to the guest and
// poll POST /api/payments/:id/verify until the payment is captured or declined.
const sendResult = async (req, res, result, { cancelling = false } = {}) => {
  const order = orderService.toDto(await orderService.getOrder(req, result.payment.orderId));
  const payment = result.payment.get({ plain: true });
  const duplicate = Boolean(result.duplicate);
  if (cancelling && payment.status === "FAILED") return res.json({ ok: true, cancelled: true, order, payment });
  if (result.declined) {
    return res.status(402).json({ ok: false, error: result.reason, code: "PAYMENT_DECLINED", order, payment, duplicate, requestId: req.id });
  }
  if (result.awaiting) {
    const checkout = payment.checkoutUrl
      ? { url: payment.checkoutUrl, qrCodeUrl: `/api/payments/${payment.id}/qr.svg`, expiresAt: payment.checkoutExpiresAt, processing: Boolean(result.processing) }
      : null;
    return res.status(202).json({ ok: true, awaiting: true, order, payment, checkout, duplicate });
  }
  res.json({ ok: true, order, payment, receiptId: result.receipt?.id ?? null, duplicate });
};

// POST /api/orders/:id/payments
export const apiPay = async (req, res) => sendResult(req, res, await paymentService.processPayment(req, req.params.id, req.body));

// POST /api/payments/:id/verify
export const apiVerify = async (req, res) => sendResult(req, res, await paymentService.verifyPayment(req, req.params.id));

// POST /api/payments/:id/cancel: 200 with cancelled, or the capture if the guest had already paid.
export const apiCancel = async (req, res) => sendResult(req, res, await paymentService.cancelPayment(req, req.params.id), { cancelling: true });

// GET /api/payments/:id/qr.svg: the checkout link of a pending e-wallet payment as a QR code.
export const qrCode = async (req, res) => {
  const payment = await paymentService.getPayment(req, req.params.id);
  if (payment.status !== "PENDING" || !payment.checkoutUrl) throw new AppError("This payment has no open checkout.", 404, "NOT_FOUND");
  res.type("image/svg+xml").set("Cache-Control", "no-store").send(await QRCode.toString(payment.checkoutUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }));
};

// POST /webhooks/paymongo (public; authenticated by the Paymongo-Signature HMAC)
// Always answers JSON: a non-2xx makes PayMongo retry the event later.
export const webhook = async (req, res) => {
  try {
    const result = await paymentService.handleWebhook(req.rawBody ?? "", req.get("paymongo-signature"));
    res.json({ ok: true, ignored: Boolean(result.ignored) });
  } catch (err) {
    if (!(err instanceof AppError)) console.error(`❌ PayMongo webhook failed [${req.id || "-"}]:`, err);
    res.status(err instanceof AppError ? err.status : 500).json({ ok: false, error: err instanceof AppError ? err.message : "Webhook processing failed.", code: err.code, requestId: req.id });
  }
};

// GET /pay/complete: where the guest's phone lands after approving (PAYMENT_RETURN_URL).
export const complete = (req, res) => res.render("payments/complete", { layout: false, appName: config.appName });

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
    methods: await paymentMethods(),
    statuses: PAYMENT_STATUSES,
    cashiers: await staffOptions(),
    canVerify: can(req, "payments.process"),
    pagination: buildPagination(req, count, page),
  });
};

export const verify = async (req, res) => {
  const result = await paymentService.verifyPayment(req, req.params.id);
  if (result.done) req.flash("success_msg", `Payment ${result.payment.paymentNumber} was confirmed by the provider.`);
  else if (result.declined) req.flash("error_msg", `Payment ${result.payment.paymentNumber} failed: ${result.reason}`);
  else if (result.awaiting) req.flash("warning_msg", `Payment ${result.payment.paymentNumber} is still waiting for the guest to approve it in their e-wallet.`);
  else req.flash("warning_msg", `Payment ${result.payment.paymentNumber} is still ${result.payment.status.toLowerCase()}. Check it again shortly.`);
  res.redirect(backUrl(req, "/payments"));
};

export const cancel = async (req, res) => {
  const result = await paymentService.cancelPayment(req, req.params.id);
  if (result.done) req.flash("success_msg", `Payment ${result.payment.paymentNumber} had already been paid, so it was recorded instead of cancelled.`);
  else req.flash("success_msg", `Payment ${result.payment.paymentNumber} was cancelled. The order is awaiting settlement again.`);
  res.redirect(backUrl(req, "/payments"));
};
