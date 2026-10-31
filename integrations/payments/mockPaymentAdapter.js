// MOCK payment gateway for development. No card, e-wallet or bank is contacted.
// Simulation rules (by payment reference):
//   "DECLINE"  -> declined by the issuer
//   "TIMEOUT"  -> captured, but the response is lost (tests verify-before-retry)
//   anything else -> approved and captured
import crypto from "crypto";
import { IntegrationError } from "../integrationLogger.js";
import { MockLedger } from "../mockLedger.js";

export class MockPaymentAdapter {
  name = "MockPaymentAdapter";
  isMock = true;

  constructor() {
    this.ledger = new MockLedger("mock-payment-ledger");
  }

  async authorizeAndCapture({ amount, methodCode, reference, idempotencyKey }) {
    const previous = this.ledger.get(idempotencyKey);
    if (previous) return previous; // providers return the original result for a repeated key

    const ref = String(reference || "").toUpperCase();
    if (ref === "DECLINE") {
      return this.ledger.set(idempotencyKey, { status: "DECLINED", reason: "Card declined by issuer (mock).", amount });
    }
    const result = this.ledger.set(idempotencyKey, {
      status: "CAPTURED",
      transactionId: `MOCK-PAY-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      amount,
      methodCode,
    });
    if (ref === "TIMEOUT") throw new IntegrationError("TIMEOUT", "Payment provider did not respond in time (mock).");
    return result;
  }

  async getStatus(idempotencyKey) {
    return this.ledger.get(idempotencyKey) || { status: "NOT_FOUND" };
  }

  async refund({ transactionId, amount, idempotencyKey }) {
    const previous = this.ledger.get(`refund:${idempotencyKey}`);
    if (previous) return previous;
    return this.ledger.set(`refund:${idempotencyKey}`, {
      status: "REFUNDED",
      refundId: `MOCK-RF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      transactionId,
      amount,
    });
  }
}
