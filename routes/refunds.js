import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as refunds from "../controllers/refundController.js";

const router = express.Router();

router.get("/", requirePermission("refunds.view", "refunds.approve"), asyncHandler(refunds.index));
router.get("/new", requirePermission("refunds.request"), asyncHandler(refunds.newForm));
router.post("/", requirePermission("refunds.request"), asyncHandler(refunds.create));
router.get("/:id(\\d+)", requirePermission("refunds.view", "refunds.approve"), asyncHandler(refunds.show));
router.post("/:id(\\d+)/approve", requirePermission("refunds.approve"), asyncHandler(refunds.approve));
router.post("/:id(\\d+)/reject", requirePermission("refunds.approve"), asyncHandler(refunds.reject));

export default router;
