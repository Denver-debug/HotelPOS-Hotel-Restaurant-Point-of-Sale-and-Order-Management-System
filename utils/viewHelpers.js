// Handlebars helpers available in every .xian view.
import { config } from "../config/env.js";
import { formatMoney, formatQty } from "./money.js";
import { formatDate, formatDateTime, toDateTimeLocal } from "./dates.js";

// Outline icons (24x24, stroke). Paths adapted from Heroicons (MIT).
const ICONS = {
  home: "M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10",
  terminal: "M4 5h16v11H4zM8 20h8M12 16v4",
  clipboard: "M9 5h6M9 3h6v4H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4",
  card: "M3 6h18v12H3zM3 10h18M7 15h3",
  key: "M15 7a3 3 0 11-3 3M12 10l-8 8v2h3l1-1v-2h2v-2h2l1.5-1.5M15 7a3 3 0 013 3",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3",
  tag: "M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  building: "M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01M2 21h20",
  percent: "M19 5L5 19M7.5 7.5h.01M16.5 16.5h.01M6 7.5a1.5 1.5 0 103 0 1.5 1.5 0 00-3 0M15 16.5a1.5 1.5 0 103 0 1.5 1.5 0 00-3 0",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  clock: "M12 7v5l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  users: "M17 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M10 10a4 4 0 100-8 4 4 0 000 8zM21 20v-2a4 4 0 00-3-3.9M16 2.1a4 4 0 010 7.8",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 01-12 0zM12 17v5",
  cog: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  logout: "M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3",
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  x: "M18 6L6 18M6 6l12 12",
  check: "M5 13l4 4L19 7",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  info: "M12 16v-4M12 8h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  menu: "M3 6h18M3 12h18M3 18h18",
  printer: "M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  edit: "M11 4H4v16h16v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  cash: "M2 6h20v12H2zM12 15a3 3 0 100-6 3 3 0 000 6zM6 12h.01M18 12h.01",
  door: "M3 21h18M5 21V3h11v18M13 12h.01M16 5h3v16",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15",
  utensils: "M6 2v8M3.5 2v5a2.5 2.5 0 005 0V2M6 10v12M18 22V2c-2.2 0-4 2.4-4 6.5V13h4",
  cocktail: "M4 3h16l-8 9zM12 12v8M8 21h8",
  cloche: "M2 18h20M4 18a8 8 0 0116 0M12 10V8M10 7h4",
  leaf: "M5 20c0-9 6-15 15-15 0 9-6 15-15 15zM5 20l8-8",
  arrow: "M5 12h14M13 6l6 6-6 6",
};

const STATUS_STYLES = {
  green: ["ACTIVE", "AVAILABLE", "COMPLETED", "CAPTURED", "POSTED", "PROCESSED", "SUCCESS", "PUBLISHED", "RECONCILED", "APPROVED", "STOCK_IN", "RETURN", "REFUND_RETURN"],
  blue: ["OPEN", "IN_PROGRESS", "AUTHORIZED", "REQUESTED", "SALE", "ROOM_CHARGE", "DIRECT_PAYMENT"],
  amber: ["AWAITING_SETTLEMENT", "SETTLING", "PENDING", "UNKNOWN", "PARTIALLY_REFUNDED", "PARTIALLY_REVERSED", "CLOSED", "ADJUSTMENT", "LOCKED", "TIMEOUT", "UNAVAILABLE"],
  red: ["VOIDED", "FAILED", "CHARGE_FAILED", "REJECTED", "REFUNDED", "REVERSED", "ERROR", "DAMAGE", "WASTE", "STOCK_OUT"],
  slate: ["INACTIVE", "ARCHIVED", "MOCK"],
};
const STATUS_CLASS = Object.fromEntries(
  Object.entries(STATUS_STYLES).flatMap(([color, list]) => list.map((s) => [s, `badge badge-${color}`]))
);

export function registerViewHelpers(hbs) {
  const H = hbs.handlebars;
  const isOptions = (v) => v && typeof v === "object" && "hash" in v && "data" in v;

  hbs.registerHelper("eq", (a, b) => String(a) === String(b));
  hbs.registerHelper("ne", (a, b) => String(a) !== String(b));
  hbs.registerHelper("gt", (a, b) => Number(a) > Number(b));
  hbs.registerHelper("lt", (a, b) => Number(a) < Number(b));
  hbs.registerHelper("and", (...args) => args.slice(0, -1).every(Boolean));
  hbs.registerHelper("or", (...args) => args.slice(0, -1).some(Boolean));
  hbs.registerHelper("not", (v) => !v);
  hbs.registerHelper("includes", (list, v) => Array.isArray(list) && list.map(String).includes(String(v)));
  hbs.registerHelper("default", (v, fallback) => (v === undefined || v === null || v === "" ? fallback : v));
  hbs.registerHelper("add", (a, b) => Number(a) + Number(b));
  hbs.registerHelper("concat", (...args) => args.slice(0, -1).join(""));

  hbs.registerHelper("money", (v) => formatMoney(v ?? 0, config.currencySymbol));
  hbs.registerHelper("qty", (v) => formatQty(v ?? 0));
  hbs.registerHelper("datetime", (v) => formatDateTime(v));
  hbs.registerHelper("date", (v) => formatDate(v));
  hbs.registerHelper("dtlocal", (v) => toDateTimeLocal(v));
  hbs.registerHelper("percent", (v) => `${(Number(v || 0) * 100).toFixed(2).replace(/\.?0+$/, "")}%`);
  hbs.registerHelper("humanize", (v) => {
    if (!v) return "";
    const s = String(v).toLowerCase().replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  });

  hbs.registerHelper("statusBadge", (status, label) => {
    const text = typeof label === "string" ? label : String(status ?? "").replace(/_/g, " ");
    return new H.SafeString(`<span class="${STATUS_CLASS[status] || "badge badge-slate"}">${H.escapeExpression(text)}</span>`);
  });

  hbs.registerHelper("selected", (a, b) => (String(a) === String(b) ? "selected" : ""));
  hbs.registerHelper("checked", (v, compare) =>
    (isOptions(compare) ? Boolean(v) && v !== "false" && v !== "0" : String(v) === String(compare)) ? "checked" : ""
  );

  // {{#if (can "orders.void")}} — reads the permissions placed in res.locals.
  hbs.registerHelper("can", (code, options) => {
    const perms = options?.data?.root?.userPermissions || [];
    return perms.includes(code);
  });

  // Safe JSON for embedding in <script type="application/json">.
  hbs.registerHelper("json", (v) => new H.SafeString(JSON.stringify(v ?? null).replace(/</g, "\\u003c")));

  // {{wordmark appName}}: the brand name as type, with a trailing "POS" set heavier in gold.
  hbs.registerHelper("wordmark", (name) => {
    const text = typeof name === "string" && name.trim() ? name.trim() : "HotelPOS";
    const match = /^(.+?)(POS)$/.exec(text);
    const inner = match
      ? `${H.escapeExpression(match[1])}<span class="wordmark-accent">${match[2]}</span>`
      : H.escapeExpression(text);
    return new H.SafeString(`<span class="wordmark">${inner}</span>`);
  });

  hbs.registerHelper("icon", (name, cls) => {
    const path = ICONS[name] || ICONS.info;
    const klass = typeof cls === "string" ? cls : "w-5 h-5";
    return new H.SafeString(
      `<svg class="${H.escapeExpression(klass)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
    );
  });
}
