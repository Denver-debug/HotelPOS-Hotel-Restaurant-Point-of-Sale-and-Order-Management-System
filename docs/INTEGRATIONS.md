# Integrations

Integration works in two directions:

- **Outbound** (this page): HotelPOS calls the PMS, the payment provider and HR through adapters, and publishes domain events to the ERP.
- **Inbound** ([API.md](API.md)): other subsystems call HotelPOS's `/api/v1` with API keys and receive its events by webhook or pull feed.

HotelPOS talks to other Hotel ERP subsystems only through adapters in `integrations/`.
Business services call a gateway factory (`getPmsGateway()`, `getPaymentGateway()`,
`getHrGateway()`) and never build HTTP requests themselves. Every external call is
recorded in `integration_logs` with timing, masked payloads, status and idempotency key
(see **System → Integrations** in the app).

| Subsystem | Adapter in use | Status |
|---|---|---|
| Front Desk / PMS | `MockPmsAdapter` (default) or `HttpPmsAdapter` | **Mock.** The HTTP adapter exists but has never been run against a real PMS |
| Payment provider | `MockPaymentAdapter` | **Mock only.** No card, e-wallet or bank processing is operational |
| HR and Staff Payroll | `MockHrAdapter` (default) or `HttpHrAdapter` | **Mock.** The HTTP adapter's endpoint is an assumption |
| ERP events | Outbox table + `logOnlyPublisher` (default) or signed `webhookPublisher` | **Log only** until `EVENTS_PUBLISHER=webhook` points at the ERP. The pull feed `GET /api/v1/events` works either way |

Configuration comes from environment variables only (`.env`, never committed; see `.env.example`):

| Area | Variables |
|---|---|
| PMS | `PMS_ADAPTER` (`mock` \| `http`), `PMS_BASE_URL`, `PMS_API_KEY`, `PMS_TIMEOUT_MS`, `PMS_MOCK_DELAY_MS` |
| Payment | `PAYMENT_ADAPTER` (`mock` only for now), `PAYMENT_BASE_URL`, `PAYMENT_API_KEY`, `PAYMENT_TIMEOUT_MS` |
| HR | `HR_ADAPTER` (`mock` \| `http`), `HR_BASE_URL`, `HR_API_KEY`, `HR_TIMEOUT_MS`, `HR_VALIDATE_ON_LOGIN` |
| Events | `EVENTS_PUBLISHER` (`log` \| `webhook`), `EVENTS_WEBHOOK_URL`, `EVENTS_WEBHOOK_SECRET`, `EVENTS_TIMEOUT_MS`, `EVENTS_DISPATCH_INTERVAL_MS`, `EVENTS_MAX_ATTEMPTS`, `EVENTS_BATCH_SIZE` |
| Inbound API | `API_CORS_ORIGINS`, `API_RATE_LIMIT_PER_MINUTE`, `TRUST_PROXY` |
| General | `CURRENCY_CODE` (ISO 4217, sent to the PMS/provider and in events) |

Adapter names are checked at startup: an unknown value stops the app instead of silently falling back to a mock. Base URLs keep their path (`https://pms/api/v1` and `https://pms/api/v1/` are the same). Every outbound call carries `X-Correlation-Id`, equal to the POS request's `X-Request-Id`, so one request can be followed through `integration_logs` and the other system's logs. Logged payloads mask secrets and personal data (guest and employee names, email, phone).

## PMS (guest room charges)

Contract: `integrations/pms/pmsGateway.js`.

| Method | Purpose | HTTP adapter endpoint |
|---|---|---|
| `getActiveFolio(roomNumber)` | Validate the room, checked-in guest, active folio and charge eligibility | `GET /rooms/{roomNo}/active-folio` (Figure 12) |
| `postCharge({...idempotencyKey})` | Post the order total to the folio | `POST /folios/{folioId}/charges` + `Idempotency-Key` header (Figure 12) |
| `getChargeStatus(idempotencyKey)` | Resolve an unknown outcome after a timeout | `GET /charges?idempotencyKey=…` *(assumed)* |
| `reverseCharge({...})` | Full refund of a posted charge | `POST /folios/{folioId}/charges/{txId}/reversal` *(assumed)* |
| `postAdjustment({...})` | Partial refund (negative amount) | `POST /folios/{folioId}/adjustments` *(assumed)* |

**What the PMS team must confirm before going live:**
1. Response field names. Map them in `httpPmsAdapter.js` only (`room.id`, `guest.id`, `guest.name`, `folio.id`, `chargeAllowed`, `transactionId`, error `code` values `ROOM_NOT_FOUND`, `ROOM_VACANT`, `NO_ACTIVE_FOLIO`, `NOT_ELIGIBLE`).
2. That `Idempotency-Key` is honoured: a repeated key must return the original result and never post twice.
3. A status-lookup endpoint by idempotency key. HotelPOS relies on it to resolve timeouts without double charging.
4. The authentication scheme. The adapter sends `Authorization: Bearer <PMS_API_KEY>`; network access is via the site-to-site VPN (Figure 4).

Then set `PMS_ADAPTER=http`, `PMS_BASE_URL`, `PMS_API_KEY` and run the room-charge scenarios on the POS terminal against a PMS test environment.

### Mock PMS scenarios (`PMS_ADAPTER=mock`)

| Room | Behaviour |
|---|---|
| 205 | Valid: guest J. Tan, folio F-88213 (Figures 5/12); first posting returns `PMS-TX-77120` |
| 207, 310 | Valid occupied rooms |
| 101 | Vacant |
| 102 | Occupied, no active folio |
| 103 | Guest not allowed to charge |
| 404 | Valid folio, the PMS rejects the charge (credit limit) |
| 306 | The charge posts, but the response times out. Use **Check status with PMS** to resolve it |
| any other | Room does not exist |

The mock remembers postings by idempotency key in `storage/mock-pms-ledger.json` (git-ignored).

## Payment provider

Contract: `integrations/payments/paymentGateway.js` (`authorizeAndCapture`, `getStatus`, `refund`).
Only the mock exists. In the mock, reference `DECLINE` declines the payment and `TIMEOUT` loses the response after capture. Cash, bank transfer and "other" methods do not use the gateway.

To add a real provider: create `integrations/payments/<provider>Adapter.js` implementing the same three methods. Use the provider's idempotency feature with the key HotelPOS passes. Then register it in `getPaymentGateway()` behind a new `PAYMENT_ADAPTER` value. Card data must never pass through HotelPOS; use the provider's terminal or hosted fields.

## HR and Staff Payroll

`getEmployee(employeeId)` verifies `external_employee_id` when a user is created and at login (when `HR_VALIDATE_ON_LOGIN=true`). If HR is unreachable, login is allowed and an `HR_CHECK_UNAVAILABLE` audit entry is written. The mock treats any `EMP-####` ID as active, except `EMP-9999`, which is inactive.

## ERP events

Domain events (`OrderCompleted`, `OrderRefunded`, `OrderVoided`, `PaymentCaptured`, `RoomChargePosted`, `RoomChargeReversed`, `ShiftOpened`/`Closed`/`Reconciled`, `StockMovementRecorded`, `ProductPriceChanged`) are inserted into `integration_events` in the same transaction as the change.

A background dispatcher, started with the server and the desktop app every `EVENTS_DISPATCH_INTERVAL_MS`, delivers them through the configured publisher:

- **`log`** (default) marks them delivered without sending anything. Use it until the ERP endpoint exists.
- **`webhook`** POSTs each event to `EVENTS_WEBHOOK_URL`, signed with `EVENTS_WEBHOOK_SECRET` (header `X-HotelPOS-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`). Any 2xx is success.

Delivery guarantees:

- At-least-once, with a stable event id to de-duplicate on.
- In order per order, shift or product.
- Exponential backoff (30 s up to 1 h). After `EVENTS_MAX_ATTEMPTS` an event "gives up". **System → Integrations** shows the counts and can dispatch now or retry events that gave up.
- Several app instances can dispatch at once (`FOR UPDATE SKIP LOCKED`).

To use a message broker instead (for example Amazon SQS, Figure 4), add a publisher with the same `publish(envelope)` method to `integrations/events/eventPublisher.js` and select it in `getEventPublisher()`.

The envelope, the event catalog and a signature-verification snippet are in [API.md](API.md#7-events).
