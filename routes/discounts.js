import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as discounts from "../controllers/discountController.js";

const router = express.Router();
const canManage = requirePermission("discounts.manage");

router.get("/", canManage, asyncHandler(discounts.index));
router.get("/new", canManage, asyncHandler(discounts.newForm));
router.post("/", canManage, asyncHandler(discounts.create));
router.get("/:id(\\d+)", canManage, asyncHandler(discounts.show));
router.get("/:id(\\d+)/edit", canManage, asyncHandler(discounts.editForm));
router.post("/:id(\\d+)", canManage, asyncHandler(discounts.update));

export default router;
