import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as guestCharges from "../controllers/guestChargeController.js";

const router = express.Router();

router.get("/", requirePermission("room_charges.view"), asyncHandler(guestCharges.index));
router.get("/:id(\\d+)", requirePermission("room_charges.view"), asyncHandler(guestCharges.show));
router.post("/:id(\\d+)/verify", requirePermission("room_charges.process"), asyncHandler(guestCharges.verify));

export default router;
