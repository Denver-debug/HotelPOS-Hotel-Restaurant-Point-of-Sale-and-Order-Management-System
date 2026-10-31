# Integrations

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
| ERP event bus | Outbox table + `logOnlyPublisher` | **Mock publisher.** Events are stored reliably but not delivered anywhere |

Configuration comes from environment variables only (`.env`, never committed):
`PMS_ADAPTER`, `PMS_BASE_URL`, `PMS_API_KEY`, `PMS_TIMEOUT_MS`, `PAYMENT_ADAPTER`,
`HR_ADAPTER`, `HR_BASE_URL`, `HR_API_KEY`, `HR_TIMEOUT_MS`, `HR_VALIDATE_ON_LOGIN`.

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

## Event bus

Domain events (`OrderCompleted`, `OrderRefunded`) are inserted into `integration_events` in the same transaction as the sale or refund. To deliver them, replace `logOnlyPublisher` in `integrations/events/eventPublisher.js` with a publisher for the ERP Integration Layer (e.g. Amazon SQS, Figure 4), and call `publishPending()` from a worker or scheduler.
