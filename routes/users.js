import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as users from "../controllers/userController.js";

const router = express.Router();
const canManage = requirePermission("users.manage");

router.get("/", canManage, asyncHandler(users.index));
router.get("/new", canManage, asyncHandler(users.newForm));
router.post("/", canManage, asyncHandler(users.create));
router.get("/:id(\\d+)/edit", canManage, asyncHandler(users.editForm));
router.post("/:id(\\d+)", canManage, asyncHandler(users.update));

export default router;
