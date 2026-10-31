// Products/services, taxes and outlet-specific pricing with full price history.
import fs from "fs/promises";
import path from "path";
import { Op, QueryTypes } from "sequelize";
import {
  sequelize, Product, ProductPrice, Category, Tax, Outlet, User, InventoryItem, ProductRecipe,
} from "../models/index.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit, diff } from "./auditService.js";
import { config } from "../config/env.js";

export async function listProducts({ search, categoryId, status, outletId, itemType }, { limit, offset }) {
  const where = {};
  if (search) where[Op.or] = [{ name: { [Op.like]: `%${search}%` } }, { code: { [Op.like]: `%${search}%` } }];
  if (categoryId) where.categoryId = categoryId;
  if (itemType) where.itemType = itemType;
  where.status = status || { [Op.ne]: "ARCHIVED" };
  if (status === "ALL") delete where.status;
  const priceInclude = {
    model: ProductPrice,
    as: "prices",
    where: { effectiveTo: null, ...(outletId ? { outletId } : {}) },
    required: Boolean(outletId),
    include: [{ model: Outlet, as: "outlet", attributes: ["id", "code", "name"] }],
  };
  return Product.findAndCountAll({
    where,
    include: [{ model: Category, as: "category", attributes: ["id", "name"] }, priceInclude],
    order: [["name", "ASC"]],
    limit,
    offset,
    distinct: true,
  });
}

export async function getProduct(id) {
  const product = await Product.findByPk(id, {
    include: [
      { model: Category, as: "category" },
      { model: Tax, as: "tax" },
      { model: ProductRecipe, as: "recipes", include: [{ model: InventoryItem, as: "item" }] },
    ],
  });
  if (!product) throw notFound("Product");
  return product;
}

export async function priceHistory(productId) {
  return ProductPrice.findAll({
    where: { productId },
    include: [
      { model: Outlet, as: "outlet", attributes: ["id", "code", "name"] },
      { model: User, as: "creator", attributes: ["id", "fullName"] },
    ],
    order: [["effectiveFrom", "DESC"], ["id", "DESC"]],
  });
}

const parse = (body) => ({
  code: v.code(body.code, "Product code", { required: true }),
  name: v.str(body.name, "Name", { required: true, max: 120 }),
  description: v.str(body.description, "Description", { max: 2000 }),
  categoryId: v.id(body.categoryId, "Category"),
  itemType: v.oneOf(body.itemType, "Type", ["PRODUCT", "SERVICE"]),
  unit: v.str(body.unit, "Unit", { required: true, max: 20 }),
  taxId: v.id(body.taxId, "Tax", { required: false }),
  isInventoryTracked: v.bool(body.isInventoryTracked),
  status: v.oneOf(body.status, "Status", ["AVAILABLE", "UNAVAILABLE", "ARCHIVED"], { required: false, fallback: "AVAILABLE" }),
});

async function assertReferences(data, transaction) {
  const category = await Category.findByPk(data.categoryId, { transaction });
  if (!category || category.status !== "ACTIVE") throw new AppError("Select an active category.", 422);
  if (data.taxId && !(await Tax.findByPk(data.taxId, { transaction }))) throw new AppError("Selected tax does not exist.", 422);
  if (data.itemType === "SERVICE" && data.isInventoryTracked) throw new AppError("Services cannot be inventory-tracked.", 422);
}

const UPLOAD_DIR = path.join(config.rootDir, "public", "uploads", "products");

async function removeImage(imagePath) {
  if (!imagePath?.startsWith("/uploads/products/")) return;
  await fs.unlink(path.join(config.rootDir, "public", imagePath)).catch(() => {});
}

export async function createProduct(req, body, file) {
  const data = parse(body);
  try {
    return await sequelize.transaction(async (transaction) => {
      await assertReferences(data, transaction);
      const product = await Product.create(
        { ...data, imagePath: file ? `/uploads/products/${file.filename}` : null, createdBy: req.user.id, updatedBy: req.user.id },
        { transaction }
      );
      // Retail goods: create the matching stock item and a 1:1 recipe so sales deduct stock.
      if (data.isInventoryTracked && v.bool(body.createInventoryItem)) {
        const item = await InventoryItem.create({ sku: data.code, name: data.name, unit: data.unit }, { transaction });
        await ProductRecipe.create({ productId: product.id, inventoryItemId: item.id, quantity: "1.000" }, { transaction });
      }
      await audit({ req, action: "PRODUCT_CREATED", entityType: "product", entityId: product.id, newValues: product, transaction });
      return product;
    });
  } catch (err) {
    if (file) await removeImage(`/uploads/products/${file.filename}`);
    throw err;
  }
}

export async function updateProduct(req, id, body, file) {
  const data = parse(body);
  const product = await Product.findByPk(id);
  if (!product) throw notFound("Product");
  const oldImage = product.imagePath;
  try {
    const updated = await sequelize.transaction(async (transaction) => {
      await assertReferences(data, transaction);
      const before = product.get({ plain: true });
      const changes = { ...data, updatedBy: req.user.id };
      if (file) changes.imagePath = `/uploads/products/${file.filename}`;
      else if (v.bool(body.removeImage)) changes.imagePath = null;
      await product.update(changes, { transaction });
      const { oldValues, newValues } = diff(before, product);
      await audit({ req, action: "PRODUCT_UPDATED", entityType: "product", entityId: id, oldValues, newValues, transaction });
      return product;
    });
    if (oldImage && oldImage !== updated.imagePath) await removeImage(oldImage);
    return updated;
  } catch (err) {
    if (file) await removeImage(`/uploads/products/${file.filename}`);
    throw err;
  }
}

// Sets the current price of a product at an outlet. The previous price row is closed
// (effective_to = now) and kept as history; orders snapshot prices so history never changes.
export async function setOutletPrice(req, productId, body) {
  const outletId = v.id(body.outletId, "Outlet");
  const price = v.money(body.price, "Price", { min: 0 });
  const isAvailable = body.isAvailable === undefined ? true : v.bool(body.isAvailable);

  return sequelize.transaction(async (transaction) => {
    const product = await Product.findByPk(productId, { transaction });
    if (!product) throw notFound("Product");
    if (!(await Outlet.findByPk(outletId, { transaction }))) throw notFound("Outlet");

    const current = await ProductPrice.findOne({ where: { productId, outletId, effectiveTo: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (current && current.price === price && current.isAvailable === isAvailable) return current;

    const now = new Date();
    if (current) await current.update({ effectiveTo: now }, { transaction });
    const row = await ProductPrice.create({ productId, outletId, price, isAvailable, effectiveFrom: now, createdBy: req.user.id }, { transaction });
    await audit({
      req,
      action: "PRICE_CHANGED",
      entityType: "product",
      entityId: productId,
      oldValues: current ? { outletId, price: current.price, isAvailable: current.isAvailable } : null,
      newValues: { outletId, price, isAvailable },
      transaction,
    });
    return row;
  });
}

export async function removeFromOutlet(req, productId, outletId) {
  return sequelize.transaction(async (transaction) => {
    const current = await ProductPrice.findOne({ where: { productId, outletId, effectiveTo: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!current) throw new AppError("This product is not sold at that outlet.", 409);
    await current.update({ effectiveTo: new Date() }, { transaction });
    await audit({ req, action: "PRODUCT_REMOVED_FROM_OUTLET", entityType: "product", entityId: productId, oldValues: { outletId, price: current.price } });
  });
}

// POS catalog for one outlet: current price, availability and tax for every sellable item.
export async function outletCatalog(outletId) {
  return sequelize.query(
    `SELECT p.id, p.code, p.name, p.description, p.item_type AS itemType, p.unit, p.image_path AS imagePath,
            p.is_inventory_tracked AS isInventoryTracked, c.id AS categoryId, c.name AS categoryName,
            pp.price, COALESCE(t.rate, 0) AS taxRate, COALESCE(t.is_inclusive, 1) AS taxInclusive
       FROM product_prices pp
       JOIN products p ON p.id = pp.product_id
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN taxes t ON t.id = p.tax_id AND t.status = 'ACTIVE'
      WHERE pp.outlet_id = ? AND pp.effective_to IS NULL AND pp.is_available = 1
        AND p.status = 'AVAILABLE' AND c.status = 'ACTIVE'
      ORDER BY c.sort_order, c.name, p.name`,
    { replacements: [outletId], type: QueryTypes.SELECT }
  );
}

// ── Taxes ────────────────────────────────────────────────────────────────

export async function saveTax(req, id, body) {
  const ratePercent = v.percent(body.ratePercent, "Rate (%)");
  const data = {
    code: v.code(body.code, "Tax code", { required: true, max: 20 }),
    name: v.str(body.name, "Tax name", { required: true, max: 80 }),
    rate: (Number(ratePercent) / 100).toFixed(4),
    isInclusive: v.bool(body.isInclusive),
    status: v.oneOf(body.status, "Status", ["ACTIVE", "INACTIVE"], { required: false, fallback: "ACTIVE" }),
  };
  if (Number(data.rate) >= 1) throw new AppError("Tax rate must be below 100%.", 422);
  return sequelize.transaction(async (transaction) => {
    if (!id) {
      const tax = await Tax.create(data, { transaction });
      await audit({ req, action: "TAX_CREATED", entityType: "tax", entityId: tax.id, newValues: tax, transaction });
      return tax;
    }
    const tax = await Tax.findByPk(id, { transaction });
    if (!tax) throw notFound("Tax");
    const before = tax.get({ plain: true });
    await tax.update(data, { transaction });
    const { oldValues, newValues } = diff(before, tax);
    await audit({ req, action: "TAX_UPDATED", entityType: "tax", entityId: id, oldValues, newValues, transaction });
    return tax;
  });
}

export { UPLOAD_DIR };
