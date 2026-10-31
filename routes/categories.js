import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as categories from "../controllers/categoryController.js";

const router = express.Router();
const canManage = requirePermission("categories.manage");

router.get("/", canManage, asyncHandler(categories.index));
router.post("/", canManage, asyncHandler(categories.save));
router.post("/:id(\\d+)", canManage, asyncHandler(categories.save));
router.post("/:id(\\d+)/archive", canManage, asyncHandler(categories.archive));
router.post("/:id(\\d+)/restore", canManage, asyncHandler(categories.restore));

export default router;
