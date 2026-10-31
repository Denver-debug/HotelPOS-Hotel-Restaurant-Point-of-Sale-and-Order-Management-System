import * as reportService from "../services/reportService.js";
import { expectedCash } from "../services/shiftService.js";
import { getSetting } from "../services/settingsService.js";
import { businessDateString, parseDateRange } from "../utils/dates.js";
import { can } from "../middleware/auth.js";

// Every figure on the dashboard comes from live database queries.
export const dashboardPage = async (req, res) => {
  const range = parseDateRange({ from: req.query.date, to: req.query.date }, 0);
  const outletId = req.query.outletId ? Number(req.query.outletId) : null;
  const base = { start: range.start, end: range.end, outletIds: req.user.outletIds, outletId };
  const showSales = can(req, "orders.view") || can(req, "reports.view");
  const showInventory = can(req, "inventory.view") && (await getSetting("low_stock_alerts", true));

  const data = {};
  if (showSales) {
    const trendRange = reportService.dayRange(range.to, 7);
    const [summary, trend, byOutlet, methods, bestSellers, recent] = await Promise.all([
      reportService.salesSummary(base),
      reportService.salesTrend({ ...base, ...trendRange }),
      reportService.salesByOutlet(base),
      reportService.paymentBreakdown(base),
      reportService.salesByProduct(base, { limit: 5, orderBy: "quantity" }),
      reportService.recentTransactions({ outletIds: req.user.outletIds, outletId }, 8),
    ]);
    Object.assign(data, { summary, trend, byOutlet, methods, bestSellers, recent });
  }
  if (showInventory) {
    const ids = outletId ? [outletId].filter((id) => req.user.outletIds.includes(id)) : req.user.outletIds;
    data.lowStock = (await reportService.lowStockReport(ids)).slice(0, 8);
  }
  if (req.openShift) data.shiftCash = await expectedCash(req.openShift);

  res.render("dashboard/index", {
    title: "Dashboard",
    filters: { date: range.to, outletId: outletId || "" },
    isToday: range.to === businessDateString(),
    outlets: req.outlets,
    showSales,
    showInventory,
    ...data,
    charts: showSales
      ? {
          trend: data.trend.map((t) => ({ label: t.period.slice(5), value: Number(t.amount), orders: t.orders })),
          outlets: data.byOutlet.map((o) => ({ label: o.name, value: Number(o.amount) })),
          methods: data.methods.map((m) => ({ label: m.method, value: Number(m.amount) })),
        }
      : null,
  });
};
