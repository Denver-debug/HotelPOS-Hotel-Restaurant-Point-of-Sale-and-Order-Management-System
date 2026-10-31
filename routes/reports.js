import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as reports from "../controllers/reportController.js";

const router = express.Router();
const canView = requirePermission("reports.view");

router.get("/", canView, reports.index);
router.get("/:type", canView, asyncHandler(reports.show));

export default router;
