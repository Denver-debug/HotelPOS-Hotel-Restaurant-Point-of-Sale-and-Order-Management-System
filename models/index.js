// Loads every model and declares associations. Import models from here.
import { sequelize } from "./db.js";
import { Role, Permission, RolePermission } from "./roleModel.js";
import { User, UserOutlet } from "./userModel.js";
import { Outlet, Category, Tax, Product, ProductPrice } from "./catalogModel.js";
import { StockLocation, InventoryItem, ProductRecipe, StockLevel, InventoryTransaction } from "./inventoryModel.js";
import {
  Shift, Order, OrderItem, Discount, DiscountProduct, DiscountOutlet, OrderDiscount,
  PaymentMethod, Payment, GuestCharge, Refund, RefundItem, Receipt, RoomChargeValidation,
} from "./salesModel.js";
import { SystemSetting, AuditLog, IntegrationLog, IntegrationEvent } from "./systemModel.js";

// Access control
User.belongsTo(Role, { as: "role", foreignKey: "roleId" });
Role.hasMany(User, { as: "users", foreignKey: "roleId" });
Role.belongsToMany(Permission, { through: RolePermission, as: "permissions", foreignKey: "roleId", otherKey: "permissionId" });
Permission.belongsToMany(Role, { through: RolePermission, as: "roles", foreignKey: "permissionId", otherKey: "roleId" });
User.belongsToMany(Outlet, { through: UserOutlet, as: "outlets", foreignKey: "userId", otherKey: "outletId" });
Outlet.belongsToMany(User, { through: UserOutlet, as: "users", foreignKey: "outletId", otherKey: "userId" });

// Catalog
Product.belongsTo(Category, { as: "category", foreignKey: "categoryId" });
Category.hasMany(Product, { as: "products", foreignKey: "categoryId" });
Product.belongsTo(Tax, { as: "tax", foreignKey: "taxId" });
Product.hasMany(ProductPrice, { as: "prices", foreignKey: "productId" });
ProductPrice.belongsTo(Product, { as: "product", foreignKey: "productId" });
ProductPrice.belongsTo(Outlet, { as: "outlet", foreignKey: "outletId" });
ProductPrice.belongsTo(User, { as: "creator", foreignKey: "createdBy" });

// Inventory
Product.hasMany(ProductRecipe, { as: "recipes", foreignKey: "productId" });
ProductRecipe.belongsTo(Product, { as: "product", foreignKey: "productId" });
ProductRecipe.belongsTo(InventoryItem, { as: "item", foreignKey: "inventoryItemId" });
StockLocation.belongsTo(Outlet, { as: "outlet", foreignKey: "outletId" });
Outlet.hasMany(StockLocation, { as: "stockLocations", foreignKey: "outletId" });
StockLevel.belongsTo(StockLocation, { as: "location", foreignKey: "stockLocationId" });
StockLevel.belongsTo(InventoryItem, { as: "item", foreignKey: "inventoryItemId" });
InventoryItem.hasMany(StockLevel, { as: "stockLevels", foreignKey: "inventoryItemId" });
InventoryTransaction.belongsTo(InventoryItem, { as: "item", foreignKey: "inventoryItemId" });
InventoryTransaction.belongsTo(StockLocation, { as: "location", foreignKey: "stockLocationId" });
InventoryTransaction.belongsTo(User, { as: "user", foreignKey: "createdBy" });

// Shifts and orders
Shift.belongsTo(User, { as: "cashier", foreignKey: "userId" });
Shift.belongsTo(Outlet, { as: "outlet", foreignKey: "outletId" });
Shift.belongsTo(User, { as: "closer", foreignKey: "closedBy" });
Shift.belongsTo(User, { as: "reconciler", foreignKey: "reconciledBy" });
Order.belongsTo(Outlet, { as: "outlet", foreignKey: "outletId" });
Order.belongsTo(Shift, { as: "shift", foreignKey: "shiftId" });
Order.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
Order.belongsTo(User, { as: "voider", foreignKey: "voidedBy" });
Order.belongsTo(User, { as: "completer", foreignKey: "completedBy" });
Order.hasMany(OrderItem, { as: "items", foreignKey: "orderId" });
OrderItem.belongsTo(Order, { as: "order", foreignKey: "orderId" });
OrderItem.belongsTo(Product, { as: "product", foreignKey: "productId" });

// Discounts
Discount.belongsToMany(Product, { through: DiscountProduct, as: "products", foreignKey: "discountId", otherKey: "productId" });
Discount.belongsToMany(Outlet, { through: DiscountOutlet, as: "outlets", foreignKey: "discountId", otherKey: "outletId" });
Order.hasMany(OrderDiscount, { as: "discounts", foreignKey: "orderId" });
OrderDiscount.belongsTo(Order, { as: "order", foreignKey: "orderId" });
OrderDiscount.belongsTo(Discount, { as: "discount", foreignKey: "discountId" });
OrderDiscount.belongsTo(OrderItem, { as: "orderItem", foreignKey: "orderItemId" });
OrderDiscount.belongsTo(User, { as: "applier", foreignKey: "appliedBy" });
OrderDiscount.belongsTo(User, { as: "authorizer", foreignKey: "authorizedBy" });

// Settlement
Order.hasMany(Payment, { as: "payments", foreignKey: "orderId" });
Payment.belongsTo(Order, { as: "order", foreignKey: "orderId" });
Payment.belongsTo(PaymentMethod, { as: "method", foreignKey: "paymentMethodId" });
Payment.belongsTo(Shift, { as: "shift", foreignKey: "shiftId" });
Payment.belongsTo(User, { as: "processor", foreignKey: "processedBy" });
Order.hasMany(GuestCharge, { as: "guestCharges", foreignKey: "orderId" });
GuestCharge.belongsTo(Order, { as: "order", foreignKey: "orderId" });
GuestCharge.belongsTo(User, { as: "requester", foreignKey: "requestedBy" });

// Refunds and receipts
Order.hasMany(Refund, { as: "refunds", foreignKey: "orderId" });
Refund.belongsTo(Order, { as: "order", foreignKey: "orderId" });
Refund.belongsTo(User, { as: "requester", foreignKey: "requestedBy" });
Refund.belongsTo(User, { as: "approver", foreignKey: "approvedBy" });
Refund.belongsTo(User, { as: "processor", foreignKey: "processedBy" });
Refund.belongsTo(PaymentMethod, { as: "refundMethod", foreignKey: "refundMethodId" });
Refund.belongsTo(Payment, { as: "payment", foreignKey: "paymentId" });
Refund.belongsTo(GuestCharge, { as: "guestCharge", foreignKey: "guestChargeId" });
Refund.hasMany(RefundItem, { as: "items", foreignKey: "refundId" });
RefundItem.belongsTo(OrderItem, { as: "orderItem", foreignKey: "orderItemId" });
Order.hasMany(Receipt, { as: "receipts", foreignKey: "orderId" });
Receipt.belongsTo(Order, { as: "order", foreignKey: "orderId" });
Receipt.belongsTo(Refund, { as: "refund", foreignKey: "refundId" });
Receipt.belongsTo(User, { as: "generator", foreignKey: "generatedBy" });

// System
AuditLog.belongsTo(User, { as: "user", foreignKey: "userId" });
IntegrationLog.belongsTo(User, { as: "user", foreignKey: "createdBy" });
SystemSetting.belongsTo(User, { as: "updater", foreignKey: "updatedBy" });

export {
  sequelize,
  Role, Permission, RolePermission, User, UserOutlet,
  Outlet, Category, Tax, Product, ProductPrice,
  StockLocation, InventoryItem, ProductRecipe, StockLevel, InventoryTransaction,
  Shift, Order, OrderItem, Discount, DiscountProduct, DiscountOutlet, OrderDiscount,
  PaymentMethod, Payment, GuestCharge, Refund, RefundItem, Receipt, RoomChargeValidation,
  SystemSetting, AuditLog, IntegrationLog, IntegrationEvent,
};
