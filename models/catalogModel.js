import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const OUTLET_TYPES = ["RESTAURANT", "BAR", "ROOM_SERVICE", "MINIBAR", "SPA", "OTHER"];

export const Outlet = sequelize.define("Outlet", {
  code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  outletType: { type: DataTypes.ENUM(...OUTLET_TYPES), allowNull: false },
  description: { type: DataTypes.TEXT },
  location: { type: DataTypes.STRING(150) },
  serviceChargeRate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: "0.00" },
  allowsRoomCharge: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE"), allowNull: false, defaultValue: "ACTIVE" },
}, { tableName: "outlets" });

export const Category = sequelize.define("Category", {
  name: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  description: { type: DataTypes.STRING(255) },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.ENUM("ACTIVE", "ARCHIVED"), allowNull: false, defaultValue: "ACTIVE" },
}, { tableName: "categories" });

export const Tax = sequelize.define("Tax", {
  code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(80), allowNull: false },
  rate: { type: DataTypes.DECIMAL(7, 4), allowNull: false },
  isInclusive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE"), allowNull: false, defaultValue: "ACTIVE" },
}, { tableName: "taxes" });

export const Product = sequelize.define("Product", {
  code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  description: { type: DataTypes.TEXT },
  categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  itemType: { type: DataTypes.ENUM("PRODUCT", "SERVICE"), allowNull: false, defaultValue: "PRODUCT" },
  unit: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pc" },
  imagePath: { type: DataTypes.STRING(255) },
  taxId: { type: DataTypes.INTEGER.UNSIGNED },
  isInventoryTracked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  status: { type: DataTypes.ENUM("AVAILABLE", "UNAVAILABLE", "ARCHIVED"), allowNull: false, defaultValue: "AVAILABLE" },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED },
  updatedBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "products" });

// Outlet-specific price history; the current row has effectiveTo = null.
export const ProductPrice = sequelize.define("ProductPrice", {
  productId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  outletId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  effectiveFrom: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  effectiveTo: { type: DataTypes.DATE },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "product_prices", updatedAt: false });
