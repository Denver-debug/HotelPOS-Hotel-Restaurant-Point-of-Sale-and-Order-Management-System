// Charge to Room with the Frontdesk / PMS (PMS_ADAPTER=frontdesk), against a fake Frontdesk
// that follows POS_ORDERS.docx: in-house lookup, POST /pos/orders queued for front-desk review,
// review status lookup, signed requests, and the signed PosOrderReviewed webhook.
import crypto from "crypto";
import http from "http";
import { startApp, SETUP_TIMEOUT_MS, Client, uuid } from "./harness.js";
import { setPmsGateway } from "../../integrations/pms/pmsGateway.js";
import { FrontdeskPmsAdapter } from "../../integrations/pms/frontdeskPmsAdapter.js";
import { reconcileAwaitingReview } from "../../services/guestChargeService.js";
import { config } from "../../config/env.js";

const API_KEY = "pos-key-for-tests-0123456789";
const INBOUND_SECRET = "inbound-secret-for-tests-0123";
const WEBHOOK_SECRET = "webhook-secret-for-tests-0123";

const cents = (n) => Math.round(Number(n) * 100);

// ── Fake Frontdesk ───────────────────────────────────────────────────────────
const fake = { requests: [], orders: new Map(), nextError: null };
let fakeServer;

function startFakeFrontdesk() {
  let seq = 30;
  const reply = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message) => reply(res, status, { success: false, error: { code, message } });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const url = new URL(req.url, "http://fake");
        fake.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: raw ? JSON.parse(raw) : null });
        if (req.headers.authorization !== `Bearer ${API_KEY}`) return fail(res, 401, "INVALID_API_KEY", "Invalid API key.");

        if (req.method === "GET" && url.pathname === "/api/v1/integrations/pos/in-house") {
          const room = url.searchParams.get("room_number");
          if (room === "204") {
            return reply(res, 200, { success: true, data: { reservation_id: 7, reservation_code: "RSV-0007", stay_id: 5, room_number: "204", guest_display_name: "J. Doe", checked_in_at: "2026-11-20T06:00:00.000Z", expected_check_out_date: "2026-11-30", folio_open: true } });
          }
          if (room === "210") {
            return reply(res, 200, { success: true, data: { reservation_id: 8, reservation_code: "RSV-0008", stay_id: 6, room_number: "210", guest_display_name: "A. Lee", folio_open: false } });
          }
          return fail(res, 404, "NO_IN_HOUSE_GUEST", `Room ${room} has no checked-in guest.`);
        }

        if (req.method === "POST" && url.pathname === "/api/v1/integrations/pos/orders") {
          const ts = req.headers["x-timestamp"];
          const expected = "sha256=" + crypto.createHmac("sha256", INBOUND_SECRET).update(`${ts}.${raw}`).digest("hex");
          if (req.headers["x-signature"] !== expected) return fail(res, 401, "INVALID_SIGNATURE", "Bad signature.");
          if (!/^[A-Za-z0-9._:-]{8,100}$/.test(req.headers["idempotency-key"] || "")) return fail(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key required.");
          if (fake.nextError) {
            const e = fake.nextError;
            fake.nextError = null;
            return fail(res, e.status, e.code, e.message);
          }
          const b = JSON.parse(raw);
          const sub = b.items.reduce((s, i) => s + i.quantity * cents(i.unit_price), 0);
          if (sub !== cents(b.subtotal) || cents(b.subtotal) + cents(b.service_charge) + cents(b.tax) - cents(b.discount) !== cents(b.total)) {
            return fail(res, 422, "VALIDATION_ERROR", "Amounts do not add up.");
          }
          if (!b.items.every((i) => Number.isInteger(i.quantity))) return fail(res, 422, "VALIDATION_ERROR", "Whole quantities only.");
          const key = `${b.restaurant_id}/${b.external_order_id}`;
          const existing = fake.orders.get(key);
          if (b.order_status === "VOIDED") {
            if (!existing) return fail(res, 422, "VALIDATION_ERROR", "Unknown order voided.");
            if (existing.status === "PENDING_REVIEW") existing.status = "REJECTED";
            existing.voided = true;
            return reply(res, 200, { success: true, data: existing });
          }
          if (existing) return reply(res, 200, { success: true, data: { ...existing, duplicate: true } });
          const order = { order_ref: `PO-0000${++seq}`, restaurant_id: b.restaurant_id, external_order_id: b.external_order_id, status: "PENDING_REVIEW", verification_reasons: [], total: b.total, charge_id: null, rejection_reason: null, body: b };
          fake.orders.set(key, order);
          return reply(res, 202, { success: true, data: order });
        }

        const m = /^\/api\/v1\/integrations\/pos\/orders\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && m) {
          const order = fake.orders.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
          return order ? reply(res, 200, { success: true, data: order }) : fail(res, 404, "NOT_FOUND", "Order not found.");
        }
        fail(res, 404, "NOT_FOUND", "No such endpoint.");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ── App under test ───────────────────────────────────────────────────────────
let ctx;
let cashier;
let supervisor;
const ids = {};
const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });
const chargeOf = async (orderId) => (await q("SELECT * FROM guest_charges WHERE order_id = :id ORDER BY id DESC", { id: orderId }))[0];

async function newOrder() {
  const created = await cashier.post("/api/orders", { outletId: ids.rs01, roomNumber: "204", productId: ids.sandwich, quantity: "1" });
  expect(created.status).toBe(201);
  let order = (await cashier.post(`/api/orders/${created.data.order.id}/items`, { productId: ids.icedTea, quantity: "2" })).data.order;
  order = (await cashier.post(`/api/orders/${order.id}/request-settlement`)).data.order;
  return order;
}

async function chargeRoom(orderId, room = "204") {
  const v = await cashier.post(`/api/orders/${orderId}/room-charge/validate`, { roomNumber: room });
  if (v.status !== 200) return { validation: v };
  const res = await cashier.post(`/api/orders/${orderId}/room-charge`, { validationToken: v.data.validation.token, idempotencyKey: uuid() });
  return { validation: v, res };
}

async function sendWebhook(event, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const signature = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const res = await fetch(`${ctx.base}/webhooks/pms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PMS-Event": event.event, "X-PMS-Timestamp": String(timestamp), "X-PMS-Signature": signature },
    body: raw,
  });
  return { status: res.status, data: await res.json() };
}

const reviewed = (charge, status, extra = {}) => ({
  event: "PosOrderReviewed", event_id: `EVT-${uuid()}`, occurred_at: new Date().toISOString(),
  order_ref: charge.pms_transaction_id, restaurant_id: "RS-01", external_order_id: charge.charge_number,
  status, reservation_id: 7, reservation_code: "RSV-0007", room_number: "204", amount: Number(charge.amount), currency: "PHP", ...extra,
});

beforeAll(async () => {
  fakeServer = await startFakeFrontdesk();
  ctx = await startApp();
  const { port } = fakeServer.address();
  setPmsGateway(new FrontdeskPmsAdapter({ baseUrl: `http://127.0.0.1:${port}/api/v1/integrations`, apiKey: API_KEY, inboundSecret: INBOUND_SECRET, timeoutMs: 5000 }));
  config.integrations.pms.webhookSecret = WEBHOOK_SECRET;

  const product = async (code) => (await q("SELECT id FROM products WHERE code = :code", { code }))[0].id;
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.sandwich = await product("FD-001");
  ids.icedTea = await product("BV-001");
  cashier = await new Client(ctx.base).login("cashier01");
  supervisor = await new Client(ctx.base).login("supervisor01");
  expect((await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "5000.00" })).status).toBe(302);
  await cashier.refreshCsrf();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  config.integrations.pms.webhookSecret = "";
  await ctx?.stop();
  await new Promise((r) => fakeServer.close(r));
});

describe("Frontdesk: charge to room is reviewed by the front desk", () => {
  test("the room is looked up in-house and the order is sent, signed, for review", async () => {
    const order = await newOrder();
    const { validation, res } = await chargeRoom(order.id);
    expect(validation.data.validation).toMatchObject({ roomNumber: "204", guestName: "J. Doe", folioId: "RSV-0007" });
    expect(res.status).toBe(200);
    expect(res.data.outcome).toBe("SUBMITTED");
    expect(res.data.order.status).toBe("COMPLETED"); // the guest has left; the bill is settled at checkout
    expect(res.data.message).toMatch(/front desk/);

    const charge = await chargeOf(order.id);
    expect(charge).toMatchObject({ status: "AWAITING_REVIEW", external_folio_id: "RSV-0007", external_guest_id: "7", external_room_id: "5" });
    expect(charge.pms_transaction_id).toMatch(/^PO-/);

    const sent = fake.requests.filter((r) => r.method === "POST").at(-1);
    expect(sent.headers["idempotency-key"]).toBe(`pos-RS-01-${charge.charge_number}-COMPLETED`);
    expect(sent.body).toMatchObject({
      external_order_id: charge.charge_number, restaurant_id: "RS-01", reservation_code: "RSV-0007", reservation_id: 7, room_number: "204",
      currency: "PHP", payment_status: "CHARGE_TO_ROOM", order_status: "COMPLETED", total: Number(order.totalAmount),
    });
    expect(sent.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ sku: "BV-001", quantity: 2 })]));
    expect(sent.body).not.toHaveProperty("customer_name"); // the guest's name is never sent or stored

    const [receipt] = await q("SELECT id, receipt_type FROM receipts WHERE order_id = :id", { id: order.id });
    expect(receipt.receipt_type).toBe("ROOM_CHARGE");
    const page = await cashier.get(`/receipts/${receipt.id}`);
    expect(page.text).toContain("CHARGED TO ROOM 204");
    expect(page.text).toContain("Sent to the front desk");
    ids.reviewedOrder = order.id;
  });

  test("a signed PosOrderReviewed ADDED_TO_FOLIO posts the charge; a re-delivery changes nothing", async () => {
    const charge = await chargeOf(ids.reviewedOrder);
    const event = reviewed(charge, "ADDED_TO_FOLIO", { charge_id: 41 });
    expect((await sendWebhook(event)).status).toBe(200);
    const posted = await chargeOf(ids.reviewedOrder);
    expect(posted.status).toBe("POSTED");
    expect(posted.posted_at).not.toBeNull();

    expect((await sendWebhook(reviewed(charge, "REJECTED", { rejection_reason: "late" }))).status).toBe(200);
    expect((await chargeOf(ids.reviewedOrder)).status).toBe("POSTED");
    const [events] = await q("SELECT COUNT(*) AS n FROM integration_events WHERE event_type = 'RoomChargePosted' AND aggregate_id = :id", { id: String(ids.reviewedOrder) });
    expect(Number(events.n)).toBe(1);
  });

  test("webhooks with a wrong signature or an old timestamp are refused", async () => {
    const charge = await chargeOf(ids.reviewedOrder);
    expect((await sendWebhook(reviewed(charge, "REJECTED"), { secret: "wrong-secret-0123456789" })).status).toBe(401);
    expect((await sendWebhook(reviewed(charge, "REJECTED"), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await sendWebhook({ event: "GuestCheckedIn", event_id: "EVT-1", room_number: "204" })).data.ignored).toBe(true);
  });

  test("a rejection found by polling marks the charge REJECTED so the cashier collects directly", async () => {
    const order = await newOrder();
    await chargeRoom(order.id);
    const charge = await chargeOf(order.id);
    const remote = fake.orders.get(`RS-01/${charge.charge_number}`);
    remote.status = "REJECTED";
    remote.rejection_reason = "Guest says this is not their order";

    // Polling skips charges sent in the last minute (the webhook usually arrives first).
    expect(await reconcileAwaitingReview()).toMatchObject({ reviewed: 0 });
    await ctx.models.sequelize.query("UPDATE guest_charges SET updated_at = NOW() - INTERVAL 5 MINUTE WHERE id = :id", { replacements: { id: charge.id } });
    expect(await reconcileAwaitingReview()).toMatchObject({ reviewed: 1 });
    const rejected = await chargeOf(order.id);
    expect(rejected).toMatchObject({ status: "REJECTED", last_error: "Guest says this is not their order" });
    const page = await cashier.get(`/guest-charges/${rejected.id}`);
    expect(page.text).toContain("Collect");
  });

  test("Check status with PMS picks up the review on demand", async () => {
    const order = await newOrder();
    await chargeRoom(order.id);
    const charge = await chargeOf(order.id);
    fake.orders.get(`RS-01/${charge.charge_number}`).status = "ADDED_TO_FOLIO";
    const res = await cashier.post(`/api/guest-charges/${charge.id}/verify`);
    expect(res.data.outcome).toBe("POSTED");
  });

  test("a full refund before review voids the order at the Frontdesk with the same content", async () => {
    const order = await newOrder();
    await chargeRoom(order.id);
    const charge = await chargeOf(order.id);
    await cashier.form("/refunds", { orderId: order.id, refundType: "FULL", reason: "Wrong room service order" });
    const [refund] = await q("SELECT id FROM refunds ORDER BY id DESC LIMIT 1");
    await supervisor.form(`/refunds/${refund.id}/approve`, {});

    const [row] = await q("SELECT r.status, g.status AS charge_status, o.status AS order_status FROM refunds r JOIN guest_charges g ON g.id = r.guest_charge_id JOIN orders o ON o.id = r.order_id WHERE r.id = :id", { id: refund.id });
    expect(row).toMatchObject({ status: "PROCESSED", charge_status: "REVERSED", order_status: "REFUNDED" });
    const posts = fake.requests.filter((r) => r.method === "POST" && r.body.external_order_id === charge.charge_number);
    expect(posts.map((p) => p.body.order_status)).toEqual(["COMPLETED", "VOIDED"]);
    const { order_status: a, ...completed } = posts[0].body;
    const { order_status: b, ...voided } = posts[1].body;
    expect(voided).toEqual(completed);
    expect(fake.orders.get(`RS-01/${charge.charge_number}`).status).toBe("REJECTED");
  });

  test("a Frontdesk validation error fails the charge and the cashier can settle another way", async () => {
    const order = await newOrder();
    fake.nextError = { status: 409, code: "ORDER_CONFLICT", message: "Order was sent before with other content." };
    const { res } = await chargeRoom(order.id);
    expect(res.data.outcome).toBe("FAILED");
    expect(res.data.message).toContain("ORDER_CONFLICT");
    expect(res.data.order.status).toBe("CHARGE_FAILED");
  });

  test("a room without a checked-in guest or with a closed folio cannot be charged", async () => {
    const order = await newOrder();
    expect((await chargeRoom(order.id, "999")).validation.data.code).toBe("ROOM_VACANT");
    expect((await chargeRoom(order.id, "210")).validation.data.code).toBe("NO_ACTIVE_FOLIO");
  });
});
