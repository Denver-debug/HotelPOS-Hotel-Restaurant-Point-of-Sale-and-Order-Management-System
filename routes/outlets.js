import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as outlets from "../controllers/outletController.js";

const router = express.Router();
const canManage = requirePermission("outlets.manage");

router.get("/", canManage, asyncHandler(outlets.index));
router.get("/new", canManage, outlets.newForm);
router.post("/", canManage, asyncHandler(outlets.create));
router.get("/:id(\\d+)", canManage, asyncHandler(outlets.show));
router.get("/:id(\\d+)/edit", canManage, asyncHandler(outlets.editForm));
router.post("/:id(\\d+)", canManage, asyncHandler(outlets.update));
router.post("/:id(\\d+)/users", canManage, asyncHandler(outlets.assignUsers));

export default router;
