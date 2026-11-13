# HotelPOS API (v1)

HotelPOS is the point-of-sale subsystem of the Hotel ERP. This guide is for teams building the other subsystems that read from it or write to it: accounting and GL, BI and reporting, purchasing and inventory planning, guest and room-service apps, and the Front Desk/PMS team.

- **Base URL:** `https://<hotelpos-host>/api/v1`
- **Contract:** `GET /api/v1/openapi.json` (OpenAPI 3.1). A test fails the build if a route is added without being described there.
- **Versioning:** changes inside v1 are additive only (new fields, new endpoints, new event types). Anything that would break a client goes to `/api/v2`. Ignore fields you don't know.

HotelPOS owns orders, payments, room-charge postings, receipts, the outlet catalog and prices, outlet stock, cashier shifts, discounts and refunds. Guests, rooms, folios and employees belong to other subsystems; HotelPOS stores only their external ids and never returns guest names.

---

## 1. Getting access

An administrator creates one **API client** per connecting system in **System → Integrations → API clients**:

1. Give it a name and a role. **ERP Integration (API)** is read-only and sees every outlet; use it for accounting, BI and reporting. For systems that create orders or record stock, pick a role with those rights (for example Cashier, or Inventory Staff) and tick the outlets it may use.
2. Optionally restrict it to the caller's IP addresses.
3. Copy the key shown. It appears **once**; HotelPOS keeps only a SHA-256 hash.

Each client acts as its own service account, so the role, outlet assignment and audit trail work exactly as they do for people. Roles that can manage users, roles, settings or keys can't be given to a key. A service account can't sign in to the web UI.

**Rotate** issues a new key and stops the old one immediately. **Revoke** stops the key and deactivates its service account. To change what a client may do, edit its service account in **Users** (role and outlets).

Keys look like `hpos_<8-char prefix>_<secret>`. Store them in the calling system's secret store, never in source code.

## 2. Making requests

```bash
curl https://pos.hotel.example/api/v1/orders?updatedSince=2026-11-12T00:00:00%2B08:00 \
  -H "Authorization: Bearer hpos_k3x9a2bc_…" \
  -H "Accept: application/json"
```

| Header | When |
|---|---|
| `Authorization: Bearer <key>` | Every request except `/health` and `/openapi.json` |
| `Content-Type: application/json` | Requests with a body (max 1 MB) |
| `Idempotency-Key: <8–100 chars>` | Creates you might retry (see §5) |
| `X-Request-Id: <8–64 chars>` | Optional. Your trace id; echoed back, logged, and passed to the PMS/payment calls this request makes. One is generated if you don't send it |

API-key requests need no CSRF token and never receive cookies.

Browser-based ERP front ends can call the API cross-origin once their origin is listed in `API_CORS_ORIGINS`.

## 3. Responses

Every response has `ok`.

```json
{ "ok": true, "order": { … } }
{ "ok": true, "orders": [ … ], "pagination": { "limit": 50, "offset": 0, "total": 132, "hasMore": true, "nextOffset": 50 } }
{ "ok": false, "error": "Amount exceeds the balance due (850.00).", "code": "AMOUNT_EXCEEDS_BALANCE", "requestId": "4e0c…" }
```

- **Money** is a decimal string with two places: `"850.00"`. Quantities are strings with up to three: `"0.500"`. Never parse them as floats for arithmetic.
- **Timestamps** are ISO-8601 instants in UTC (`"2026-11-12T03:15:22.000Z"`). Business dates (report ranges, `from`/`to` dates) follow the hotel's `APP_TIMEZONE` (default `+08:00`).
- **Ids** are integers. `orderNumber`, `paymentNumber`, `receiptNumber` and similar are the human document numbers printed on receipts.
- `currency` (in events) is the ISO 4217 code from `CURRENCY_CODE` (default `PHP`).

### Lists, paging and sync

All list endpoints accept:

| Parameter | Meaning |
|---|---|
| `limit` (default 50 for most lists; max 200, orders 100, some lists 500), `offset` | Paging. Use `pagination.nextOffset` until `hasMore` is false |
| `updatedSince=<ISO time>` | **Incremental sync.** Rows created or changed at or after that instant, **oldest first** |
| `from`, `to` | Creation-date window, newest first. A date (`2026-11-12`) is a whole business day, inclusive; a date-time is used as is |

Callers only ever see their outlets. A filter for an outlet outside the client's assignment returns an empty list, not an error.

**Sync recipe** (orders, payments, guest charges, refunds, shifts, products, categories):

```text
cursor = last saved cursor, or the start of time
loop:
  GET /orders?updatedSince=<cursor>&limit=200&offset=<o>
  upsert every row by id
  follow nextOffset until hasMore = false
save cursor = the largest updatedAt you received
```

`updated_at` has one-second resolution, so a row can share the cursor's timestamp. That's why the filter is "at or after": you may see a row twice, so upsert by `id`. For products, a price change counts as an update.

For a push model instead of polling, use events (§7).

## 4. Errors

| HTTP | `code` | What to do |
|---|---|---|
| 400 | `BAD_REQUEST` | Fix the request (malformed JSON, for example) |
| 401 | `UNAUTHENTICATED`, `INVALID_API_KEY` | Send a valid, unrevoked key |
| 403 | `FORBIDDEN`, `IP_NOT_ALLOWED`, `OVERRIDE_DENIED` | The client's role, outlets or IP allowlist don't permit this. `OVERRIDE_DENIED`: wrong supervisor credentials for a void or discount |
| 404 | `NOT_FOUND` | Wrong id or path |
| 409 | see below | The record's current state doesn't allow this. Re-read it, then decide |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 422 | `VALIDATION_ERROR` or see below | Invalid input; `error` says which field |
| 429 | `RATE_LIMITED` | Wait `Retry-After` seconds |
| 500 | `SERVER_ERROR` | Retry later; report the `requestId` |
| 502 / 504 | `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT` | The PMS or payment provider failed. See the operation's notes before retrying |
| 503 | `SERVICE_UNAVAILABLE`, `PMS_UNAVAILABLE` | A dependency is down; retry later |

Codes you are likely to branch on:

| Area | Code | HTTP | Meaning |
|---|---|---|---|
| Orders | `NOT_EDITABLE` | 409 | The order is being settled, settled, or partly paid |
| | `NOT_VOIDABLE` | 409 | Money was collected or a room charge exists; refund instead |
| | `INVALID_TRANSITION` | 409 | Not allowed from the order's current status |
| | `EMPTY_ORDER` | 422 | Settlement requested with no lines |
| | `INSUFFICIENT_STOCK` | 409 | `details.shortages` lists items, needed and available |
| | `PRODUCT_UNAVAILABLE` | 422 | Product inactive or not sold at that outlet |
| | `OUTLET_INACTIVE` | 422 | |
| Payments | `NOT_SETTLEABLE` | 409 | Call `request-settlement` first |
| | `SETTLEMENT_IN_PROGRESS` | 409 | Another payment or charge is still being processed (`details.paymentId` if known) |
| | `ROOM_CHARGE_IN_PROGRESS` | 409 | A room charge is pending or posted |
| | `ALREADY_PAID` | 409 | |
| | `AMOUNT_EXCEEDS_BALANCE`, `INSUFFICIENT_TENDER`, `REFERENCE_REQUIRED`, `PAYMENT_METHOD_INACTIVE` | 422 | |
| | `SHIFT_REQUIRED` | 409 | The caller needs an open shift at that outlet (`POST /shifts`) |
| | `PAYMENT_DECLINED` | 402 | The body also carries the updated `order` and `payment` |
| | `PAYMENT_UNKNOWN` | 504 | The provider didn't confirm. **Do not take the money another way**; the payment is verified, not resent |
| Room charges | `ROOM_NOT_FOUND`, `ROOM_VACANT`, `NO_ACTIVE_FOLIO`, `NOT_ELIGIBLE` | 422 | The PMS refused the room |
| | `VALIDATION_EXPIRED` | 409 | Token older than 5 minutes, already used, or from another caller: validate again |
| | `ORDER_CHANGED` | 409 | The order changed after validation: validate again |
| | `ROOM_CHARGE_NOT_ALLOWED`, `PARTIALLY_PAID`, `NOTHING_TO_CHARGE` | 409/422 | |
| Discounts | `DISCOUNT_NOT_ELIGIBLE`, `DISCOUNT_ALREADY_APPLIED` | 409 | |
| Refunds | `NOT_REFUNDABLE`, `NOTHING_TO_REFUND`, `INVALID_REFUND_STATE` | 409 | |
| | `REFUND_METHOD_MISMATCH` | 422 | |
| | `REFUND_FAILED`, `EXTERNAL_REJECTED` | 502 | The provider or PMS refused the reversal |
| Shifts | `SHIFT_ALREADY_OPEN`, `SHIFT_NOT_OPEN`, `SHIFT_NOT_CLOSED`, `OPEN_SHIFTS` | 409 | |
| Stock | `NOTHING_TO_ADJUST` | 422 | Counted quantity equals the system quantity |
| | `NO_STOCK_LOCATION` | 409 | The outlet has no default stock location |
| Any | `IDEMPOTENCY_CONFLICT` | 409 | The key was already used for a different request |
| | `DUPLICATE`, `IN_USE`, `CONFLICT` | 409 | Unique value taken / record referenced / other state conflict |

New codes may be added; treat an unknown code by its HTTP status.

## 5. Idempotency

Send an `Idempotency-Key` (or `idempotencyKey` in the body) on every create you might retry after a timeout:

| Endpoint | Repeating the same key returns |
|---|---|
| `POST /orders` | The order created the first time (`200`, `duplicate: true`) |
| `POST /orders/{id}/payments` | The original outcome: captured (with receipt), the same `402` decline, or `409 SETTLEMENT_IN_PROGRESS` while still pending |
| `POST /orders/{id}/room-charge` | The original charge and outcome |
| `POST /inventory/movements` | The movement recorded the first time (`200`, `duplicate: true`) |

Use a new UUID per business operation and reuse it only for retries of that operation. Concurrent retries are safe: exactly one is applied and the others return it. A key used for a different order or movement is refused with `IDEMPOTENCY_CONFLICT`.

## 6. Endpoints

`id`, `itemId` and similar path parameters are integers. Permissions are those of the client's role.

### Service

| | Path | Permission | Notes |
|---|---|---|---|
| GET | `/health` | none | `200 {status: "up", database: "up"}`, or `503` when the database is unreachable. Also reports which integrations are mocks |
| GET | `/openapi.json` | none | The contract |
| GET | `/me` | any | Client name, role, permissions, outlets, open shift |

### Reference data

| | Path | Permission | Notes |
|---|---|---|---|
| GET | `/outlets` | any | Outlets the client may use |
| GET | `/categories` | products.view / products.manage / pos.access | `status`, sync params |
| GET | `/payment-methods` | any | Codes such as `CASH`, `CREDIT_CARD` |
| GET | `/products` | products.view / products.manage | `outletId`, `categoryId`, `status`, `search`, sync params. Each product lists its current `prices[]` per outlet |

### Orders

| | Path | Permission | Notes |
|---|---|---|---|
| GET | `/orders` | orders.view | Full documents with lines, discounts, payments, room charge, receipts. Filters: `outletId`, `status`, `settlementType`, `externalReference`, sync params |
| POST | `/orders` | orders.create | Creates the order **and its lines in one transaction**. Body: `outletId`, `orderType`, `tableOrLocation`, `guestCount`, `notes`, `externalReference` (your id), `items: [{productId, quantity, notes}]` (max 100). Prices always come from HotelPOS |
| GET | `/orders/{id}` | orders.view / pos.access | |
| PATCH | `/orders/{id}` | orders.create | Header fields |
| POST | `/orders/{id}/items` | orders.create | Adds a line; the same product with the same notes merges |
| PATCH / DELETE | `/orders/{id}/items/{itemId}` | orders.create | Quantity `0` removes the line |
| POST | `/orders/{id}/request-settlement` | orders.create | Locks the lines and checks stock |
| POST | `/orders/{id}/reopen` | orders.create | Unlocks an order awaiting settlement |
| POST | `/orders/{id}/void` | orders.create | `reason`; needs orders.void or a supervisor's `supervisorUsername`/`supervisorPassword` |
| GET | `/orders/{id}/discounts/available` | discounts.apply | |
| POST | `/orders/{id}/discounts` | discounts.apply | `discountId`, `orderItemId` for item discounts |
| DELETE | `/orders/{id}/discounts/{orderDiscountId}` | discounts.apply | |

Order lifecycle: `OPEN → IN_PROGRESS → AWAITING_SETTLEMENT → SETTLING → COMPLETED`, plus `CHARGE_FAILED`, `VOIDED`, `PARTIALLY_REFUNDED` and `REFUNDED`.

### Settlement

| | Path | Permission | Notes |
|---|---|---|---|
| POST | `/orders/{id}/payments` | payments.process | `paymentMethodId`, `amount`, `tenderedAmount` (cash), `reference`; idempotent. Needs an open shift when the hotel requires one |
| GET | `/payments` | payments.view | `outletId`, `status`, `methodId`, sync params |
| POST | `/orders/{id}/room-charge/validate` | room_charges.process | `roomNumber` → PMS-validated room, guest **name for display**, folio, and a 5-minute single-use `token` |
| POST | `/orders/{id}/room-charge` | room_charges.process | `validationToken`; idempotent. `outcome`: `POSTED`, `FAILED`, or `UNKNOWN` |
| POST | `/guest-charges/{id}/verify` | room_charges.process | Resolves an `UNKNOWN` charge by asking the PMS. Never re-posts blindly |
| GET | `/guest-charges`, `/guest-charges/{id}` | room_charges.view | `externalFolioId` filter. External PMS ids only |
| GET | `/refunds`, `/refunds/{id}` | refunds.view / refunds.approve | |
| GET | `/receipts/{id}` | receipts.view | The frozen receipt snapshot |
| POST | `/receipts/{id}/printed` | receipts.view | Counts a print |

**Charge to room, step by step:**

1. Create the order, then call `request-settlement`.
2. Call `validate` with the room number. Show the returned guest name to the guest to confirm, then discard it.
3. Post the charge with the token and an `Idempotency-Key`.
4. Act on the `outcome`:
   - `POSTED`: the order is completed.
   - `FAILED`: use another room or a direct payment.
   - `UNKNOWN`: call `verify` until it resolves. Do not settle the order another way meanwhile.

### Shifts

| | Path | Permission | Notes |
|---|---|---|---|
| GET | `/shifts` | shifts.view / shifts.open / shifts.manage | Without shifts.manage or reports.view, only the caller's own |
| GET | `/shifts/current` | same | The caller's open shift with running totals |
| GET | `/shifts/{id}` | same | With summary |
| POST | `/shifts` | shifts.open | `outletId`, `openingCash`; opens a shift for the client's service account |
| POST | `/shifts/{id}/close` | shifts.open / shifts.manage | `actualCash`; returns the expected cash and variance |

### Inventory

| | Path | Permission | Notes |
|---|---|---|---|
| GET | `/inventory/levels` | inventory.view | `outletId`, `search`, `low=true` |
| GET | `/inventory/movements` | inventory.view | The append-only ledger. `from`/`to` (default last 30 days), `outletId`, `itemId`, `type` |
| POST | `/inventory/movements` | inventory.manage / inventory.adjust | `transactionType` (`STOCK_IN`, `STOCK_OUT`, `ADJUSTMENT` with the counted quantity, `DAMAGE`, `WASTE`, `RETURN`), `inventoryItemId`, `outletId`, `quantity`, `unitCost`, `reason`, `reference`; idempotent |

### Reports and events

| | Path | Permission | Notes |
|---|---|---|---|
| GET | `/reports` | reports.view | Report keys and their columns |
| GET | `/reports/{key}` | reports.view | Same figures as the Reports screens. `from`, `to`, `outletId`, and per report `cashierId`, `productId`, `methodId`, `granularity`, `sort` |
| GET | `/events` | integrations.view | Pull feed, see §7 |

## 7. Events

Every business change worth reacting to writes an event **in the same database transaction**. An event exists if and only if the change committed.

```json
{
  "id": "6f1c9a3e-5b7d-4c1e-9a52-1f0f2b8d7c41",
  "sequence": 1842,
  "type": "OrderCompleted",
  "schemaVersion": 1,
  "occurredAt": "2026-11-12T03:15:22.481Z",
  "source": "hotelpos",
  "outletId": 1,
  "aggregate": { "type": "order", "id": "512" },
  "data": { … }
}
```

- `id` is stable: **de-duplicate on it**. Delivery is at-least-once.
- `sequence` increases with every event; it is the cursor for the pull feed.
- Events of one aggregate (one order, shift, product or item) are delivered **in order**: a refund never arrives before the sale it refunds.

### Receiving events

Pick either option, or both.

**Webhook (push).** Set `EVENTS_PUBLISHER=webhook`, `EVENTS_WEBHOOK_URL` and `EVENTS_WEBHOOK_SECRET` on the HotelPOS server. Each event is POSTed as JSON with these headers:

| Header | Value |
|---|---|
| `X-HotelPOS-Event` | Event type |
| `X-HotelPOS-Delivery` / `Idempotency-Key` | Event id |
| `X-HotelPOS-Timestamp` | Unix seconds |
| `X-HotelPOS-Signature` | `sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret>` |

Delivery rules:

- Answer with any 2xx within `EVENTS_TIMEOUT_MS`.
- Anything else is retried with backoff: 30 s, 1 min, 2 min, … up to 1 h.
- After `EVENTS_MAX_ATTEMPTS` the event "gives up". An operator can retry it from System → Integrations.
- While an event is failing, later events of the same order wait behind it.

Verify the signature before trusting a webhook (Node.js):

```js
import crypto from "crypto";

// rawBody: the request body exactly as received (string or Buffer), not re-serialised JSON.
export function verifyHotelPosWebhook(headers, rawBody, secret, toleranceSeconds = 300) {
  const timestamp = headers["x-hotelpos-timestamp"];
  const signature = headers["x-hotelpos-signature"] || "";
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

**Pull feed.** No broker or inbound firewall rule is needed:

```text
GET /api/v1/events?after=<last sequence you processed>&limit=500&type=OrderCompleted,OrderRefunded
→ { ok, events: [...], nextAfter, hasMore }
```

- Save `nextAfter` after you have processed the page, and repeat while `hasMore` is true.
- Events appear in the feed about 3 seconds after they are written, so a reader never skips one that committed slightly later.
- Clients without every-outlet access see only their outlets' events.

### Event catalog

All amounts are decimal strings; `currency` is the ISO code.

| Type | Aggregate | `data` highlights |
|---|---|---|
| `OrderCompleted` | order | `orderNumber`, `externalReference`, `outletId`, `shiftId`, `orderType`, `settlementType`, `currency`, `subtotal`, `discountAmount`, `taxAmount`, `serviceChargeAmount`, `totalAmount`, `completedAt`, `receiptNumber`, `lines[]` (product, quantity, unit price, gross, discount, tax rate/inclusive, tax, net, line total), `discounts[]`, `payments[]` (method, amount, provider reference), `guestCharge` (folio, PMS transaction) |
| `OrderVoided` | order | `orderNumber`, `previousStatus`, `totalAmount`, `reason`, `requestedBy`, `approvedBy`, `voidedAt` |
| `OrderRefunded` | order | `refundNumber`, `refundType`, `settlementType`, `reason`, `amount`, `method`, `lines[]` (with `restock`), `refundReference`, `orderStatus`, `receiptNumber`, `processedAt` |
| `PaymentCaptured` | order | `paymentNumber`, `method`, `isCash`, `amount`, `tenderedAmount`, `changeAmount`, `reference`, `externalTransactionId`, `shiftId`, `capturedAt` |
| `RoomChargePosted` | order | `chargeNumber`, `roomNumber`, `externalGuestId`, `externalRoomId`, `externalFolioId`, `amount`, `pmsTransactionId`, `postedAt` |
| `RoomChargeReversed` | order | `chargeNumber`, `refundNumber`, `externalFolioId`, `pmsTransactionId`, `reversalReference`, `amount`, `chargeStatus` |
| `ShiftOpened` / `ShiftClosed` / `ShiftReconciled` | shift | `shiftNumber`, `outletId`, `cashierId`, opening/expected/actual cash and variance, timestamps |
| `StockMovementRecorded` | inventory_item | `transactionNumber`, `type`, `item` (sku, name, unit), `quantity`, `balanceAfter`, `negativeStock`, `unitCost`, `reason`, `reference` |
| `ProductPriceChanged` | product | `productCode`, `outletId`, `oldPrice`, `price`, `isAvailable`, `removed`, `effectiveFrom` |

Sales deduct stock through each product's recipe; those ledger rows are not separate events (read them from `/inventory/movements`). `StockMovementRecorded` covers manual and API movements.

## 8. Recipes

**Accounting / GL.** Subscribe to `OrderCompleted`, `OrderRefunded`, `OrderVoided` and `ShiftClosed`.

1. Post revenue from `lines[].netAmount`, VAT from `taxAmount`, and the service charge from `serviceChargeAmount`.
2. Post the settlement side from `payments[]`, or for room charges, as a receivable on the PMS folio from `guestCharge`.
3. Use `id` as the journal's source reference so redeliveries are ignored.

**BI / data warehouse.** Sync `orders`, `payments`, `guest-charges`, `refunds` and `products` nightly with `updatedSince`, or read the event feed continuously. Pull `/reports/{key}` for the same figures the hotel staff see.

**Purchasing / inventory planning.**

1. Read `/inventory/levels?low=true` to raise purchase requests.
2. When goods arrive, `POST /inventory/movements` with `STOCK_IN`, the PO number as `reference`, and the GRN id as `Idempotency-Key`.
3. Subscribe to `StockMovementRecorded` for waste and damage.

**Guest / room-service app.** Use a client with a Cashier-type role assigned to the room-service outlet.

1. `POST /shifts` once per business day.
2. `POST /orders` with `items`, `orderType: "ROOM_SERVICE"`, your order id as `externalReference`, and an `Idempotency-Key`.
3. `request-settlement`, then charge to room (§6) or take a payment.

## 9. Limits

| Limit | Default | Setting |
|---|---|---|
| Requests per minute per key | 600 | `API_RATE_LIMIT_PER_MINUTE`. Every response carries `X-RateLimit-Limit`, `-Remaining` and `-Reset` |
| Body size | 1 MB | |
| Page size | 200 (orders 100; categories, products, stock levels, movements and events 500) | |
| Room validation token | 5 minutes, single use | |
| Lines per order create | 100 | |

Behind a reverse proxy, set `TRUST_PROXY` on the HotelPOS server so IP allowlists and the audit log see the real client address.
