// Idempotent seed data: roles/permissions, outlets, taxes, payment methods, settings,
// a sample catalog (matching the Room 205 scenario in the system diagrams) and an admin.
// Existing rows are never overwritten except role/permission definitions.
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import bcrypt from "bcrypt";
import { config } from "../../config/env.js";
import { PERMISSIONS, ROLES } from "../../config/permissions.js";

const OUTLETS = [
  ["RS-01", "In-Room Dining", "ROOM_SERVICE", "24-hour room service", "Main kitchen", "0.00"],
  ["REST-01", "The Garden Restaurant", "RESTAURANT", "All-day dining restaurant", "Ground floor", "10.00"],
  ["BAR-01", "Lobby Bar", "BAR", "Cocktails, beer and coffee", "Lobby", "10.00"],
  ["MB-01", "Minibar", "MINIBAR", "In-room minibar consumption", "Guest rooms", "0.00"],
  ["SPA-01", "Serenity Spa", "SPA", "Massage and wellness services", "3rd floor", "0.00"],
];

const PAYMENT_METHODS = [
  ["CASH", "Cash", 1, 0, 0, 1],
  ["CREDIT_CARD", "Credit Card", 0, 1, 0, 2],
  ["DEBIT_CARD", "Debit Card", 0, 1, 0, 3],
  ["E_WALLET", "E-Wallet", 0, 1, 0, 4],
  ["BANK_TRANSFER", "Bank Transfer", 0, 0, 1, 5],
  ["OTHER", "Other", 0, 0, 1, 6],
];

const SETTINGS = [
  ["receipt_header", "", "text", "Receipt header", "Address / contact lines printed under the hotel name", 1],
  ["receipt_footer", "Thank you for dining with us!", "text", "Receipt footer", "Closing message printed on receipts", 2],
  ["room_charge_max_attempts", "3", "number", "Room charge post attempts", "Maximum PMS posting attempts per charge (F13: retry < 3)", 3],
  ["require_shift_for_settlement", "true", "boolean", "Require open shift to settle", "Cashiers must have an open shift to take payments", 4],
  ["low_stock_alerts", "true", "boolean", "Low-stock alerts", "Show low-stock warnings on the dashboard", 5],
];

const CATEGORIES = [
  ["Food", "Main courses, sandwiches and salads", 1],
  ["Beverages", "Non-alcoholic drinks", 2],
  ["Desserts", "Cakes and sweets", 3],
  ["Alcoholic Drinks", "Beer, wine and cocktails", 4],
  ["Minibar Items", "In-room minibar goods", 5],
  ["Spa Services", "Massages and treatments", 6],
];

// code, name, category, type, unit, tracked, { outletCode: price }
const PRODUCTS = [
  ["FD-001", "Club Sandwich", "Food", "PRODUCT", "pc", 1, { "RS-01": "520.00", "REST-01": "480.00" }],
  ["FD-002", "Caesar Salad", "Food", "PRODUCT", "bowl", 0, { "RS-01": "420.00", "REST-01": "390.00" }],
  ["FD-003", "Wagyu Beef Burger", "Food", "PRODUCT", "pc", 0, { "RS-01": "680.00", "REST-01": "650.00" }],
  ["FD-004", "Chicken Adobo Rice Bowl", "Food", "PRODUCT", "bowl", 0, { "RS-01": "450.00", "REST-01": "420.00" }],
  ["BV-001", "Iced Tea", "Beverages", "PRODUCT", "glass", 1, { "RS-01": "165.00", "REST-01": "150.00", "BAR-01": "150.00" }],
  ["BV-002", "Cappuccino", "Beverages", "PRODUCT", "cup", 0, { "RS-01": "210.00", "REST-01": "190.00", "BAR-01": "190.00" }],
  ["BV-003", "Mango Shake", "Beverages", "PRODUCT", "glass", 0, { "REST-01": "220.00", "BAR-01": "220.00" }],
  ["BV-004", "Bottled Water", "Beverages", "PRODUCT", "bottle", 1, { "RS-01": "90.00", "REST-01": "80.00", "BAR-01": "80.00" }],
  ["DS-001", "Chocolate Lava Cake", "Desserts", "PRODUCT", "slice", 0, { "RS-01": "320.00", "REST-01": "300.00" }],
  ["AL-001", "San Miguel Pale Pilsen", "Alcoholic Drinks", "PRODUCT", "bottle", 1, { "BAR-01": "180.00", "REST-01": "190.00" }],
  ["AL-002", "Classic Mojito", "Alcoholic Drinks", "PRODUCT", "glass", 0, { "BAR-01": "380.00" }],
  ["MB-001", "Potato Chips", "Minibar Items", "PRODUCT", "pack", 1, { "MB-01": "150.00" }],
  ["MB-002", "Soft Drink Can", "Minibar Items", "PRODUCT", "can", 1, { "MB-01": "120.00" }],
  ["SP-001", "Swedish Massage (60 min)", "Spa Services", "SERVICE", "session", 0, { "SPA-01": "2500.00" }],
  ["SP-002", "Foot Reflexology (45 min)", "Spa Services", "SERVICE", "session", 0, { "SPA-01": "1500.00" }],
];

// sku, name, unit, reorder level, { outletCode: opening stock }
const INVENTORY_ITEMS = [
  ["INV-BV-001", "Iced Tea (serving)", "glass", "10", { "RS-01": "40", "REST-01": "60", "BAR-01": "30" }],
  ["INV-BV-004", "Bottled Water 500ml", "bottle", "24", { "RS-01": "48", "REST-01": "48", "BAR-01": "24" }],
  ["INV-AL-001", "San Miguel Pale Pilsen 330ml", "bottle", "24", { "BAR-01": "72", "REST-01": "24" }],
  ["INV-MB-001", "Potato Chips 60g", "pack", "10", { "MB-01": "50" }],
  ["INV-MB-002", "Soft Drink Can 330ml", "can", "10", { "MB-01": "60" }],
  ["ING-BREAD", "Sandwich Bread", "slice", "30", { "RS-01": "120", "REST-01": "120" }],
  ["ING-CHICKEN", "Chicken Fillet", "pc", "10", { "RS-01": "40", "REST-01": "40" }],
  ["ING-BACON", "Bacon Strip", "strip", "20", { "RS-01": "80", "REST-01": "80" }],
];

// product code -> [[inventory sku, qty per unit sold]]
const RECIPES = {
  "FD-001": [["ING-BREAD", "3"], ["ING-CHICKEN", "1"], ["ING-BACON", "2"]],
  "BV-001": [["INV-BV-001", "1"]],
  "BV-004": [["INV-BV-004", "1"]],
  "AL-001": [["INV-AL-001", "1"]],
  "MB-001": [["INV-MB-001", "1"]],
  "MB-002": [["INV-MB-002", "1"]],
};

const DEMO_USERS = [
  ["cashier01", "Cashier One", "CASHIER", "EMP-0231", ["RS-01", "REST-01"]],
  ["supervisor01", "Outlet Supervisor", "SUPERVISOR", "EMP-0102", ["RS-01", "REST-01", "BAR-01"]],
  ["manager01", "POS Manager", "POS_MANAGER", "EMP-0007", []],
  ["staff01", "Restaurant Staff", "RESTAURANT_STAFF", "EMP-0310", ["REST-01"]],
  ["inventory01", "Inventory Staff", "INVENTORY_STAFF", "EMP-0405", ["RS-01", "REST-01", "BAR-01", "MB-01"]],
  ["accountant01", "Accounting Staff", "ACCOUNTANT", "EMP-0050", []],
];

const idMap = async (conn, table, keyCol) => {
  const [rows] = await conn.query(`SELECT id, ${keyCol} AS k FROM ${table}`);
  return Object.fromEntries(rows.map((r) => [r.k, r.id]));
};

const randomPassword = () => crypto.randomBytes(9).toString("base64url");

export async function runSeeds(conn, { demo = false, log = console.log } = {}) {
  // Roles and permissions (definitions are kept in sync with config/permissions.js)
  for (const [code, [module, description]] of Object.entries(PERMISSIONS)) {
    await conn.query(
      "INSERT INTO permissions (code, module, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE module = VALUES(module), description = VALUES(description)",
      [code, module, description]
    );
  }
  for (const [code, role] of Object.entries(ROLES)) {
    await conn.query(
      "INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), is_system = 1",
      [code, role.name, role.description]
    );
  }
  const roleIds = await idMap(conn, "roles", "code");
  const permIds = await idMap(conn, "permissions", "code");
  for (const [code, role] of Object.entries(ROLES)) {
    const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?", [roleIds[code]]);
    if (n > 0 && code !== "SYSTEM_ADMIN") continue; // keep admin-customised grants
    for (const perm of role.permissions) {
      await conn.query("INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [roleIds[code], permIds[perm]]);
    }
  }

  for (const o of OUTLETS) {
    await conn.query(
      "INSERT IGNORE INTO outlets (code, name, outlet_type, description, location, service_charge_rate) VALUES (?, ?, ?, ?, ?, ?)",
      o
    );
  }
  const outletIds = await idMap(conn, "outlets", "code");
  for (const [code, outletId] of Object.entries(outletIds)) {
    await conn.query(
      "INSERT IGNORE INTO stock_locations (outlet_id, code, name, is_default) VALUES (?, ?, ?, 1)",
      [outletId, `${code}-STORE`, `${code} storeroom`]
    );
  }

  await conn.query("INSERT IGNORE INTO taxes (code, name, rate, is_inclusive) VALUES ('VAT12', 'VAT 12% (inclusive)', 0.1200, 1), ('VAT-EXEMPT', 'VAT exempt', 0.0000, 1)");
  for (const pm of PAYMENT_METHODS) {
    await conn.query(
      "INSERT IGNORE INTO payment_methods (code, name, is_cash, uses_gateway, requires_reference, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      pm
    );
  }
  for (const s of SETTINGS) {
    await conn.query(
      "INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, label, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      s
    );
  }

  // Admin account
  const credentials = [];
  const [[existingAdmin]] = await conn.query("SELECT id FROM users WHERE username = 'admin'");
  let adminId = existingAdmin?.id;
  if (!adminId) {
    const password = config.seedAdminPassword || randomPassword();
    const [res] = await conn.query(
      "INSERT INTO users (username, full_name, password_hash, role_id, password_changed_at) VALUES ('admin', 'System Administrator', ?, ?, NOW())",
      [await bcrypt.hash(password, 12), roleIds.SYSTEM_ADMIN]
    );
    adminId = res.insertId;
    credentials.push(["admin", password]);
  }

  // Sample catalog
  const [[{ productCount }]] = await conn.query("SELECT COUNT(*) AS productCount FROM products");
  if (productCount === 0) {
    for (const c of CATEGORIES) await conn.query("INSERT IGNORE INTO categories (name, description, sort_order) VALUES (?, ?, ?)", c);
    const categoryIds = await idMap(conn, "categories", "name");
    const [[vat]] = await conn.query("SELECT id FROM taxes WHERE code = 'VAT12'");

    for (const [code, name, category, type, unit, tracked, prices] of PRODUCTS) {
      const [res] = await conn.query(
        "INSERT INTO products (code, name, category_id, item_type, unit, tax_id, is_inventory_tracked, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [code, name, categoryIds[category], type, unit, vat.id, tracked, adminId]
      );
      for (const [outletCode, price] of Object.entries(prices)) {
        await conn.query("INSERT INTO product_prices (product_id, outlet_id, price, created_by) VALUES (?, ?, ?, ?)", [
          res.insertId, outletIds[outletCode], price, adminId,
        ]);
      }
    }

    const [locations] = await conn.query("SELECT l.id, o.code FROM stock_locations l JOIN outlets o ON o.id = l.outlet_id WHERE l.is_default = 1");
    const locationByOutlet = Object.fromEntries(locations.map((l) => [l.code, l.id]));
    for (const [sku, name, unit, reorder, stock] of INVENTORY_ITEMS) {
      const [res] = await conn.query(
        "INSERT INTO inventory_items (sku, name, unit, default_reorder_level) VALUES (?, ?, ?, ?)",
        [sku, name, unit, reorder]
      );
      for (const [outletCode, qty] of Object.entries(stock)) {
        const locationId = locationByOutlet[outletCode];
        await conn.query(
          "INSERT INTO stock_levels (stock_location_id, inventory_item_id, quantity, reorder_level) VALUES (?, ?, ?, ?)",
          [locationId, res.insertId, qty, reorder]
        );
        await conn.query(
          `INSERT INTO inventory_transactions (transaction_number, inventory_item_id, stock_location_id, transaction_type, quantity, balance_after, reference_type, idempotency_key, reason, created_by)
           VALUES (?, ?, ?, 'STOCK_IN', ?, ?, 'SEED', ?, 'Opening stock', ?)`,
          [`SEED-${res.insertId}-${locationId}`, res.insertId, locationId, qty, qty, `SEED:${sku}:${locationId}`, adminId]
        );
      }
    }

    const productIds = await idMap(conn, "products", "code");
    const itemIds = await idMap(conn, "inventory_items", "sku");
    for (const [productCode, lines] of Object.entries(RECIPES)) {
      for (const [sku, qty] of lines) {
        await conn.query("INSERT INTO product_recipes (product_id, inventory_item_id, quantity) VALUES (?, ?, ?)", [
          productIds[productCode], itemIds[sku], qty,
        ]);
      }
    }

    await conn.query(
      `INSERT INTO discounts (code, name, description, discount_type, value, scope, requires_authorization, created_by) VALUES
        ('HAPPY10', 'Happy Hour 10%', 'Bar happy hour promotion', 'PERCENTAGE', 10.00, 'ORDER', 0, ?),
        ('MGR20', 'Manager Courtesy 20%', 'Courtesy discount; supervisor authorization required', 'PERCENTAGE', 20.00, 'ORDER', 1, ?),
        ('LESS50', 'Less PHP 50', 'Fixed item discount', 'FIXED', 50.00, 'ITEM', 0, ?)`,
      [adminId, adminId, adminId]
    );
    const [[happy]] = await conn.query("SELECT id FROM discounts WHERE code = 'HAPPY10'");
    await conn.query("INSERT INTO discount_outlets (discount_id, outlet_id) VALUES (?, ?)", [happy.id, outletIds["BAR-01"]]);
    log("✅ Seeded sample catalog, inventory and discounts.");
  }

  if (demo) {
    const demoPassword = config.seedAdminPassword || randomPassword();
    const hash = await bcrypt.hash(demoPassword, 12);
    let created = 0;
    for (const [username, fullName, role, employeeId, outlets] of DEMO_USERS) {
      const [[exists]] = await conn.query("SELECT id FROM users WHERE username = ?", [username]);
      if (exists) continue;
      const [res] = await conn.query(
        "INSERT INTO users (username, full_name, password_hash, role_id, external_employee_id, password_changed_at) VALUES (?, ?, ?, ?, ?, NOW())",
        [username, fullName, hash, roleIds[role], employeeId]
      );
      for (const code of outlets) await conn.query("INSERT INTO user_outlets (user_id, outlet_id) VALUES (?, ?)", [res.insertId, outletIds[code]]);
      created++;
    }
    if (created) credentials.push(["demo users (cashier01, supervisor01, manager01, staff01, inventory01, accountant01)", demoPassword]);
  }

  if (credentials.length) {
    const lines = credentials.map(([u, p]) => `${u}: ${p}`).join("\n");
    log(`\n🔑 Seeded credentials (shown once; also saved to storage/seed-credentials.txt):\n${lines}\n`);
    const storageDir = path.join(config.rootDir, "storage");
    await fs.mkdir(storageDir, { recursive: true });
    await fs.appendFile(path.join(storageDir, "seed-credentials.txt"), `[${new Date().toISOString()}] ${config.db.name}\n${lines}\n\n`);
  }
  log("✅ Seed data is in place.");
}
