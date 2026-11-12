import { paymentMethods } from "../services/lookupService.js";
import { ORDER_TYPES } from "../models/salesModel.js";
import * as productService from "../services/productService.js";
import { getSetting } from "../services/settingsService.js";
import { forbidden } from "../utils/http.js";
import { can } from "../middleware/auth.js";
import { config } from "../config/env.js";

const pickOutlet = (req) => {
  const requested = Number(req.query.outletId);
  if (requested) {
    if (!req.user.outletIds.includes(requested)) throw forbidden("You are not assigned to this outlet.");
    return req.outlets.find((o) => o.id === requested);
  }
  return req.outlets.find((o) => o.id === req.openShift?.outletId) || req.outlets[0];
};

// Dedicated full-screen POS terminal (Figure 8: POSTerminalPage /pos/terminal).
export const terminal = async (req, res) => {
  const outlet = pickOutlet(req);
  if (!outlet) {
    req.flash("error_msg", "You are not assigned to any active outlet. Ask an administrator to assign you.");
    return res.redirect("/dashboard");
  }
  const catalog = await productService.outletCatalog(outlet.id);
  const categories = [...new Map(catalog.map((p) => [p.categoryId, { id: p.categoryId, name: p.categoryName }])).values()];
  const methods = await paymentMethods({ activeOnly: true });
  const requireShift = await getSetting("require_shift_for_settlement", true);

  res.render("pos/terminal", {
    layout: "layouts/pos",
    title: "POS Terminal",
    outlet,
    outlets: req.outlets,
    boot: {
      outlet: { id: outlet.id, code: outlet.code, name: outlet.name, outletType: outlet.outletType, allowsRoomCharge: Boolean(outlet.allowsRoomCharge) },
      catalog,
      categories,
      paymentMethods: methods.map((m) => ({ id: m.id, code: m.code, name: m.name, isCash: m.isCash, usesGateway: m.usesGateway, requiresReference: m.requiresReference })),
      orderTypes: ORDER_TYPES,
      resumeOrderId: Number(req.query.orderId) || null,
      currency: config.currencySymbol,
      shift: req.openShift ? { id: req.openShift.id, number: req.openShift.shiftNumber, outletId: req.openShift.outletId } : null,
      requireShift,
      mocks: {
        pms: config.integrations.pms.adapter !== "http",
        payment: config.integrations.payment.adapter !== "http",
      },
      can: {
        settle: can(req, "payments.process"),
        roomCharge: can(req, "room_charges.process"),
        void: can(req, "orders.void"),
        discount: can(req, "discounts.apply"),
        authorizeDiscount: can(req, "discounts.authorize"),
        openShift: can(req, "shifts.open"),
      },
    },
  });
};

export const catalog = async (req, res) => {
  const outlet = pickOutlet(req);
  res.json({ ok: true, catalog: await productService.outletCatalog(outlet.id) });
};
