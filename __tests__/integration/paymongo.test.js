// GCash and Maya through PayMongo (PAYMENT_ADAPTER=paymongo), end to end: the app talks to a
// fake PayMongo API started here, and the "guest" approves or declines on the fake side.
// Configuration is read when the app is imported, so everything is imported after the fake
// API is listening.
import http from "http";
import crypto from "crypto";

const SECRET_KEY = "sk_test_hotelpos_fake";
const WEBHOOK_SECRET = "whsk_test_hotelpos_fake";

// ── Fake PayMongo API ──────────────────────────────────────────────────────
const fake = {
  intents: new Map(),
  byKey: new Map(),
  requests: [],
  refunds: [],
  seq: 0,
  nextId(prefix) {
    return `${prefix}_${String(++this.seq).padStart(6, "0")}`;
  },
  pay(id) {
    const intent = this.intents.get(id);
    intent.attributes.status = "succeeded";
    intent.attributes.payments = [{ id: this.nextId("pay"), type: "payment", attributes: { status: "paid", amount: intent.attributes.amount } }];
    intent.attributes.next_action = null;
  },
  fail(id) {
    const intent = this.intents.get(id);
    intent.attributes.status = "awaiting_payment_method";
    intent.attributes.next_action = null;
    intent.attributes.last_payment_error = { failed_code: "payment_failed", failed_message: "The guest declined the payment in the e-wallet." };
  },
};

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const refuse = (res, status, detail) => send(res, status, { errors: [{ code: "parameter_invalid", detail }] });

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const attrs = body.data?.attributes || {};
    fake.requests.push({ method: req.method, url: req.url, headers: req.headers, attrs });
    if (req.headers.authorization !== `Basic ${Buffer.from(`${SECRET_KEY}:`).toString("base64")}`) return refuse(res, 401, "Invalid API key.");
    const key = req.headers["idempotency-key"];
    const path = req.url.replace(/^\/v1\//, "");
    let m;
    if (req.method === "POST" && path === "payment_intents") {
      if (key && fake.byKey.has(key)) return send(res, 200, { data: fake.byKey.get(key) });
      if (attrs.amount > 10000000) return refuse(res, 400, "The amount is above the maximum of 100,000.00.");
      const intent = { id: fake.nextId("pi"), type: "payment_intent", attributes: { ...attrs, status: "awaiting_payment_method", payments: [], next_action: null, last_payment_error: null } };
      fake.intents.set(intent.id, intent);
      if (key) fake.byKey.set(key, structuredClone(intent));
      return send(res, 200, { data: intent });
    }
    if (req.method === "POST" && path === "payment_methods") return send(res, 200, { data: { id: fake.nextId("pm"), type: "payment_method", attributes: { type: attrs.type } } });
    if ((m = /^payment_intents\/(pi_\w+)(\/(attach|cancel))?$/.exec(path))) {
      const intent = fake.intents.get(m[1]);
      if (!intent) return refuse(res, 404, "No such payment intent.");
      const a = intent.attributes;
      if (req.method === "GET") return send(res, 200, { data: intent });
      if (m[3] === "attach") {
        a.status = "awaiting_next_action";
        a.next_action = { type: "redirect", redirect: { url: `https://pay.paymongo.test/checkout/${intent.id}`, return_url: attrs.return_url } };
        return send(res, 200, { data: intent });
      }
      if (m[3] === "cancel") {
        if (["succeeded", "processing"].includes(a.status)) return refuse(res, 400, `Payment intent is ${a.status}.`);
        a.status = "cancelled";
        return send(res, 200, { data: intent });
      }
    }
    if (req.method === "POST" && path === "refunds") {
      const refund = { id: fake.nextId("ref"), type: "refund", attributes: { ...attrs, status: "pending" } };
      fake.refunds.push(refund);
      return send(res, 200, { data: refund });
    }
    refuse(res, 404, `Unknown route ${req.method} ${req.url}`);
  });
});

let ctx, cashier, startApp, Client, uuid;
const ids = {};
const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });
const intentRequests = () => fake.requests.filter((r) => r.method === "POST" && r.url === "/v1/payment_intents");

async function newOrder() {
  const created = await cashier.post("/api/orders", { outletId: ids.rs01, roomNumber: "205", productId: ids.water, quantity: "1" });
  expect(created.status).toBe(201);
  return (await cashier.post(`/api/orders/${created.data.order.id}/request-settlement`)).data.order;
}

const pay = (order, methodId, key = uuid()) => cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: methodId, amount: order.balanceDue, idempotencyKey: key });

function webhook(event, { secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const te = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`${ctx.base}/webhooks/paymongo`, { method: "POST", headers: { "Content-Type": "application/json", "Paymongo-Signature": `t=${t},te=${te},li=` }, body: raw });
}
const paidEvent = (intentId) => ({
  data: { id: `evt_${intentId}`, type: "event", attributes: { type: "payment.paid", livemode: false, data: { id: "pay_x", type: "payment", attributes: { payment_intent_id: intentId, status: "paid" } } } },
});

beforeAll(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    PAYMENT_ADAPTER: "paymongo",
    PAYMENT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    PAYMENT_API_KEY: SECRET_KEY,
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYMENT_RETURN_URL: "https://hotel.example/pay/complete",
  });
  ({ startApp, Client, uuid } = await import("./harness.js"));
  ctx = await startApp();
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.water = (await q("SELECT id FROM products WHERE code = 'BV-004'"))[0].id;
  ids.gcash = (await q("SELECT id FROM payment_methods WHERE code = 'GCASH'"))[0].id;
  ids.maya = (await q("SELECT id FROM payment_methods WHERE code = 'MAYA'"))[0].id;
  cashier = await new Client(ctx.base).login("cashier01");
  expect((await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "5000.00" })).status).toBe(302);
  await cashier.refreshCsrf();
}, 120000);

afterAll(async () => {
  await ctx?.stop();
  await new Promise((r) => server.close(r));
});

describe("GCash and Maya through PayMongo", () => {
  test("GCash: no typed reference, the guest scans the QR code, and the order completes once PayMongo says paid", async () => {
    const order = await newOrder();
    const key = uuid();
    const res = await pay(order, ids.gcash, key);
    expect(res.status).toBe(202);
    expect(res.data).toMatchObject({ ok: true, awaiting: true, payment: { status: "PENDING" }, order: { status: "SETTLING" } });
    expect(res.data.checkout.url).toMatch(/^https:\/\/pay\.paymongo\.test\/checkout\/pi_/);

    const [create] = intentRequests().slice(-1);
    expect(create.headers["idempotency-key"]).toBe(key);
    expect(create.attrs).toMatchObject({ amount: 9000, currency: "PHP", payment_method_allowed: ["gcash"], capture_type: "automatic" });
    expect(fake.requests.find((r) => r.url.endsWith("/attach") && r.url.includes(res.data.payment.providerReference)).attrs.return_url).toBe("https://hotel.example/pay/complete");

    const qr = await cashier.get(res.data.checkout.qrCodeUrl);
    expect(qr.status).toBe(200);
    expect(qr.text).toContain("<svg");

    // The POS reopening the order resumes the same checkout.
    const reopened = await cashier.get(`/api/orders/${order.id}`);
    expect(reopened.data.order.payments[0].checkout.url).toBe(res.data.checkout.url);

    const waiting = await cashier.post(`/api/payments/${res.data.payment.id}/verify`);
    expect(waiting.status).toBe(202);

    // Pressing Confirm again with the same key shows the same checkout, no second intent.
    const before = intentRequests().length;
    const again = await pay(order, ids.gcash, key);
    expect(again.status).toBe(202);
    expect(again.data).toMatchObject({ duplicate: true, checkout: { url: res.data.checkout.url } });
    expect(intentRequests().length).toBe(before);

    fake.pay(res.data.payment.providerReference);
    const paid = await cashier.post(`/api/payments/${res.data.payment.id}/verify`);
    expect(paid.status).toBe(200);
    expect(paid.data.order.status).toBe("COMPLETED");
    expect(paid.data.receiptId).toBeTruthy();
    const [row] = await q("SELECT status, external_transaction_id, provider_reference, is_mock, gateway FROM payments WHERE id = :id", { id: res.data.payment.id });
    expect(row).toMatchObject({ status: "CAPTURED", provider_reference: res.data.payment.providerReference, gateway: "PayMongoAdapter" });
    expect(row.external_transaction_id).toMatch(/^pay_/);
    expect(Boolean(row.is_mock)).toBe(false);
  });

  test("Maya: a payment the guest declines returns the order to awaiting settlement", async () => {
    const order = await newOrder();
    const res = await pay(order, ids.maya);
    expect(res.status).toBe(202);
    expect(intentRequests().slice(-1)[0].attrs.payment_method_allowed).toEqual(["paymaya"]);
    expect(fake.requests.filter((r) => r.url === "/v1/payment_methods").slice(-1)[0].attrs.type).toBe("paymaya");

    fake.fail(res.data.payment.providerReference);
    const declined = await cashier.post(`/api/payments/${res.data.payment.id}/verify`);
    expect(declined.status).toBe(402);
    expect(declined.data).toMatchObject({ code: "PAYMENT_DECLINED", error: "The guest declined the payment in the e-wallet.", order: { status: "AWAITING_SETTLEMENT" } });
  });

  test("PayMongo refusing the payment (over its limit) fails it at once and charges nothing", async () => {
    const order = await newOrder();
    await ctx.models.Order.update({ totalAmount: "150000.00" }, { where: { id: order.id } });
    const res = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.gcash, amount: "150000.00", idempotencyKey: uuid() });
    expect(res.status).toBe(402);
    expect(res.data.error).toContain("maximum");
    expect(res.data.order.status).toBe("AWAITING_SETTLEMENT");
  });

  test("the cashier can cancel a checkout the guest walked away from", async () => {
    const order = await newOrder();
    const res = await pay(order, ids.gcash);
    const cancelled = await cashier.post(`/api/payments/${res.data.payment.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.cancelled).toBe(true);
    expect(cancelled.data.order.status).toBe("AWAITING_SETTLEMENT");
    expect(cancelled.data.payment.status).toBe("FAILED");
    expect(fake.intents.get(res.data.payment.providerReference).attributes.status).toBe("cancelled");
    const [audit] = await q("SELECT action FROM audit_logs WHERE entity_type = 'order' AND entity_id = :id ORDER BY id DESC LIMIT 1", { id: String(order.id) });
    expect(audit.action).toBe("PAYMENT_CANCELLED");
    // The QR code is gone, and the order can be paid another way.
    expect((await cashier.get(res.data.checkout.qrCodeUrl)).status).toBe(404);
  });

  test("cancelling a checkout the guest already paid records it as paid instead", async () => {
    const order = await newOrder();
    const res = await pay(order, ids.gcash);
    fake.pay(res.data.payment.providerReference);
    const cancelled = await cashier.post(`/api/payments/${res.data.payment.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.order.status).toBe("COMPLETED");
  });

  test("a signed payment.paid webhook completes the order; a forged one changes nothing", async () => {
    const order = await newOrder();
    const res = await pay(order, ids.gcash);
    const intentId = res.data.payment.providerReference;
    fake.pay(intentId);

    const forged = await webhook(paidEvent(intentId), { secret: "whsk_wrong" });
    expect(forged.status).toBe(401);
    expect((await cashier.get(`/api/orders/${order.id}`)).data.order.status).toBe("SETTLING");

    const ok = await webhook(paidEvent(intentId));
    expect(ok.status).toBe(200);
    const after = (await cashier.get(`/api/orders/${order.id}`)).data.order;
    expect(after.status).toBe("COMPLETED");
    const [audit] = await q("SELECT user_id FROM audit_logs WHERE action = 'PAYMENT_CAPTURED' AND entity_id = :id", { id: String(order.id) });
    expect(audit.user_id).toBe(res.data.payment.processedBy); // the cashier who took it

    // A repeated delivery is acknowledged and changes nothing.
    expect((await webhook(paidEvent(intentId))).status).toBe(200);
    expect((await webhook(paidEvent("pi_unknown"))).status).toBe(200);
  });

  test("refunds go back to the PayMongo payment in centavos", async () => {
    const { PayMongoAdapter } = await import("../../integrations/payments/paymongoAdapter.js");
    const { config } = await import("../../config/env.js");
    const adapter = new PayMongoAdapter(config.integrations.payment);
    const result = await adapter.refund({ transactionId: "pay_000123", amount: "45.50", idempotencyKey: "refund-key-1" });
    expect(result).toMatchObject({ status: "REFUNDED", refundId: expect.stringMatching(/^ref_/) });
    expect(fake.refunds.slice(-1)[0].attributes).toMatchObject({ amount: 4550, payment_id: "pay_000123", reason: "requested_by_customer" });
    expect(fake.requests.slice(-1)[0].headers["idempotency-key"]).toBe("refund-key-1");
  });
});
