import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as shifts from "../controllers/shiftController.js";

const router = express.Router();

router.get("/", requirePermission("shifts.view", "shifts.manage"), asyncHandler(shifts.index));
router.get("/open", requirePermission("shifts.open"), shifts.openForm);
router.post("/open", requirePermission("shifts.open"), asyncHandler(shifts.open));
router.get("/:id(\\d+)", requirePermission("shifts.view", "shifts.open", "shifts.manage"), asyncHandler(shifts.show));
router.post("/:id(\\d+)/close", requirePermission("shifts.open", "shifts.manage"), asyncHandler(shifts.close));
router.post("/:id(\\d+)/reconcile", requirePermission("shifts.manage"), asyncHandler(shifts.reconcile));

export default router;
