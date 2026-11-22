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
      // frontdesk only: request signing secret (the Frontdesk's POS_INBOUND_SECRET), the secret
      // that signs its webhooks to /webhooks/pms (its POS_WEBHOOK_SECRET), the restaurant_id sent
      // for every outlet (empty: each outlet's code), and how often charges awaiting front-desk
      // review are polled when no webhook arrives (0 = webhook and "Check status" only).
      inboundSecret: env.PMS_INBOUND_SECRET || "",
      webhookSecret: env.PMS_WEBHOOK_SECRET || "",
      restaurantId: env.PMS_RESTAURANT_ID || "",
      reviewPollMs: int(env.PMS_REVIEW_POLL_MS, isTest ? 0 : 120000),
    },
    // "paymongo": GCash and Maya through PayMongo. PAYMENT_API_KEY is the secret key (sk_test_… / sk_live_…).
    payment: {
      adapter: env.PAYMENT_ADAPTER || "mock",
      baseUrl: env.PAYMENT_BASE_URL || (env.PAYMENT_ADAPTER === "paymongo" ? "https://api.paymongo.com/v1" : ""),
      apiKey: env.PAYMENT_API_KEY || "",
      timeoutMs: int(env.PAYMENT_TIMEOUT_MS, 15000),
      // Where the guest's phone lands after approving in GCash / Maya (any page; the POS does not depend on it).
      returnUrl: env.PAYMENT_RETURN_URL || `http://localhost:${int(env.PORT, 3000)}/pay/complete`,
      // Signing secret of the PayMongo webhook (whsk_…). Empty: payments are confirmed by polling only.
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET || "",
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
  PMS_ADAPTER: [config.integrations.pms.adapter, ["mock", "http", "frontdesk"]],
  PAYMENT_ADAPTER: [config.integrations.payment.adapter, ["mock", "paymongo"]],
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
if (config.integrations.pms.adapter === "frontdesk") {
  const pms = config.integrations.pms;
  if (!pms.baseUrl || !pms.apiKey) throw new Error("PMS_BASE_URL and PMS_API_KEY must be set when PMS_ADAPTER=frontdesk.");
  if (pms.restaurantId && !/^[A-Za-z0-9._:-]{1,40}$/.test(pms.restaurantId)) throw new Error("PMS_RESTAURANT_ID may only use letters, digits and . _ : - (at most 40).");
  if (!pms.webhookSecret && !isTest) console.warn("⚠️  PMS_WEBHOOK_SECRET is not set: /webhooks/pms is refused and front-desk reviews are picked up by polling only.");
}
if (config.integrations.payment.adapter === "paymongo") {
  const key = config.integrations.payment.apiKey;
  if (!/^sk_(test|live)_/.test(key)) throw new Error("PAYMENT_API_KEY must be a PayMongo secret key (sk_test_… or sk_live_…) when PAYMENT_ADAPTER=paymongo.");
  if (isProduction && key.startsWith("sk_test_")) console.warn("⚠️  PayMongo is in test mode (sk_test_ key): GCash and Maya payments move no real money.");
}
const mocks = Object.entries(SUPPORTED_ADAPTERS).filter(([, [value]]) => value === "mock" || value === "log").map(([name]) => name);
if (isProduction && mocks.length) {
  console.warn(`⚠️  Running in production with simulated integrations: ${mocks.join(", ")}. No real PMS/payment/HR calls are made.`);
}
