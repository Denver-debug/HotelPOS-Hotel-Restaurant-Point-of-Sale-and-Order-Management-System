import { Category, Tax, Outlet } from "../models/index.js";
import * as productService from "../services/productService.js";
import { parsePage, buildPagination, filtersFrom } from "../utils/pagination.js";
import { handleForm } from "../utils/forms.js";
import { can } from "../middleware/auth.js";
import { notFound } from "../utils/http.js";

const formOptions = async () => ({
  categories: (await Category.findAll({ where: { status: "ACTIVE" }, order: [["sortOrder", "ASC"], ["name", "ASC"]] })).map((c) => c.get({ plain: true })),
  taxes: (await Tax.findAll({ where: { status: "ACTIVE" }, order: [["name", "ASC"]] })).map((t) => t.get({ plain: true })),
});

const crumbs = (label, href) => [{ label: "Products & Services", href: "/products" }, ...(label ? [{ label, href }] : [])];

export const index = async (req, res) => {
  const page = parsePage(req.query);
  const filters = filtersFrom(req.query, ["search", "categoryId", "status", "outletId", "itemType"]);
  const { rows, count } = await productService.listProducts(filters, page);
  res.render("products/index", {
    title: "Products & Services",
    breadcrumbs: crumbs(),
    products: rows.map((p) => p.get({ plain: true })),
    filters,
    categories: (await Category.findAll({ order: [["name", "ASC"]] })).map((c) => c.get({ plain: true })),
    outlets: (await Outlet.findAll({ order: [["name", "ASC"]] })).map((o) => o.get({ plain: true })),
    pagination: buildPagination(req, count, page),
    canManage: can(req, "products.manage"),
  });
};

export const show = async (req, res) => {
  const product = (await productService.getProduct(req.params.id)).get({ plain: true });
  const history = (await productService.priceHistory(product.id)).map((p) => p.get({ plain: true }));
  const outlets = (await Outlet.findAll({ order: [["name", "ASC"]] })).map((o) => o.get({ plain: true }));
  const current = Object.fromEntries(history.filter((h) => !h.effectiveTo).map((h) => [h.outletId, h]));
  res.render("products/show", {
    title: product.name,
    breadcrumbs: crumbs(product.name),
    product,
    outletPrices: outlets.map((o) => ({ outlet: o, current: current[o.id] || null })),
    history,
    canManage: can(req, "products.manage"),
  });
};

export const newForm = async (req, res) => {
  res.render("products/form", { title: "New product or service", breadcrumbs: crumbs("New"), product: { itemType: "PRODUCT", unit: "pc", status: "AVAILABLE" }, ...(await formOptions()) });
};

export const create = async (req, res) => {
  const product = await handleForm(res, () => productService.createProduct(req, req.body, req.file), {
    view: "products/form",
    locals: async () => ({ title: "New product or service", breadcrumbs: crumbs("New"), product: req.body, ...(await formOptions()) }),
  });
  if (!product) return;
  req.flash("success_msg", `${product.name} was created. Set its price for each outlet below.`);
  res.redirect(`/products/${product.id}`);
};

export const editForm = async (req, res) => {
  const product = (await productService.getProduct(req.params.id)).get({ plain: true });
  res.render("products/form", { title: `Edit ${product.name}`, breadcrumbs: crumbs(product.name, `/products/${product.id}`), product, editing: true, ...(await formOptions()) });
};

export const update = async (req, res) => {
  const product = await handleForm(res, () => productService.updateProduct(req, req.params.id, req.body, req.file), {
    view: "products/form",
    locals: async () => ({ title: "Edit product", breadcrumbs: crumbs("Edit"), product: { ...req.body, id: req.params.id }, editing: true, ...(await formOptions()) }),
  });
  if (!product) return;
  req.flash("success_msg", `${product.name} was updated.`);
  res.redirect(`/products/${product.id}`);
};

export const setPrice = async (req, res) => {
  await productService.setOutletPrice(req, req.params.id, req.body);
  req.flash("success_msg", "Outlet price saved. The previous price was kept in the price history.");
  res.redirect(`/products/${req.params.id}#prices`);
};

export const removePrice = async (req, res) => {
  await productService.removeFromOutlet(req, req.params.id, req.params.outletId);
  req.flash("success_msg", "The product is no longer sold at that outlet.");
  res.redirect(`/products/${req.params.id}#prices`);
};

// ── Taxes ────────────────────────────────────────────────────────────────

export const taxes = async (req, res) => {
  const editing = req.query.edit ? (await Tax.findByPk(req.query.edit))?.get({ plain: true }) : null;
  if (req.query.edit && !editing) throw notFound("Tax");
  res.render("products/taxes", {
    title: "Taxes",
    breadcrumbs: crumbs("Taxes"),
    taxes: (await Tax.findAll({ order: [["name", "ASC"]] })).map((t) => t.get({ plain: true })),
    tax: editing ? { ...editing, ratePercent: (Number(editing.rate) * 100).toFixed(2) } : { isInclusive: true },
    editing: Boolean(editing),
  });
};

export const saveTax = async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  const tax = await handleForm(res, () => productService.saveTax(req, id, req.body), {
    view: "products/taxes",
    locals: async () => ({
      title: "Taxes",
      breadcrumbs: crumbs("Taxes"),
      taxes: (await Tax.findAll({ order: [["name", "ASC"]] })).map((t) => t.get({ plain: true })),
      tax: { ...req.body, id },
      editing: Boolean(id),
    }),
  });
  if (!tax) return;
  req.flash("success_msg", `Tax ${tax.code} was saved.`);
  res.redirect("/products/taxes");
};
