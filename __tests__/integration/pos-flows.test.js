// End-to-end scenarios from the development plan (Phase 6 A–F), run over HTTP
// against a freshly migrated and seeded HotelPOS_test database.
import { startApp, SETUP_TIMEOUT_MS, Client, uuid } from "./harness.js";
import { setPmsGateway, getPmsGateway } from "../../integrations/pms/pmsGateway.js";
import { IntegrationError } from "../../integrations/integrationLogger.js";

let ctx;
let cashier;
let supervisor;
let admin;
const ids = {};

const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });
const stockOf = async (sku, outletCode = "RS-01") => {
  const [row] = await q(
    `SELECT sl.quantity FROM stock_levels sl JOIN stock_locations l ON l.id = sl.stock_location_id
       JOIN outlets o ON o.id = l.outlet_id JOIN inventory_items i ON i.id = sl.inventory_item_id
      WHERE i.sku = :sku AND o.code = :outletCode`,
    { sku, outletCode }
  );
  return Number(row.quantity);
};

async function newOrder(lines, { settle = true } = {}) {
  const [first, ...rest] = lines;
  const created = await cashier.post("/api/orders", { outletId: ids.rs01, roomNumber: "205", productId: first[0], quantity: String(first[1]) });
  expect(created.status).toBe(201);
  let order = created.data.order;
  for (const [productId, qty] of rest) order = (await cashier.post(`/api/orders/${order.id}/items`, { productId, quantity: String(qty) })).data.order;
  if (settle) order = (await cashier.post(`/api/orders/${order.id}/request-settlement`)).data.order;
  return order;
}

async function chargeRoom(orderId, room, key = uuid()) {
  const v = await cashier.post(`/api/orders/${orderId}/room-charge/validate`, { roomNumber: room });
  if (v.status !== 200) return { validation: v };
  const res = await cashier.post(`/api/orders/${orderId}/room-charge`, { validationToken: v.data.validation.token, idempotencyKey: key });
  return { validation: v, res, key };
}

beforeAll(async () => {
  ctx = await startApp();
  const product = async (code) => (await q("SELECT id FROM products WHERE code = :code", { code }))[0].id;
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.bar01 = (await q("SELECT id FROM outlets WHERE code = 'BAR-01'"))[0].id;
  ids.rest01 = (await q("SELECT id FROM outlets WHERE code = 'REST-01'"))[0].id;
  ids.sandwich = await product("FD-001");
  ids.icedTea = await product("BV-001");
  ids.water = await product("BV-004");
  ids.salad = await product("FD-002");
  ids.cash = (await q("SELECT id FROM payment_methods WHERE code = 'CASH'"))[0].id;
  ids.gcash = (await q("SELECT id FROM payment_methods WHERE code = 'GCASH'"))[0].id;

  cashier = await new Client(ctx.base).login("cashier01");
  supervisor = await new Client(ctx.base).login("supervisor01");
  admin = await new Client(ctx.base).login("admin");
  const opened = await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "5000.00" });
  expect(opened.status).toBe(302);
  await cashier.refreshCsrf();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await ctx?.stop();
});

describe("B. Room charging (Room 205 scenario, Figures 5, 12, 16)", () => {
  test("charges a valid occupied room, stores the PMS reference and prints CHARGED TO ROOM", async () => {
    expect(await stockOf("INV-BV-001")).toBe(40);
    const order = await newOrder([[ids.sandwich, 1], [ids.icedTea, 2]]);
    expect(order.totalAmount).toBe("850.00"); // TC-02

    const { validation, res } = await chargeRoom(order.id, "205");
    expect(validation.data.validation).toMatchObject({ roomNumber: "205", guestName: "J. Tan", folioId: "F-88213" });
    expect(res.status).toBe(200);
    expect(res.data.outcome).toBe("POSTED");
    expect(res.data.order.status).toBe("COMPLETED");
    expect(res.data.charge.pmsTransactionId).toBe("PMS-TX-77120"); // TC-05

    const [charge] = await q("SELECT * FROM guest_charges WHERE order_id = :id", { id: order.id });
    expect(charge).toMatchObject({ status: "POSTED", external_folio_id: "F-88213", external_guest_id: "G-1001", room_number: "205" });
    expect(await stockOf("INV-BV-001")).toBe(38); // Figure 16: D5 Iced Tea 40 -> 38

    const [receipt] = await q("SELECT id, receipt_type FROM receipts WHERE order_id = :id", { id: order.id });
    expect(receipt.receipt_type).toBe("ROOM_CHARGE");
    const page = await cashier.get(`/receipts/${receipt.id}`);
    expect(page.text).toContain("CHARGED TO ROOM 205");
    expect(page.text).toContain("PMS-TX-77120");
    ids.room205Order = order.id;
  });

  test("TC-09: HotelPOS stores no PMS master data (only external references)", async () => {
    const tables = await q("SELECT LOWER(table_name) AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    const names = tables.map((r) => r.t);
    for (const forbidden of ["guests", "rooms", "reservations", "folios", "employees"]) expect(names).not.toContain(forbidden);
    const cols = await q("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'guest_charges'");
    expect(cols.map((r) => r.c)).not.toContain("guest_name");
  });
});

describe("C. Invalid room charging", () => {
  let orderId;
  beforeAll(async () => {
    orderId = (await newOrder([[ids.water, 1]])).id;
  });

  test.each([
    ["999", "ROOM_NOT_FOUND"],
    ["101", "ROOM_VACANT"],
    ["102", "NO_ACTIVE_FOLIO"],
    ["103", "NOT_ELIGIBLE"],
  ])("room %s is refused with %s and nothing is charged", async (room, code) => {
    const { validation } = await chargeRoom(orderId, room);
    expect(validation.status).toBe(422);
    expect(validation.data.code).toBe(code);
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM guest_charges WHERE order_id = :orderId", { orderId });
    expect(Number(n)).toBe(0);
  });

  test("a PMS rejection fails the charge and the order can still be paid directly", async () => {
    const { res } = await chargeRoom(orderId, "404");
    expect(res.data.outcome).toBe("FAILED");
    expect(res.data.order.status).toBe("CHARGE_FAILED");
    const pay = await cashier.post(`/api/orders/${orderId}/payments`, { paymentMethodId: ids.cash, amount: "90.00", tenderedAmount: "100.00", idempotencyKey: uuid() });
    expect(pay.data.order.status).toBe("COMPLETED");
    expect(pay.data.payment.changeAmount).toBe("10.00");
  });

  test("a timeout is never blindly retried: duplicate submit is idempotent and verify resolves it", async () => {
    const order = await newOrder([[ids.water, 1]]);
    const { res, validation, key } = await chargeRoom(order.id, "306");
    expect(res.data.outcome).toBe("UNKNOWN");
    expect(res.data.order.status).toBe("SETTLING");

    const again = await cashier.post(`/api/orders/${order.id}/room-charge`, { validationToken: validation.data.validation.token, idempotencyKey: key });
    expect(again.data.duplicate).toBe(true);
    const directWhileUnknown = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.cash, amount: "90.00", tenderedAmount: "90.00", idempotencyKey: uuid() });
    expect(directWhileUnknown.status).toBe(409);

    const verified = await cashier.post(`/api/guest-charges/${res.data.charge.id}/verify`);
    expect(verified.data.outcome).toBe("POSTED");
    expect(verified.data.order.status).toBe("COMPLETED");
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM guest_charges WHERE order_id = :id", { id: order.id });
    expect(Number(n)).toBe(1);
    const [log] = await q("SELECT COUNT(*) AS n FROM integration_logs WHERE operation = 'postCharge' AND idempotency_key = :key", { key });
    expect(Number(log.n)).toBe(1); // posted once, then only a status lookup
  });

  test("a charge the PMS never received is re-posted with the same key after verification", async () => {
    const real = getPmsGateway();
    let calls = 0;
    setPmsGateway(Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      postCharge: async (args) => {
        calls += 1;
        if (calls === 1) throw new IntegrationError("NETWORK", "Connection reset before the request reached the PMS.");
        return real.postCharge(args);
      },
    }));
    try {
      const order = await newOrder([[ids.water, 1]]);
      const { res, key } = await chargeRoom(order.id, "207");
      expect(res.data.outcome).toBe("UNKNOWN");
      const verified = await cashier.post(`/api/guest-charges/${res.data.charge.id}/verify`);
      expect(verified.data.outcome).toBe("POSTED");
      expect(verified.data.charge.attempts).toBe(2);
      expect(verified.data.charge.idempotencyKey).toBe(key);
    } finally {
      setPmsGateway(real);
    }
  });

  test("a validation token cannot be reused for a second charge", async () => {
    const order = await newOrder([[ids.water, 1]]);
    const { res, validation } = await chargeRoom(order.id, "310");
    expect(res.data.outcome).toBe("POSTED");
    const reuse = await cashier.post(`/api/orders/${order.id}/room-charge`, { validationToken: validation.data.validation.token, idempotencyKey: uuid() });
    expect(reuse.status).toBe(409);
  });
});

describe("A. Normal transactions", () => {
  test("create, add/remove/update items, calculate totals, pay cash and issue a receipt", async () => {
    const created = await cashier.post("/api/orders", { outletId: ids.rs01, roomNumber: "205", productId: ids.salad, quantity: "1", totalAmount: "1.00" });
    let order = created.data.order;
    expect(order.totalAmount).toBe("420.00"); // client-supplied totals are ignored
    order = (await cashier.post(`/api/orders/${order.id}/items`, { productId: ids.water, quantity: "3" })).data.order;
    const water = order.items.find((i) => i.productCode === "BV-004");
    order = (await cashier.patch(`/api/orders/${order.id}/items/${water.id}`, { quantity: "2" })).data.order;
    expect(order.totalAmount).toBe("600.00");
    order = (await cashier.del(`/api/orders/${order.id}/items/${water.id}`)).data.order;
    expect(order.items).toHaveLength(1);
    expect(order.totalAmount).toBe("420.00");
    expect(order.taxAmount).toBe("45.00");

    await cashier.post(`/api/orders/${order.id}/request-settlement`);
    const short = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.cash, amount: "420.00", tenderedAmount: "400.00", idempotencyKey: uuid() });
    expect(short.status).toBe(422);
    const paid = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.cash, amount: "420.00", tenderedAmount: "500.00", idempotencyKey: uuid() });
    expect(paid.status).toBe(200);
    expect(paid.data.order.status).toBe("COMPLETED");
    expect(paid.data.payment.changeAmount).toBe("80.00");
    const receipt = await cashier.get(`/receipts/${paid.data.receiptId}`);
    expect(receipt.status).toBe(200);
    expect(receipt.text).toContain("₱420.00");
    ids.cashOrder = order.id;
  });

  test("a declined card returns the order to awaiting settlement", async () => {
    const order = await newOrder([[ids.water, 1]]);
    const declined = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.gcash, amount: "90.00", reference: "DECLINE", idempotencyKey: uuid() });
    expect(declined.status).toBe(402);
    expect(declined.data.order.status).toBe("AWAITING_SETTLEMENT");
  });
});

describe("D. Inventory", () => {
  test("stock is deducted exactly once even when the payment request is repeated", async () => {
    const before = await stockOf("INV-BV-004");
    const order = await newOrder([[ids.water, 2]]);
    const key = uuid();
    const body = { paymentMethodId: ids.cash, amount: "180.00", tenderedAmount: "200.00", idempotencyKey: key };
    const [a, b] = await Promise.all([cashier.post(`/api/orders/${order.id}/payments`, body), cashier.post(`/api/orders/${order.id}/payments`, body)]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(await stockOf("INV-BV-004")).toBe(before - 2);
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM payments WHERE idempotency_key = :key", { key });
    expect(Number(n)).toBe(1);
    const [{ m }] = await q("SELECT COUNT(*) AS m FROM inventory_transactions WHERE reference_type = 'order' AND reference_id = :id", { id: String(order.id) });
    expect(Number(m)).toBe(1);
  });

  test("a voided order never deducts stock", async () => {
    const before = await stockOf("INV-BV-004");
    const order = await newOrder([[ids.water, 1]], { settle: false });
    const voided = await cashier.post(`/api/orders/${order.id}/void`, { reason: "Guest left", supervisorUsername: "supervisor01", supervisorPassword: "TestPass123" });
    expect(voided.data.order.status).toBe("VOIDED");
    expect(await stockOf("INV-BV-004")).toBe(before);
  });

  test("insufficient stock blocks settlement before any money moves", async () => {
    const order = await newOrder([[ids.water, 500]], { settle: false });
    const res = await cashier.post(`/api/orders/${order.id}/request-settlement`);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("INSUFFICIENT_STOCK");
  });

  test("adjustments and waste are recorded in the ledger; the ledger is append-only", async () => {
    const [item] = await q("SELECT id FROM inventory_items WHERE sku = 'INV-BV-004'");
    const waste = await admin.form("/inventory/movements", { transactionType: "WASTE", inventoryItemId: item.id, outletId: ids.rs01, quantity: "1", reason: "Broken bottle" });
    expect(waste.status).toBe(302);
    const count = await admin.form("/inventory/movements", { transactionType: "ADJUSTMENT", inventoryItemId: item.id, outletId: ids.rs01, quantity: "30", reason: "Cycle count" });
    expect(count.status).toBe(302);
    expect(await stockOf("INV-BV-004")).toBe(30);
    await expect(ctx.models.sequelize.query("UPDATE inventory_transactions SET quantity = 0 LIMIT 1")).rejects.toThrow(/append-only/);
    await expect(ctx.models.sequelize.query("DELETE FROM audit_logs LIMIT 1")).rejects.toThrow(/append-only/);
  });

  test("the POS catalog carries the stock behind each tracked item", async () => {
    const { data } = await cashier.get(`/api/pos/catalog?outletId=${ids.rs01}`);
    const byId = new Map(data.catalog.map((p) => [p.id, p]));
    expect(byId.get(ids.water).stock).toEqual([expect.objectContaining({ perUnit: "1.000" })]);
    expect(Number(byId.get(ids.water).stock[0].onHand)).toBe(await stockOf("INV-BV-004"));
    expect(byId.get(ids.sandwich).stock).toHaveLength(3); // bread, chicken, bacon
    expect(byId.get(ids.salad).stock).toBeNull(); // not stock-tracked
  });

  test("an outlet price can be saved as unavailable, then stopped altogether", async () => {
    const current = () => q("SELECT price, is_available AS isAvailable FROM product_prices WHERE product_id = :p AND outlet_id = :o AND effective_to IS NULL", { p: ids.water, o: ids.rest01 });
    const inCatalog = async () => (await cashier.get(`/api/pos/catalog?outletId=${ids.rest01}`)).data.catalog.some((p) => p.id === ids.water);
    expect(await inCatalog()).toBe(true);

    // An unticked "Available" checkbox is simply missing from the form post.
    expect((await admin.form(`/products/${ids.water}/prices`, { outletId: String(ids.rest01), price: "80.00" })).status).toBe(302);
    expect(await current()).toEqual([{ price: "80.00", isAvailable: 0 }]);
    expect(await inCatalog()).toBe(false);

    expect((await admin.get(`/products/${ids.water}`)).text).toContain("Stop selling");
    expect((await admin.form(`/products/${ids.water}/prices/${ids.rest01}/remove`, {})).status).toBe(302);
    expect(await current()).toEqual([]);
  });
});

describe("E. Financial operations", () => {
  test("partial cash refund with restock needs a different approver and reduces expected cash", async () => {
    const supShift = await supervisor.form("/shifts/open", { outletId: ids.rs01, openingCash: "1000.00" });
    expect(supShift.status).toBe(302);
    await supervisor.refreshCsrf();
    const [line] = await q("SELECT id FROM order_items WHERE order_id = :id", { id: ids.cashOrder });
    const before = await stockOf("INV-BV-004");
    const req = await cashier.form("/refunds", { orderId: ids.cashOrder, refundType: "PARTIAL", [`quantities[item_${line.id}]`]: "1", reason: "Wrong dressing", refundMethodId: ids.cash });
    expect(req.status).toBe(302);
    const [refund] = await q("SELECT id, amount, status FROM refunds ORDER BY id DESC LIMIT 1");
    expect(refund).toMatchObject({ amount: "420.00", status: "REQUESTED" });

    await cashier.form(`/refunds/${refund.id}/approve`, {});
    expect((await q("SELECT status FROM refunds WHERE id = :id", { id: refund.id }))[0].status).toBe("REQUESTED"); // own request
    await supervisor.form(`/refunds/${refund.id}/approve`, {});
    const [done] = await q("SELECT r.status, r.shift_id, o.status AS order_status FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.id = :id", { id: refund.id });
    expect(done.status).toBe("PROCESSED");
    expect(done.order_status).toBe("REFUNDED");
    expect(done.shift_id).not.toBeNull();
    expect(await stockOf("INV-BV-004")).toBe(before); // salad is not stock-tracked
  });

  test("full refund of a room charge reverses it through the PMS", async () => {
    await cashier.form("/refunds", { orderId: ids.room205Order, refundType: "FULL", reason: "Guest dispute", restock: "1" });
    const [refund] = await q("SELECT id FROM refunds ORDER BY id DESC LIMIT 1");
    const before = await stockOf("INV-BV-001");
    await supervisor.form(`/refunds/${refund.id}/approve`, {});
    const [row] = await q(
      `SELECT r.status, r.external_reference, g.status AS charge_status, g.reversed_amount, o.status AS order_status
         FROM refunds r JOIN guest_charges g ON g.id = r.guest_charge_id JOIN orders o ON o.id = r.order_id WHERE r.id = :id`,
      { id: refund.id }
    );
    expect(row).toMatchObject({ status: "PROCESSED", charge_status: "REVERSED", reversed_amount: "850.00", order_status: "REFUNDED" });
    expect(row.external_reference).toMatch(/^PMS-TX-/);
    expect(await stockOf("INV-BV-001")).toBe(before + 2); // restocked iced tea
  });

  test("shift close computes expected cash and variance", async () => {
    const [shift] = await q("SELECT s.id FROM shifts s JOIN users u ON u.id = s.user_id WHERE u.username = 'cashier01' AND s.status = 'OPEN'");
    const [{ cash }] = await q(
      `SELECT COALESCE(SUM(p.amount),0) AS cash FROM payments p JOIN payment_methods m ON m.id = p.payment_method_id
        WHERE p.shift_id = :id AND m.is_cash = 1 AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')`,
      { id: shift.id }
    );
    const expected = 5000 + Number(cash);
    const actualCash = (expected - 25).toFixed(2);
    const stillDining = await newOrder([[ids.water, 1]], { settle: false });
    const close = (body) => cashier.request("POST", `/shifts/${shift.id}/close`, { json: body, headers: { Accept: "application/json" } });

    // Unpaid orders block the close...
    const blocked = await close({ actualCash });
    expect(blocked.status).toBe(409);
    expect(blocked.data.code).toBe("UNSETTLED_ORDERS");
    expect(blocked.data.details.orders.map((o) => o.orderNumber)).toContain(stillDining.orderNumber);
    expect((await cashier.get(`/shifts/${shift.id}`)).text).toContain(stillDining.orderNumber);
    // ...until they are handed over, with a note for the next shift.
    const noNote = await close({ actualCash, handOver: true });
    expect(noNote.status).toBe(422);
    expect(noNote.data.code).toBe("HANDOVER_NOTE_REQUIRED");
    const closed = await cashier.form(`/shifts/${shift.id}/close`, { actualCash, handOver: "1", closingNotes: "Room 205 still eating, bill to follow" });
    expect(closed.status).toBe(302);
    const [after] = await q("SELECT status, expected_cash, cash_variance FROM shifts WHERE id = :id", { id: shift.id });
    expect(after).toMatchObject({ status: "CLOSED", expected_cash: expected.toFixed(2), cash_variance: "-25.00" });
    const [handover] = await q("SELECT new_values FROM audit_logs WHERE action = 'SHIFT_ORDERS_HANDED_OVER' AND entity_id = :id", { id: String(shift.id) });
    expect(JSON.stringify(handover.new_values)).toContain(stillDining.orderNumber);
    expect((await q("SELECT status FROM orders WHERE id = :id", { id: stillDining.id }))[0].status).toBe("IN_PROGRESS");

    // The handed-over order is now the next closing shift's responsibility at this outlet.
    const [supShift] = await q("SELECT s.id FROM shifts s JOIN users u ON u.id = s.user_id WHERE u.username = 'supervisor01' AND s.status = 'OPEN'");
    const next = await supervisor.request("POST", `/shifts/${supShift.id}/close`, { json: { actualCash: "0.00" }, headers: { Accept: "application/json" } });
    expect(next.status).toBe(409);
    expect(next.data.details.orders.map((o) => o.orderNumber)).toContain(stillDining.orderNumber);
  });
});

describe("F. Security", () => {
  test("role-based access is enforced on the server", async () => {
    expect((await cashier.get("/users")).status).toBe(403);
    expect((await cashier.get("/settings")).status).toBe(403);
    expect((await cashier.get("/reports/sales")).status).toBe(403);
    expect((await admin.get("/users")).status).toBe(200);
  });

  test("outlet assignment is enforced", async () => {
    const res = await cashier.post("/api/orders", { outletId: ids.bar01, productId: ids.water });
    expect(res.status).toBe(403);
  });

  test("unauthenticated API calls are rejected", async () => {
    const anon = new Client(ctx.base);
    const res = await anon.request("GET", "/api/pos/open-orders?outletId=1", { json: undefined, headers: { Accept: "application/json" } });
    expect(res.status).toBe(401);
  });

  test("state-changing requests without a CSRF token are rejected", async () => {
    const res = await cashier.request("POST", "/api/orders", { json: { outletId: ids.rs01, roomNumber: "205", productId: ids.water }, csrf: false });
    expect(res.status).toBe(403);
    expect(res.data.code).toBe("CSRF");
  });

  test("voids require supervisor authorization for cashiers", async () => {
    const order = await newOrder([[ids.water, 1]], { settle: false });
    const res = await cashier.post(`/api/orders/${order.id}/void`, { reason: "test" });
    expect(res.status).toBe(403);
  });

  test("backend validation rejects bad input and injection-like search terms are harmless", async () => {
    expect((await cashier.post("/api/orders/999999/items", { productId: ids.water })).status).toBe(404);
    const bad = await cashier.post("/api/orders", { outletId: ids.rs01, roomNumber: "205", productId: ids.water, quantity: "-3" });
    expect(bad.status).toBe(422);
    const search = await admin.get(`/orders?search=${encodeURIComponent("' OR 1=1 --")}`);
    expect(search.status).toBe(200);
  });

  test("account lockout after repeated failed logins", async () => {
    const intruder = new Client(ctx.base);
    for (let i = 0; i < 5; i++) {
      const page = await intruder.get("/login");
      const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
      await intruder.request("POST", "/login", { form: { _csrf: token, username: "staff01", password: "wrong-password" } });
    }
    const [user] = await q("SELECT locked_until FROM users WHERE username = 'staff01'");
    expect(user.locked_until).not.toBeNull();
  });

  test("supervisor overrides count toward lockout, so they cannot be used to guess a password", async () => {
    const order = await newOrder([[ids.water, 1]], { settle: false });
    const voidWith = (password) => cashier.post(`/api/orders/${order.id}/void`, { reason: "test", supervisorUsername: "supervisor01", supervisorPassword: password });
    try {
      for (let i = 0; i < 5; i++) expect((await voidWith("wrong-password")).data.code).toBe("OVERRIDE_DENIED");
      const locked = await voidWith("TestPass123");
      expect(locked.status).toBe(423);
      expect(locked.data.code).toBe("LOCKED");
      const [row] = await q("SELECT status FROM orders WHERE id = :id", { id: order.id });
      expect(row.status).not.toBe("VOIDED");
    } finally {
      await ctx.models.sequelize.query("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE username = 'supervisor01'");
    }
  });

  test("health checks and anonymous API reads do not start a session", async () => {
    for (const url of ["/api/v1/health", "/api/v1/orders"]) {
      const res = await fetch(ctx.base + url, { headers: { Accept: "application/json" } });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });
});

describe("G. Where the order is served", () => {
  const tablesOf = async (outletId) => (await cashier.get(`/api/outlets/${outletId}/tables`)).data.tables;

  test("dine-in orders need one of the outlet's own tables", async () => {
    // (Water is no longer sold at REST-01 after section D; iced tea is.)
    const tables = await tablesOf(ids.rest01);
    expect(tables.map((t) => t.label)).toEqual(expect.arrayContaining(["T1", "T8", "P1", "P4"]));
    const t5 = tables.find((t) => t.label === "T5");
    const p1 = tables.find((t) => t.label === "P1");

    const countAtRest = async () => Number((await q("SELECT COUNT(*) AS n FROM orders WHERE outlet_id = :o", { o: ids.rest01 }))[0].n);
    const before = await countAtRest();
    const none = await cashier.post("/api/orders", { outletId: ids.rest01, productId: ids.icedTea });
    expect(none.status).toBe(422);
    expect(none.data.code).toBe("TABLE_REQUIRED");
    const [barTable] = await q("SELECT t.id FROM outlet_tables t JOIN outlets o ON o.id = t.outlet_id WHERE o.code = 'BAR-01' LIMIT 1");
    const foreign = await cashier.post("/api/orders", { outletId: ids.rest01, tableId: barTable.id, productId: ids.icedTea });
    expect(foreign.status).toBe(422);
    expect(foreign.data.code).toBe("TABLE_NOT_FOUND");
    expect(await countAtRest()).toBe(before); // nothing was created by the rejected requests

    const created = await cashier.post("/api/orders", { outletId: ids.rest01, tableId: t5.id, productId: ids.icedTea });
    expect(created.status).toBe(201);
    expect(created.data.order).toMatchObject({ orderType: "DINE_IN", tableId: t5.id, tableOrLocation: "T5", roomNumber: null });
    const open = await cashier.get(`/api/pos/open-orders?outletId=${ids.rest01}`);
    expect(open.data.orders.find((o) => o.id === created.data.order.id)).toMatchObject({ tableOrLocation: "T5", tableId: t5.id });

    // Moving to another table keeps the note; a dine-in order cannot lose its table.
    const id = created.data.order.id;
    expect((await cashier.patch(`/api/orders/${id}`, { notes: "Birthday cake at 8" })).status).toBe(200);
    const moved = await cashier.patch(`/api/orders/${id}`, { tableId: p1.id });
    expect(moved.data.order).toMatchObject({ tableOrLocation: "P1", tableId: p1.id, notes: "Birthday cake at 8" });
    const cleared = await cashier.patch(`/api/orders/${id}`, { tableId: null });
    expect(cleared.status).toBe(422);
    expect(cleared.data.code).toBe("TABLE_REQUIRED");

    // Older API clients that send the table's name still work.
    const byName = await cashier.post("/api/orders", { outletId: ids.rest01, tableOrLocation: "p2", productId: ids.icedTea });
    expect(byName.status).toBe(201);
    expect(byName.data.order.tableOrLocation).toBe("P2");
    expect((await cashier.post("/api/orders", { outletId: ids.rest01, tableOrLocation: "Table nine", productId: ids.icedTea })).data.code).toBe("TABLE_NOT_FOUND");
  });

  test("an administrator manages the table list; a switched-off table leaves the POS list", async () => {
    const page = await admin.get(`/outlets/${ids.rest01}`);
    expect(page.text).toContain('id="tables"');
    expect((await admin.form(`/outlets/${ids.rest01}/tables`, { label: "T9", area: "Window", seats: "2", sortOrder: "20" })).status).toBe(302);
    expect((await admin.form(`/outlets/${ids.rest01}/tables`, { label: "t9" })).status).toBe(302); // duplicate: flashed, not added
    const t9 = (await tablesOf(ids.rest01)).filter((t) => t.label.toUpperCase() === "T9");
    expect(t9).toHaveLength(1);
    expect(t9[0]).toMatchObject({ area: "Window", seats: 2, status: "ACTIVE" });

    const order = (await cashier.post("/api/orders", { outletId: ids.rest01, tableId: t9[0].id, productId: ids.icedTea })).data.order;
    expect((await admin.form(`/outlets/${ids.rest01}/tables/${t9[0].id}`, { label: "T9", area: "Window", seats: "2", sortOrder: "20", status: "INACTIVE" })).status).toBe(302);
    const terminal = await cashier.get(`/pos/terminal?outletId=${ids.rest01}`);
    expect(terminal.text).toContain('id="order-table"');
    expect(terminal.text).toContain('"label":"T5"');
    expect(terminal.text).not.toContain('"label":"T9"');
    // New orders cannot use it; the order already seated there keeps it.
    expect((await cashier.post("/api/orders", { outletId: ids.rest01, tableId: t9[0].id, productId: ids.icedTea })).data.code).toBe("TABLE_INACTIVE");
    expect((await cashier.patch(`/api/orders/${order.id}`, { notes: "Still here" })).data.order.tableOrLocation).toBe("T9");
  });

  test("room service and minibar orders need a checked-in guest room", async () => {
    const create = (body) => cashier.post("/api/orders", { outletId: ids.rs01, productId: ids.water, ...body });
    expect((await create({})).data.code).toBe("ROOM_REQUIRED");
    expect((await create({ roomNumber: "999" })).data.code).toBe("ROOM_NOT_FOUND");
    expect((await create({ roomNumber: "101" })).data.code).toBe("ROOM_VACANT");
    // A checked-in guest without a chargeable folio can still order (and pays directly).
    expect((await create({ roomNumber: "102" })).status).toBe(201);
    const ok = await create({ roomNumber: "205" });
    expect(ok.status).toBe(201);
    expect(ok.data.order).toMatchObject({ orderType: "ROOM_SERVICE", roomNumber: "205", tableOrLocation: "Room 205", tableId: null });
    const minibar = await create({ orderType: "MINIBAR", roomNumber: "310" });
    expect(minibar.data.order).toMatchObject({ orderType: "MINIBAR", tableOrLocation: "Room 310" });

    // Changing type: dine-in at an outlet without tables is refused; takeout needs no location.
    const id = ok.data.order.id;
    const dine = await cashier.patch(`/api/orders/${id}`, { orderType: "DINE_IN" });
    expect(dine.status).toBe(422);
    expect(dine.data.error).toContain("no tables set up");
    const takeout = await cashier.patch(`/api/orders/${id}`, { orderType: "TAKEOUT" });
    expect(takeout.data.order).toMatchObject({ orderType: "TAKEOUT", roomNumber: null, tableOrLocation: null });
    const back = await cashier.patch(`/api/orders/${id}`, { orderType: "ROOM_SERVICE", roomNumber: "101" });
    expect(back.data.code).toBe("ROOM_VACANT");
    expect((await cashier.patch(`/api/orders/${id}`, { orderType: "ROOM_SERVICE", roomNumber: "207" })).data.order.tableOrLocation).toBe("Room 207");
  });

  test("if the PMS cannot be reached the room order is not taken", async () => {
    const real = getPmsGateway();
    setPmsGateway({
      name: "DownPms",
      isMock: true,
      getActiveFolio: async () => {
        throw new IntegrationError("TIMEOUT", "PMS timeout (test)");
      },
    });
    try {
      const res = await cashier.post("/api/orders", { outletId: ids.rs01, roomNumber: "205", productId: ids.water });
      expect(res.status).toBe(503);
      expect(res.data.code).toBe("PMS_UNAVAILABLE");
    } finally {
      setPmsGateway(real);
    }
  });
});

describe("H. Payment methods: Cash, GCash and Maya only", () => {
  beforeAll(async () => {
    expect((await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "1000.00" })).status).toBe(302);
    await cashier.refreshCsrf();
  });

  test("the POS offers Cash, GCash and Maya; e-wallets need the reference number", async () => {
    const active = await q("SELECT code FROM payment_methods WHERE status = 'ACTIVE' ORDER BY sort_order");
    expect(active.map((m) => m.code)).toEqual(["CASH", "GCASH", "MAYA"]);
    const [maya] = await q("SELECT id FROM payment_methods WHERE code = 'MAYA'");
    const terminal = await cashier.get(`/pos/terminal?outletId=${ids.rs01}`);
    expect(terminal.text).toContain('"code":"GCASH"');
    expect(terminal.text).toContain('"code":"MAYA"');

    const order = await newOrder([[ids.water, 1]]);
    const noRef = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.gcash, amount: "90.00", idempotencyKey: uuid() });
    expect(noRef.status).toBe(422);
    expect(noRef.data.code).toBe("REFERENCE_REQUIRED");
    const paid = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: maya.id, amount: "90.00", reference: "MAYA-7781203", idempotencyKey: uuid() });
    expect(paid.status).toBe(200);
    expect(paid.data.order.status).toBe("COMPLETED");
    expect(paid.data.payment).toMatchObject({ status: "CAPTURED", reference: "MAYA-7781203" });
  });

  test("an existing database keeps old methods for history but can no longer use them", async () => {
    const { connect } = await import("../../database/migrator.js");
    const { up } = await import("../../database/migrations/009_tables_rooms_and_ewallets.js");
    await ctx.models.sequelize.query("INSERT INTO payment_methods (code, name, is_cash, uses_gateway, requires_reference, sort_order) VALUES ('CREDIT_CARD', 'Credit Card', 0, 1, 0, 9)");
    const conn = await connect();
    try {
      await up(conn, { log: () => {} }); // re-running the migration is safe and retires the method
    } finally {
      await conn.end();
    }
    const [card] = await q("SELECT id, status FROM payment_methods WHERE code = 'CREDIT_CARD'");
    expect(card.status).toBe("INACTIVE");

    const order = await newOrder([[ids.water, 1]]);
    const res = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: card.id, amount: "90.00", reference: "X", idempotencyKey: uuid() });
    expect(res.data.code).toBe("PAYMENT_METHOD_INACTIVE");
    // Settings refuse to switch it back on, and do not list it.
    await admin.form(`/settings/payment-methods/${card.id}`, { name: "Credit Card", status: "ACTIVE", sortOrder: "9" });
    expect((await q("SELECT status FROM payment_methods WHERE id = :id", { id: card.id }))[0].status).toBe("INACTIVE");
    expect((await admin.get("/settings")).text).not.toContain("CREDIT_CARD");
  });
});
