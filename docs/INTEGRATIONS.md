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
| Payment provider | `MockPaymentAdapter` (default) or `PayMongoAdapter` | **PayMongo** takes real GCash and Maya payments once `PAYMENT_ADAPTER=paymongo` has the hotel's keys. Tested against a simulated PayMongo API, not yet against the PayMongo sandbox |
| HR and Staff Payroll | `MockHrAdapter` (default) or `HttpHrAdapter` | **Mock.** The HTTP adapter's endpoint is an assumption |
| ERP events | Outbox table + `logOnlyPublisher` (default) or signed `webhookPublisher` | **Log only** until `EVENTS_PUBLISHER=webhook` points at the ERP. The pull feed `GET /api/v1/events` works either way |

Configuration comes from environment variables only (`.env`, never committed; see `.env.example`):

| Area | Variables |
|---|---|
| PMS | `PMS_ADAPTER` (`mock` \| `http`), `PMS_BASE_URL`, `PMS_API_KEY`, `PMS_TIMEOUT_MS`, `PMS_MOCK_DELAY_MS` |
| Payment | `PAYMENT_ADAPTER` (`mock` \| `paymongo`), `PAYMENT_API_KEY` (PayMongo secret key), `PAYMENT_WEBHOOK_SECRET`, `PAYMENT_RETURN_URL`, `PAYMENT_BASE_URL` (default `https://api.paymongo.com/v1`), `PAYMENT_TIMEOUT_MS` |
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

Contract: `integrations/payments/paymentGateway.js` (`authorizeAndCapture`, `getStatus`, `cancel`, `refund`, `parseWebhook`).
The hotel takes **Cash, GCash and Maya** only (`SUPPORTED_PAYMENT_METHODS` in `models/salesModel.js`). Cash is recorded locally. Older methods (cards, bank transfer) stay in `payment_methods` as `INACTIVE` for history and cannot be switched back on.

### PayMongo (`PAYMENT_ADAPTER=paymongo`)

GCash and Maya go through [PayMongo](https://docs.paymongo.com)'s Payment Intent workflow (`integrations/payments/paymongoAdapter.js`). The guest pays on their own phone:

1. The cashier picks GCash or Maya and presses **Show QR code**. No reference number is typed. HotelPOS creates a payment intent for the amount in centavos (`Idempotency-Key` = the POS payment key), attaches a `gcash` or `paymaya` payment method and gets PayMongo's checkout link. The payment is `PENDING` and the order is `SETTLING`.
2. The POS shows the link as a QR code (`GET /api/payments/{id}/qr.svg`). The guest scans it with their phone camera and approves in GCash or Maya. Their phone then opens `PAYMENT_RETURN_URL` (default `/pay/complete`, a "you can close this page" screen).
3. The terminal checks the payment every 3 seconds (`POST /api/payments/{id}/verify`, which reads the payment intent). `succeeded` records the payment as captured, with PayMongo's `pay_…` id as the transaction id, and completes the order. `awaiting_payment_method` means the guest declined, abandoned or let the checkout expire (GCash 4 hours, Maya 30 minutes): the payment fails and the order returns to Awaiting Settlement.
4. **Cancel payment** (POS) or **Cancel** (Payments page) cancels the payment intent. If the guest had already paid, PayMongo refuses the cancel and the payment is recorded as paid instead. While PayMongo is still processing it, cancel answers `409 PAYMENT_PROCESSING`.
5. Closing the dialog does not cancel anything. Opening payment on the same order again shows the same QR code.

Webhooks are optional, because the POS polls. They also complete payments when no terminal is watching. In the PayMongo dashboard, add a webhook for `payment.paid` and `payment.failed` pointing at `https://<your-domain>/webhooks/paymongo`, and put its signing secret in `PAYMENT_WEBHOOK_SECRET`. The `Paymongo-Signature` HMAC is checked. The event only names the payment intent, and its outcome is always read back from the API, so a replayed event changes nothing. PayMongo cannot reach `localhost`, so webhooks need the app on a public HTTPS domain.

Refunds of a GCash or Maya sale go back through `POST /refunds` (in centavos, `reason: requested_by_customer`) to the original `pay_…` payment. If PayMongo reports a payment as paid after HotelPOS had already failed it, an audit entry `PAYMENT_PAID_AFTER_FAILURE` is written. That money must be refunded from the PayMongo dashboard.

Setting it up:

1. Create a PayMongo account. Test keys (`sk_test_…`) work at once. Live keys need PayMongo's business verification (DTI/SEC, BIR registration, bank account).
2. In `.env`, set `PAYMENT_ADAPTER=paymongo` and `PAYMENT_API_KEY=sk_test_…`, then restart. The app refuses to start without a valid secret key. The POS shows **PAYMONGO TEST** while a test key is in use.
3. Take a payment. In test mode, PayMongo's checkout page has buttons to authorise or fail the test payment, so you can try paid, declined and cancelled without moving money.
4. Switch to `sk_live_…` (and the live webhook secret) for real payments.

Payments taken with one adapter are verified, cancelled and refunded only through that adapter. After switching `PAYMENT_ADAPTER`, older pending payments must be checked in the provider's own dashboard.

### Mock (`PAYMENT_ADAPTER=mock`, the default)

The cashier types the e-wallet reference number. Reference `DECLINE` declines the payment, and `TIMEOUT` loses the response after capture. **With the mock, a GCash or Maya payment is marked paid without any money moving**: check the guest's confirmation screen and the hotel's merchant app before relying on it.

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
