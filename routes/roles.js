import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as users from "../controllers/userController.js";

const router = express.Router();
const canManage = requirePermission("roles.manage");

router.get("/", canManage, asyncHandler(users.rolesIndex));
router.get("/new", canManage, asyncHandler(users.roleForm));
router.post("/", canManage, asyncHandler(users.saveRole));
router.get("/:id(\\d+)", canManage, asyncHandler(users.roleForm));
router.post("/:id(\\d+)", canManage, asyncHandler(users.saveRole));

export default router;
