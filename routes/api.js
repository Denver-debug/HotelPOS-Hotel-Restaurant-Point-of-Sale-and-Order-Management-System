// JSON API. Mounted at /api/v1 (the versioned contract for other ERP subsystems, documented in
// docs/API.md and served as /api/v1/openapi.json) and at /api (the same routes, used by the POS
// terminal). Callers authenticate with a browser session + CSRF token, or with an API key
// ("Authorization: Bearer hpos_…") bound to a service account. Every route declares its permission.
import express from "express";
import { asyncHandler, AppError } from "../utils/http.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { idempotencyHeader } from "../middleware/apiEdge.js";
import * as pos from "../controllers/posController.js";
import * as orders from "../controllers/orderController.js";
import * as payments from "../controllers/paymentController.js";
import * as receipts from "../controllers/receiptController.js";
import * as guestCharges from "../controllers/guestChargeController.js";
import * as discounts from "../controllers/discountController.js";
import * as api from "../controllers/apiController.js";

const router = express.Router();
const ID = "(\\d+)";
const canOrder = requirePermission("orders.create");
const canViewOrders = requirePermission("orders.view", "pos.access");

router.use(idempotencyHeader);

// ── Service ──────────────────────────────────────────────────────────────
router.get("/health", asyncHandler(api.health));
router.get("/openapi.json", api.openapi);
router.get("/me", requireAuth, asyncHandler(api.me));

// ── Reference data ───────────────────────────────────────────────────────
router.get("/outlets", requireAuth, asyncHandler(api.outlets));
router.get("/categories", requirePermission("products.view", "products.manage", "pos.access"), asyncHandler(api.categories));
router.get("/payment-methods", requireAuth, asyncHandler(api.paymentMethods));
router.get("/products", requirePermission("products.view", "products.manage"), asyncHandler(api.products));

// ── POS terminal ─────────────────────────────────────────────────────────
router.get("/pos/catalog", requirePermission("pos.access"), asyncHandler(pos.catalog));
router.get("/pos/open-orders", requirePermission("pos.access"), asyncHandler(orders.apiOpenOrders));

// ── Orders ───────────────────────────────────────────────────────────────
router.get("/orders", requirePermission("orders.view"), asyncHandler(api.orders));
router.post("/orders", canOrder, asyncHandler(orders.apiCreate));
router.get(`/orders/:id${ID}`, canViewOrders, asyncHandler(orders.apiShow));
router.patch(`/orders/:id${ID}`, canOrder, asyncHandler(orders.apiUpdate));
router.post(`/orders/:id${ID}/items`, canOrder, asyncHandler(orders.apiAddItem));
router.patch(`/orders/:id${ID}/items/:itemId${ID}`, canOrder, asyncHandler(orders.apiUpdateItem));
router.delete(`/orders/:id${ID}/items/:itemId${ID}`, canOrder, asyncHandler(orders.apiRemoveItem));
router.post(`/orders/:id${ID}/request-settlement`, canOrder, asyncHandler(orders.apiRequestSettlement));
router.post(`/orders/:id${ID}/reopen`, canOrder, asyncHandler(orders.apiReopen));
// Void needs orders.void, or a supervisor override supplied in the request body.
router.post(`/orders/:id${ID}/void`, canOrder, asyncHandler(orders.apiVoid));

// ── Discounts ────────────────────────────────────────────────────────────
const canDiscount = requirePermission("discounts.apply");
router.get(`/orders/:id${ID}/discounts/available`, canDiscount, asyncHandler(discounts.apiAvailable));
router.post(`/orders/:id${ID}/discounts`, canDiscount, asyncHandler(discounts.apiApply));
router.delete(`/orders/:id${ID}/discounts/:orderDiscountId${ID}`, canDiscount, asyncHandler(discounts.apiRemove));

// ── Settlement ───────────────────────────────────────────────────────────
router.post(`/orders/:id${ID}/payments`, requirePermission("payments.process"), asyncHandler(payments.apiPay));
router.get("/payments", requirePermission("payments.view"), asyncHandler(api.payments));
const canCharge = requirePermission("room_charges.process");
router.post(`/orders/:id${ID}/room-charge/validate`, canCharge, asyncHandler(guestCharges.apiValidate));
router.post(`/orders/:id${ID}/room-charge`, canCharge, asyncHandler(guestCharges.apiPost));
router.post(`/guest-charges/:id${ID}/verify`, canCharge, asyncHandler(guestCharges.apiVerify));
router.get("/guest-charges", requirePermission("room_charges.view"), asyncHandler(api.guestCharges));
router.get(`/guest-charges/:id${ID}`, requirePermission("room_charges.view"), asyncHandler(api.guestCharge));
router.get("/refunds", requirePermission("refunds.view", "refunds.approve"), asyncHandler(api.refunds));
router.get(`/refunds/:id${ID}`, requirePermission("refunds.view", "refunds.approve"), asyncHandler(api.refund));
router.get(`/receipts/:id${ID}`, requirePermission("receipts.view"), asyncHandler(api.receipt));
router.post(`/receipts/:id${ID}/printed`, requirePermission("receipts.view"), asyncHandler(receipts.apiPrinted));

// ── Shifts ───────────────────────────────────────────────────────────────
const canSeeShifts = requirePermission("shifts.view", "shifts.open", "shifts.manage");
router.get("/shifts", canSeeShifts, asyncHandler(api.shifts));
router.get("/shifts/current", canSeeShifts, asyncHandler(api.shiftCurrent));
router.get(`/shifts/:id${ID}`, canSeeShifts, asyncHandler(api.shiftShow));
router.post("/shifts", requirePermission("shifts.open"), asyncHandler(api.shiftOpen));
router.post(`/shifts/:id${ID}/close`, requirePermission("shifts.open", "shifts.manage"), asyncHandler(api.shiftClose));

// ── Inventory ────────────────────────────────────────────────────────────
router.get("/inventory/levels", requirePermission("inventory.view"), asyncHandler(api.stockLevels));
router.get("/inventory/movements", requirePermission("inventory.view"), asyncHandler(api.movements));
router.post("/inventory/movements", requirePermission("inventory.manage", "inventory.adjust"), asyncHandler(api.movementCreate));

// ── Events (pull feed over the outbox) ───────────────────────────────────
router.get("/events", requirePermission("integrations.view"), asyncHandler(api.events));

// ── Reports ──────────────────────────────────────────────────────────────
router.get("/reports", requirePermission("reports.view"), api.reports);
router.get("/reports/:key", requirePermission("reports.view"), asyncHandler(api.report));

// Unknown /api paths are JSON 404s (never the HTML error page).
router.use((req, res, next) => next(new AppError(`No API endpoint matches ${req.method} ${req.originalUrl.split("?")[0]}.`, 404, "NOT_FOUND")));

export default router;
