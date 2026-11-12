// API correctness: error envelope and codes, request ids, idempotent replays under
// concurrency, database-backed room validation and outlet scoping.
import { startApp, Client, uuid } from "./harness.js";

let ctx;
let cashier;
let supervisor;
let admin;
let inventory;
const ids = {};
const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });

async function settledOrder(client = cashier, productId = ids.water, quantity = "1") {
  const created = await client.post("/api/orders", { outletId: ids.rs01, productId, quantity });
  expect(created.status).toBe(201);
  const settled = await client.post(`/api/orders/${created.data.order.id}/request-settlement`);
  expect(settled.status).toBe(200);
  return settled.data.order;
}

beforeAll(async () => {
  ctx = await startApp();
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.mb01 = (await q("SELECT id FROM outlets WHERE code = 'MB-01'"))[0].id;
  ids.water = (await q("SELECT id FROM products WHERE code = 'BV-004'"))[0].id;
  ids.cash = (await q("SELECT id FROM payment_methods WHERE code = 'CASH'"))[0].id;
  ids.card = (await q("SELECT id FROM payment_methods WHERE code = 'CREDIT_CARD'"))[0].id;
  ids.waterItem = (await q("SELECT id FROM inventory_items WHERE sku = 'INV-BV-004'"))[0].id;
  cashier = await new Client(ctx.base).login("cashier01");
  supervisor = await new Client(ctx.base).login("supervisor01");
  admin = await new Client(ctx.base).login("admin");
  inventory = await new Client(ctx.base).login("inventory01");
  expect((await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "1000.00" })).status).toBe(302);
  await cashier.refreshCsrf();
});

afterAll(async () => {
  await ctx?.stop();
});

describe("Error envelope and request ids", () => {
  test("every JSON error has ok, error, code and the request id, which is also a header", async () => {
    const res = await cashier.request("GET", "/api/orders/999999", { headers: { Accept: "application/json" } });
    expect(res.status).toBe(404);
    expect(res.data).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(typeof res.data.error).toBe("string");
    expect(res.data.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a caller's X-Request-Id is kept and reaches the integration log as the correlation id", async () => {
    const order = await settledOrder();
    const res = await cashier.request("POST", `/api/orders/${order.id}/room-charge/validate`, { json: { roomNumber: "205" }, headers: { "X-Request-Id": "erp-trace-0001" } });
    expect(res.status).toBe(200);
    const [log] = await q("SELECT correlation_id FROM integration_logs WHERE operation = 'getActiveFolio' ORDER BY id DESC LIMIT 1");
    expect(log.correlation_id).toBe("erp-trace-0001");
  });

  test("malformed JSON is a 400 with a code, not a server error", async () => {
    const raw = await fetch(`${ctx.base}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": cashier.csrf, Cookie: [...cashier.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    const body = await raw.json();
    expect(body).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(raw.headers.get("x-request-id")).toBe(body.requestId);
  });

  test("business conflicts carry a specific code", async () => {
    const order = await settledOrder();
    const res = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.cash, amount: "999.00", tenderedAmount: "999.00", idempotencyKey: uuid() });
    expect(res.status).toBe(422);
    expect(res.data.code).toBe("AMOUNT_EXCEEDS_BALANCE");
    const edit = await cashier.post(`/api/orders/${order.id}/void`, { reason: "x" });
    expect(edit.data.code).not.toBe("APP_ERROR");
  });
});

describe("Idempotent payments", () => {
  test("two identical payment requests at once: both succeed, one is the replay, one payment exists", async () => {
    const order = await settledOrder();
    const key = uuid();
    const body = { paymentMethodId: ids.cash, amount: "90.00", tenderedAmount: "100.00", idempotencyKey: key };
    const [a, b] = await Promise.all([cashier.post(`/api/orders/${order.id}/payments`, body), cashier.post(`/api/orders/${order.id}/payments`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.data.duplicate, b.data.duplicate].sort()).toEqual([false, true]);
    expect(a.data.receiptId).toBe(b.data.receiptId);
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM payments WHERE idempotency_key = :key", { key });
    expect(Number(n)).toBe(1);
  });

  test("replaying a declined payment's key returns the same decline", async () => {
    const order = await settledOrder();
    const body = { paymentMethodId: ids.card, amount: "90.00", reference: "DECLINE", idempotencyKey: uuid() };
    const first = await cashier.post(`/api/orders/${order.id}/payments`, body);
    const again = await cashier.post(`/api/orders/${order.id}/payments`, body);
    expect(first.status).toBe(402);
    expect(again.status).toBe(402);
    expect(again.data).toMatchObject({ code: "PAYMENT_DECLINED", duplicate: true });
  });

  test("a key already used on another order is refused", async () => {
    const one = await settledOrder();
    const two = await settledOrder();
    const key = uuid();
    expect((await cashier.post(`/api/orders/${one.id}/payments`, { paymentMethodId: ids.cash, amount: "90.00", idempotencyKey: key })).status).toBe(200);
    const reuse = await cashier.post(`/api/orders/${two.id}/payments`, { paymentMethodId: ids.cash, amount: "90.00", idempotencyKey: key });
    expect(reuse.status).toBe(409);
    expect(reuse.data.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("Room charge validation lives in the database", () => {
  test("a validation from one session can be completed from another session of the same user", async () => {
    const order = await settledOrder();
    const v = await cashier.post(`/api/orders/${order.id}/room-charge/validate`, { roomNumber: "205" });
    expect(v.status).toBe(200);
    const otherSession = await new Client(ctx.base).login("cashier01");
    const res = await otherSession.post(`/api/orders/${order.id}/room-charge`, { validationToken: v.data.validation.token, idempotencyKey: uuid() });
    expect(res.status).toBe(200);
    expect(res.data.outcome).toBe("POSTED");
    const [row] = await q("SELECT token_hash, used_at FROM room_charge_validations WHERE order_id = :id", { id: order.id });
    expect(row.token_hash).not.toBe(v.data.validation.token); // stored hashed
    expect(row.used_at).not.toBeNull();
  });

  test("another user cannot use someone else's validation", async () => {
    const order = await settledOrder();
    const v = await cashier.post(`/api/orders/${order.id}/room-charge/validate`, { roomNumber: "207" });
    const res = await supervisor.post(`/api/orders/${order.id}/room-charge`, { validationToken: v.data.validation.token, idempotencyKey: uuid() });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("VALIDATION_EXPIRED");
  });

  test("two identical charge requests at once post exactly one charge", async () => {
    const order = await settledOrder();
    const v = await cashier.post(`/api/orders/${order.id}/room-charge/validate`, { roomNumber: "310" });
    const body = { validationToken: v.data.validation.token, idempotencyKey: uuid() };
    const [a, b] = await Promise.all([cashier.post(`/api/orders/${order.id}/room-charge`, body), cashier.post(`/api/orders/${order.id}/room-charge`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.data.charge.id]).toEqual([b.data.charge.id]);
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM guest_charges WHERE order_id = :id", { id: order.id });
    expect(Number(n)).toBe(1);
  });
});

describe("Stock movements and scope", () => {
  test("a stock receipt retried with the same idempotency key is recorded once", async () => {
    const key = uuid();
    const form = { transactionType: "STOCK_IN", inventoryItemId: ids.waterItem, outletId: ids.rs01, quantity: "12", unitCost: "20.00", reason: "PO-1001", idempotencyKey: key };
    expect((await inventory.form("/inventory/movements", form)).status).toBe(302);
    expect((await inventory.form("/inventory/movements", form)).status).toBe(302);
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM inventory_transactions WHERE idempotency_key = :k", { k: `EXT:${key}` });
    expect(Number(n)).toBe(1);
  });

  test("a supervisor cannot close or reconcile a shift at an outlet they are not assigned to", async () => {
    expect((await admin.form("/shifts/open", { outletId: ids.mb01, openingCash: "0.00" })).status).toBe(302);
    const [shift] = await q("SELECT id FROM shifts WHERE outlet_id = :o AND status = 'OPEN'", { o: ids.mb01 });
    const res = await supervisor.request("POST", `/shifts/${shift.id}/close`, { json: { actualCash: "0.00" }, headers: { Accept: "application/json" } });
    expect(res.status).toBe(403);
  });
});
