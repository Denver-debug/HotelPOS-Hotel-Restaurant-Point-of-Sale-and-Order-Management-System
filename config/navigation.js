// Sidebar structure. An item is shown when the user holds its permission, or any of them
// when it lists several (keep these in step with the route's requirePermission(...)).

export const NAVIGATION = [
  { section: null, items: [{ label: "Dashboard", href: "/dashboard", icon: "home", permission: "dashboard.view" }] },
  {
    section: "Transactions",
    items: [
      { label: "POS Terminal", href: "/pos/terminal", icon: "terminal", permission: "pos.access" },
      { label: "Orders", href: "/orders", icon: "clipboard", permission: "orders.view" },
      { label: "Payments", href: "/payments", icon: "card", permission: "payments.view" },
      { label: "Guest Room Charges", href: "/guest-charges", icon: "key", permission: "room_charges.view" },
      { label: "Receipts", href: "/receipts", icon: "receipt", permission: "receipts.view" },
      { label: "Refunds & Voids", href: "/refunds", icon: "undo", permission: ["refunds.view", "refunds.approve"] },
    ],
  },
  {
    section: "Management",
    items: [
      { label: "Products & Services", href: "/products", icon: "tag", permission: ["products.view", "products.manage"] },
      { label: "Categories", href: "/categories", icon: "folder", permission: "categories.manage" },
      { label: "Outlets", href: "/outlets", icon: "building", permission: "outlets.manage" },
      { label: "Discounts", href: "/discounts", icon: "percent", permission: "discounts.manage" },
      { label: "Inventory", href: "/inventory", icon: "box", permission: "inventory.view" },
    ],
  },
  {
    section: "Operations",
    items: [
      { label: "Cashier Shifts", href: "/shifts", icon: "clock", permission: ["shifts.view", "shifts.manage"] },
      { label: "Reports", href: "/reports", icon: "chart", permission: "reports.view" },
    ],
  },
  {
    section: "System",
    items: [
      { label: "Users", href: "/users", icon: "users", permission: "users.manage" },
      { label: "Roles & Permissions", href: "/roles", icon: "shield", permission: "roles.manage" },
      { label: "Audit Logs", href: "/audit-logs", icon: "list", permission: "audit.view" },
      { label: "Integrations", href: "/integrations", icon: "plug", permission: "integrations.view" },
      { label: "Settings", href: "/settings", icon: "cog", permission: "settings.manage" },
    ],
  },
];

export const buildNavigation = (permissions, currentPath) =>
  NAVIGATION.map((group) => ({
    section: group.section,
    items: group.items
      .filter((item) => [].concat(item.permission).some((p) => permissions.has(p)))
      .map((item) => ({
        ...item,
        active: currentPath === item.href || currentPath.startsWith(item.href + "/"),
      })),
  })).filter((group) => group.items.length > 0);
