import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as payments from "../controllers/paymentController.js";

const router = express.Router();

router.get("/", requirePermission("payments.view"), asyncHandler(payments.index));
router.post("/:id(\\d+)/verify", requirePermission("payments.process"), asyncHandler(payments.verify));

export default router;
