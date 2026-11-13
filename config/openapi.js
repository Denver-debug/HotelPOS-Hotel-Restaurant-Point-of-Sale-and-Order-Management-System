// OpenAPI 3.1 description of /api/v1, served at GET /api/v1/openapi.json.
// One row per route in routes/api.js; __tests__/integration/api-v1.test.js fails if a route is
// added without a row here. Human-oriented guide: docs/API.md.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const money = { type: "string", pattern: "^-?\\d+\\.\\d{2}$", examples: ["850.00"] };
const qty = { type: "string", pattern: "^\\d+(\\.\\d{1,3})?$", examples: ["2", "0.5"] };
const ts = { type: ["string", "null"], format: "date-time" };
const id = { type: "integer", minimum: 1 };
const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const list = (key, item) => obj({ ok: { const: true }, [key]: { type: "array", items: ref(item) }, pagination: ref("Pagination") }, ["ok", key]);
const one = (key, item, extra = {}) => obj({ ok: { const: true }, [key]: ref(item), ...extra }, ["ok", key]);

const PAGING = ["limit", "offset", "updatedSince", "from", "to"];

// [method, path, tag, summary, permission(s), { query, body, response, idempotent, status }]
const OPERATIONS = [
  ["get", "/health", "Service", "Liveness and database check (no authentication)", null, { response: "Health", public: true }],
  ["get", "/openapi.json", "Service", "This document", null, { public: true, raw: true }],
  ["get", "/me", "Service", "The calling user or API client, its permissions and outlets", "any signed-in caller", { response: "Me" }],

  ["get", "/outlets", "Reference data", "Outlets the caller may use", "any signed-in caller", { response: list("outlets", "Outlet") }],
  ["get", "/categories", "Reference data", "Product categories", "products.view | products.manage | pos.access", { query: [...PAGING, "status"], response: list("categories", "Category") }],
  ["get", "/payment-methods", "Reference data", "Payment methods", "any signed-in caller", { response: obj({ ok: { const: true }, paymentMethods: { type: "array", items: ref("PaymentMethod") } }) }],
  ["get", "/products", "Reference data", "Products and services with current outlet prices (a price change counts as an update)", "products.view | products.manage", { query: [...PAGING, "outletId", "categoryId", "status", "search"], response: list("products", "Product") }],

  ["get", "/pos/catalog", "POS terminal", "Sellable catalog for one outlet (POS terminal)", "pos.access", { query: ["outletId"] }],
  ["get", "/pos/open-orders", "POS terminal", "Unsettled orders at one outlet (POS terminal)", "pos.access", { query: ["outletId"] }],

  ["get", "/orders", "Orders", "Orders with lines, discounts, payments and room charges", "orders.view", { query: [...PAGING, "outletId", "status", "settlementType", "externalReference"], response: list("orders", "Order") }],
  ["post", "/orders", "Orders", "Create an order, optionally with its lines, in one transaction", "orders.create", { body: "OrderCreate", response: one("order", "Order", { duplicate: { type: "boolean" } }), idempotent: true, status: 201 }],
  ["get", "/orders/{id}", "Orders", "One order", "orders.view | pos.access", { response: one("order", "Order") }],
  ["patch", "/orders/{id}", "Orders", "Change order type, table/location, guest count or notes", "orders.create", { body: "OrderHeader", response: one("order", "Order") }],
  ["post", "/orders/{id}/items", "Orders", "Add a line (same product + notes merges)", "orders.create", { body: "OrderLineInput", response: one("order", "Order") }],
  ["patch", "/orders/{id}/items/{itemId}", "Orders", "Change a line's quantity (0 removes it) or notes", "orders.create", { body: obj({ quantity: qty, notes: { type: "string", maxLength: 255 } }), response: one("order", "Order") }],
  ["delete", "/orders/{id}/items/{itemId}", "Orders", "Remove a line", "orders.create", { response: one("order", "Order") }],
  ["post", "/orders/{id}/request-settlement", "Orders", "Lock the lines and check stock before taking money", "orders.create", { response: one("order", "Order") }],
  ["post", "/orders/{id}/reopen", "Orders", "Unlock an order awaiting settlement for editing", "orders.create", { response: one("order", "Order") }],
  ["post", "/orders/{id}/void", "Orders", "Void an unpaid order (orders.void, or a supervisor's credentials in the body)", "orders.create", { body: obj({ reason: { type: "string", maxLength: 255 }, supervisorUsername: { type: "string" }, supervisorPassword: { type: "string" } }, ["reason"]), response: one("order", "Order") }],

  ["get", "/orders/{id}/discounts/available", "Discounts", "Discounts valid for this order now", "discounts.apply", {}],
  ["post", "/orders/{id}/discounts", "Discounts", "Apply a discount", "discounts.apply", { body: obj({ discountId: id, orderItemId: id, supervisorUsername: { type: "string" }, supervisorPassword: { type: "string" } }, ["discountId"]), response: one("order", "Order") }],
  ["delete", "/orders/{id}/discounts/{orderDiscountId}", "Discounts", "Remove an applied discount", "discounts.apply", { response: one("order", "Order") }],

  ["post", "/orders/{id}/payments", "Settlement", "Take a direct payment (402 PAYMENT_DECLINED carries the order and payment)", "payments.process", { body: "PaymentInput", response: obj({ ok: { const: true }, order: ref("Order"), payment: ref("Payment"), receiptId: { type: ["integer", "null"] }, duplicate: { type: "boolean" } }), idempotent: true }],
  ["get", "/payments", "Settlement", "Payments", "payments.view", { query: [...PAGING, "outletId", "status", "methodId"], response: list("payments", "Payment") }],
  ["post", "/orders/{id}/room-charge/validate", "Settlement", "Ask the PMS to validate a room; returns a single-use token (5 min)", "room_charges.process", { body: obj({ roomNumber: { type: "string", maxLength: 20 } }, ["roomNumber"]) }],
  ["post", "/orders/{id}/room-charge", "Settlement", "Post the order total to the validated folio (outcome POSTED | FAILED | UNKNOWN)", "room_charges.process", { body: obj({ validationToken: { type: "string" }, idempotencyKey: { type: "string", minLength: 8, maxLength: 100 } }, ["validationToken"]), idempotent: true }],
  ["post", "/guest-charges/{id}/verify", "Settlement", "Resolve an UNKNOWN room charge by asking the PMS", "room_charges.process", {}],
  ["get", "/guest-charges", "Settlement", "Room charges (external PMS ids only)", "room_charges.view", { query: [...PAGING, "outletId", "status", "externalFolioId"], response: list("guestCharges", "GuestCharge") }],
  ["get", "/guest-charges/{id}", "Settlement", "One room charge", "room_charges.view", { response: one("guestCharge", "GuestCharge") }],
  ["get", "/refunds", "Settlement", "Refunds", "refunds.view | refunds.approve", { query: [...PAGING, "outletId", "status"], response: list("refunds", "Refund") }],
  ["get", "/refunds/{id}", "Settlement", "One refund with its lines", "refunds.view | refunds.approve", { response: one("refund", "Refund") }],
  ["get", "/receipts/{id}", "Settlement", "A receipt and its frozen snapshot", "receipts.view", { response: one("receipt", "Receipt") }],
  ["post", "/receipts/{id}/printed", "Settlement", "Count a print (later prints are marked REPRINT)", "receipts.view", {}],

  ["get", "/shifts", "Shifts", "Cashier shifts (own shifts only without shifts.manage / reports.view)", "shifts.view | shifts.open | shifts.manage", { query: [...PAGING, "outletId", "status"], response: list("shifts", "Shift") }],
  ["get", "/shifts/current", "Shifts", "The caller's open shift with its running totals", "shifts.view | shifts.open | shifts.manage", {}],
  ["get", "/shifts/{id}", "Shifts", "One shift with its summary", "shifts.view | shifts.open | shifts.manage", { response: one("shift", "Shift") }],
  ["post", "/shifts", "Shifts", "Open a shift for the caller", "shifts.open", { body: obj({ outletId: id, openingCash: money, openingNotes: { type: "string" } }, ["outletId", "openingCash"]), status: 201 }],
  ["post", "/shifts/{id}/close", "Shifts", "Close a shift with the counted cash", "shifts.open | shifts.manage", { body: obj({ actualCash: money, closingNotes: { type: "string" } }, ["actualCash"]) }],

  ["get", "/inventory/levels", "Inventory", "Stock on hand per outlet", "inventory.view", { query: ["limit", "offset", "outletId", "search", "low"], response: list("stockLevels", "StockLevel") }],
  ["get", "/inventory/movements", "Inventory", "The append-only stock ledger (default: last 30 days)", "inventory.view", { query: ["limit", "offset", "from", "to", "outletId", "itemId", "type"], response: list("movements", "StockMovement") }],
  ["post", "/inventory/movements", "Inventory", "Record stock in/out, adjustment, damage, waste or return", "inventory.manage | inventory.adjust", { body: "StockMovementInput", response: one("movement", "StockMovement", { duplicate: { type: "boolean" } }), idempotent: true, status: 201 }],

  ["get", "/reports", "Reports", "Available reports and their columns", "reports.view", {}],
  ["get", "/reports/{key}", "Reports", "Run a report (same figures as the Reports screens)", "reports.view", { query: ["from", "to", "outletId", "cashierId", "productId", "methodId", "granularity", "sort"] }],
];

const QUERY = {
  limit: { schema: { type: "integer", minimum: 1, maximum: 500, default: 50 }, description: "Page size." },
  offset: { schema: { type: "integer", minimum: 0, default: 0 } },
  updatedSince: { schema: { type: "string", format: "date-time" }, description: "Incremental sync: rows changed at or after this instant, oldest first. Keep the newest updatedAt you saw and pass it next time; ties are possible, so de-duplicate by id." },
  from: { schema: { type: "string" }, description: "Start of a creation-date window: a business date (YYYY-MM-DD, APP_TIMEZONE) or an ISO date-time." },
  to: { schema: { type: "string" }, description: "End of the window. A date is inclusive (whole business day)." },
  outletId: { schema: id }, categoryId: { schema: id }, methodId: { schema: id }, itemId: { schema: id }, cashierId: { schema: id }, productId: { schema: id },
  status: { schema: { type: "string" } }, settlementType: { schema: { enum: ["DIRECT_PAYMENT", "ROOM_CHARGE"] } }, search: { schema: { type: "string" } },
  externalReference: { schema: { type: "string" }, description: "The caller's own order id given at creation." },
  externalFolioId: { schema: { type: "string" } }, low: { schema: { type: "boolean" } }, type: { schema: { type: "string" } },
  granularity: { schema: { enum: ["day", "week", "month"] } }, sort: { schema: { enum: ["amount", "quantity"] } },
};

const SCHEMAS = {
  Error: obj({
    ok: { const: false },
    error: { type: "string", description: "Message for people." },
    code: { type: "string", description: "Stable machine code (see docs/API.md, Error codes)." },
    details: {},
    requestId: { type: "string", description: "Also in the X-Request-Id header; quote it when reporting a problem." },
  }, ["ok", "error", "code"]),
  Pagination: obj({ limit: { type: "integer" }, offset: { type: "integer" }, total: { type: "integer" }, hasMore: { type: "boolean" }, nextOffset: { type: ["integer", "null"] } }),
  Health: obj({ ok: { type: "boolean" }, status: { enum: ["up", "degraded"] }, app: { type: "string" }, version: { type: "string" }, time: { type: "string", format: "date-time" }, database: { enum: ["up", "down"] }, integrations: { type: "object" } }),
  Me: obj({ ok: { const: true }, user: { type: "object" }, client: { type: ["object", "null"] }, permissions: { type: "array", items: { type: "string" } }, outlets: { type: "array" }, openShift: { type: ["object", "null"] } }),
  Outlet: obj({ id, code: { type: "string" }, name: { type: "string" }, outletType: { type: "string" }, status: { type: "string" }, allowsRoomCharge: { type: "boolean" }, serviceChargeRate: { type: "string" }, updatedAt: ts }),
  Category: obj({ id, name: { type: "string" }, sortOrder: { type: "integer" }, status: { enum: ["ACTIVE", "ARCHIVED"] }, updatedAt: ts }),
  PaymentMethod: obj({ id, code: { type: "string" }, name: { type: "string" }, isCash: { type: "boolean" }, usesGateway: { type: "boolean" }, requiresReference: { type: "boolean" }, status: { type: "string" } }),
  Product: obj({
    id, code: { type: "string" }, name: { type: "string" }, itemType: { enum: ["PRODUCT", "SERVICE"] }, unit: { type: "string" }, status: { type: "string" },
    category: obj({ id, name: { type: "string" } }), tax: { type: ["object", "null"] },
    prices: { type: "array", items: obj({ outletId: id, price: money, isAvailable: { type: "boolean" }, effectiveFrom: ts }) }, updatedAt: ts,
  }),
  OrderLine: obj({ id, productId: id, productCode: { type: "string" }, productName: { type: "string" }, unit: { type: "string" }, quantity: qty, unitPrice: money, grossAmount: money, discountAmount: money, taxAmount: money, lineTotal: money, notes: { type: ["string", "null"] } }),
  Order: obj({
    id, orderNumber: { type: "string" }, externalReference: { type: ["string", "null"] }, outletId: id, shiftId: { type: ["integer", "null"] },
    orderType: { enum: ["DINE_IN", "TAKEOUT", "ROOM_SERVICE", "MINIBAR", "SPA", "OTHER"] },
    status: { enum: ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "SETTLING", "CHARGE_FAILED", "COMPLETED", "VOIDED", "PARTIALLY_REFUNDED", "REFUNDED"] },
    settlementType: { enum: ["DIRECT_PAYMENT", "ROOM_CHARGE", null] }, tableOrLocation: { type: ["string", "null"] },
    subtotal: money, discountAmount: money, taxAmount: money, serviceChargeAmount: money, totalAmount: money, amountPaid: money, balanceDue: money,
    items: { type: "array", items: ref("OrderLine") }, discounts: { type: "array" }, payments: { type: "array" }, guestCharge: { type: ["object", "null"] },
    receipts: { type: "array" }, editable: { type: "boolean" }, version: { type: "integer" }, createdAt: ts, updatedAt: ts, completedAt: ts,
  }),
  OrderHeader: obj({ orderType: { type: "string" }, tableOrLocation: { type: "string", maxLength: 60 }, guestCount: { type: "integer" }, notes: { type: "string", maxLength: 500 } }),
  OrderLineInput: obj({ productId: id, quantity: qty, notes: { type: "string", maxLength: 255 } }, ["productId"]),
  OrderCreate: obj({
    outletId: id, orderType: { type: "string" }, tableOrLocation: { type: "string" }, guestCount: { type: "integer" }, notes: { type: "string" },
    externalReference: { type: "string", maxLength: 100, description: "Your own order id, for matching." },
    idempotencyKey: { type: "string", minLength: 8, maxLength: 100, description: "Or the Idempotency-Key header." },
    items: { type: "array", maxItems: 100, items: ref("OrderLineInput") },
  }, ["outletId"]),
  PaymentInput: obj({ paymentMethodId: id, amount: money, tenderedAmount: money, reference: { type: "string", maxLength: 100 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 100 } }, ["paymentMethodId", "amount"]),
  Payment: obj({ id, paymentNumber: { type: "string" }, orderId: id, method: { type: "object" }, amount: money, tenderedAmount: { ...money, type: ["string", "null"] }, changeAmount: money, status: { type: "string" }, reference: { type: ["string", "null"] }, externalTransactionId: { type: ["string", "null"] }, isMock: { type: "boolean" }, capturedAt: ts, updatedAt: ts }),
  GuestCharge: obj({ id, chargeNumber: { type: "string" }, orderId: id, roomNumber: { type: "string" }, externalGuestId: { type: "string" }, externalRoomId: { type: "string" }, externalFolioId: { type: "string" }, amount: money, reversedAmount: money, status: { type: "string" }, pmsTransactionId: { type: ["string", "null"] }, isMock: { type: "boolean" }, postedAt: ts, updatedAt: ts }),
  Refund: obj({ id, refundNumber: { type: "string" }, orderId: id, refundType: { enum: ["FULL", "PARTIAL"] }, settlementType: { type: "string" }, amount: money, reason: { type: "string" }, status: { type: "string" }, restock: { type: "boolean" }, items: { type: "array" }, processedAt: ts, updatedAt: ts }),
  Receipt: obj({ id, receiptNumber: { type: "string" }, receiptType: { enum: ["SALE", "ROOM_CHARGE", "REFUND"] }, orderId: id, refundId: { type: ["integer", "null"] }, printCount: { type: "integer" }, generatedAt: ts, snapshot: { type: "object" } }),
  Shift: obj({ id, shiftNumber: { type: "string" }, outletId: id, cashier: { type: "object" }, status: { enum: ["OPEN", "CLOSED", "RECONCILED"] }, openedAt: ts, closedAt: ts, openingCash: money, expectedCash: { type: ["string", "null"] }, actualCash: { type: ["string", "null"] }, cashVariance: { type: ["string", "null"] }, summary: { type: "object" } }),
  StockLevel: obj({ id, outletId: id, item: obj({ id, sku: { type: "string" }, name: { type: "string" }, unit: { type: "string" } }), quantity: qty, reorderLevel: qty, isLow: { type: "boolean" }, updatedAt: ts }),
  StockMovement: obj({ id, transactionNumber: { type: "string" }, type: { type: "string" }, item: { type: "object" }, outletId: id, quantity: { type: "string" }, balanceAfter: { type: "string" }, unitCost: { type: ["string", "null"] }, reason: { type: ["string", "null"] }, createdAt: ts }),
  StockMovementInput: obj({
    transactionType: { enum: ["STOCK_IN", "STOCK_OUT", "ADJUSTMENT", "DAMAGE", "WASTE", "RETURN"] }, inventoryItemId: id, outletId: id,
    quantity: { ...qty, description: "For ADJUSTMENT: the counted quantity." }, unitCost: money, reason: { type: "string" }, reference: { type: "string", maxLength: 40 },
    idempotencyKey: { type: "string", minLength: 8, maxLength: 90 },
  }, ["transactionType", "inventoryItemId", "outletId", "quantity"]),
};

const ERRORS = {
  400: "Malformed request (BAD_REQUEST)",
  401: "No or invalid credentials (UNAUTHENTICATED, INVALID_API_KEY)",
  403: "Not permitted, or outside the caller's outlets (FORBIDDEN, IP_NOT_ALLOWED)",
  404: "Not found (NOT_FOUND)",
  409: "Conflicts with the current state (see error codes)",
  422: "Invalid input (VALIDATION_ERROR or a specific code)",
  429: "Rate limit exceeded (RATE_LIMITED); see Retry-After",
};

export const API_OPERATIONS = OPERATIONS.map(([method, path]) => ({ method, path }));

export function buildOpenApi({ version }) {
  const paths = {};
  for (const [method, path, tag, summary, permission, o] of OPERATIONS) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, schema: name === "key" ? { type: "string" } : id }));
    for (const q of o.query || []) params.push({ name: q, in: "query", required: false, ...QUERY[q] });
    if (o.idempotent) params.push({ name: "Idempotency-Key", in: "header", required: false, description: "Retry-safe key (8–100 chars); a repeat returns the original result.", schema: { type: "string" } });
    const okStatus = String(o.status || 200);
    const responses = { [okStatus]: { description: "Success", content: { "application/json": { schema: typeof o.response === "string" ? ref(o.response) : o.response || { type: "object" } } } } };
    if (!o.public) for (const [code, description] of Object.entries(ERRORS)) responses[code] = { description, content: { "application/json": { schema: ref("Error") } } };
    paths[path] ??= {};
    paths[path][method] = {
      tags: [tag],
      summary,
      description: permission ? `Requires: ${permission}.` : undefined,
      security: o.public ? [] : undefined,
      parameters: params.length ? params : undefined,
      requestBody: o.body ? { required: true, content: { "application/json": { schema: typeof o.body === "string" ? ref(o.body) : o.body } } } : undefined,
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "HotelPOS API",
      version,
      description: "Point-of-sale subsystem of the Hotel ERP. Authenticate with an API key (System → Integrations → API clients) sent as `Authorization: Bearer hpos_…`. Every response has `ok`; errors add `error`, `code` and `requestId`. Money is a decimal string. See docs/API.md.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ apiKey: [] }],
    tags: ["Service", "Reference data", "POS terminal", "Orders", "Discounts", "Settlement", "Shifts", "Inventory", "Reports"].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "hpos_<prefix>_<secret>" } },
      schemas: SCHEMAS,
    },
  };
}
