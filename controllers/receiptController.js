import * as receiptService from "../services/receiptService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { parseDateRange } from "../utils/dates.js";

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const range = parseDateRange(req.query, 7);
  const filters = { ...filtersFrom(req.query, ["search", "type"]), from: range.from, to: range.to };
  const { rows, count } = await receiptService.listReceipts(req, { ...filters, start: range.start, end: range.end }, page);
  res.render("receipts/index", {
    title: "Receipts",
    breadcrumbs: [{ label: "Receipts" }],
    receipts: rows.map((r) => r.get({ plain: true })),
    filters,
    pagination: buildPagination(req, count, page),
  });
};

// Printer-friendly receipt (80 mm). ?print=1 opens the print dialog automatically.
export const show = async (req, res) => {
  const receipt = (await receiptService.getReceipt(req, req.params.id)).get({ plain: true });
  res.render("receipts/show", {
    layout: "layouts/print",
    title: `Receipt ${receipt.receiptNumber}`,
    receipt,
    s: receipt.snapshot,
    isReprint: receipt.printCount > 0,
    autoPrint: req.query.print === "1",
  });
};

export const apiPrinted = async (req, res) => {
  const receipt = await receiptService.markPrinted(req, req.params.id);
  res.json({ ok: true, printCount: receipt.printCount });
};
