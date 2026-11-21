// PayMongo adapter: GCash and Maya through PayMongo's Payment Intent workflow.
//   POST /payment_intents             (Idempotency-Key = HotelPOS payment key)
//   POST /payment_methods             type "gcash" | "paymaya"
//   POST /payment_intents/{id}/attach -> next_action.redirect.url: the guest's checkout
//   GET  /payment_intents/{id}        status checks (the POS polls; webhooks only trigger one)
//   POST /payment_intents/{id}/cancel, POST /refunds
// E-wallets are approved by the guest on their phone, so authorizeAndCapture() returns
// AWAITING_CUSTOMER with the checkout link and the payment stays PENDING until a status check
// says succeeded (paid) or awaiting_payment_method (declined, abandoned or expired).
// Amounts are sent in centavos. Docs: https://docs.paymongo.com
import crypto from "crypto";
import { requestJson } from "../httpClient.js";
import { IntegrationError } from "../integrationLogger.js";
import { toCents, fromCents } from "../../utils/money.js";

const METHOD_TYPES = { GCASH: "gcash", MAYA: "paymaya" };
// How long PayMongo keeps an e-wallet checkout open (fixed by the provider).
const CHECKOUT_MINUTES = { GCASH: 240, MAYA: 30 };

// A 4xx answer: PayMongo refused the request, so nothing was charged.
class PayMongoRefusal extends Error {}

const errorDetail = (data, httpStatus) =>
  (data?.errors || []).map((e) => e.detail || e.code).filter(Boolean).join(" ") || `HTTP ${httpStatus}`;

export class PayMongoAdapter {
  name = "PayMongoAdapter";
  isMock = false;
  // The provider issues the reference; the cashier does not type one.
  hostedCheckout = true;

  constructor(cfg) {
    this.cfg = cfg;
    this.auth = `Basic ${Buffer.from(`${cfg.apiKey}:`).toString("base64")}`;
    this.livemode = cfg.apiKey.startsWith("sk_live_");
  }

  async call(method, path, attributes, idempotencyKey) {
    const res = await requestJson({
      baseUrl: this.cfg.baseUrl,
      timeoutMs: this.cfg.timeoutMs,
      method,
      path,
      body: attributes === undefined ? undefined : { data: { attributes } },
      headers: { Authorization: this.auth },
      idempotencyKey,
    });
    if (res.ok) return { ...res.data.data, httpStatus: res.httpStatus };
    const detail = errorDetail(res.data, res.httpStatus);
    if (res.httpStatus >= 500 || res.httpStatus === 429) {
      throw new IntegrationError("REJECTED", `PayMongo error: ${detail}`, { httpStatus: res.httpStatus, response: res.data });
    }
    const err = new PayMongoRefusal(`PayMongo: ${detail}`);
    err.httpStatus = res.httpStatus;
    throw err;
  }

  async authorizeAndCapture({ amount, currency, methodCode, idempotencyKey, description, metadata }) {
    const type = METHOD_TYPES[methodCode];
    if (!type) return { status: "DECLINED", reason: `PayMongo does not take ${methodCode} payments here.` };
    let intent;
    try {
      intent = await this.call(
        "POST",
        "payment_intents",
        { amount: toCents(amount), currency, payment_method_allowed: [type], capture_type: "automatic", description, metadata },
        idempotencyKey
      );
      const method = await this.call("POST", "payment_methods", { type }, `${idempotencyKey}:method`);
      intent = await this.call("POST", `payment_intents/${encodeURIComponent(intent.id)}/attach`, { payment_method: method.id, return_url: this.cfg.returnUrl });
    } catch (err) {
      if (err instanceof PayMongoRefusal) return { status: "DECLINED", reason: err.message, providerReference: intent?.id, httpStatus: err.httpStatus };
      throw err;
    }
    const result = this.toResult(intent);
    if (result.status === "AWAITING_CUSTOMER") result.expiresAt = new Date(Date.now() + CHECKOUT_MINUTES[methodCode] * 60000);
    return result;
  }

  // Without a payment intent id the checkout link never reached the POS, so nobody can have
  // paid it: the payment is safe to fail.
  async getStatus({ providerReference }) {
    if (!providerReference) return { status: "NOT_FOUND" };
    try {
      return this.toResult(await this.call("GET", `payment_intents/${encodeURIComponent(providerReference)}`));
    } catch (err) {
      if (err instanceof PayMongoRefusal && err.httpStatus === 404) return { status: "NOT_FOUND", httpStatus: 404 };
      if (err instanceof PayMongoRefusal) throw new IntegrationError("REJECTED", err.message, { httpStatus: err.httpStatus });
      throw err;
    }
  }

  // PayMongo refuses to cancel an intent that is processing or already paid; the current
  // status is returned instead, so a payment the guest just approved is never lost.
  async cancel({ providerReference }) {
    if (!providerReference) return { status: "DECLINED", reason: "Cancelled at the POS." };
    try {
      const intent = await this.call("POST", `payment_intents/${encodeURIComponent(providerReference)}/cancel`, undefined);
      return { ...this.toResult(intent), status: "DECLINED", reason: "Cancelled at the POS.", cancelled: true };
    } catch (err) {
      if (!(err instanceof PayMongoRefusal)) throw err;
      const current = await this.getStatus({ providerReference });
      return current.status === "DECLINED" ? { ...current, reason: "Cancelled at the POS.", cancelled: true } : current;
    }
  }

  async refund({ transactionId, amount, idempotencyKey }) {
    try {
      const refund = await this.call(
        "POST",
        "refunds",
        { amount: toCents(amount), payment_id: transactionId, reason: "requested_by_customer" },
        idempotencyKey
      );
      if (refund.attributes?.status === "failed") return { status: "REJECTED", reason: "PayMongo could not refund the payment.", httpStatus: refund.httpStatus };
      return { status: "REFUNDED", refundId: refund.id, transactionId, amount, providerStatus: refund.attributes?.status, httpStatus: refund.httpStatus };
    } catch (err) {
      if (err instanceof PayMongoRefusal) return { status: "REJECTED", reason: err.message, httpStatus: err.httpStatus };
      throw err;
    }
  }

  toResult(intent) {
    const a = intent.attributes || {};
    const base = { providerReference: intent.id, providerStatus: a.status, httpStatus: intent.httpStatus };
    switch (a.status) {
      case "succeeded": {
        const paid = (a.payments || []).find((p) => p.attributes?.status === "paid") || (a.payments || [])[0];
        const amount = paid?.attributes?.amount ?? a.amount;
        return { ...base, status: "CAPTURED", transactionId: paid?.id ?? intent.id, amount: amount === undefined ? undefined : fromCents(amount) };
      }
      case "awaiting_next_action":
        return { ...base, status: "AWAITING_CUSTOMER", checkoutUrl: a.next_action?.redirect?.url ?? null };
      case "processing":
        return { ...base, status: "AWAITING_CUSTOMER", processing: true };
      case "awaiting_payment_method":
        return { ...base, status: "DECLINED", reason: a.last_payment_error?.failed_message || "The guest did not complete the payment, or the checkout expired." };
      case "cancelled":
        return { ...base, status: "DECLINED", reason: "The checkout was cancelled." };
      default:
        throw new IntegrationError("INVALID_RESPONSE", `Unexpected PayMongo payment intent status "${a.status}".`, { httpStatus: intent.httpStatus });
    }
  }

  // Paymongo-Signature: "t=<timestamp>,te=<test HMAC>,li=<live HMAC>", HMAC-SHA256 of
  // "<t>.<raw body>" with the webhook secret. The event only tells us which payment to check;
  // its outcome is always read back from the API, so a replayed event changes nothing.
  parseWebhook(rawBody, signatureHeader) {
    if (!this.cfg.webhookSecret) throw new IntegrationError("NOT_CONFIGURED", "PAYMENT_WEBHOOK_SECRET is not set.");
    const parts = Object.fromEntries(String(signatureHeader || "").split(",").map((p) => p.trim().split("=")));
    const signature = this.livemode ? parts.li : parts.te;
    const expected = crypto.createHmac("sha256", this.cfg.webhookSecret).update(`${parts.t}.${rawBody}`).digest("hex");
    const valid = parts.t && signature && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return null;
    const event = JSON.parse(rawBody).data || {};
    const resource = event.attributes?.data || {};
    const providerReference = resource.attributes?.payment_intent_id ?? (String(resource.id || "").startsWith("pi_") ? resource.id : null);
    return { eventId: event.id, type: event.attributes?.type, providerReference };
  }
}
