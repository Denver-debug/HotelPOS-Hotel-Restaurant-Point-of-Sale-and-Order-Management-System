// Minimal JSON HTTP client for real ERP integrations (native fetch + timeout).
import { IntegrationError } from "./integrationLogger.js";
import { currentCorrelationId } from "../utils/requestContext.js";

// new URL("rooms/1", "https://pms/api/v1") drops "v1"; a trailing slash keeps every segment.
// An empty path means "exactly baseUrl" (e.g. a webhook endpoint).
export const resolveUrl = (baseUrl, path) =>
  !path ? new URL(baseUrl) : new URL(String(path).replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

// rawBody: a string sent byte-for-byte (e.g. a signed webhook); headers: extra request headers;
// expectJson=false accepts an empty or non-JSON success reply.
export async function requestJson({ baseUrl, apiKey, timeoutMs, method = "GET", path, body, rawBody, headers: extraHeaders, idempotencyKey, correlationId, expectJson = true }) {
  if (!baseUrl) throw new IntegrationError("NOT_CONFIGURED", "Integration base URL is not configured.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: "application/json" };
  if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders || {});
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const correlation = correlationId || currentCorrelationId();
  if (correlation) headers["X-Correlation-Id"] = correlation;

  let res;
  try {
    res = await fetch(resolveUrl(baseUrl, path), {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
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
    if (res.ok && expectJson) throw new IntegrationError("INVALID_RESPONSE", "Response was not valid JSON.", { httpStatus: res.status });
  }
  return { httpStatus: res.status, ok: res.ok, data };
}
