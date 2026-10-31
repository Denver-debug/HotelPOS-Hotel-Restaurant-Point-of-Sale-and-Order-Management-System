// End-to-end scenarios from the development plan (Phase 6 A–F), run over HTTP
// against a freshly migrated and seeded HotelPOS_test database.
import { startApp, Client, uuid } from "./harness.js";
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
  const created = await cashier.post("/api/orders", { outletId: ids.rs01, productId: first[0], quantity: String(first[1]) });
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
  ids.sandwich = await product("FD-001");
  ids.icedTea = await product("BV-001");
  ids.water = await product("BV-004");
  ids.salad = await product("FD-002");
  ids.cash = (await q("SELECT id FROM payment_methods WHERE code = 'CASH'"))[0].id;
  ids.card = (await q("SELECT id FROM payment_methods WHERE code = 'CREDIT_CARD'"))[0].id;

  cashier = await new Client(ctx.base).login("cashier01");
  supervisor = await new Client(ctx.base).login("supervisor01");
  admin = await new Client(ctx.base).login("admin");
  const opened = await cashier.form("/shifts/open", { outletId: ids.rs01, openingCash: "5000.00" });
  expect(opened.status).toBe(302);
  await cashier.refreshCsrf();
});

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
    const created = await cashier.post("/api/orders", { outletId: ids.rs01, productId: ids.salad, quantity: "1", totalAmount: "1.00" });
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
    const declined = await cashier.post(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.card, amount: "90.00", reference: "DECLINE", idempotencyKey: uuid() });
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
    const closed = await cashier.form(`/shifts/${shift.id}/close`, { actualCash: (expected - 25).toFixed(2) });
    expect(closed.status).toBe(302);
    const [after] = await q("SELECT status, expected_cash, cash_variance FROM shifts WHERE id = :id", { id: shift.id });
    expect(after).toMatchObject({ status: "CLOSED", expected_cash: expected.toFixed(2), cash_variance: "-25.00" });
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
    const res = await cashier.request("POST", "/api/orders", { json: { outletId: ids.rs01, productId: ids.water }, csrf: false });
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
    const bad = await cashier.post("/api/orders", { outletId: ids.rs01, productId: ids.water, quantity: "-3" });
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
});
