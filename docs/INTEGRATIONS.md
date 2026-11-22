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
| Front Desk / PMS | `MockPmsAdapter` (default), `FrontdeskPmsAdapter` or `HttpPmsAdapter` | **Frontdesk** (`PMS_ADAPTER=frontdesk`) connects to the hotel's Frontdesk system (e.g. `frontdesk.dineai.site`) as described in its guide `POS_ORDERS.docx`. Tested against a simulated Frontdesk, not yet against the live one. The generic HTTP adapter is unused |
| Payment provider | `MockPaymentAdapter` (default) or `PayMongoAdapter` | **PayMongo** takes real GCash and Maya payments once `PAYMENT_ADAPTER=paymongo` has the hotel's keys. Tested against a simulated PayMongo API, not yet against the PayMongo sandbox |
| HR and Staff Payroll | `MockHrAdapter` (default) or `HttpHrAdapter` | **Mock.** The HTTP adapter's endpoint is an assumption |
| ERP events | Outbox table + `logOnlyPublisher` (default) or signed `webhookPublisher` | **Log only** until `EVENTS_PUBLISHER=webhook` points at the ERP. The pull feed `GET /api/v1/events` works either way |

Configuration comes from environment variables only (`.env`, never committed; see `.env.example`):

| Area | Variables |
|---|---|
| PMS | `PMS_ADAPTER` (`mock` \| `frontdesk` \| `http`), `PMS_BASE_URL`, `PMS_API_KEY`, `PMS_TIMEOUT_MS`, `PMS_MOCK_DELAY_MS`; Frontdesk only: `PMS_INBOUND_SECRET`, `PMS_WEBHOOK_SECRET`, `PMS_RESTAURANT_ID`, `PMS_REVIEW_POLL_MS` |
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

### Frontdesk PMS (`PMS_ADAPTER=frontdesk`)

The hotel's Frontdesk system (Member 2) does not post a POS charge straight to the guest's folio. It queues the order, a receptionist checks the guest and adds it to the bill, and the Frontdesk then tells HotelPOS the outcome. Its endpoints are under `https://<frontdesk-host>/api/v1/integrations/pos`:

| HotelPOS step | Frontdesk call |
|---|---|
| Cashier enters the room (`getActiveFolio`) | `GET /pos/in-house?room_number=204` → reservation, masked name, `folio_open` |
| Cashier confirms (`postCharge`) | `POST /pos/orders` with `order_status: COMPLETED`, `payment_status: CHARGE_TO_ROOM`, items and totals, signed |
| **Check status with PMS** and background polling (`getChargeStatus`) | `GET /pos/orders/{restaurant_id}/{external_order_id}` |
| Full refund (`reverseCharge`) | `POST /pos/orders` again, same content, `order_status: VOIDED` |
| Review outcome | Frontdesk → `POST https://<hotelpos-host>/webhooks/pms` (`PosOrderReviewed`) |

How a charge moves:

| Charge status | Meaning | Order |
|---|---|---|
| `AWAITING_REVIEW` | The Frontdesk accepted the order (`PENDING_REVIEW` or `NEEDS_GUEST_VERIFICATION`). The receipt prints | **Completed**: the guest has left; the bill is settled at checkout |
| `POSTED` | A receptionist added it to the folio (`ADDED_TO_FOLIO`) | Completed |
| `REJECTED` | The front desk rejected it after the sale. The charge page says to **collect the amount from the guest directly** | Completed, not on the folio |
| `FAILED` | The Frontdesk refused the request itself (validation, signature, conflict) | `CHARGE_FAILED`: try another room or pay directly |
| `UNKNOWN` | No answer (timeout, 5xx). Nothing is re-sent until **Check status with PMS** asks | Settling |

Details:

- **Ids.** `restaurant_id` is the outlet code (`RS-01`, `REST-01`, …) unless `PMS_RESTAURANT_ID` sets one value for all outlets. `external_order_id` is the room-charge number (`GC-0001`), new for each attempt, so a retry after a rejection is never an `ORDER_CONFLICT`. HotelPOS keeps `reservation_code` as the folio reference, `reservation_id` as the guest reference and `stay_id` as the room reference.
- **Idempotency.** `Idempotency-Key: pos-{restaurant_id}-{external_order_id}-{COMPLETED|VOIDED}`, stable across retries.
- **Amounts.** Items are sent with whole quantities (a fractional quantity becomes one line of its amount). `subtotal` = Σ quantity × unit price, `discount` = all discounts, `tax` = exclusive tax only (prices already include VAT), plus `service_charge`; `total` = the order total. HotelPOS refuses to send an order whose totals would not reconcile.
- **Signing.** With `PMS_INBOUND_SECRET`, every POST carries `X-Timestamp` and `X-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`. Keep the server clock in sync (NTP): the Frontdesk refuses signatures more than 300 s off.
- **Webhooks.** `/webhooks/pms` checks `X-PMS-Signature` with `PMS_WEBHOOK_SECRET` (±300 s) and acts on `PosOrderReviewed` only. `GuestCheckedIn` / `GuestCheckedOut` are acknowledged and ignored, because every charge is checked live. Repeated deliveries change nothing once a charge is reviewed.
- **Polling.** If a webhook is missed, charges awaiting review for more than a minute are checked every `PMS_REVIEW_POLL_MS` (default 2 min, `0` turns it off).
- **Refunds.** A full refund voids the order. Before review the Frontdesk rejects it; after it was added to the folio, the Frontdesk flags it and the front desk corrects the bill. Partial refunds of a Frontdesk room charge are refused, because the Frontdesk has no API for them; the front desk posts a bill adjustment instead. While a charge awaits review, only a full refund is allowed.
- The guest's name is shown to the cashier and never sent back or stored.

**Setting it up**

1. Ask the Frontdesk administrator for the **POS API key**, the **inbound signing secret** (their `POS_INBOUND_SECRET`, if they turned signing on) and the **webhook secret** (their `POS_WEBHOOK_SECRET`).
2. Give them:
   - the webhook URL `https://<hotelpos-host>/webhooks/pms`, for their `POS_WEBHOOK_URL`;
   - the restaurant ids HotelPOS sends: the codes of the outlets that allow room charges, or your `PMS_RESTAURANT_ID`. These go in their `POS_RESTAURANT_IDS` if they keep an allow-list; otherwise orders are refused with `VALIDATION_ERROR` (unknown restaurant).
3. Set in HotelPOS:

   ```dotenv
   PMS_ADAPTER=frontdesk
   PMS_BASE_URL=https://frontdesk.dineai.site/api/v1/integrations
   PMS_API_KEY=<POS key from the Frontdesk>
   PMS_INBOUND_SECRET=<their POS_INBOUND_SECRET, if signing is on>
   PMS_WEBHOOK_SECRET=<their POS_WEBHOOK_SECRET>
   ```

4. Run `npm run migrate` (migration `011_frontdesk_review` adds the two charge statuses) and restart.
5. Test with a checked-in test guest: charge to the room, approve it on the Frontdesk and see the charge become `POSTED`; charge again, reject it, and see `REJECTED`; refund one in full and see it voided on the Frontdesk.

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

Domain events (`OrderCompleted`, `OrderRefunded`, `OrderVoided`, `PaymentCaptured`, `RoomChargeSubmitted` (awaiting front-desk review), `RoomChargePosted`, `RoomChargeRejected`, `RoomChargeReversed`, `ShiftOpened`/`Closed`/`Reconciled`, `StockMovementRecorded`, `ProductPriceChanged`) are inserted into `integration_events` in the same transaction as the change.

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
