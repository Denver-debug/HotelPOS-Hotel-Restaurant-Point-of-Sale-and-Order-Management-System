import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requirePermission } from "../middleware/auth.js";
import { productImage } from "../middleware/upload.js";
import * as products from "../controllers/productController.js";

const router = express.Router();
const canView = requirePermission("products.view", "products.manage");
const canManage = requirePermission("products.manage");

router.get("/", canView, asyncHandler(products.index));
router.get("/new", canManage, asyncHandler(products.newForm));
router.post("/", canManage, productImage, asyncHandler(products.create));
router.get("/taxes", canManage, asyncHandler(products.taxes));
router.post("/taxes", canManage, asyncHandler(products.saveTax));
router.post("/taxes/:id(\\d+)", canManage, asyncHandler(products.saveTax));
router.get("/:id(\\d+)", canView, asyncHandler(products.show));
router.get("/:id(\\d+)/edit", canManage, asyncHandler(products.editForm));
router.post("/:id(\\d+)", canManage, productImage, asyncHandler(products.update));
router.post("/:id(\\d+)/prices", canManage, asyncHandler(products.setPrice));
router.post("/:id(\\d+)/prices/:outletId(\\d+)/remove", canManage, asyncHandler(products.removePrice));

export default router;
