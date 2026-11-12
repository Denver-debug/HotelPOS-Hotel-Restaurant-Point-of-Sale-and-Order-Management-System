import { Product } from "../models/index.js";
import { staffOptions, paymentMethods } from "../services/lookupService.js";
import { REPORTS } from "../services/reportDefinitions.js";
import { audit } from "../services/auditService.js";
import { parseDateRange, formatDateTime } from "../utils/dates.js";
import { parsePage, buildPagination } from "../utils/pagination.js";
import { notFound, fullPath } from "../utils/http.js";

export const index = (req, res) => {
  res.render("reports/index", {
    title: "Reports",
    breadcrumbs: [{ label: "Reports" }],
    reports: Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description })),
  });
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvValue = (col, row) => (col.type === "datetime" ? formatDateTime(row[col.key]) : row[col.key]);

export const show = async (req, res) => {
  const key = req.params.type;
  const def = REPORTS[key];
  if (!def) throw notFound("Report");

  const range = parseDateRange(req.query, key === "sales" ? 6 : 0);
  const filters = {
    start: range.start,
    end: range.end,
    from: range.from,
    to: range.to,
    outletIds: req.user.outletIds,
    outletId: req.query.outletId ? Number(req.query.outletId) : null,
    cashierId: req.query.cashierId ? Number(req.query.cashierId) : null,
    productId: req.query.productId ? Number(req.query.productId) : null,
    methodId: req.query.methodId ? Number(req.query.methodId) : null,
    granularity: ["day", "week", "month"].includes(req.query.granularity) ? req.query.granularity : "day",
    sort: req.query.sort === "quantity" ? "quantity" : "amount",
  };
  const data = await def.load(filters);

  if (req.query.format === "csv") {
    const lines = [def.columns.map((c) => csvCell(c.label)).join(",")];
    for (const row of data.rows) lines.push(def.columns.map((c) => csvCell(csvValue(c, row))).join(","));
    if (def.secondary && data.secondaryRows?.length) {
      lines.push("", csvCell(def.secondary.title), def.secondary.columns.map((c) => csvCell(c.label)).join(","));
      for (const row of data.secondaryRows) lines.push(def.secondary.columns.map((c) => csvCell(csvValue(c, row))).join(","));
    }
    await audit({ req, action: "REPORT_EXPORTED", entityType: "report", entityId: key, newValues: { from: filters.from, to: filters.to, outletId: filters.outletId, rows: data.rows.length } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hotelpos-${key}-${filters.from}-to-${filters.to}.csv"`);
    return res.send("﻿" + lines.join("\r\n"));
  }

  const page = parsePage(req.query, 50);
  const shape = (cols, rows) =>
    rows.map((row) => cols.map((c) => ({ value: row[c.key], type: c.type || "text", href: c.href ? c.href(row) : null })));
  const needs = new Set(def.filters);
  res.render("reports/show", {
    title: def.title,
    breadcrumbs: [{ label: "Reports", href: "/reports" }, { label: def.title }],
    reportKey: key,
    def: { title: def.title, description: def.description, columns: def.columns },
    rows: shape(def.columns, data.rows.slice(page.offset, page.offset + page.limit)),
    totals: data.totals ? def.columns.map((c) => ({ value: data.totals[c.key] ?? "", type: c.type || "text" })) : null,
    summary: data.summary,
    secondary: def.secondary ? { title: def.secondary.title, columns: def.secondary.columns, rows: shape(def.secondary.columns, data.secondaryRows || []) } : null,
    pagination: buildPagination(req, data.rows.length, page),
    filters: { ...req.query, from: filters.from, to: filters.to, granularity: filters.granularity, sort: filters.sort },
    show: { dates: needs.has("dates"), outlet: needs.has("outlet"), cashier: needs.has("cashier"), product: needs.has("product"), method: needs.has("method"), granularity: needs.has("granularity"), sort: needs.has("sort") },
    outlets: req.outlets,
    cashiers: needs.has("cashier") ? await staffOptions() : [],
    products: needs.has("product") ? (await Product.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]] })).map((p) => p.get({ plain: true })) : [],
    methods: needs.has("method") ? await paymentMethods() : [],
    exportUrl: `${fullPath(req)}?${new URLSearchParams({ ...req.query, format: "csv" }).toString()}`,
    charts: def.chart && data.rows.length
      ? { extra: [{ id: "report-chart", kind: def.chart.kind, rows: data.rows.slice(0, 31).map((row) => ({ label: String(row[def.chart.label]), value: Number(row[def.chart.value]) })) }] }
      : null,
  });
};
