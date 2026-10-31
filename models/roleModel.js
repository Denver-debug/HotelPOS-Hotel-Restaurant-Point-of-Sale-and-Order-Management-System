import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const Role = sequelize.define("Role", {
  code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(80), allowNull: false },
  description: { type: DataTypes.STRING(255) },
  isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "roles" });

export const Permission = sequelize.define("Permission", {
  code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
  module: { type: DataTypes.STRING(40), allowNull: false },
  description: { type: DataTypes.STRING(255) },
}, { tableName: "permissions", timestamps: false });

export const RolePermission = sequelize.define("RolePermission", {
  roleId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  permissionId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: "role_permissions", timestamps: false });
