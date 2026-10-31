import express from "express";
import { asyncHandler } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  loginPage, loginUser, logoutUser, forgotPasswordPage, changePasswordPage, changePassword,
} from "../controllers/authController.js";

const router = express.Router();

router.get("/login", loginPage);
router.post("/login", asyncHandler(loginUser));
router.post("/logout", asyncHandler(logoutUser));
router.get("/forgot-password", forgotPasswordPage);
router.get("/account/password", requireAuth, changePasswordPage);
router.post("/account/password", requireAuth, asyncHandler(changePassword));

export default router;
