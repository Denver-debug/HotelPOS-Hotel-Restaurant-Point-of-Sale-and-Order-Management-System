import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as pos from "../controllers/posController.js";

const router = express.Router();

router.get("/", (req, res) => res.redirect("/pos/terminal"));
router.get("/terminal", requirePermission("pos.access"), asyncHandler(pos.terminal));

export default router;
