// Web UI consistency: links inside mounted routers, flash messages, 404s and
// permission-aware links, checked over HTTP against a fresh test database.
import { startApp, Client } from "./harness.js";

let ctx;
let cashier;
let manager;
let admin;
const ids = {};
const q = (sql, replacements = {}) => ctx.models.sequelize.query(sql, { replacements, type: "SELECT" });
const decode = (html) => html.replace(/&amp;/g, "&").replace(/&#x3D;/g, "=");

beforeAll(async () => {
  ctx = await startApp();
  ids.rs01 = (await q("SELECT id FROM outlets WHERE code = 'RS-01'"))[0].id;
  ids.water = (await q("SELECT id FROM products WHERE code = 'BV-004'"))[0].id;
  ids.sandwich = (await q("SELECT id FROM products WHERE code = 'FD-001'"))[0].id;
  cashier = await new Client(ctx.base).login("cashier01");
  manager = await new Client(ctx.base).login("manager01");
  admin = await new Client(ctx.base).login("admin");
});

afterAll(async () => {
  await ctx?.stop();
});

describe("Web UI consistency", () => {
  test("pagination links on a mounted list page stay on that page", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await cashier.post("/api/orders", { outletId: ids.rs01, productId: ids.water, quantity: "1" });
      expect(res.status).toBe(201);
    }
    const page = await manager.get("/orders?limit=5");
    expect(page.status).toBe(200);
    const html = decode(page.text);
    expect(html).toMatch(/href="\/orders\?limit=5&page=2"/);
    expect(html).not.toMatch(/href="\/\?limit=5&page=2"/);
  });

  test("report CSV export links keep the /reports prefix", async () => {
    const page = await manager.get("/reports/sales");
    expect(page.status).toBe(200);
    expect(decode(page.text)).toMatch(/href="\/reports\/sales\?[^"]*format=csv"/);
  });

  test("a POS API call does not swallow the flash message meant for the next page", async () => {
    const saved = await admin.form("/categories", { name: "Flash Test Category", description: "", sortOrder: "5" });
    expect(saved.status).toBe(302);
    const api = await admin.get(`/api/pos/catalog?outletId=${ids.rs01}`);
    expect(api.status).toBe(200);
    const next = await admin.get("/categories");
    expect(next.text).toContain("Flash Test Category");
    expect(next.text).toMatch(/Category “Flash Test Category” was saved\./);
  });

  test("missing records are 404s rather than silent redirects", async () => {
    expect((await admin.get("/roles/999999")).status).toBe(404);
    expect((await admin.get("/categories?edit=999999")).status).toBe(404);
    expect((await admin.get("/products/taxes?edit=999999")).status).toBe(404);
    expect((await admin.get("/inventory/recipes/999999")).status).toBe(404);
  });

  test("the recipe Manage link is only shown to users who may manage products", async () => {
    const asCashier = await cashier.get(`/products/${ids.sandwich}`);
    expect(asCashier.status).toBe(200);
    expect(asCashier.text).not.toContain(`/inventory/recipes/${ids.sandwich}`);
    const asManager = await manager.get(`/products/${ids.sandwich}`);
    expect(asManager.text).toContain(`/inventory/recipes/${ids.sandwich}`);
  });

  test("signing in again is a notice, not an error", async () => {
    const anon = new Client(ctx.base);
    const res = await anon.get("/orders");
    expect(res.status).toBe(302);
    const login = await anon.get(res.location.replace(ctx.base, ""));
    expect(login.text).toContain("Please sign in to continue.");
    expect(login.text).toMatch(/bg-amber-50[^>]*role="status">Please sign in/);
  });
});
