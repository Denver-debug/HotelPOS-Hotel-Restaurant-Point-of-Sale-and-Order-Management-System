// Payment provider integration contract (Class diagram: PaymentGateway interface).
//
// interface PaymentGateway {
//   name: string; isMock: boolean;
//   authorizeAndCapture({ amount, currency, methodCode, reference, idempotencyKey })
//       -> { status: "CAPTURED", transactionId } | { status: "DECLINED", reason }
//       throws IntegrationError("TIMEOUT" | "NETWORK") when the outcome is unknown
//   getStatus(idempotencyKey) -> { status: "CAPTURED" | "DECLINED" | "NOT_FOUND", transactionId?, reason? }
//   refund({ transactionId, amount, idempotencyKey }) -> { status: "REFUNDED", refundId } | { status: "REJECTED", reason }
// }
//
// No real provider is integrated yet: only the mock adapter is available. A real adapter
// (e.g. a card acquirer or e-wallet SDK) must implement the same methods — see docs/INTEGRATIONS.md.
import { config } from "../../config/env.js";
import { MockPaymentAdapter } from "./mockPaymentAdapter.js";

let instance;

export function getPaymentGateway() {
  if (!instance) {
    const { adapter } = config.integrations.payment;
    if (adapter !== "mock") {
      throw new Error(`PAYMENT_ADAPTER="${adapter}" is not implemented. Only "mock" is available until a real provider adapter is added.`);
    }
    instance = new MockPaymentAdapter();
  }
  return instance;
}
