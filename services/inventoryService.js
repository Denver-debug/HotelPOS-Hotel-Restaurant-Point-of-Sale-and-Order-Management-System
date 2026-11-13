// Outlet-based inventory: stock levels, the append-only movement ledger, recipes,
// sale deductions (idempotent) and refund returns.
import { Op, QueryTypes, UniqueConstraintError } from "sequelize";
import {
  sequelize, InventoryItem, StockLevel, StockLocation, InventoryTransaction, ProductRecipe, Product, Outlet,
} from "../models/index.js";
import { AppError, notFound, forbidden } from "../utils/http.js";
import { toMilli, fromMilli } from "../utils/money.js";
import * as v from "../utils/validate.js";
import { audit, diff } from "./auditService.js";
import { nextNumber } from "./numberingService.js";
import { recordEvent } from "../integrations/events/eventPublisher.js";

// Sign of each movement type; ADJUSTMENT is computed from a physical count.
const DIRECTION = { STOCK_IN: 1, RETURN: 1, REFUND_RETURN: 1, STOCK_OUT: -1, SALE: -1, DAMAGE: -1, WASTE: -1 };
export const MANUAL_TYPES = {
  STOCK_IN: "inventory.manage",
  STOCK_OUT: "inventory.manage",
  RETURN: "inventory.manage",
  ADJUSTMENT: "inventory.adjust",
  DAMAGE: "inventory.adjust",
  WASTE: "inventory.adjust",
};

export async function defaultLocation(outletId, transaction) {
  const location = await StockLocation.findOne({ where: { outletId, isDefault: true, status: "ACTIVE" }, transaction });
  if (!location) throw new AppError("This outlet has no active default stock location.", 409, "NO_STOCK_LOCATION");
  return location;
}

/**
 * Applies one stock movement inside an existing transaction.
 * Returns the ledger row, or the existing row when the idempotency key was already used.
 */
export async function applyMovement(
  { itemId, locationId, type, deltaMilli, reason, referenceType, referenceId, idempotencyKey, userId, allowNegative = false, unitCost = null },
  transaction
) {
  if (idempotencyKey) {
    const existing = await InventoryTransaction.findOne({ where: { idempotencyKey }, transaction });
    if (existing) return { row: existing, duplicate: true };
  }

  let level = await StockLevel.findOne({ where: { stockLocationId: locationId, inventoryItemId: itemId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!level) {
    const item = await InventoryItem.findByPk(itemId, { transaction });
    if (!item) throw notFound("Inventory item");
    level = await StockLevel.create(
      { stockLocationId: locationId, inventoryItemId: itemId, quantity: "0", reorderLevel: item.defaultReorderLevel },
      { transaction }
    );
    level = await StockLevel.findByPk(level.id, { transaction, lock: transaction.LOCK.UPDATE });
  }

  const balance = toMilli(level.quantity) + deltaMilli;
  if (balance < 0 && !level.allowNegative && !allowNegative) {
    const item = await InventoryItem.findByPk(itemId, { transaction });
    throw new AppError(
      `Insufficient stock for ${item?.name ?? "item"}: ${fromMilli(toMilli(level.quantity)).replace(/\.?0+$/, "")} available.`,
      409,
      "INSUFFICIENT_STOCK"
    );
  }
  await level.update({ quantity: fromMilli(balance) }, { transaction });

  const row = await InventoryTransaction.create(
    {
      transactionNumber: await nextNumber("inventory", transaction),
      inventoryItemId: itemId,
      stockLocationId: locationId,
      transactionType: type,
      quantity: fromMilli(deltaMilli),
      balanceAfter: fromMilli(balance),
      unitCost,
      referenceType,
      referenceId: referenceId === undefined || referenceId === null ? null : String(referenceId),
      idempotencyKey: idempotencyKey ?? null,
      reason,
      createdBy: userId ?? null,
    },
    { transaction }
  );
  return { row, duplicate: false, negative: balance < 0 };
}

// Stock needed for a set of order lines: Map(inventoryItemId -> milli units).
async function requirementsFor(lines, transaction) {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  if (!productIds.length) return { recipes: new Map(), needs: new Map() };
  const tracked = await Product.findAll({ where: { id: productIds, isInventoryTracked: true }, attributes: ["id"], transaction });
  const trackedIds = new Set(tracked.map((p) => p.id));
  const recipeRows = await ProductRecipe.findAll({ where: { productId: [...trackedIds] }, transaction });
  const recipes = new Map();
  for (const r of recipeRows) {
    if (!recipes.has(r.productId)) recipes.set(r.productId, []);
    recipes.get(r.productId).push(r);
  }
  const needs = new Map();
  for (const line of lines) {
    for (const r of recipes.get(line.productId) || []) {
      const milli = Math.round((toMilli(line.quantity) * toMilli(r.quantity)) / 1000);
      needs.set(r.inventoryItemId, (needs.get(r.inventoryItemId) || 0) + milli);
    }
  }
  return { recipes, needs };
}

// Pre-settlement check so a guest is not charged for something that cannot be served.
export async function findShortages(outletId, lines, transaction) {
  const { needs } = await requirementsFor(lines, transaction);
  if (!needs.size) return [];
  const location = await defaultLocation(outletId, transaction);
  const levels = await StockLevel.findAll({
    where: { stockLocationId: location.id, inventoryItemId: [...needs.keys()] },
    include: [{ model: InventoryItem, as: "item", attributes: ["name", "unit"] }],
    transaction,
  });
  const byItem = new Map(levels.map((l) => [l.inventoryItemId, l]));
  const shortages = [];
  for (const [itemId, need] of needs) {
    const level = byItem.get(itemId);
    const have = level ? toMilli(level.quantity) : 0;
    if (have < need && !level?.allowNegative) {
      const item = level?.item ?? (await InventoryItem.findByPk(itemId, { transaction }));
      shortages.push({ itemId, name: item?.name, unit: item?.unit, available: fromMilli(have), required: fromMilli(need) });
    }
  }
  return shortages;
}

/**
 * Deducts stock for a completed order (F13 Completed entry: deductStock()).
 * Idempotent per order line and inventory item. When `settledExternally` is true
 * (payment captured / PMS charge posted) a shortage cannot block completion, so the
 * stock may go negative and the event is audited instead.
 */
export async function deductForOrder(order, items, { userId, settledExternally = false, req }, transaction) {
  const { recipes } = await requirementsFor(items, transaction);
  if (!recipes.size) return [];
  const location = await defaultLocation(order.outletId, transaction);
  const results = [];
  for (const line of items) {
    for (const recipe of recipes.get(line.productId) || []) {
      const deltaMilli = -Math.round((toMilli(line.quantity) * toMilli(recipe.quantity)) / 1000);
      const result = await applyMovement(
        {
          itemId: recipe.inventoryItemId,
          locationId: location.id,
          type: "SALE",
          deltaMilli,
          reason: `Sale ${order.orderNumber}`,
          referenceType: "order",
          referenceId: order.id,
          idempotencyKey: `SALE:${line.id}:${recipe.inventoryItemId}`,
          userId,
          allowNegative: settledExternally,
        },
        transaction
      );
      if (result.negative) {
        await audit({ req, userId, action: "STOCK_NEGATIVE_AFTER_SETTLEMENT", entityType: "inventory_item", entityId: recipe.inventoryItemId, newValues: { orderId: order.id, balance: result.row.balanceAfter }, transaction });
      }
      results.push(result);
    }
  }
  return results;
}

// Puts refunded goods back into stock (refund with restock).
export async function returnForRefund(order, refundLines, { userId }, transaction) {
  const { recipes } = await requirementsFor(refundLines, transaction);
  if (!recipes.size) return;
  const location = await defaultLocation(order.outletId, transaction);
  for (const line of refundLines) {
    for (const recipe of recipes.get(line.productId) || []) {
      await applyMovement(
        {
          itemId: recipe.inventoryItemId,
          locationId: location.id,
          type: "REFUND_RETURN",
          deltaMilli: Math.round((toMilli(line.quantity) * toMilli(recipe.quantity)) / 1000),
          reason: `Refund ${line.refundNumber}`,
          referenceType: "refund",
          referenceId: line.refundId,
          idempotencyKey: `REFUND:${line.refundItemId}:${recipe.inventoryItemId}`,
          userId,
        },
        transaction
      );
    }
  }
}

// ── Manual movements (stock in/out, adjustment, damage, waste, return) ───

export async function recordManualMovement(req, body) {
  const type = v.oneOf(body.transactionType, "Movement type", Object.keys(MANUAL_TYPES));
  if (!req.permissions.has(MANUAL_TYPES[type])) throw forbidden(`You are not allowed to record ${type.replace("_", " ").toLowerCase()} movements.`);
  const itemId = v.id(body.inventoryItemId, "Item");
  const outletId = v.id(body.outletId, "Outlet");
  if (!req.user.outletIds.includes(outletId)) throw forbidden("You are not assigned to this outlet.");
  const reason = v.str(body.reason, "Reason", { required: type !== "STOCK_IN", max: 255 });
  const unitCost = type === "STOCK_IN" ? v.money(body.unitCost, "Unit cost", { required: false }) : null;
  const reference = v.str(body.reference, "Reference", { max: 40 });
  // Optional client key (e.g. an ERP goods receipt retried after a timeout). Namespaced so it can
  // never collide with the keys HotelPOS uses for sale and refund movements.
  const clientKey = v.str(body.idempotencyKey, "Idempotency key", { min: 8, max: 90 });
  const idempotencyKey = clientKey ? `EXT:${clientKey}` : null;

  const replay = async () => {
    const row = await InventoryTransaction.findOne({ where: { idempotencyKey } });
    if (String(row.inventoryItemId) !== String(itemId) || row.transactionType !== type) {
      throw new AppError("This idempotency key was already used for a different stock movement.", 409, "IDEMPOTENCY_CONFLICT");
    }
    row.duplicate = true;
    return row;
  };
  if (idempotencyKey && (await InventoryTransaction.count({ where: { idempotencyKey } }))) return replay();

  try {
    return await sequelize.transaction(async (transaction) => {
      const location = await defaultLocation(outletId, transaction);
      let deltaMilli;
      if (type === "ADJUSTMENT") {
        const counted = toMilli(v.quantity(body.quantity, "Counted quantity", { allowZero: true }));
        const level = await StockLevel.findOne({ where: { stockLocationId: location.id, inventoryItemId: itemId }, transaction, lock: transaction.LOCK.UPDATE });
        deltaMilli = counted - (level ? toMilli(level.quantity) : 0);
        if (deltaMilli === 0) throw new AppError("The counted quantity matches the system quantity; nothing to adjust.", 422, "NOTHING_TO_ADJUST");
      } else {
        deltaMilli = DIRECTION[type] * toMilli(v.quantity(body.quantity, "Quantity"));
      }
      const { row } = await applyMovement(
        { itemId, locationId: location.id, type, deltaMilli, reason, unitCost, referenceType: reference ? "manual" : null, referenceId: reference, idempotencyKey, userId: req.user.id },
        transaction
      );
      await audit({ req, action: `INVENTORY_${type}`, entityType: "inventory_item", entityId: itemId, newValues: { outletId, quantity: row.quantity, balanceAfter: row.balanceAfter, reason }, transaction });
      const item = await InventoryItem.findByPk(itemId, { attributes: ["sku", "name", "unit"], transaction });
      await recordEvent(
        "StockMovementRecorded",
        "inventory_item",
        itemId,
        {
          transactionNumber: row.transactionNumber, type, outletId, stockLocationId: location.id, item: { id: itemId, sku: item?.sku, name: item?.name, unit: item?.unit },
          quantity: row.quantity, balanceAfter: row.balanceAfter, negativeStock: Number(row.balanceAfter) < 0, unitCost: row.unitCost ?? null,
          reason: reason ?? null, reference: reference ?? null, recordedBy: req.user.id, recordedAt: row.createdAt,
        },
        transaction
      );
      return row;
    });
  } catch (err) {
    if (idempotencyKey && err instanceof UniqueConstraintError) return replay();
    throw err;
  }
}

// ── Queries ──────────────────────────────────────────────────────────────

export async function stockLevels(req, { outletId, search, low }, { limit, offset }) {
  const where = ["1=1"];
  const params = [];
  if (!req.user.allOutlets) {
    where.push(`l.outlet_id IN (${req.user.outletIds.map(() => "?").join(",") || "0"})`);
    params.push(...req.user.outletIds);
  }
  if (outletId) { where.push("l.outlet_id = ?"); params.push(outletId); }
  if (search) { where.push("(i.name LIKE ? OR i.sku LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
  if (low) where.push("sl.quantity <= sl.reorder_level");
  const base = `FROM stock_levels sl
    JOIN inventory_items i ON i.id = sl.inventory_item_id
    JOIN stock_locations l ON l.id = sl.stock_location_id
    JOIN outlets o ON o.id = l.outlet_id
    WHERE ${where.join(" AND ")}`;
  const [{ total }] = await sequelize.query(`SELECT COUNT(*) AS total ${base}`, { replacements: params, type: QueryTypes.SELECT });
  const rows = await sequelize.query(
    `SELECT sl.id, sl.quantity, sl.reorder_level, sl.allow_negative, sl.updated_at,
            i.id AS item_id, i.sku, i.name, i.unit, o.id AS outlet_id, o.name AS outlet_name, o.code AS outlet_code,
            (sl.quantity <= sl.reorder_level) AS is_low
     ${base} ORDER BY is_low DESC, o.name, i.name LIMIT ? OFFSET ?`,
    { replacements: [...params, limit, offset], type: QueryTypes.SELECT }
  );
  return { rows, count: Number(total) };
}

export async function lowStock(req, limit = 10) {
  const { rows } = await stockLevels(req, { low: true }, { limit, offset: 0 });
  return rows;
}

export async function movements(req, { itemId, outletId, type, start, end }, { limit, offset }) {
  const where = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
  if (itemId) where.inventoryItemId = itemId;
  if (type) where.transactionType = type;
  const locationWhere = {};
  if (outletId) locationWhere.outletId = outletId;
  if (!req.user.allOutlets) locationWhere.outletId = outletId && req.user.outletIds.includes(Number(outletId)) ? outletId : req.user.outletIds;
  return InventoryTransaction.findAndCountAll({
    where,
    include: [
      { model: InventoryItem, as: "item", attributes: ["id", "sku", "name", "unit"] },
      { model: StockLocation, as: "location", where: locationWhere, include: [{ model: Outlet, as: "outlet", attributes: ["code", "name"] }] },
      { association: "user", attributes: ["fullName"] },
    ],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit,
    offset,
  });
}

// ── Items, stock-level settings and recipes ───────────────────────────────

export async function saveItem(req, id, body) {
  const data = {
    sku: v.code(body.sku, "SKU", { required: true }),
    name: v.str(body.name, "Name", { required: true, max: 120 }),
    unit: v.str(body.unit, "Unit", { required: true, max: 20 }),
    description: v.str(body.description, "Description", { max: 255 }),
    defaultReorderLevel: v.quantity(body.defaultReorderLevel || "0", "Reorder level", { allowZero: true }),
    status: v.oneOf(body.status, "Status", ["ACTIVE", "INACTIVE"], { required: false, fallback: "ACTIVE" }),
  };
  return sequelize.transaction(async (transaction) => {
    if (!id) {
      const item = await InventoryItem.create(data, { transaction });
      await audit({ req, action: "INVENTORY_ITEM_CREATED", entityType: "inventory_item", entityId: item.id, newValues: item, transaction });
      return item;
    }
    const item = await InventoryItem.findByPk(id, { transaction });
    if (!item) throw notFound("Inventory item");
    const before = item.get({ plain: true });
    await item.update(data, { transaction });
    const { oldValues, newValues } = diff(before, item);
    await audit({ req, action: "INVENTORY_ITEM_UPDATED", entityType: "inventory_item", entityId: id, oldValues, newValues, transaction });
    return item;
  });
}

export async function updateStockLevelSettings(req, levelId, body) {
  const level = await StockLevel.findByPk(levelId, { include: [{ model: StockLocation, as: "location" }] });
  if (!level) throw notFound("Stock level");
  if (!req.user.outletIds.includes(level.location.outletId)) throw forbidden("You are not assigned to this outlet.");
  const before = { reorderLevel: level.reorderLevel, allowNegative: level.allowNegative };
  await level.update({
    reorderLevel: v.quantity(body.reorderLevel || "0", "Reorder level", { allowZero: true }),
    allowNegative: v.bool(body.allowNegative),
  });
  await audit({ req, action: "STOCK_LEVEL_SETTINGS_UPDATED", entityType: "stock_level", entityId: levelId, oldValues: before, newValues: { reorderLevel: level.reorderLevel, allowNegative: level.allowNegative } });
}

export async function saveRecipe(req, productId, body) {
  const product = await Product.findByPk(productId);
  if (!product) throw notFound("Product");
  const itemIds = [].concat(body.inventoryItemId || []);
  const quantities = [].concat(body.quantity || []);
  const lines = [];
  itemIds.forEach((rawId, i) => {
    if (!rawId) return;
    lines.push({ inventoryItemId: v.id(rawId, "Item"), quantity: v.quantity(quantities[i], "Recipe quantity") });
  });
  if (new Set(lines.map((l) => l.inventoryItemId)).size !== lines.length) throw new AppError("Each inventory item may appear only once in a recipe.", 422);

  return sequelize.transaction(async (transaction) => {
    const before = (await ProductRecipe.findAll({ where: { productId }, transaction })).map((r) => ({ inventoryItemId: r.inventoryItemId, quantity: r.quantity }));
    if (lines.length && (await InventoryItem.count({ where: { id: lines.map((l) => l.inventoryItemId) }, transaction })) !== lines.length) {
      throw new AppError("Unknown inventory item in recipe.", 422);
    }
    await ProductRecipe.destroy({ where: { productId }, transaction });
    await ProductRecipe.bulkCreate(lines.map((l) => ({ ...l, productId })), { transaction });
    if (lines.length && !product.isInventoryTracked) await product.update({ isInventoryTracked: true }, { transaction });
    await audit({ req, action: "RECIPE_UPDATED", entityType: "product", entityId: productId, oldValues: { lines: before }, newValues: { lines }, transaction });
  });
}
