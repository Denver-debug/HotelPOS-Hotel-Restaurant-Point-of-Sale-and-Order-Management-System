import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import { dashboardPage } from "../controllers/dashboardController.js";

const router = express.Router();

router.get("/", requirePermission("dashboard.view"), asyncHandler(dashboardPage));

export default router;
