// Minimal JSON HTTP client for real ERP integrations (native fetch + timeout).
import { IntegrationError } from "./integrationLogger.js";

export async function requestJson({ baseUrl, apiKey, timeoutMs, method = "GET", path, body, idempotencyKey, correlationId }) {
  if (!baseUrl) throw new IntegrationError("NOT_CONFIGURED", "Integration base URL is not configured.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (correlationId) headers["X-Correlation-Id"] = correlationId;

  let res;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new IntegrationError("TIMEOUT", `No response within ${timeoutMs} ms.`);
    throw new IntegrationError("NETWORK", `Connection failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    if (res.ok) throw new IntegrationError("INVALID_RESPONSE", "Response was not valid JSON.", { httpStatus: res.status });
  }
  return { httpStatus: res.status, ok: res.ok, data };
}
