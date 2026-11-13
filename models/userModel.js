import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

// Local login account. The employee master record lives in HR and Staff Payroll;
// only its reference (externalEmployeeId) is kept here.
export const User = sequelize.define("User", {
  username: { type: DataTypes.STRING(50), allowNull: false, unique: true },
  email: { type: DataTypes.STRING(160), unique: true },
  fullName: { type: DataTypes.STRING(120), allowNull: false },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false },
  roleId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  externalEmployeeId: { type: DataTypes.STRING(50), unique: true },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE", "LOCKED"), allowNull: false, defaultValue: "ACTIVE" },
  // API service account (see api_clients): never signs in to the web UI.
  isServiceAccount: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  failedLoginCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  lockedUntil: { type: DataTypes.DATE },
  lastLoginAt: { type: DataTypes.DATE },
  passwordChangedAt: { type: DataTypes.DATE },
}, {
  tableName: "users",
  defaultScope: { attributes: { exclude: ["passwordHash"] } },
  scopes: { withPassword: { attributes: { include: ["passwordHash"] } } },
});

export const UserOutlet = sequelize.define("UserOutlet", {
  userId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  outletId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: "user_outlets", updatedAt: false });

export { sequelize };
