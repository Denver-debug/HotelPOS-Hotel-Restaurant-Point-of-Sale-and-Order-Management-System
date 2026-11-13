import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const SystemSetting = sequelize.define("SystemSetting", {
  settingKey: { type: DataTypes.STRING(80), primaryKey: true },
  settingValue: { type: DataTypes.TEXT },
  valueType: { type: DataTypes.ENUM("string", "number", "boolean", "text"), allowNull: false, defaultValue: "string" },
  label: { type: DataTypes.STRING(120), allowNull: false },
  description: { type: DataTypes.STRING(255) },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  updatedBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "system_settings", createdAt: false });

// Append-only (UPDATE/DELETE are blocked by database triggers).
export const AuditLog = sequelize.define("AuditLog", {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED },
  action: { type: DataTypes.STRING(60), allowNull: false },
  entityType: { type: DataTypes.STRING(60), allowNull: false },
  entityId: { type: DataTypes.STRING(60) },
  oldValues: { type: DataTypes.JSON },
  newValues: { type: DataTypes.JSON },
  ipAddress: { type: DataTypes.STRING(45) },
  userAgent: { type: DataTypes.STRING(255) },
}, { tableName: "audit_logs", updatedAt: false });

export const IntegrationLog = sequelize.define("IntegrationLog", {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  systemName: { type: DataTypes.ENUM("PMS", "PAYMENT", "HR", "EVENT"), allowNull: false },
  operation: { type: DataTypes.STRING(60), allowNull: false },
  direction: { type: DataTypes.ENUM("OUTBOUND", "INBOUND"), allowNull: false, defaultValue: "OUTBOUND" },
  status: { type: DataTypes.ENUM("SUCCESS", "FAILED", "TIMEOUT", "ERROR"), allowNull: false },
  httpStatus: { type: DataTypes.SMALLINT },
  durationMs: { type: DataTypes.INTEGER.UNSIGNED },
  correlationId: { type: DataTypes.STRING(64) },
  idempotencyKey: { type: DataTypes.STRING(120) },
  referenceType: { type: DataTypes.STRING(40) },
  referenceId: { type: DataTypes.STRING(60) },
  requestPayload: { type: DataTypes.JSON },
  responsePayload: { type: DataTypes.JSON },
  errorMessage: { type: DataTypes.STRING(500) },
  isMock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "integration_logs", updatedAt: false });

// Transactional outbox: one row per domain event, written in the same transaction as the change.
export const IntegrationEvent = sequelize.define("IntegrationEvent", {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  eventUid: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
  eventType: { type: DataTypes.STRING(60), allowNull: false },
  schemaVersion: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
  aggregateType: { type: DataTypes.STRING(40), allowNull: false },
  aggregateId: { type: DataTypes.STRING(60), allowNull: false },
  outletId: { type: DataTypes.INTEGER.UNSIGNED },
  payload: { type: DataTypes.JSON, allowNull: false },
  status: { type: DataTypes.ENUM("PENDING", "PUBLISHED", "FAILED", "DEAD"), allowNull: false, defaultValue: "PENDING" },
  attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  nextAttemptAt: { type: DataTypes.DATE(3) },
  lastError: { type: DataTypes.STRING(500) },
  publishedAt: { type: DataTypes.DATE },
}, { tableName: "integration_events", updatedAt: false });

// API key for another ERP subsystem. The key acts as a service-account user (userId), so its
// role and outlet assignments decide what it may do. Only a SHA-256 hash of the key is stored.
export const ApiClient = sequelize.define("ApiClient", {
  name: { type: DataTypes.STRING(80), allowNull: false },
  keyPrefix: { type: DataTypes.CHAR(8), allowNull: false, unique: true },
  keyHash: { type: DataTypes.CHAR(64), allowNull: false },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
  allowedIps: { type: DataTypes.STRING(500) },
  status: { type: DataTypes.ENUM("ACTIVE", "REVOKED"), allowNull: false, defaultValue: "ACTIVE" },
  lastUsedAt: { type: DataTypes.DATE },
  lastUsedIp: { type: DataTypes.STRING(45) },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED },
  revokedBy: { type: DataTypes.INTEGER.UNSIGNED },
  revokedAt: { type: DataTypes.DATE },
}, { tableName: "api_clients", defaultScope: { attributes: { exclude: ["keyHash"] } }, scopes: { withHash: { attributes: { include: ["keyHash"] } } } });
