// Domain events: what is recorded, signed webhook delivery, ordering, retries/backoff,
// concurrent dispatchers and the pull feed.
import http from "http";
import crypto from "crypto";
import { startApp, Client, uuid } from "./harness.js";
import { publishPending, webhookPublisher, retryEvents, signWebhook, backoffMs } from "../../integrations/events/eventPublisher.js";

let ctx;
let cashier;
let admin;
const ids = {};
const SECRET = "test-webhook-secret-0123456789";
const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A local webhook receiver that records every delivery and can be told to fail.
function receiver() {
  const received = [];
  let failWith = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = failWith || 204;
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/hooks/hotelpos`,
        received,
        fail: (status) => (failWith = status),
        close: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

async function cashSale(quantity = "1") {
  const created = await cashier.post("/api/orders", { outletId: ids.rs01, productId: ids.water, quantity });
  const id = created.data.order.id;
  await cashier.post(`/api/orders/${id}/request-settlement`);
  const total = (await cashier.get(`/api/orders/${id}`)).data.order.totalAmount;
  const paid = await cashier.post(`/api/orders/${id}/payments`, { paymentMethodId: ids.cash, amount: total, tenderedAmount: total, idempotencyKey: uuid() });
  expect(paid.data.order.status).toBe("COMPLETED");
  return id;
}

beforeAll(async () => {
  ctx = await startApp();
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.water = (await q("SELECT id FROM products WHERE code = 'BV-004'"))[0].id;
  ids.salad = (await q("SELECT id FROM products WHERE code = 'FD-002'"))[0].id;
  ids.cash = (await q("SELECT id FROM payment_methods WHERE code = 'CASH'"))[0].id;
  cashier = await new Client(ctx.base).login("cashier01");
  admin = await new Client(ctx.base).login("admin");
  expect((await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "500.00" })).status).toBe(302);
  await cashier.refreshCsrf();
});

afterAll(async () => {
  await ctx?.stop();
});

describe("What is recorded", () => {
  test("a cash sale records PaymentCaptured then OrderCompleted with everything needed to post it", async () => {
    const orderId = await cashSale("2");
    const events = await q("SELECT event_type, payload, outlet_id, event_uid FROM integration_events WHERE aggregate_type = 'order' AND aggregate_id = :id ORDER BY id", { id: String(orderId) });
    expect(events.map((e) => e.event_type)).toEqual(["PaymentCaptured", "OrderCompleted"]);
    const completed = events[1].payload;
    expect(events[1].outlet_id).toBe(ids.rs01);
    expect(events[1].event_uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed).toMatchObject({ currency: "PHP", settlementType: "DIRECT_PAYMENT", totalAmount: "180.00" });
    expect(completed.lines).toHaveLength(1);
    expect(completed.lines[0]).toMatchObject({ productCode: "BV-004", quantity: "2.000", lineTotal: "180.00" });
    expect(completed.payments).toEqual([expect.objectContaining({ method: "CASH", amount: "180.00", isCash: true })]);
  });

  test("voids, shifts, price changes and stock movements are recorded", async () => {
    const created = await cashier.post("/api/orders", { outletId: ids.rs01, productId: ids.water, quantity: "1" });
    await cashier.post(`/api/orders/${created.data.order.id}/void`, { reason: "Guest left", supervisorUsername: "supervisor01", supervisorPassword: "TestPass123" });
    await admin.form(`/products/${ids.salad}/prices`, { outletId: String(ids.rs01), price: "440.00", isAvailable: "1" });
    const [item] = await q("SELECT id FROM inventory_items WHERE sku = 'INV-BV-004'");
    await admin.form("/inventory/movements", { transactionType: "WASTE", inventoryItemId: item.id, outletId: ids.rs01, quantity: "1", reason: "Broken bottle" });
    const types = (await q("SELECT DISTINCT event_type AS t FROM integration_events")).map((r) => r.t);
    expect(types).toEqual(expect.arrayContaining(["OrderVoided", "ShiftOpened", "ProductPriceChanged", "StockMovementRecorded"]));
    const [price] = await q("SELECT payload FROM integration_events WHERE event_type = 'ProductPriceChanged' ORDER BY id DESC LIMIT 1");
    expect(price.payload).toMatchObject({ productCode: "FD-002", price: "440.00", outletId: ids.rs01 });
  });
});

describe("Webhook delivery", () => {
  test("every event is POSTed once, signed, with its id as the delivery id", async () => {
    const hook = await receiver();
    try {
      const publisher = webhookPublisher({ url: hook.url, secret: SECRET });
      const result = await publishPending({ publisher, limit: 500 });
      expect(result.failed + result.dead).toBe(0);
      expect(hook.received.length).toBe(result.published);
      expect(hook.received.length).toBeGreaterThan(0);
      for (const { headers, body } of hook.received) {
        const expected = signWebhook(SECRET, headers["x-hotelpos-timestamp"], body);
        expect(headers["x-hotelpos-signature"]).toBe(`sha256=${expected}`);
        const env = JSON.parse(body);
        expect(headers["x-hotelpos-delivery"]).toBe(env.id);
        expect(headers["x-hotelpos-event"]).toBe(env.type);
        expect(env).toMatchObject({ source: "hotelpos", schemaVersion: 1 });
      }
      // Per order: the payment is delivered before the completion.
      const types = hook.received.map(({ body }) => JSON.parse(body)).filter((e) => e.aggregate.type === "order").map((e) => e.type);
      expect(types.indexOf("PaymentCaptured")).toBeLessThan(types.indexOf("OrderCompleted"));
      const [{ n }] = await q("SELECT COUNT(*) AS n FROM integration_events WHERE status <> 'PUBLISHED'");
      expect(Number(n)).toBe(0);
    } finally {
      await hook.close();
    }
  });

  test("a failing endpoint backs off, then gives up; later events of that order wait; an operator can retry", async () => {
    const hook = await receiver();
    try {
      const orderId = await cashSale();
      hook.fail(503);
      const publisher = webhookPublisher({ url: hook.url, secret: SECRET });
      const first = await publishPending({ publisher, maxAttempts: 2 });
      expect(first.failed).toBe(1); // PaymentCaptured failed; OrderCompleted held behind it
      const rows = await q("SELECT event_type, status, attempts, next_attempt_at > NOW(3) AS later FROM integration_events WHERE aggregate_id = :id ORDER BY id", { id: String(orderId) });
      expect(rows.map((r) => [r.event_type, r.status])).toEqual([["PaymentCaptured", "FAILED"], ["OrderCompleted", "PENDING"]]);
      expect(Number(rows[0].later)).toBe(1);
      expect((await publishPending({ publisher, maxAttempts: 2 })).attempted).toBe(0); // backing off

      await ctx.models.sequelize.query("UPDATE integration_events SET next_attempt_at = NULL WHERE status = 'FAILED'");
      const second = await publishPending({ publisher, maxAttempts: 2 });
      expect(second.dead).toBe(1);

      hook.fail(null);
      expect(await retryEvents({ statuses: ["DEAD"] })).toBe(1);
      // One run now delivers the retried PaymentCaptured and then the OrderCompleted behind it.
      const third = await publishPending({ publisher, maxAttempts: 2 });
      expect(third.published).toBe(2);
      const delivered = hook.received.slice(-2).map((r) => JSON.parse(r.body));
      expect(delivered.map((e) => [e.aggregate.id, e.type])).toEqual([[String(orderId), "PaymentCaptured"], [String(orderId), "OrderCompleted"]]);
    } finally {
      await hook.close();
    }
  });

  test("two dispatchers running at once never deliver an event twice", async () => {
    for (let i = 0; i < 4; i++) await cashSale();
    const hook = await receiver();
    try {
      const publisher = webhookPublisher({ url: hook.url, secret: SECRET });
      await Promise.all([publishPending({ publisher, limit: 3 }), publishPending({ publisher, limit: 3 }), publishPending({ publisher, limit: 3 })]);
      const deliveries = hook.received.map((r) => r.headers["x-hotelpos-delivery"]);
      expect(new Set(deliveries).size).toBe(deliveries.length);
    } finally {
      await hook.close();
    }
  });

  test("backoff grows exponentially up to an hour", () => {
    expect(backoffMs(1)).toBe(30000);
    expect(backoffMs(2)).toBe(60000);
    expect(backoffMs(20)).toBe(3600000);
  });
});

describe("Pull feed", () => {
  test("an ERP reads events by sequence, in order, without a broker", async () => {
    const [role] = await q("SELECT id FROM roles WHERE code = 'ERP_INTEGRATION'");
    const res = await admin.form("/integrations/api-clients", [["name", "Data warehouse"], ["roleId", String(role.id)]]);
    const key = /id="new-api-key"[^>]*value="(hpos_[^"]+)"/.exec(res.text)[1];
    const get = async (url) => {
      const r = await fetch(ctx.base + url, { headers: { Authorization: `Bearer ${key}` } });
      return { status: r.status, data: await r.json() };
    };
    await sleep(3200); // events settle before they appear in the feed
    const page1 = await get("/api/v1/events?after=0&limit=2");
    expect(page1.status).toBe(200);
    expect(page1.data.events).toHaveLength(2);
    expect(page1.data.hasMore).toBe(true);
    expect(page1.data.events[0].sequence).toBeLessThan(page1.data.events[1].sequence);
    const page2 = await get(`/api/v1/events?after=${page1.data.nextAfter}&limit=500`);
    expect(page2.data.events[0].sequence).toBeGreaterThan(page1.data.nextAfter);
    const end = await get(`/api/v1/events?after=${page2.data.nextAfter}`);
    expect(end.data.events).toEqual([]);
    const completed = await get("/api/v1/events?type=OrderCompleted&limit=500");
    expect(completed.data.events.every((e) => e.type === "OrderCompleted")).toBe(true);
    expect((await get("/api/v1/events?after=-1")).status).toBe(422);
  });

  test("the feed needs integrations.view", async () => {
    const res = await cashier.get("/api/v1/events");
    expect(res.status).toBe(403);
  });
});

test("envelope ids are UUIDs and unique", async () => {
  const rows = await q("SELECT event_uid FROM integration_events");
  expect(new Set(rows.map((r) => r.event_uid)).size).toBe(rows.length);
  expect(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.event_uid))).toBe(true);
  expect(crypto.randomUUID).toBeDefined();
});
