// API-key authentication for other ERP subsystems: "Authorization: Bearer hpos_<prefix>_<secret>".
//
// The key's prefix finds the client, the SHA-256 of the whole key is compared in constant time,
// and the client's service-account user becomes req.user exactly as a browser login would
// (middleware/auth.js loadUserContext). Roles, outlet scoping and the audit log therefore apply
// unchanged. Key requests never create a session or need a CSRF token.
import crypto from "crypto";
import { ApiClient } from "../models/index.js";
import { AppError, clientIp } from "../utils/http.js";
import { loadUserContext, applyUserContext } from "./auth.js";

const KEY_FORMAT = /^hpos_([a-z0-9]{8})_([A-Za-z0-9_-]{30,64})$/;
const LAST_USED_EVERY_MS = 60 * 1000;
const lastStamped = new Map(); // clientId -> ms, so a busy client doesn't write on every request

export const hashApiKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

// New key: the prefix is stored in clear (to look the key up), the rest only as part of the hash.
export function generateApiKey() {
  const prefix = crypto.randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(8, "0").slice(0, 8);
  const key = `hpos_${prefix}_${crypto.randomBytes(30).toString("base64url")}`;
  return { key, prefix, hash: hashApiKey(key) };
}

const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normalizeIp = (ip) => String(ip || "").replace(/^::ffff:/, "");

const unauthorized = (message) => new AppError(message, 401, "INVALID_API_KEY");

export const apiAuth = async (req, res, next) => {
  const header = req.get("authorization");
  if (!header || !req.originalUrl.startsWith("/api/")) return next();
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const parts = m && KEY_FORMAT.exec(m[1]);
    if (!parts) throw unauthorized("The Authorization header must be: Bearer hpos_<prefix>_<secret>.");

    const client = await ApiClient.scope("withHash").findOne({ where: { keyPrefix: parts[1] } });
    if (!client || !sameHash(client.keyHash, hashApiKey(m[1]))) throw unauthorized("The API key is not valid.");
    if (client.status !== "ACTIVE") throw unauthorized("This API key has been revoked.");

    const ip = normalizeIp(clientIp(req));
    const allowed = (client.allowedIps || "").split(",").map((s) => normalizeIp(s.trim())).filter(Boolean);
    if (allowed.length && !allowed.includes(ip)) throw new AppError(`This API key may not be used from ${ip}.`, 403, "IP_NOT_ALLOWED");

    const ctx = await loadUserContext(client.userId);
    if (!ctx || !ctx.user.isServiceAccount) throw unauthorized("The service account for this API key is inactive.");
    applyUserContext(req, ctx);
    req.apiClient = { id: client.id, name: client.name, keyPrefix: client.keyPrefix };

    const now = Date.now();
    if ((lastStamped.get(client.id) || 0) + LAST_USED_EVERY_MS < now) {
      lastStamped.set(client.id, now);
      ApiClient.update({ lastUsedAt: new Date(now), lastUsedIp: ip.slice(0, 45) }, { where: { id: client.id } }).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
};
