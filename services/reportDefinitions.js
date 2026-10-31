// Report catalog. Each report declares its filters, columns and a loader built on
// reportService, so one view, one CSV exporter and one paginator serve them all.
import * as r from "./reportService.js";
import { toCents, fromCents } from "../utils/money.js";

const sum = (rows, key) => fromCents(rows.reduce((s, row) => s + (toCents(row[key]) || 0), 0));

export const REPORTS = {
  sales: {
    title: "Sales (daily / weekly / monthly)",
    description: "Completed sales per period with totals.",
    filters: ["dates", "outlet", "cashier", "granularity"],
    columns: [
      { key: "period", label: "Period" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "amount", label: "Sales", type: "money" },
    ],
    chart: { kind: "line", label: "period", value: "amount" },
    async load(f) {
      const [rows, summary] = await Promise.all([r.salesTrend(f, f.granularity), r.salesSummary(f)]);
      return {
        rows,
        totals: { period: "Total", orders: summary.orders, amount: summary.grossSales },
        summary: [
          ["Gross sales", summary.grossSales, "money"], ["Refunds", summary.refunds.amount, "money"], ["Net sales", summary.netSales, "money"],
          ["VAT", summary.taxAmount, "money"], ["Discounts", summary.discountAmount, "money"], ["Service charge", summary.serviceChargeAmount, "money"],
        ],
      };
    },
  },
  outlets: {
    title: "Sales by outlet",
    description: "Completed sales per hotel outlet.",
    filters: ["dates", "cashier"],
    columns: [
      { key: "code", label: "Code" }, { key: "name", label: "Outlet" },
      { key: "orders", label: "Orders", type: "int" }, { key: "amount", label: "Sales", type: "money" },
    ],
    chart: { kind: "bar", label: "name", value: "amount" },
    async load(f) {
      const rows = await r.salesByOutlet(f);
      return { rows, totals: { code: "Total", orders: rows.reduce((s, x) => s + Number(x.orders), 0), amount: sum(rows, "amount") } };
    },
  },
  products: {
    title: "Sales by product / best sellers",
    description: "Quantity sold (net of refunds) and revenue per product or service.",
    filters: ["dates", "outlet", "product", "sort"],
    columns: [
      { key: "code", label: "Code" }, { key: "name", label: "Product" }, { key: "category", label: "Category" },
      { key: "quantity", label: "Qty sold", type: "qty" }, { key: "orders", label: "Orders", type: "int" },
      { key: "gross", label: "Gross", type: "money" }, { key: "discounts", label: "Discounts", type: "money" }, { key: "amount", label: "Revenue", type: "money" },
    ],
    async load(f) {
      const rows = await r.salesByProduct(f, { orderBy: f.sort === "quantity" ? "quantity" : "amount" });
      return { rows, totals: { code: "Total", gross: sum(rows, "gross"), discounts: sum(rows, "discounts"), amount: sum(rows, "amount") } };
    },
  },
  payments: {
    title: "Payment method breakdown",
    description: "Collections per payment method, including charges to guest rooms.",
    filters: ["dates", "outlet", "method"],
    columns: [
      { key: "method", label: "Method" }, { key: "count", label: "Transactions", type: "int" },
      { key: "amount", label: "Amount", type: "money" }, { key: "refunded", label: "Refunded / reversed", type: "money" },
    ],
    chart: { kind: "bar", label: "method", value: "amount" },
    async load(f) {
      const rows = await r.paymentBreakdown(f);
      return { rows, totals: { method: "Total", count: rows.reduce((s, x) => s + Number(x.count), 0), amount: sum(rows, "amount"), refunded: sum(rows, "refunded") } };
    },
  },
  "room-charges": {
    title: "Guest room charges",
    description: "Every charge sent to the PMS with its folio reference and status.",
    filters: ["dates", "outlet"],
    columns: [
      { key: "created_at", label: "Date", type: "datetime" }, { key: "charge_number", label: "Charge" },
      { key: "order_number", label: "Order", type: "link", href: (row) => `/orders/${row.order_id}` },
      { key: "outlet_code", label: "Outlet" }, { key: "room_number", label: "Room" }, { key: "external_folio_id", label: "Folio" },
      { key: "pms_transaction_id", label: "PMS ref" }, { key: "amount", label: "Amount", type: "money" },
      { key: "reversed_amount", label: "Reversed", type: "money" }, { key: "status", label: "Status", type: "status" }, { key: "requested_by", label: "By" },
    ],
    async load(f) {
      const rows = await r.roomChargeReport(f);
      const posted = rows.filter((x) => ["POSTED", "PARTIALLY_REVERSED", "REVERSED"].includes(x.status));
      return { rows, totals: { created_at: "Posted total", amount: sum(posted, "amount"), reversed_amount: sum(posted, "reversed_amount") } };
    },
  },
  cashiers: {
    title: "Cashier performance",
    description: "Completed orders and sales per cashier.",
    filters: ["dates", "outlet"],
    columns: [
      { key: "cashier", label: "Cashier" }, { key: "orders", label: "Orders", type: "int" }, { key: "amount", label: "Sales", type: "money" },
      { key: "average", label: "Avg. ticket", type: "money" }, { key: "discounts", label: "Discounts given", type: "money" }, { key: "room_charges", label: "Room charges", type: "int" },
    ],
    chart: { kind: "bar", label: "cashier", value: "amount" },
    async load(f) {
      const rows = (await r.cashierPerformance(f)).map((x) => ({ ...x, average: fromCents(toCents(Number(x.average).toFixed(2))) }));
      return { rows, totals: { cashier: "Total", orders: rows.reduce((s, x) => s + Number(x.orders), 0), amount: sum(rows, "amount"), discounts: sum(rows, "discounts") } };
    },
  },
  shifts: {
    title: "Shift reconciliation",
    description: "Opening float, collections, expected vs counted cash and variance per shift.",
    filters: ["dates", "outlet", "cashier"],
    columns: [
      { key: "shift_number", label: "Shift", type: "link", href: (row) => `/shifts/${row.id}` }, { key: "cashier", label: "Cashier" }, { key: "outlet_code", label: "Outlet" },
      { key: "opened_at", label: "Opened", type: "datetime" }, { key: "closed_at", label: "Closed", type: "datetime" },
      { key: "orders", label: "Orders", type: "int" }, { key: "collections", label: "Collections", type: "money" },
      { key: "opening_cash", label: "Opening", type: "money" }, { key: "expected_cash", label: "Expected", type: "money" },
      { key: "actual_cash", label: "Counted", type: "money" }, { key: "cash_variance", label: "Variance", type: "money" }, { key: "status", label: "Status", type: "status" },
    ],
    async load(f) {
      const rows = await r.shiftReport(f);
      return { rows, totals: { shift_number: "Total", collections: sum(rows, "collections"), cash_variance: sum(rows, "cash_variance") } };
    },
  },
  refunds: {
    title: "Refunds and voids",
    description: "Refund requests with approvals, and voided orders.",
    filters: ["dates", "outlet"],
    columns: [
      { key: "created_at", label: "Date", type: "datetime" }, { key: "refund_number", label: "Refund", type: "link", href: (row) => `/refunds/${row.id}` },
      { key: "order_number", label: "Order", type: "link", href: (row) => `/orders/${row.order_id}` }, { key: "outlet_code", label: "Outlet" },
      { key: "refund_type", label: "Type" }, { key: "settlement_type", label: "Settlement" }, { key: "reason", label: "Reason" },
      { key: "requested_by", label: "Requested by" }, { key: "approved_by", label: "Approved by" },
      { key: "amount", label: "Amount", type: "money" }, { key: "status", label: "Status", type: "status" },
    ],
    secondary: {
      title: "Voided orders",
      columns: [
        { key: "voided_at", label: "Voided", type: "datetime" }, { key: "order_number", label: "Order", type: "link", href: (row) => `/orders/${row.order_id}` },
        { key: "outlet_code", label: "Outlet" }, { key: "created_by", label: "Created by" }, { key: "voided_by", label: "Approved by" },
        { key: "void_reason", label: "Reason" }, { key: "total_amount", label: "Order total", type: "money" },
      ],
    },
    async load(f) {
      const { refunds, voids } = await r.refundVoidReport(f);
      const processed = refunds.filter((x) => x.status === "PROCESSED");
      return { rows: refunds, secondaryRows: voids, totals: { created_at: "Processed total", amount: sum(processed, "amount") } };
    },
  },
  inventory: {
    title: "Inventory movement",
    description: "Stock in/out, sales and losses per item and outlet.",
    filters: ["dates", "outlet"],
    columns: [
      { key: "outlet_code", label: "Outlet" }, { key: "sku", label: "SKU" }, { key: "name", label: "Item" }, { key: "unit", label: "Unit" },
      { key: "qty_in", label: "In", type: "qty" }, { key: "qty_out", label: "Out", type: "qty" }, { key: "sold", label: "Sold", type: "qty" },
      { key: "lost", label: "Damage/waste", type: "qty" }, { key: "net", label: "Net change", type: "qty" }, { key: "movements", label: "Movements", type: "int" },
    ],
    load: async (f) => ({ rows: await r.inventoryMovementReport(f) }),
  },
  "low-stock": {
    title: "Low-stock products",
    description: "Items at or below their reorder level (current stock, no date filter).",
    filters: ["outlet"],
    columns: [
      { key: "outlet_name", label: "Outlet" }, { key: "sku", label: "SKU" }, { key: "name", label: "Item" },
      { key: "quantity", label: "On hand", type: "qty" }, { key: "reorder_level", label: "Reorder level", type: "qty" }, { key: "unit", label: "Unit" },
    ],
    load: async (f) => ({ rows: await r.lowStockReport(f.outletId ? [Number(f.outletId)].filter((id) => f.outletIds.includes(id)) : f.outletIds) }),
  },
};

// The 13 required reports map onto these definitions:
// daily/weekly/monthly sales → sales; best sellers → products (sort by quantity).
