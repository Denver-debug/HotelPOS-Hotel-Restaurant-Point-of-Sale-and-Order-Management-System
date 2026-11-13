// ERP integration API (/api/v1): API keys bound to service accounts, outlet scoping,
// incremental sync, idempotent creates, rate limits, CORS and the OpenAPI contract.
import { startApp, Client, uuid } from "./harness.js";
import { config } from "../../config/env.js";

let ctx;
let admin;
const ids = {};
const keys = {};
const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });

// A machine client: Authorization header only, no cookies, no CSRF token.
async function call(key, method, url, { body, headers = {} } = {}) {
  const h = { Accept: "application/json", ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(ctx.base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
}

async function createClient(name, roleCode, { outlets = [], ips = "" } = {}) {
  const [role] = await q("SELECT id FROM roles WHERE code = :code", { code: roleCode });
  const fields = [["name", name], ["roleId", String(role.id)], ["allowedIps", ips], ...outlets.map((o) => ["outletIds", String(o)])];
  const res = await admin.form("/integrations/api-clients", fields);
  const key = /id="new-api-key"[^>]*value="(hpos_[^"]+)"/.exec(res.text)?.[1];
  if (!key) throw new Error(`No key in response (${res.status}): ${res.text.slice(0, 300)}`);
  return key;
}

beforeAll(async () => {
  ctx = await startApp();
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.bar01 = (await q("SELECT id FROM outlets WHERE code = 'BAR-01'"))[0].id;
  ids.water = (await q("SELECT id FROM products WHERE code = 'BV-004'"))[0].id;
  ids.salad = (await q("SELECT id FROM products WHERE code = 'FD-002'"))[0].id;
  ids.waterItem = (await q("SELECT id FROM inventory_items WHERE sku = 'INV-BV-004'"))[0].id;
  admin = await new Client(ctx.base).login("admin");
  keys.reader = await createClient("Accounting GL", "ERP_INTEGRATION");
  keys.writer = await createClient("Room service app", "CASHIER", { outlets: [ids.rs01] });
  keys.stock = await createClient("ERP purchasing", "INVENTORY_STAFF", { outlets: [ids.rs01] });
});

afterAll(async () => {
  await ctx?.stop();
});

describe("Authentication", () => {
  test("health needs no credentials and checks the database", async () => {
    const res = await call(null, "GET", "/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, status: "up", database: "up" });
  });

  test("missing and invalid keys are 401 with a code", async () => {
    const none = await call(null, "GET", "/api/v1/orders");
    expect(none.status).toBe(401);
    expect(none.data.code).toBe("UNAUTHENTICATED");
    expect(none.data.error).toMatch(/Authorization: Bearer/);
    const bad = await call("hpos_abcdefgh_" + "x".repeat(40), "GET", "/api/v1/orders");
    expect(bad.status).toBe(401);
    expect(bad.data.code).toBe("INVALID_API_KEY");
  });

  test("a key identifies its client and never starts a session", async () => {
    const me = await call(keys.reader, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.data.client.name).toBe("Accounting GL");
    expect(me.data.user.isServiceAccount).toBe(true);
    expect(me.data.permissions).toContain("orders.view");
    expect(me.data.permissions).not.toContain("orders.create");
    expect(me.headers.get("set-cookie")).toBeNull();
  });

  test("writes need no CSRF token with a key, but still need the permission", async () => {
    const denied = await call(keys.reader, "POST", "/api/v1/orders", { body: { outletId: ids.rs01, items: [{ productId: ids.water }] } });
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe("FORBIDDEN");
    const ok = await call(keys.writer, "POST", "/api/v1/orders", { body: { outletId: ids.rs01, items: [{ productId: ids.water }] } });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("set-cookie")).toBeNull();
  });

  test("a service account cannot sign in to the web UI", async () => {
    const [svc] = await q("SELECT u.username FROM users u JOIN api_clients c ON c.user_id = u.id WHERE c.name = 'Room service app'");
    const anon = new Client(ctx.base);
    const page = await anon.get("/login");
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    const res = await anon.request("POST", "/login", { form: { _csrf: token, username: svc.username, password: "anything-at-all", next: "" } });
    expect(res.status).toBe(401);
    const [audit] = await q("SELECT action FROM audit_logs WHERE action LIKE 'LOGIN_%' ORDER BY id DESC LIMIT 1");
    expect(audit.action).toMatch(/LOGIN_(FAILED|BLOCKED)/);
  });

  test("an IP allowlist is enforced", async () => {
    const key = await createClient("Locked to one IP", "ERP_INTEGRATION", { ips: "10.9.9.9" });
    const res = await call(key, "GET", "/api/v1/me");
    expect(res.status).toBe(403);
    expect(res.data.code).toBe("IP_NOT_ALLOWED");
  });

  test("a revoked key stops working; a rotated key replaces the old one", async () => {
    const key = await createClient("Short lived", "ERP_INTEGRATION");
    const [client] = await q("SELECT id FROM api_clients WHERE name = 'Short lived'");
    const rotated = await admin.form(`/integrations/api-clients/${client.id}/rotate`, {});
    const newKey = /id="new-api-key"[^>]*value="(hpos_[^"]+)"/.exec(rotated.text)[1];
    expect((await call(key, "GET", "/api/v1/me")).status).toBe(401);
    expect((await call(newKey, "GET", "/api/v1/me")).status).toBe(200);
    expect((await admin.form(`/integrations/api-clients/${client.id}/revoke`, {})).status).toBe(302);
    const revoked = await call(newKey, "GET", "/api/v1/me");
    expect(revoked.status).toBe(401);
    expect(revoked.data.error).toMatch(/revoked/);
  });

  test("API keys cannot be given administration roles", async () => {
    const [role] = await q("SELECT id FROM roles WHERE code = 'SYSTEM_ADMIN'");
    const res = await admin.form("/integrations/api-clients", [["name", "Too powerful"], ["roleId", String(role.id)]]);
    expect(res.status).toBe(422);
    expect(res.text).toContain("cannot hold administration permissions");
  });
});

describe("Orders", () => {
  test("create with lines in one call; a retried Idempotency-Key returns the same order", async () => {
    const key = uuid();
    const body = { outletId: ids.rs01, externalReference: "RSAPP-1001", tableOrLocation: "Room 205", items: [{ productId: ids.water, quantity: "2" }, { productId: ids.salad, quantity: "1", notes: "no dressing" }] };
    const first = await call(keys.writer, "POST", "/api/v1/orders", { body, headers: { "Idempotency-Key": key } });
    expect(first.status).toBe(201);
    expect(first.data.order.items).toHaveLength(2);
    expect(first.data.order.externalReference).toBe("RSAPP-1001");
    expect(first.data.order.totalAmount).toBe("600.00");
    const again = await call(keys.writer, "POST", "/api/v1/orders", { body, headers: { "Idempotency-Key": key } });
    expect(again.status).toBe(200);
    expect(again.data.duplicate).toBe(true);
    expect(again.data.order.id).toBe(first.data.order.id);
    const found = await call(keys.reader, "GET", "/api/v1/orders?externalReference=RSAPP-1001");
    expect(found.data.orders.map((o) => o.id)).toEqual([first.data.order.id]);
  });

  test("an order with an invalid line is not created at all", async () => {
    const res = await call(keys.writer, "POST", "/api/v1/orders", { body: { outletId: ids.rs01, externalReference: "RSAPP-BAD", items: [{ productId: ids.water }, { productId: 999999 }] } });
    expect(res.status).toBe(422);
    expect(res.data.code).toBe("PRODUCT_UNAVAILABLE");
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM orders WHERE external_reference = 'RSAPP-BAD'");
    expect(Number(n)).toBe(0);
  });

  test("outlet scoping applies to keys exactly as to people", async () => {
    const outside = await call(keys.writer, "POST", "/api/v1/orders", { body: { outletId: ids.bar01, items: [{ productId: ids.water }] } });
    expect(outside.status).toBe(403);
    const [bar] = await q("SELECT id FROM orders WHERE outlet_id = :o LIMIT 1", { o: ids.bar01 });
    if (bar) expect((await call(keys.writer, "GET", `/api/v1/orders/${bar.id}`)).status).toBe(403);
    // Asking for an outlet outside the key's assignment matches nothing (no data leaks, no error).
    const listed = await call(keys.writer, "GET", `/api/v1/orders?outletId=${ids.bar01}`);
    expect(listed.status).toBe(200);
    expect(listed.data.orders).toEqual([]);
    expect(listed.data.pagination.total).toBe(0);
  });

  test("incremental sync: updatedSince returns changed orders oldest first, with paging", async () => {
    const since = new Date(Date.now() - 2000).toISOString();
    const a = await call(keys.writer, "POST", "/api/v1/orders", { body: { outletId: ids.rs01, items: [{ productId: ids.water }] } });
    const b = await call(keys.writer, "POST", "/api/v1/orders", { body: { outletId: ids.rs01, items: [{ productId: ids.water }] } });
    const page1 = await call(keys.reader, "GET", `/api/v1/orders?updatedSince=${encodeURIComponent(since)}&limit=1`);
    expect(page1.status).toBe(200);
    expect(page1.data.pagination).toMatchObject({ limit: 1, offset: 0, hasMore: true });
    const all = await call(keys.reader, "GET", `/api/v1/orders?updatedSince=${encodeURIComponent(since)}&limit=200`);
    const got = all.data.orders.map((o) => o.id);
    expect(got).toEqual(expect.arrayContaining([a.data.order.id, b.data.order.id]));
    const times = all.data.orders.map((o) => new Date(o.updatedAt).getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect((await call(keys.reader, "GET", "/api/v1/orders?updatedSince=yesterday")).status).toBe(422);
  });
});

describe("Settlement and stock by API key", () => {
  test("a guest-app client opens a shift, takes an order and charges it to a room", async () => {
    const shift = await call(keys.writer, "POST", "/api/v1/shifts", { body: { outletId: ids.rs01, openingCash: "0.00" } });
    expect(shift.status).toBe(201);
    const current = await call(keys.writer, "GET", "/api/v1/shifts/current");
    expect(current.data.shift.id).toBe(shift.data.shift.id);
    const created = await call(keys.writer, "POST", "/api/v1/orders", { body: { outletId: ids.rs01, orderType: "ROOM_SERVICE", items: [{ productId: ids.water }] } });
    const orderId = created.data.order.id;
    expect((await call(keys.writer, "POST", `/api/v1/orders/${orderId}/request-settlement`)).status).toBe(200);
    const v = await call(keys.writer, "POST", `/api/v1/orders/${orderId}/room-charge/validate`, { body: { roomNumber: "205" } });
    expect(v.status).toBe(200);
    const charge = await call(keys.writer, "POST", `/api/v1/orders/${orderId}/room-charge`, { body: { validationToken: v.data.validation.token }, headers: { "Idempotency-Key": uuid() } });
    expect(charge.status).toBe(200);
    expect(charge.data.outcome).toBe("POSTED");
    const charges = await call(keys.reader, "GET", `/api/v1/guest-charges?externalFolioId=${charge.data.charge.externalFolioId}`);
    expect(charges.data.guestCharges.some((g) => g.orderId === orderId && g.status === "POSTED")).toBe(true);
    expect(JSON.stringify(charges.data)).not.toMatch(/J\. Tan/); // no guest names leave HotelPOS
  });

  test("ERP purchasing records a goods receipt; a retry is not counted twice", async () => {
    const key = uuid();
    const body = { transactionType: "STOCK_IN", inventoryItemId: ids.waterItem, outletId: ids.rs01, quantity: "24", unitCost: "18.50", reason: "PO-2024-118" };
    const first = await call(keys.stock, "POST", "/api/v1/inventory/movements", { body, headers: { "Idempotency-Key": key } });
    expect(first.status).toBe(201);
    expect(first.data.movement.quantity).toBe("24.000");
    const again = await call(keys.stock, "POST", "/api/v1/inventory/movements", { body, headers: { "Idempotency-Key": key } });
    expect(again.status).toBe(200);
    expect(again.data.duplicate).toBe(true);
    expect(again.data.movement.id).toBe(first.data.movement.id);
  });

  test("read endpoints for the other subsystems", async () => {
    for (const [url, key] of [
      ["/api/v1/outlets", "outlets"], ["/api/v1/categories", "categories"], ["/api/v1/payment-methods", "paymentMethods"],
      ["/api/v1/products?limit=5", "products"], ["/api/v1/payments", "payments"], ["/api/v1/refunds", "refunds"],
      ["/api/v1/shifts", "shifts"], ["/api/v1/inventory/levels", "stockLevels"], ["/api/v1/inventory/movements", "movements"],
      ["/api/v1/reports", "reports"],
    ]) {
      const res = await call(keys.reader, "GET", url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(Array.isArray(res.data[key])).toBe(true);
    }
    const products = await call(keys.reader, "GET", `/api/v1/products?outletId=${ids.rs01}&limit=3`);
    expect(products.data.products[0].prices[0]).toMatchObject({ outletId: ids.rs01 });
    expect(products.data.products[0].prices[0].price).toMatch(/^\d+\.\d{2}$/);
    const report = await call(keys.reader, "GET", "/api/v1/reports/sales");
    expect(report.status).toBe(200);
    expect(Array.isArray(report.data.rows)).toBe(true);
  });

  test("a price change counts as a product update for incremental sync", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    expect((await admin.form(`/products/${ids.salad}/prices`, { outletId: String(ids.rs01), price: "435.00", isAvailable: "1" })).status).toBe(302);
    const res = await call(keys.reader, "GET", `/api/v1/products?updatedSince=${encodeURIComponent(since)}`);
    const salad = res.data.products.find((p) => p.id === ids.salad);
    expect(salad.prices.find((p) => p.outletId === ids.rs01).price).toBe("435.00");
  });
});

describe("Edge behaviour and contract", () => {
  test("rate limit returns 429 with Retry-After", async () => {
    const before = config.api.rateLimitPerMinute;
    const key = await createClient("Chatty client", "ERP_INTEGRATION");
    config.api.rateLimitPerMinute = 3;
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await call(key, "GET", "/api/v1/me")).status);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      const limited = await call(key, "GET", "/api/v1/me");
      expect(limited.status).toBe(429);
      expect(limited.data.code).toBe("RATE_LIMITED");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      config.api.rateLimitPerMinute = before;
    }
  });

  test("CORS answers preflights only for configured origins", async () => {
    const before = config.api.corsOrigins;
    config.api.corsOrigins = ["https://erp.example"];
    try {
      const ok = await fetch(`${ctx.base}/api/v1/orders`, { method: "OPTIONS", headers: { Origin: "https://erp.example", "Access-Control-Request-Method": "GET" } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://erp.example");
      const other = await fetch(`${ctx.base}/api/v1/orders`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      config.api.corsOrigins = before;
    }
  });

  test("unknown API paths are JSON 404s", async () => {
    const res = await call(keys.reader, "GET", "/api/v1/no-such-thing");
    expect(res.status).toBe(404);
    expect(res.data).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  test("the OpenAPI document describes every route on the API router", async () => {
    const res = await call(null, "GET", "/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.data.openapi).toBe("3.1.0");
    const { default: router } = await import("../../routes/api.js");
    const routes = router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m} ${layer.route.path.replace(/:(\w+)(\([^)]*\))?/g, "{$1}")}`));
    const documented = Object.entries(res.data.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`));
    expect(routes.filter((r) => !documented.includes(r))).toEqual([]);
    expect(documented.filter((d) => !routes.includes(d))).toEqual([]);
  });
});
