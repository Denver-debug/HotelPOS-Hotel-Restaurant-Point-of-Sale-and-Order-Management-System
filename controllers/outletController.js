import { User } from "../models/index.js";
import { OUTLET_TYPES } from "../models/catalogModel.js";
import * as outletService from "../services/outletService.js";
import { handleForm } from "../utils/forms.js";

const crumbs = (label, href) => [{ label: "Outlets", href: "/outlets" }, ...(label ? [{ label, href }] : [])];

export const index = async (req, res) => {
  res.render("outlets/index", { title: "Outlets", breadcrumbs: crumbs(), outlets: await outletService.listOutlets() });
};

export const show = async (req, res) => {
  const outlet = (await outletService.getOutlet(req.params.id)).get({ plain: true });
  const users = (await User.findAll({ where: { status: "ACTIVE" }, order: [["fullName", "ASC"]], include: ["role"] })).map((u) => u.get({ plain: true }));
  res.render("outlets/show", {
    title: outlet.name,
    breadcrumbs: crumbs(outlet.name),
    outlet,
    assignedIds: outlet.users.map((u) => u.id),
    users,
    products: await outletService.outletProducts(outlet.id),
  });
};

export const newForm = (req, res) =>
  res.render("outlets/form", { title: "New outlet", breadcrumbs: crumbs("New"), outlet: { status: "ACTIVE", allowsRoomCharge: true, serviceChargeRate: "0.00" }, types: OUTLET_TYPES });

export const create = async (req, res) => {
  const outlet = await handleForm(res, () => outletService.createOutlet(req, req.body), {
    view: "outlets/form",
    locals: { title: "New outlet", breadcrumbs: crumbs("New"), outlet: req.body, types: OUTLET_TYPES },
  });
  if (!outlet) return;
  req.flash("success_msg", `Outlet ${outlet.name} was created with a default stock location.`);
  res.redirect(`/outlets/${outlet.id}`);
};

export const editForm = async (req, res) => {
  const outlet = (await outletService.getOutlet(req.params.id)).get({ plain: true });
  res.render("outlets/form", { title: `Edit ${outlet.name}`, breadcrumbs: crumbs(outlet.name, `/outlets/${outlet.id}`), outlet, types: OUTLET_TYPES, editing: true });
};

export const update = async (req, res) => {
  const outlet = await handleForm(res, () => outletService.updateOutlet(req, req.params.id, req.body), {
    view: "outlets/form",
    locals: { title: "Edit outlet", breadcrumbs: crumbs("Edit"), outlet: { ...req.body, id: req.params.id }, types: OUTLET_TYPES, editing: true },
  });
  if (!outlet) return;
  req.flash("success_msg", `Outlet ${outlet.name} was updated.`);
  res.redirect(`/outlets/${outlet.id}`);
};

export const assignUsers = async (req, res) => {
  await outletService.setAssignedUsers(req, req.params.id, req.body.userIds);
  req.flash("success_msg", "Assigned users were updated.");
  res.redirect(`/outlets/${req.params.id}`);
};
