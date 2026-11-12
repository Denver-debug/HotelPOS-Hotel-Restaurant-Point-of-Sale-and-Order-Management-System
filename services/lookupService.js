// Option lists shared by filter dropdowns and forms, so every page builds them the same way.
import { User, PaymentMethod } from "../models/index.js";

// Every user, because history filters (orders, payments, shifts, audit) must still find people
// who have since been deactivated. Inactive and locked accounts are labelled as such.
export async function staffOptions() {
  const users = await User.findAll({ attributes: ["id", "fullName", "status"], order: [["fullName", "ASC"]] });
  return users.map((u) => ({
    id: u.id,
    fullName: u.status === "ACTIVE" ? u.fullName : `${u.fullName} (${u.status.toLowerCase()})`,
  }));
}

// Payment methods in display order. activeOnly for places that take new payments.
export async function paymentMethods({ activeOnly = false } = {}) {
  const rows = await PaymentMethod.findAll({ where: activeOnly ? { status: "ACTIVE" } : undefined, order: [["sortOrder", "ASC"]] });
  return rows.map((m) => m.get({ plain: true }));
}
