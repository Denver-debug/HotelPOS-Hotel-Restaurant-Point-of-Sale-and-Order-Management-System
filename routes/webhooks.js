// Public endpoints for the payment provider and the guest's phone: no session, no CSRF.
// Mounted in index.js before the session-user and CSRF middleware.
import express from "express";
import { asyncHandler } from "../utils/http.js";
import * as payments from "../controllers/paymentController.js";
import * as guestCharges from "../controllers/guestChargeController.js";

const router = express.Router();

router.post("/webhooks/paymongo", asyncHandler(payments.webhook));
router.post("/webhooks/pms", asyncHandler(guestCharges.pmsWebhook));
router.get("/pay/complete", payments.complete);

export default router;
