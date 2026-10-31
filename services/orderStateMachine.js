// Order lifecycle from the State Machine Diagram (Figure 13).
//
//   OPEN ─addItem→ IN_PROGRESS ─requestSettlement→ AWAITING_SETTLEMENT
//   AWAITING_SETTLEMENT ─editOrder→ IN_PROGRESS
//   AWAITING_SETTLEMENT ─pay / chargeToRoom→ SETTLING (Payment Processing / Folio Validation / Posting Charge)
//   SETTLING ─declined / invalidFolio→ AWAITING_SETTLEMENT     SETTLING ─postFailed→ CHARGE_FAILED
//   CHARGE_FAILED ─retry→ SETTLING      CHARGE_FAILED ─cancelCharge→ AWAITING_SETTLEMENT
//   SETTLING ─paymentCaptured / chargePosted + postSaleDone→ COMPLETED
//   COMPLETED ─refundApproved→ PARTIALLY_REFUNDED | REFUNDED
//   OPEN | IN_PROGRESS (| AWAITING_SETTLEMENT | CHARGE_FAILED with nothing collected) ─void [supervisor]→ VOIDED
import { AppError } from "../utils/http.js";

export const TRANSITIONS = {
  OPEN: ["IN_PROGRESS", "VOIDED"],
  IN_PROGRESS: ["IN_PROGRESS", "AWAITING_SETTLEMENT", "VOIDED"],
  AWAITING_SETTLEMENT: ["IN_PROGRESS", "SETTLING", "AWAITING_SETTLEMENT", "COMPLETED", "VOIDED"],
  SETTLING: ["AWAITING_SETTLEMENT", "CHARGE_FAILED", "COMPLETED"],
  CHARGE_FAILED: ["SETTLING", "AWAITING_SETTLEMENT", "VOIDED"],
  COMPLETED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  VOIDED: [],
  REFUNDED: [],
};

export const EDITABLE_STATUSES = ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT"];
export const SETTLEABLE_STATUSES = ["AWAITING_SETTLEMENT", "CHARGE_FAILED"];
export const VOIDABLE_STATUSES = ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "CHARGE_FAILED"];
export const FINAL_SALE_STATUSES = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"];

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new AppError(`An order that is ${from.replace(/_/g, " ").toLowerCase()} cannot become ${to.replace(/_/g, " ").toLowerCase()}.`, 409, "INVALID_TRANSITION");
  }
}
