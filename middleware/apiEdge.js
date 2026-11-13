// Edge concerns for the versioned API (/api/v1): CORS for browser-based ERP front ends and a
// per-client rate limit. Both are configured from .env (API_CORS_ORIGINS, API_RATE_LIMIT_PER_MINUTE).
import { config } from "../config/env.js";
import { AppError } from "../utils/http.js";

const isV1 = (req) => req.originalUrl.startsWith("/api/v1/") || req.originalUrl === "/api/v1";

// CORS: only listed origins, and only for API-key calls (no cookies are ever allowed cross-site).
export const apiCors = (req, res, next) => {
  if (!isV1(req)) return next();
  const origin = req.get("origin");
  const allowed = config.api.corsOrigins;
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Request-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
};

// Fixed one-minute window per API client (in memory: per app instance).
const windows = new Map(); // clientId -> { start, count }
export const apiRateLimit = (req, res, next) => {
  const limit = config.api.rateLimitPerMinute;
  if (!req.apiClient || !limit) return next();
  const now = Date.now();
  const start = now - (now % 60000);
  let w = windows.get(req.apiClient.id);
  if (!w || w.start !== start) {
    w = { start, count: 0 };
    windows.set(req.apiClient.id, w);
  }
  w.count += 1;
  const reset = Math.ceil((start + 60000 - now) / 1000);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - w.count)));
  res.setHeader("X-RateLimit-Reset", String(reset));
  if (w.count > limit) {
    res.setHeader("Retry-After", String(reset));
    return next(new AppError(`Rate limit of ${limit} requests per minute exceeded. Retry in ${reset} s.`, 429, "RATE_LIMITED"));
  }
  next();
};

// Retries from other systems usually carry the key as a header; services read it from the body.
export const idempotencyHeader = (req, res, next) => {
  const key = req.get("idempotency-key");
  if (key && req.body && typeof req.body === "object" && req.body.idempotencyKey === undefined) req.body.idempotencyKey = key;
  next();
};
