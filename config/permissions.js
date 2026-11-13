// Permission catalog and default role grants. Seeded into `permissions` and
// `role_permissions`; enforcement always reads the database, not this file.

export const PERMISSIONS = {
  "dashboard.view": ["dashboard", "View the dashboard"],
  "pos.access": ["pos", "Use the POS terminal"],
  "orders.view": ["orders", "View orders"],
  "orders.create": ["orders", "Create and edit orders"],
  "orders.void": ["orders", "Void orders (supervisor)"],
  "payments.process": ["payments", "Process direct payments"],
  "payments.view": ["payments", "View payments"],
  "room_charges.process": ["guest-charges", "Charge orders to guest rooms"],
  "room_charges.view": ["guest-charges", "View guest room charges"],
  "receipts.view": ["receipts", "View and print receipts"],
  "refunds.request": ["refunds", "Request refunds"],
  "refunds.approve": ["refunds", "Approve and process refunds (supervisor)"],
  "refunds.view": ["refunds", "View refunds"],
  "discounts.apply": ["discounts", "Apply discounts to orders"],
  "discounts.authorize": ["discounts", "Authorize restricted discounts (supervisor)"],
  "discounts.manage": ["discounts", "Manage discounts and promotions"],
  "products.view": ["products", "View products and services"],
  "products.manage": ["products", "Manage products, services and prices"],
  "categories.manage": ["categories", "Manage categories"],
  "outlets.manage": ["outlets", "Manage outlets"],
  "outlets.all_access": ["outlets", "Access every outlet without assignment"],
  "inventory.view": ["inventory", "View inventory"],
  "inventory.manage": ["inventory", "Record stock in/out and manage inventory items"],
  "inventory.adjust": ["inventory", "Record adjustments, damage and waste"],
  "shifts.open": ["shifts", "Open and close own cashier shift"],
  "shifts.manage": ["shifts", "Close, approve and reconcile any shift"],
  "shifts.view": ["shifts", "View shift history"],
  "reports.view": ["reports", "View reports and analytics"],
  "users.manage": ["users", "Manage user accounts"],
  "roles.manage": ["users", "Manage roles and permissions"],
  "audit.view": ["audit", "View audit logs"],
  "integrations.view": ["integrations", "View integration status and logs"],
  "integrations.manage": ["integrations", "Manage integration configuration"],
  "settings.manage": ["settings", "Manage system settings"],
};

const ALL = Object.keys(PERMISSIONS);

export const ROLES = {
  SYSTEM_ADMIN: { name: "System Administrator", description: "Full access to every module.", permissions: ALL },
  POS_MANAGER: {
    name: "POS Manager",
    description: "Manages catalog, prices, discounts, inventory and reports.",
    permissions: ALL.filter((p) => !["users.manage", "roles.manage", "settings.manage", "integrations.manage"].includes(p)),
  },
  SUPERVISOR: {
    name: "Supervisor",
    description: "Outlet supervisor: authorizes discounts, voids and refunds; reconciles shifts.",
    permissions: [
      "dashboard.view", "pos.access", "orders.view", "orders.create", "orders.void",
      "payments.process", "payments.view", "room_charges.process", "room_charges.view", "receipts.view",
      "refunds.request", "refunds.approve", "refunds.view", "discounts.apply", "discounts.authorize",
      "products.view", "inventory.view", "shifts.open", "shifts.manage", "shifts.view", "reports.view",
    ],
  },
  CASHIER: {
    name: "Cashier",
    description: "Creates orders and settles them by direct payment or room charge.",
    permissions: [
      "dashboard.view", "pos.access", "orders.view", "orders.create", "payments.process", "payments.view",
      "room_charges.process", "room_charges.view", "receipts.view", "refunds.request", "refunds.view",
      "discounts.apply", "products.view", "inventory.view", "shifts.open", "shifts.view",
    ],
  },
  RESTAURANT_STAFF: {
    name: "Restaurant Staff",
    description: "Takes orders; settlement is done by a cashier.",
    permissions: ["dashboard.view", "pos.access", "orders.view", "orders.create", "receipts.view", "products.view"],
  },
  INVENTORY_STAFF: {
    name: "Inventory Staff",
    description: "Maintains stock levels and inventory movements.",
    permissions: ["dashboard.view", "products.view", "inventory.view", "inventory.manage", "inventory.adjust"],
  },
  ERP_INTEGRATION: {
    name: "ERP Integration (API)",
    description: "Read-only API access for other ERP subsystems: sales, settlements, catalog, stock, shifts, reports and events.",
    permissions: [
      "orders.view", "payments.view", "room_charges.view", "receipts.view", "refunds.view", "products.view",
      "inventory.view", "shifts.view", "reports.view", "outlets.all_access", "integrations.view",
    ],
  },
  ACCOUNTANT: {
    name: "Accountant",
    description: "Read-only access to transactions, reports and audit logs.",
    permissions: [
      "dashboard.view", "orders.view", "payments.view", "room_charges.view", "receipts.view", "refunds.view",
      "shifts.view", "reports.view", "audit.view", "outlets.all_access", "products.view", "inventory.view",
    ],
  },
};
