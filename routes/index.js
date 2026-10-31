/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

// Route registry: each feature lives in its own router module under routes/.
import express from "express";
import { homePage } from "../controllers/homeController.js";
import { asyncHandler } from "../utils/http.js";
import authRoutes from "./auth.js";
import dashboardRoutes from "./dashboard.js";
import userRoutes from "./users.js";
import roleRoutes from "./roles.js";
import outletRoutes from "./outlets.js";
import categoryRoutes from "./categories.js";
import productRoutes from "./products.js";
import inventoryRoutes from "./inventory.js";
import shiftRoutes from "./shifts.js";
import posRoutes from "./pos.js";
import orderRoutes from "./orders.js";
import apiRoutes from "./api.js";
import paymentRoutes from "./payments.js";
import receiptRoutes from "./receipts.js";
import guestChargeRoutes from "./guestCharges.js";
import discountRoutes from "./discounts.js";
import refundRoutes from "./refunds.js";
import reportRoutes from "./reports.js";
import systemRoutes from "./system.js";

const router = express.Router();

router.get("/", asyncHandler(homePage));
router.use("/", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/users", userRoutes);
router.use("/roles", roleRoutes);
router.use("/outlets", outletRoutes);
router.use("/categories", categoryRoutes);
router.use("/products", productRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/shifts", shiftRoutes);
router.use("/pos", posRoutes);
router.use("/orders", orderRoutes);
router.use("/payments", paymentRoutes);
router.use("/receipts", receiptRoutes);
router.use("/guest-charges", guestChargeRoutes);
router.use("/discounts", discountRoutes);
router.use("/refunds", refundRoutes);
router.use("/reports", reportRoutes);
router.use("/", systemRoutes);
router.use("/api", apiRoutes);

export default router;
