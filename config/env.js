// Loads .env (if present) and exposes typed configuration. Import this first.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(rootDir, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
// TRUST_PROXY: "true", a hop count ("1"), or Express names like "loopback" (behind a reverse proxy).
const trustProxy = (v) => (v === undefined || v === "" ? false : /^\d+$/.test(v) ? Number(v) : ["true", "false"].includes(v) ? v === "true" : v);

const isProduction = env.NODE_ENV === "production";
const isTest = env.NODE_ENV === "test";

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) throw new Error("SESSION_SECRET must be set in production.");
  sessionSecret = "hotelpos-development-only-secret";
  if (!isTest) console.warn("⚠️  SESSION_SECRET is not set; using an insecure development secret.");
}

export const config = {
  rootDir,
  env: env.NODE_ENV || "development",
  isProduction,
  isTest,
  port: int(env.PORT, 3000),
  appName: env.APP_NAME || "HotelPOS",
  timezone: env.APP_TIMEZONE || "+08:00",
  currencySymbol: env.CURRENCY_SYMBOL || "₱",
  // ISO 4217 code sent to the PMS and payment provider and included in events.
  currencyCode: (env.CURRENCY_CODE || "PHP").toUpperCase(),
  session: {
    secret: sessionSecret,
    cookieSecure: bool(env.COOKIE_SECURE, false),
    ttlMinutes: int(env.SESSION_TTL_MINUTES, 480),
  },
  db: {
    host: env.DB_HOST || "localhost",
    port: int(env.DB_PORT, 3306),
    name: isTest ? env.DB_TEST_NAME || "HotelPOS_test" : env.DB_NAME || "HotelPOS",
    user: env.DB_USER || "root",
    password: env.DB_PASSWORD || "",
  },
  seedAdminPassword: env.SEED_ADMIN_PASSWORD || "",
  trustProxy: trustProxy(env.TRUST_PROXY),
  api: {
    corsOrigins: list(env.API_CORS_ORIGINS),
    rateLimitPerMinute: int(env.API_RATE_LIMIT_PER_MINUTE, 600),
  },
  // Domain events (outbox) delivered to the ERP: "log" records them only, "webhook" POSTs
  // each one, HMAC-signed, to EVENTS_WEBHOOK_URL. The pull feed (/api/v1/events) works with both.
  events: {
    publisher: env.EVENTS_PUBLISHER || "log",
    webhookUrl: env.EVENTS_WEBHOOK_URL || "",
    webhookSecret: env.EVENTS_WEBHOOK_SECRET || "",
    timeoutMs: int(env.EVENTS_TIMEOUT_MS, 10000),
    dispatchIntervalMs: int(env.EVENTS_DISPATCH_INTERVAL_MS, isTest ? 0 : 15000),
    maxAttempts: int(env.EVENTS_MAX_ATTEMPTS, 10),
    batchSize: int(env.EVENTS_BATCH_SIZE, 50),
  },
  integrations: {
    pms: {
      adapter: env.PMS_ADAPTER || "mock",
      baseUrl: env.PMS_BASE_URL || "",
      apiKey: env.PMS_API_KEY || "",
      timeoutMs: int(env.PMS_TIMEOUT_MS, 8000),
      mockDelayMs: int(env.PMS_MOCK_DELAY_MS, 0),
    },
    payment: {
      adapter: env.PAYMENT_ADAPTER || "mock",
      baseUrl: env.PAYMENT_BASE_URL || "",
      apiKey: env.PAYMENT_API_KEY || "",
      timeoutMs: int(env.PAYMENT_TIMEOUT_MS, 15000),
    },
    hr: {
      adapter: env.HR_ADAPTER || "mock",
      baseUrl: env.HR_BASE_URL || "",
      apiKey: env.HR_API_KEY || "",
      timeoutMs: int(env.HR_TIMEOUT_MS, 5000),
      validateOnLogin: bool(env.HR_VALIDATE_ON_LOGIN, true),
    },
  },
};

// Adapter names are checked at startup. A typo used to fall back to the mock silently, which
// in production would mean fake room charges and fake card approvals.
const SUPPORTED_ADAPTERS = {
  PMS_ADAPTER: [config.integrations.pms.adapter, ["mock", "http"]],
  PAYMENT_ADAPTER: [config.integrations.payment.adapter, ["mock"]],
  HR_ADAPTER: [config.integrations.hr.adapter, ["mock", "http"]],
  EVENTS_PUBLISHER: [config.events.publisher, ["log", "webhook"]],
};
for (const [name, [value, allowed]] of Object.entries(SUPPORTED_ADAPTERS)) {
  if (!allowed.includes(value)) {
    throw new Error(`${name}="${value}" is not supported. Use one of: ${allowed.join(", ")}.`);
  }
}
if (config.events.publisher === "webhook") {
  if (!config.events.webhookUrl) throw new Error("EVENTS_WEBHOOK_URL must be set when EVENTS_PUBLISHER=webhook.");
  if (config.events.webhookSecret.length < 16) throw new Error("EVENTS_WEBHOOK_SECRET must be at least 16 characters when EVENTS_PUBLISHER=webhook.");
}
const mocks = Object.entries(SUPPORTED_ADAPTERS).filter(([, [value]]) => value === "mock" || value === "log").map(([name]) => name);
if (isProduction && mocks.length) {
  console.warn(`⚠️  Running in production with simulated integrations: ${mocks.join(", ")}. No real PMS/payment/HR calls are made.`);
}
