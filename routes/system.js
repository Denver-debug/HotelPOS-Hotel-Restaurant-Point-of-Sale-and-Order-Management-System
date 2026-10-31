import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as system from "../controllers/systemController.js";

const router = express.Router();

router.get("/audit-logs", requirePermission("audit.view"), asyncHandler(system.auditIndex));
router.get("/integrations", requirePermission("integrations.view"), asyncHandler(system.integrations));
router.get("/integrations/logs/:id(\\d+)", requirePermission("integrations.view"), asyncHandler(system.integrationLog));
router.post("/integrations/events/dispatch", requirePermission("integrations.manage"), asyncHandler(system.dispatchEvents));
router.get("/settings", requirePermission("settings.manage"), asyncHandler(system.settings));
router.post("/settings", requirePermission("settings.manage"), asyncHandler(system.saveSettings));
router.post("/settings/payment-methods/:id(\\d+)", requirePermission("settings.manage"), asyncHandler(system.savePaymentMethod));

export default router;
