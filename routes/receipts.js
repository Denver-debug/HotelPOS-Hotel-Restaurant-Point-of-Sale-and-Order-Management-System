import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as receipts from "../controllers/receiptController.js";

const router = express.Router();

router.get("/", requirePermission("receipts.view"), asyncHandler(receipts.index));
router.get("/:id(\\d+)", requirePermission("receipts.view"), asyncHandler(receipts.show));

export default router;
