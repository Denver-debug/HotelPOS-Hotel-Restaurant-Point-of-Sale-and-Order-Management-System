import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const ORDER_TYPES = ["DINE_IN", "TAKEOUT", "ROOM_SERVICE", "MINIBAR", "SPA", "OTHER"];
export const ORDER_STATUSES = [
  "OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "SETTLING", "CHARGE_FAILED",
  "COMPLETED", "VOIDED", "PARTIALLY_REFUNDED", "REFUNDED",
];
export const PAYMENT_STATUSES = ["PENDING", "AUTHORIZED", "CAPTURED", "FAILED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"];
export const CHARGE_STATUSES = ["PENDING", "POSTED", "FAILED", "UNKNOWN", "REVERSED", "PARTIALLY_REVERSED"];
export const REFUND_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "PROCESSED", "FAILED"];

const money = (extra = {}) => ({ type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: "0.00", ...extra });
const bigId = { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true };

export const Shift = sequelize.define("Shift", {
  shiftNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  outletId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  status: { type: DataTypes.ENUM("OPEN", "CLOSED", "RECONCILED"), allowNull: false, defaultValue: "OPEN" },
  openedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  closedAt: { type: DataTypes.DATE },
  openingCash: money(),
  expectedCash: { type: DataTypes.DECIMAL(12, 2) },
  actualCash: { type: DataTypes.DECIMAL(12, 2) },
  cashVariance: { type: DataTypes.DECIMAL(12, 2) },
  openingNotes: { type: DataTypes.STRING(255) },
  closingNotes: { type: DataTypes.STRING(255) },
  closedBy: { type: DataTypes.INTEGER.UNSIGNED },
  reconciledBy: { type: DataTypes.INTEGER.UNSIGNED },
  reconciledAt: { type: DataTypes.DATE },
}, { tableName: "shifts" });

export const Order = sequelize.define("Order", {
  id: bigId,
  orderNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  outletId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  shiftId: { type: DataTypes.INTEGER.UNSIGNED },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  orderType: { type: DataTypes.ENUM(...ORDER_TYPES), allowNull: false },
  settlementType: { type: DataTypes.ENUM("DIRECT_PAYMENT", "ROOM_CHARGE") },
  status: { type: DataTypes.ENUM(...ORDER_STATUSES), allowNull: false, defaultValue: "OPEN" },
  tableOrLocation: { type: DataTypes.STRING(60) },
  guestCount: { type: DataTypes.SMALLINT.UNSIGNED },
  notes: { type: DataTypes.STRING(500) },
  serviceChargeRate: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: "0.00" },
  subtotal: money(),
  discountAmount: money(),
  taxAmount: money(),
  serviceChargeAmount: money(),
  totalAmount: money(),
  amountPaid: money(),
  amountRefunded: money(),
  voidReason: { type: DataTypes.STRING(255) },
  voidRequestedBy: { type: DataTypes.INTEGER.UNSIGNED },
  voidedBy: { type: DataTypes.INTEGER.UNSIGNED },
  voidedAt: { type: DataTypes.DATE },
  completedBy: { type: DataTypes.INTEGER.UNSIGNED },
  completedAt: { type: DataTypes.DATE },
  version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
}, { tableName: "orders" });

export const OrderItem = sequelize.define("OrderItem", {
  id: bigId,
  orderId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  productId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  productCode: { type: DataTypes.STRING(40), allowNull: false },
  productName: { type: DataTypes.STRING(120), allowNull: false },
  itemType: { type: DataTypes.ENUM("PRODUCT", "SERVICE"), allowNull: false },
  unit: { type: DataTypes.STRING(20), allowNull: false },
  quantity: { type: DataTypes.DECIMAL(10, 3), allowNull: false },
  unitPrice: money(),
  grossAmount: money(),
  discountAmount: money(),
  taxRate: { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: "0" },
  taxInclusive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  taxAmount: money(),
  netAmount: money(),
  lineTotal: money(),
  quantityRefunded: { type: DataTypes.DECIMAL(10, 3), allowNull: false, defaultValue: "0" },
  notes: { type: DataTypes.STRING(255) },
}, { tableName: "order_items" });

export const Discount = sequelize.define("Discount", {
  code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  description: { type: DataTypes.STRING(255) },
  discountType: { type: DataTypes.ENUM("PERCENTAGE", "FIXED"), allowNull: false },
  value: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  scope: { type: DataTypes.ENUM("ORDER", "ITEM"), allowNull: false, defaultValue: "ORDER" },
  requiresAuthorization: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  minOrderAmount: { type: DataTypes.DECIMAL(12, 2) },
  validFrom: { type: DataTypes.DATE },
  validTo: { type: DataTypes.DATE },
  maxUses: { type: DataTypes.INTEGER.UNSIGNED },
  timesUsed: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE", "ARCHIVED"), allowNull: false, defaultValue: "ACTIVE" },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "discounts" });

export const DiscountProduct = sequelize.define("DiscountProduct", {
  discountId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  productId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: "discount_products", timestamps: false });

export const DiscountOutlet = sequelize.define("DiscountOutlet", {
  discountId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  outletId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: "discount_outlets", timestamps: false });

export const OrderDiscount = sequelize.define("OrderDiscount", {
  id: bigId,
  orderId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  orderItemId: { type: DataTypes.BIGINT.UNSIGNED },
  discountId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  discountCode: { type: DataTypes.STRING(30), allowNull: false },
  discountName: { type: DataTypes.STRING(100), allowNull: false },
  discountType: { type: DataTypes.ENUM("PERCENTAGE", "FIXED"), allowNull: false },
  discountValue: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  amount: money(),
  appliedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  authorizedBy: { type: DataTypes.INTEGER.UNSIGNED },
}, { tableName: "order_discounts" });

export const PaymentMethod = sequelize.define("PaymentMethod", {
  code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(60), allowNull: false },
  isCash: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  usesGateway: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  requiresReference: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE"), allowNull: false, defaultValue: "ACTIVE" },
}, { tableName: "payment_methods" });

export const Payment = sequelize.define("Payment", {
  id: bigId,
  paymentNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  orderId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  shiftId: { type: DataTypes.INTEGER.UNSIGNED },
  paymentMethodId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  amount: money(),
  tenderedAmount: { type: DataTypes.DECIMAL(12, 2) },
  changeAmount: money(),
  refundedAmount: money(),
  reference: { type: DataTypes.STRING(100) },
  status: { type: DataTypes.ENUM(...PAYMENT_STATUSES), allowNull: false, defaultValue: "PENDING" },
  gateway: { type: DataTypes.STRING(40) },
  externalTransactionId: { type: DataTypes.STRING(100) },
  idempotencyKey: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  failureReason: { type: DataTypes.STRING(255) },
  isMock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  processedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  capturedAt: { type: DataTypes.DATE },
}, { tableName: "payments" });

// Only external PMS identifiers are stored; guest/room/folio master data stays in the PMS.
export const GuestCharge = sequelize.define("GuestCharge", {
  id: bigId,
  chargeNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  orderId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  roomNumber: { type: DataTypes.STRING(20), allowNull: false },
  externalGuestId: { type: DataTypes.STRING(60), allowNull: false },
  externalRoomId: { type: DataTypes.STRING(60), allowNull: false },
  externalFolioId: { type: DataTypes.STRING(60), allowNull: false },
  amount: money(),
  reversedAmount: money(),
  status: { type: DataTypes.ENUM(...CHARGE_STATUSES), allowNull: false, defaultValue: "PENDING" },
  idempotencyKey: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  pmsTransactionId: { type: DataTypes.STRING(100), unique: true },
  attempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
  lastError: { type: DataTypes.STRING(500) },
  isMock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  requestedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  postedAt: { type: DataTypes.DATE },
}, { tableName: "guest_charges" });

export const Refund = sequelize.define("Refund", {
  refundNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  orderId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  refundType: { type: DataTypes.ENUM("FULL", "PARTIAL"), allowNull: false },
  settlementType: { type: DataTypes.ENUM("DIRECT_PAYMENT", "ROOM_CHARGE"), allowNull: false },
  amount: money(),
  reason: { type: DataTypes.STRING(255), allowNull: false },
  status: { type: DataTypes.ENUM(...REFUND_STATUSES), allowNull: false, defaultValue: "REQUESTED" },
  restock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  refundMethodId: { type: DataTypes.INTEGER.UNSIGNED },
  paymentId: { type: DataTypes.BIGINT.UNSIGNED },
  guestChargeId: { type: DataTypes.BIGINT.UNSIGNED },
  shiftId: { type: DataTypes.INTEGER.UNSIGNED },
  externalReference: { type: DataTypes.STRING(100) },
  idempotencyKey: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  requestedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  approvedBy: { type: DataTypes.INTEGER.UNSIGNED },
  approvedAt: { type: DataTypes.DATE },
  rejectionReason: { type: DataTypes.STRING(255) },
  processedBy: { type: DataTypes.INTEGER.UNSIGNED },
  processedAt: { type: DataTypes.DATE },
  failureReason: { type: DataTypes.STRING(255) },
}, { tableName: "refunds" });

export const RefundItem = sequelize.define("RefundItem", {
  refundId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  orderItemId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  quantity: { type: DataTypes.DECIMAL(10, 3), allowNull: false },
  amount: money(),
  restock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { tableName: "refund_items", timestamps: false });

export const Receipt = sequelize.define("Receipt", {
  id: bigId,
  receiptNumber: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  orderId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  refundId: { type: DataTypes.INTEGER.UNSIGNED },
  receiptType: { type: DataTypes.ENUM("SALE", "ROOM_CHARGE", "REFUND"), allowNull: false },
  snapshot: { type: DataTypes.JSON, allowNull: false },
  printCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  lastPrintedAt: { type: DataTypes.DATE },
  generatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  generatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: "receipts", timestamps: false });
