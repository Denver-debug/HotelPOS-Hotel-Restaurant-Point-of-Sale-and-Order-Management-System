// Per-request context that follows async calls without being passed around.
// Used to stamp outbound integration calls with the inbound request id, so a request can be
// traced from the POS (X-Request-Id) through integration_logs to the PMS/HR/payment logs
// (X-Correlation-Id).
import { AsyncLocalStorage } from "async_hooks";

export const requestContext = new AsyncLocalStorage();
export const outboundContext = new AsyncLocalStorage();

export const currentRequestId = () => requestContext.getStore()?.requestId ?? null;
export const currentCorrelationId = () => outboundContext.getStore()?.correlationId ?? null;
