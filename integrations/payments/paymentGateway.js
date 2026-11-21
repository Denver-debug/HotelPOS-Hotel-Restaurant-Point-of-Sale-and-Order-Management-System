// Payment provider integration contract (Class diagram: PaymentGateway interface).
//
// interface PaymentGateway {
//   name: string; isMock: boolean;
//   hostedCheckout?: boolean   // the provider issues the reference (no reference typed at the POS)
//   authorizeAndCapture({ amount, currency, methodCode, reference, idempotencyKey, description, metadata })
//       -> { status: "CAPTURED", transactionId } | { status: "DECLINED", reason }
//        | { status: "AWAITING_CUSTOMER", providerReference, checkoutUrl, expiresAt }  (guest approves on their phone)
//       throws IntegrationError("TIMEOUT" | "NETWORK") when the outcome is unknown
//   getStatus({ idempotencyKey, providerReference })
//       -> { status: "CAPTURED" | "DECLINED" | "NOT_FOUND" | "AWAITING_CUSTOMER", transactionId?, reason? }
//   cancel?({ idempotencyKey, providerReference }) -> same as getStatus; DECLINED once cancelled
//   refund({ transactionId, amount, idempotencyKey }) -> { status: "REFUNDED", refundId } | { status: "REJECTED", reason }
//   parseWebhook?(rawBody, signatureHeader) -> { eventId, type, providerReference } | null (bad signature)
// }
//
// PAYMENT_ADAPTER=paymongo takes GCash and Maya through PayMongo; "mock" simulates them.
import { config } from "../../config/env.js";
import { MockPaymentAdapter } from "./mockPaymentAdapter.js";
import { PayMongoAdapter } from "./paymongoAdapter.js";

let instance;

export function getPaymentGateway() {
  if (!instance) {
    const cfg = config.integrations.payment;
    instance = cfg.adapter === "paymongo" ? new PayMongoAdapter(cfg) : new MockPaymentAdapter();
  }
  return instance;
}
