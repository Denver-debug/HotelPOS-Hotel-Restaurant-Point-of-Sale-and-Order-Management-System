# Requirement Traceability (17 system diagrams)

Source: `HotelPOS_ Hotel Restaurant Point-of-Sale and Order Management System (1).docx`.
Status reflects the final implementation. **Tested** means covered by the automated suite in `__tests__/`.

| Diagram ref | Requirement | HotelPOS module | Database entity | Status |
|---|---|---|---|---|
| F17 REQ-1, F2, F9-2.0, F10 | Manage catalog, outlet prices, price history | Products, Categories, Outlets | products, categories, outlets, product_prices, taxes | Implemented |
| F17 REQ-2, F7, F8, F12-1.0, TC-02 | Create order with items; total 850.00 | POS terminal, Orders | orders, order_items | Implemented, tested (TC-02) |
| F17 REQ-3, F12-2.0, F11, F15 | Validate room and active folio through PMS; invalid → direct payment | Guest room charges, PMS adapter | guest_charges, integration_logs | Implemented, tested (mock PMS) |
| F17 REQ-4, F10, F13 | Direct payment (cash/card/e-wallet/bank); declined → back to settlement | Payments, payment adapter | payments, payment_methods | Implemented, tested (mock gateway) |
| F17 REQ-5, F12-3.0, F13, TC-05 | Post room charge, store PMS-TX, retry ≤ 3, idempotent | Guest room charges | guest_charges | Implemented, tested (TC-05, timeout/retry) |
| F17 REQ-6, F2, F14-3.4, F16 | Deduct stock once on completion (Iced Tea 40 → 38) | Inventory | inventory_items, stock_levels, product_recipes, inventory_transactions, stock_locations | Implemented, tested (40 → 38) |
| F17 REQ-7, F11, F14-3.5 | Receipt; "CHARGED TO ROOM 205"; guest signature | Receipts | receipts | Implemented, tested |
| F17 REQ-8, F9-8.0, F10 | Sales/shift reports and audit | Reports, Audit logs | audit_logs | Implemented (13 reports, CSV export) |
| F17 REQ-9, F1, F2, TC-09 | No PMS/HR master data copies | All | external_* columns only | Implemented, tested (TC-09) |
| F9-1.0, F10 | Login validates employee with HR | Auth, HR adapter | users.external_employee_id | Done (mock HR) |
| F2, F9-1.0, F10 | Open/close shift, expected vs actual cash, variance | Cashier shifts | shifts | Implemented, tested (variance) |
| F2, F10, F13 | Discounts; supervisor authorization | Discounts | discounts, order_discounts, discount_products, discount_outlets | Implemented |
| F10, F13 | Void [supervisor]; refund to payment method; restock | Refunds & voids | refunds, refund_items | Implemented, tested |
| F15 | Publish OrderCompleted event | Integration events (outbox) | integration_events | Implemented (mock publisher) |
| F1, F10 | Accounting views reports | Roles | roles (ACCOUNTANT) | Done (seed) |
| F3, F4 | Electron terminal shell | Existing XianFire Electron app | — | Kept |
| F1, F4 | Load balancer, Docker, RDS, SQS, S3, VPN, ESC/POS, EMV | Infrastructure | — | Out of scope (documented) |
| F3 | Nodemailer e-receipts | Receipts | — | Deferred (no mail dependency) |

## Diagram discrepancies and resolutions

1. **Order statuses.** The prompt, F2 and F13 differ. Persisted: `OPEN, IN_PROGRESS, AWAITING_SETTLEMENT, SETTLING, CHARGE_FAILED, COMPLETED, VOIDED, PARTIALLY_REFUNDED, REFUNDED`. F13's Payment Processing / Folio Validation / Posting Charge are `SETTLING` plus the payment or guest-charge status. Paid / Charged to Room → Completed happens atomically.
2. **ChargeStatus** gains `UNKNOWN` (PMS timeout) and `PARTIALLY_REVERSED`. A charge is retried only after a status lookup by idempotency key.
3. **Discount** (F2) is extended with validity dates, outlet/product scope, status and usage limits.
4. **OrderRepository** (F7) is omitted. Sequelize models are the repository layer in XianFire.
5. **Accounting actor** (F1, F10) → read-only `ACCOUNTANT` role.
6. **HR login check** (F9, F10) → local accounts with `external_employee_id`, verified through the HR adapter at login.
7. **Guest name** is shown live from the PMS at confirmation and never persisted (TC-09).
8. **Tax**: 12% VAT inclusive (F5: 850.00 VAT-inclusive) and a per-outlet service charge rate (0% for room service).
9. **Infrastructure** in F1/F4 is not part of the application code base.
