import { Op } from "sequelize";
import { InventoryItem, Product, ProductRecipe, StockLevel, StockLocation } from "../models/index.js";
import { INVENTORY_TRANSACTION_TYPES } from "../models/inventoryModel.js";
import * as inventoryService from "../services/inventoryService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";
import { handleForm } from "../utils/forms.js";
import { can } from "../middleware/auth.js";

const crumbs = (label) => [{ label: "Inventory", href: "/inventory" }, ...(label ? [{ label }] : [])];
const activeItems = async () => (await InventoryItem.findAll({ where: { status: "ACTIVE" }, order: [["name", "ASC"]] })).map((i) => i.get({ plain: true }));

export const index = async (req, res) => {
  const page = parsePage(req.query, 25);
  const filters = filtersFrom(req.query, ["outletId", "search", "low"]);
  const { rows, count } = await inventoryService.stockLevels(req, filters, page);
  res.render("inventory/index", {
    title: "Inventory",
    breadcrumbs: crumbs(),
    levels: rows,
    filters,
    outlets: req.outlets,
    pagination: buildPagination(req, count, page),
    canManage: can(req, "inventory.manage"),
    canAdjust: can(req, "inventory.adjust"),
  });
};

export const movementForm = async (req, res) => {
  const types = Object.keys(inventoryService.MANUAL_TYPES).filter((t) => req.permissions.has(inventoryService.MANUAL_TYPES[t]));
  res.render("inventory/movement", {
    title: "Record stock movement",
    breadcrumbs: crumbs("Record movement"),
    items: await activeItems(),
    outlets: req.outlets,
    types,
    movement: { transactionType: req.query.type || types[0], inventoryItemId: req.query.itemId, outletId: req.query.outletId },
  });
};

export const recordMovement = async (req, res) => {
  const types = Object.keys(inventoryService.MANUAL_TYPES).filter((t) => req.permissions.has(inventoryService.MANUAL_TYPES[t]));
  const row = await handleForm(res, () => inventoryService.recordManualMovement(req, req.body), {
    view: "inventory/movement",
    locals: async () => ({ title: "Record stock movement", breadcrumbs: crumbs("Record movement"), items: await activeItems(), outlets: req.outlets, types, movement: req.body }),
  });
  if (!row) return;
  req.flash("success_msg", `Movement ${row.transactionNumber} recorded. New balance: ${Number(row.balanceAfter)}.`);
  res.redirect("/inventory/movements");
};

export const movements = async (req, res) => {
  const page = parsePage(req.query, 30);
  const range = parseDateRange(req.query, 30);
  const filters = { ...filtersFrom(req.query, ["itemId", "outletId", "type"]), from: range.from, to: range.to };
  const { rows, count } = await inventoryService.movements(req, { ...filters, start: range.start, end: range.end }, page);
  res.render("inventory/movements", {
    title: "Inventory movements",
    breadcrumbs: crumbs("Movements"),
    movements: rows.map((r) => r.get({ plain: true })),
    filters,
    items: await activeItems(),
    outlets: req.outlets,
    types: INVENTORY_TRANSACTION_TYPES,
    pagination: buildPagination(req, count, page),
  });
};

export const items = async (req, res) => {
  const where = req.query.search ? { [Op.or]: [{ name: { [Op.like]: `%${req.query.search}%` } }, { sku: { [Op.like]: `%${req.query.search}%` } }] } : {};
  const list = (await InventoryItem.findAll({ where, order: [["status", "ASC"], ["name", "ASC"]] })).map((i) => i.get({ plain: true }));
  const editing = req.query.edit ? list.find((i) => String(i.id) === String(req.query.edit)) : null;
  res.render("inventory/items", { title: "Inventory items", breadcrumbs: crumbs("Items"), items: list, item: editing || { status: "ACTIVE", unit: "pc" }, editing: Boolean(editing), search: req.query.search || "" });
};

export const saveItem = async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  const item = await handleForm(res, () => inventoryService.saveItem(req, id, req.body), {
    view: "inventory/items",
    locals: async () => ({
      title: "Inventory items",
      breadcrumbs: crumbs("Items"),
      items: (await InventoryItem.findAll({ order: [["name", "ASC"]] })).map((i) => i.get({ plain: true })),
      item: { ...req.body, id },
      editing: Boolean(id),
    }),
  });
  if (!item) return;
  req.flash("success_msg", `Inventory item ${item.sku} was saved.`);
  res.redirect("/inventory/items");
};

export const updateLevel = async (req, res) => {
  await inventoryService.updateStockLevelSettings(req, req.params.id, req.body);
  req.flash("success_msg", "Stock level settings were updated.");
  res.redirect(req.get("referer")?.includes("/inventory") ? req.get("referer") : "/inventory");
};

export const recipeForm = async (req, res) => {
  const product = await Product.findByPk(req.params.productId, { include: [{ model: ProductRecipe, as: "recipes", include: ["item"] }] });
  if (!product) return res.redirect("/products");
  const plain = product.get({ plain: true });
  res.render("inventory/recipe", {
    title: `Recipe: ${plain.name}`,
    breadcrumbs: [{ label: "Products & Services", href: "/products" }, { label: plain.name, href: `/products/${plain.id}` }, { label: "Recipe" }],
    product: plain,
    lines: [...plain.recipes, {}, {}],
    items: await activeItems(),
  });
};

export const saveRecipe = async (req, res) => {
  await inventoryService.saveRecipe(req, req.params.productId, req.body);
  req.flash("success_msg", "Recipe saved. Future sales will deduct these quantities.");
  res.redirect(`/products/${req.params.productId}`);
};

// Stock locations (for reference and future multi-location stores)
export const locations = async (req, res) => {
  const rows = await StockLocation.findAll({ include: ["outlet"], order: [["code", "ASC"]] });
  const counts = await StockLevel.count({ group: ["stockLocationId"] });
  const byLocation = Object.fromEntries(counts.map((c) => [c.stockLocationId, c.count]));
  res.render("inventory/locations", {
    title: "Stock locations",
    breadcrumbs: crumbs("Locations"),
    locations: rows.map((l) => ({ ...l.get({ plain: true }), itemCount: byLocation[l.id] || 0 })),
  });
};
