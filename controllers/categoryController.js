import { Category } from "../models/index.js";
import * as categoryService from "../services/categoryService.js";
import { handleForm } from "../utils/forms.js";

const render = async (res, extra = {}) =>
  res.render("categories/index", {
    title: "Categories",
    breadcrumbs: [{ label: "Categories" }],
    categories: await categoryService.listCategories(),
    ...extra,
  });

export const index = async (req, res) => {
  const editing = req.query.edit ? (await Category.findByPk(req.query.edit))?.get({ plain: true }) : null;
  await render(res, { category: editing || {}, editing: Boolean(editing) });
};

export const save = async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  const category = await handleForm(res, () => categoryService.saveCategory(req, id, req.body), {
    view: "categories/index",
    locals: async () => ({
      title: "Categories",
      breadcrumbs: [{ label: "Categories" }],
      categories: await categoryService.listCategories(),
      category: { ...req.body, id },
      editing: Boolean(id),
    }),
  });
  if (!category) return;
  req.flash("success_msg", `Category “${category.name}” was saved.`);
  res.redirect("/categories");
};

export const archive = async (req, res) => {
  const category = await categoryService.setCategoryStatus(req, req.params.id, "ARCHIVED");
  req.flash("success_msg", `Category “${category.name}” was archived.`);
  res.redirect("/categories");
};

export const restore = async (req, res) => {
  const category = await categoryService.setCategoryStatus(req, req.params.id, "ACTIVE");
  req.flash("success_msg", `Category “${category.name}” was restored.`);
  res.redirect("/categories");
};
