// JSON API used by the POS terminal (Figure 8: POST /api/orders, POST /api/orders/{id}/room-charge).
import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as pos from "../controllers/posController.js";
import * as orders from "../controllers/orderController.js";
import * as payments from "../controllers/paymentController.js";
import * as receipts from "../controllers/receiptController.js";
import * as guestCharges from "../controllers/guestChargeController.js";

const router = express.Router();
const canOrder = requirePermission("orders.create");
const canView = requirePermission("orders.view", "pos.access");

router.get("/pos/catalog", requirePermission("pos.access"), asyncHandler(pos.catalog));
router.get("/pos/open-orders", requirePermission("pos.access"), asyncHandler(orders.apiOpenOrders));

router.post("/orders", canOrder, asyncHandler(orders.apiCreate));
router.get("/orders/:id(\\d+)", canView, asyncHandler(orders.apiShow));
router.patch("/orders/:id(\\d+)", canOrder, asyncHandler(orders.apiUpdate));
router.post("/orders/:id(\\d+)/items", canOrder, asyncHandler(orders.apiAddItem));
router.patch("/orders/:id(\\d+)/items/:itemId(\\d+)", canOrder, asyncHandler(orders.apiUpdateItem));
router.delete("/orders/:id(\\d+)/items/:itemId(\\d+)", canOrder, asyncHandler(orders.apiRemoveItem));
router.post("/orders/:id(\\d+)/request-settlement", canOrder, asyncHandler(orders.apiRequestSettlement));
router.post("/orders/:id(\\d+)/reopen", canOrder, asyncHandler(orders.apiReopen));
// Void needs orders.void, or a supervisor override supplied in the request body.
router.post("/orders/:id(\\d+)/void", canOrder, asyncHandler(orders.apiVoid));

router.post("/orders/:id(\\d+)/payments", requirePermission("payments.process"), asyncHandler(payments.apiPay));
const canCharge = requirePermission("room_charges.process");
router.post("/orders/:id(\\d+)/room-charge/validate", canCharge, asyncHandler(guestCharges.apiValidate));
router.post("/orders/:id(\\d+)/room-charge", canCharge, asyncHandler(guestCharges.apiPost));
router.post("/guest-charges/:id(\\d+)/verify", canCharge, asyncHandler(guestCharges.apiVerify));

router.post("/receipts/:id(\\d+)/printed", requirePermission("receipts.view"), asyncHandler(receipts.apiPrinted));

export default router;
