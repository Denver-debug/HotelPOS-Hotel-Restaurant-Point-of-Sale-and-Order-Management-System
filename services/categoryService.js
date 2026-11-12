// Product and service categories (archived, never deleted).
import { Op } from "sequelize";
import { sequelize, Category, Product } from "../models/index.js";
import { AppError, notFound } from "../utils/http.js";
import * as v from "../utils/validate.js";
import { audit, diff } from "./auditService.js";

export async function listCategories({ status } = {}) {
  const rows = await Category.findAll({
    where: status ? { status } : {},
    attributes: {
      include: [[sequelize.literal("(SELECT COUNT(*) FROM products p WHERE p.category_id = Category.id AND p.status <> 'ARCHIVED')"), "productCount"]],
    },
    order: [["status", "ASC"], ["sortOrder", "ASC"], ["name", "ASC"]],
  });
  return rows.map((r) => r.get({ plain: true }));
}

const parse = (body) => ({
  name: v.str(body.name, "Category name", { required: true, max: 80 }),
  description: v.str(body.description, "Description", { max: 255 }),
  sortOrder: v.int(body.sortOrder || "0", "Sort order", { min: 0, max: 9999 }),
});

export async function saveCategory(req, id, body) {
  const data = parse(body);
  return sequelize.transaction(async (transaction) => {
    if (!id) {
      const category = await Category.create(data, { transaction });
      await audit({ req, action: "CATEGORY_CREATED", entityType: "category", entityId: category.id, newValues: category, transaction });
      return category;
    }
    const category = await Category.findByPk(id, { transaction });
    if (!category) throw notFound("Category");
    const before = category.get({ plain: true });
    await category.update(data, { transaction });
    const { oldValues, newValues } = diff(before, category);
    await audit({ req, action: "CATEGORY_UPDATED", entityType: "category", entityId: id, oldValues, newValues, transaction });
    return category;
  });
}

export async function setCategoryStatus(req, id, status) {
  const category = await Category.findByPk(id);
  if (!category) throw notFound("Category");
  if (status === "ARCHIVED") {
    const active = await Product.count({ where: { categoryId: id, status: { [Op.ne]: "ARCHIVED" } } });
    if (active > 0) throw new AppError(`Move or archive the ${active} product(s) in “${category.name}” before archiving it.`, 409, "CATEGORY_IN_USE");
  }
  const before = category.status;
  await category.update({ status });
  await audit({ req, action: status === "ARCHIVED" ? "CATEGORY_ARCHIVED" : "CATEGORY_RESTORED", entityType: "category", entityId: id, oldValues: { status: before }, newValues: { status } });
  return category;
}
