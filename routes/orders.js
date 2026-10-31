import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as orders from "../controllers/orderController.js";

const router = express.Router();

router.get("/", requirePermission("orders.view"), asyncHandler(orders.index));
router.get("/:id(\\d+)", requirePermission("orders.view"), asyncHandler(orders.show));

export default router;
