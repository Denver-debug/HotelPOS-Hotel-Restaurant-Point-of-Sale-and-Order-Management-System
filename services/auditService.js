// Append-only audit trail for security-relevant and financial actions.
import { AuditLog } from "../models/index.js";
import { clientIp } from "../utils/http.js";

const SENSITIVE = new Set(["passwordHash", "password", "password_hash", "apiKey", "_csrf"]);

const clean = (values) => {
  if (values === undefined || values === null) return null;
  const plain = typeof values.get === "function" ? values.get({ plain: true }) : values;
  if (typeof plain !== "object") return { value: plain };
  return Object.fromEntries(Object.entries(plain).filter(([k]) => !SENSITIVE.has(k)));
};

// Returns only the keys whose values differ, for compact before/after records.
export const diff = (before, after) => {
  const b = clean(before) || {};
  const a = clean(after) || {};
  const oldValues = {};
  const newValues = {};
  for (const key of Object.keys(a)) {
    if (["updatedAt", "createdAt"].includes(key)) continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      oldValues[key] = b[key] ?? null;
      newValues[key] = a[key];
    }
  }
  return { oldValues, newValues };
};

export async function audit({ req, userId, action, entityType, entityId, oldValues, newValues, transaction }) {
  return AuditLog.create(
    {
      userId: userId ?? req?.user?.id ?? null,
      action,
      entityType,
      entityId: entityId === undefined || entityId === null ? null : String(entityId),
      oldValues: clean(oldValues),
      newValues: clean(newValues),
      ipAddress: clientIp(req),
      userAgent: req?.get?.("user-agent")?.slice(0, 255) ?? null,
    },
    { transaction }
  );
}
