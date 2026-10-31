import { Outlet, Product } from "../models/index.js";
import * as discountService from "../services/discountService.js";
import * as orderService from "../services/orderService.js";
import { handleForm } from "../utils/forms.js";
import { toCents, fromCents } from "../utils/money.js";

const options = async () => ({
  outlets: (await Outlet.findAll({ order: [["name", "ASC"]] })).map((o) => o.get({ plain: true })),
  products: (await Product.findAll({ where: { status: ["AVAILABLE", "UNAVAILABLE"] }, order: [["name", "ASC"]], attributes: ["id", "code", "name"] })).map((p) => p.get({ plain: true })),
});
const crumbs = (label, href) => [{ label: "Discounts", href: "/discounts" }, ...(label ? [{ label, href }] : [])];
const asForm = (d) => ({ ...d, outletIds: (d.outlets || []).map((o) => o.id), productIds: (d.products || []).map((p) => p.id) });
const fromBody = (body, id) => ({ ...body, id, outletIds: [].concat(body.outletIds || []), productIds: [].concat(body.productIds || []) });

export const index = async (req, res) => {
  res.render("discounts/index", { title: "Discounts & Promotions", breadcrumbs: crumbs(), discounts: await discountService.listDiscounts(req.query), filters: { status: req.query.status || "" } });
};

export const newForm = async (req, res) =>
  res.render("discounts/form", { title: "New discount", breadcrumbs: crumbs("New"), discount: { discountType: "PERCENTAGE", scope: "ORDER", status: "ACTIVE", outletIds: [], productIds: [] }, ...(await options()) });

export const create = async (req, res) => {
  const d = await handleForm(res, () => discountService.saveDiscount(req, null, req.body), {
    view: "discounts/form",
    locals: async () => ({ title: "New discount", breadcrumbs: crumbs("New"), discount: fromBody(req.body), ...(await options()) }),
  });
  if (!d) return;
  req.flash("success_msg", `Discount ${d.code} was created.`);
  res.redirect(`/discounts/${d.id}`);
};

export const show = async (req, res) => {
  const discount = (await discountService.getDiscount(req.params.id)).get({ plain: true });
  const usage = await discountService.usageHistory(discount.id);
  res.render("discounts/show", {
    title: discount.name,
    breadcrumbs: crumbs(discount.code),
    discount,
    usage,
    totalDiscounted: fromCents(usage.reduce((s, u) => s + toCents(u.amount), 0)),
  });
};

export const editForm = async (req, res) => {
  const discount = asForm((await discountService.getDiscount(req.params.id)).get({ plain: true }));
  res.render("discounts/form", { title: `Edit ${discount.code}`, breadcrumbs: crumbs(discount.code, `/discounts/${discount.id}`), discount, editing: true, ...(await options()) });
};

export const update = async (req, res) => {
  const d = await handleForm(res, () => discountService.saveDiscount(req, Number(req.params.id), req.body), {
    view: "discounts/form",
    locals: async () => ({ title: "Edit discount", breadcrumbs: crumbs("Edit"), discount: fromBody(req.body, req.params.id), editing: true, ...(await options()) }),
  });
  if (!d) return;
  req.flash("success_msg", `Discount ${d.code} was updated.`);
  res.redirect(`/discounts/${d.id}`);
};

// ── POS API ──────────────────────────────────────────────────────────────

export const apiAvailable = async (req, res) => res.json({ ok: true, discounts: await discountService.availableForOrder(req, req.params.id) });

export const apiApply = async (req, res) => {
  const id = await discountService.applyDiscount(req, req.params.id, req.body);
  res.json({ ok: true, order: orderService.toDto(await orderService.getOrder(req, id)) });
};

export const apiRemove = async (req, res) => {
  const id = await discountService.removeDiscount(req, req.params.id, req.params.orderDiscountId);
  res.json({ ok: true, order: orderService.toDto(await orderService.getOrder(req, id)) });
};
