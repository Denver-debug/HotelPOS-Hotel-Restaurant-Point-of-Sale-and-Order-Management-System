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
  appName: env.APP_NAME || "HotelFlow",
  timezone: env.APP_TIMEZONE || "+08:00",
  currencySymbol: env.CURRENCY_SYMBOL || "₱",
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
