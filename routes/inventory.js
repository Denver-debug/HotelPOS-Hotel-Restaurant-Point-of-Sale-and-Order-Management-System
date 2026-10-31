import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import * as inventory from "../controllers/inventoryController.js";

const router = express.Router();
const canView = requirePermission("inventory.view");
const canRecord = requirePermission("inventory.manage", "inventory.adjust");
const canManage = requirePermission("inventory.manage");

router.get("/", canView, asyncHandler(inventory.index));
router.get("/movements", canView, asyncHandler(inventory.movements));
router.get("/movements/new", canRecord, asyncHandler(inventory.movementForm));
router.post("/movements", canRecord, asyncHandler(inventory.recordMovement));
router.get("/items", canManage, asyncHandler(inventory.items));
router.post("/items", canManage, asyncHandler(inventory.saveItem));
router.post("/items/:id(\\d+)", canManage, asyncHandler(inventory.saveItem));
router.post("/levels/:id(\\d+)", canManage, asyncHandler(inventory.updateLevel));
router.get("/locations", canView, asyncHandler(inventory.locations));
router.get("/recipes/:productId(\\d+)", requirePermission("products.manage"), asyncHandler(inventory.recipeForm));
router.post("/recipes/:productId(\\d+)", requirePermission("products.manage"), asyncHandler(inventory.saveRecipe));

export default router;
