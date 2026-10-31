// POS-specific settings stored in `system_settings`, cached briefly in memory.
import { SystemSetting } from "../models/index.js";

let cache = null;
let cachedAt = 0;
const TTL_MS = 30000;

const coerce = (row) => {
  if (row.valueType === "number") return Number(row.settingValue);
  if (row.valueType === "boolean") return row.settingValue === "true";
  return row.settingValue ?? "";
};

export async function getSettings() {
  if (!cache || Date.now() - cachedAt > TTL_MS) {
    const rows = await SystemSetting.findAll({ order: [["sortOrder", "ASC"]] });
    cache = Object.fromEntries(rows.map((r) => [r.settingKey, coerce(r)]));
    cachedAt = Date.now();
  }
  return cache;
}

export async function getSetting(key, fallback = null) {
  const settings = await getSettings();
  return key in settings ? settings[key] : fallback;
}

export function invalidateSettings() {
  cache = null;
}
