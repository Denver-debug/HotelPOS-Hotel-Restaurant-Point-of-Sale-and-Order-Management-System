import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const INVENTORY_TRANSACTION_TYPES = ["STOCK_IN", "STOCK_OUT", "SALE", "ADJUSTMENT", "DAMAGE", "WASTE", "RETURN", "REFUND_RETURN"];

export const StockLocation = sequelize.define("StockLocation", {
  outletId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE"), allowNull: false, defaultValue: "ACTIVE" },
}, { tableName: "stock_locations" });

export const InventoryItem = sequelize.define("InventoryItem", {
  sku: { type: DataTypes.STRING(40), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  unit: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pc" },
  description: { type: DataTypes.STRING(255) },
  defaultReorderLevel: { type: DataTypes.DECIMAL(12, 3), allowNull: false, defaultValue: "0" },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE"), allowNull: false, defaultValue: "ACTIVE" },
}, { tableName: "inventory_items" });

// Bill of materials: inventory consumed by one unit of a product.
export const ProductRecipe = sequelize.define("ProductRecipe", {
  productId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  inventoryItemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
}, { tableName: "product_recipes" });

export const StockLevel = sequelize.define("StockLevel", {
  stockLocationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  inventoryItemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false, defaultValue: "0" },
  reorderLevel: { type: DataTypes.DECIMAL(12, 3), allowNull: false, defaultValue: "0" },
  allowNegative: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "stock_levels" });

// Append-only ledger (UPDATE/DELETE are blocked by database triggers).
export const InventoryTransaction = sequelize.define("InventoryTransaction", {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  transactionNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  inventoryItemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  stockLocationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  transactionType: { type: DataTypes.ENUM(...INVENTORY_TRANSACTION_TYPES), allowNull: false },
  quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
  balanceAfter: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
  unitCost: { type: DataTypes.DECIMAL(12, 2) },
  referenceType: { type: DataTypes.STRING(30) },
  referenceId: { type: DataTypes.STRING(40) },
  idempotencyKey: { type: DataTypes.STRING(120), unique: true },
  reason: { type: DataTypes.STRING(255) },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "inventory_transactions", updatedAt: false });
