# System audit: POS, endpoints, consistency, usability, responsiveness, integration

**Scope.** Every route (95 web operations, 19 JSON operations at the start), controller, service, integration adapter, middleware, view and front-end script, checked against three goals: a fast POS for cashiers, a consistent and responsive back office, and easy integration with the other Hotel ERP subsystems.

**Method.**

- Read the code end to end.
- Reproduced each suspected bug before fixing it.
- Ran the Jest suite: 48 tests before, 103 after.
- Drove the real UI in Chromium (Electron) with real key events. The POS run has 83 checks, the back-office run 25.
- Checked layouts at 390 px (phone), 1024×600 (short landscape tablet) and 1366 px (desktop).

**Status key.** **Fixed**: changed and covered by a test or browser check. **Deferred**: written down with the reason it was not changed now.

---

## 1. POS terminal

| # | Finding | Status |
|---|---|---|
| P1 | Only 4 keyboard shortcuts (`/`, F2, F4, F8); Void, Discount, Note, quantity, open orders and the dialogs had none | **Fixed.** Every function has a key, listed in docs/POS-SHORTCUTS.md and the in-app F1 overlay. Void is F10 or Shift+Delete |
| P2 | Shortcuts weren't visible except F2/F4/F8 | **Fixed.** Every button, field, chip and dialog button shows its key on a badge drawn from the same registry that handles the key. Touch-only stations can hide them |
| P3 | A second product tap while a request was in flight was silently dropped (busy guard), losing items on fast taps and scanner bursts | **Fixed.** Line changes are queued and all applied in order |
| P4 | A page reload lost the open order | **Fixed.** The order id stays in the URL; reload resumes it |
| P5 | Quantity could only change by ±1; no decimal quantities for weighed items | **Fixed.** Quantity dialog (`*`) accepts decimals; `3*CODE` adds several at once |
| P6 | The catalog was loaded once per page; price or availability changes needed a reload | **Fixed.** Refreshes when stale and after an unavailable-product error |
| P7 | Expired session or stale CSRF token produced repeated error toasts; no offline handling | **Fixed.** A banner offers sign-in (returning to the same order) or reload; offline disables money actions |
| P8 | Dialogs had no height limit and were cut off on short screens; no focus trap or focus return | **Fixed** |
| P9 | Below 1024 px the Pay buttons sat under the whole catalog; `100vh` hid them on iPad Safari | **Fixed.** Products/Order switch with a bottom bar (total + Pay); `dvh` height |
| P10 | Touch targets of 30–36 px on the order pad; header overflowed at 390 px | **Fixed.** At least 40 px; header compacts on phones |
| P11 | Flash messages (e.g. "Shift opened") were never shown on the POS layout; "No open shift" didn't return to the POS | **Fixed** |
| P12 | Voiding without supervisor credentials showed "invalid credentials" | **Fixed.** The dialog asks for them first |

## 2. Back office: consistency, usability, responsiveness

| # | Finding | Status |
|---|---|---|
| W1 | Pagination and report CSV links used the router-relative path: page 2 of Orders went to `/?page=2`, Inventory movements and CSV export to 404s | **Fixed** (`utils/http.js` `fullPath`) |
| W2 | POS API calls consumed flash messages meant for the next page | **Fixed** |
| W3 | Two redirects trusted any referer containing a path fragment | **Fixed.** Same-origin `backUrl` |
| W4 | Missing roles, categories, taxes, inventory items and recipe products redirected silently or showed an empty "new" form | **Fixed.** 404 |
| W5 | Sidebar hid Refunds, Products and Shifts from roles holding the route's alternate permission; recipe "Manage" link 403'd for view-only users | **Fixed** |
| W6 | Pending payments and unconfirmed room charges were flashed as success; "please sign in" looked like an error | **Fixed.** New amber warning flash |
| W7 | Filter bars: buttons labelled "Go", "Filter" or missing; placeholder-only fields with no accessible name | **Fixed** on all 14 list pages |
| W8 | GET filter buttons stayed disabled after Back | **Fixed** |
| W9 | No confirmation for refund reject, outlet staff changes, stock movements, event dispatch, deactivating a payment method/user/discount | **Fixed.** The last three only ask when that is the change (`data-confirm-when`) |
| W10 | Blank tables instead of empty states (items, locations, taxes, roles, refunds, settings, integrations) | **Fixed** |
| W11 | Payment-method settings were a fixed 6-column grid under a 7-column header; shift stats squeezed 4 across | **Fixed.** Stacks on phones |
| W12 | Hidden phone sidebar stayed in the tab order; no Esc; no `aria-expanded`; no skip link; confirm dialog didn't trap focus | **Fixed** |
| W13 | Staff dropdowns loaded every user unlabelled; staff and payment-method queries were duplicated 5× each | **Fixed.** `services/lookupService.js` |
| W14 | `javascript:history.back()` on the error page | **Fixed** |

## 3. Endpoints and API consistency

| # | Finding | Status |
|---|---|---|
| A1 | 71 of 109 errors had the catch-all code `APP_ERROR`; the same condition used different codes (`NOT_EDITABLE` vs none, 409 vs 422) | **Fixed.** Specific codes for branchable conditions, status-based codes for the rest; catalog in docs/API.md |
| A2 | Provider timeouts on "verify" returned 500 "unexpected error"; malformed JSON returned 500 | **Fixed.** 502/504 and 400 |
| A3 | No request id: an error couldn't be traced across POS, logs and the PMS | **Fixed.** `X-Request-Id` in/out, in every JSON error and on the error page, sent on as `X-Correlation-Id` |
| A4 | Concurrent retries with one idempotency key could return "not settleable" instead of the original result | **Fixed** for payments, room charges, order creation and stock movements |
| A5 | Replaying a declined payment's key returned `ok: true` | **Fixed.** Same 402 |
| A6 | Room-charge validation token lived in the browser session: API clients, other sessions and other app instances could not complete a charge | **Fixed.** Hashed single-use row consumed in the charge transaction |
| A7 | Order + first line were created in two transactions | **Fixed.** One atomic create with up to 100 lines |
| A8 | No JSON read access to products, categories, outlets, payments, refunds, guest charges, receipts, shifts, inventory, reports | **Fixed.** 25 new `/api/v1` operations (44 in total) with paging and `updatedSince` |
| A9 | No machine authentication; integrators had to scrape a session and CSRF token | **Fixed.** API keys bound to service accounts, IP allowlist, rotate/revoke |
| A10 | No API versioning, CORS, rate limit, health check or machine-readable contract | **Fixed.** `/api/v1`, `API_CORS_ORIGINS`, per-key limit, `/health`, OpenAPI 3.1 checked against the router |
| A11 | Each JSON endpoint used its own top-level shape | **Partly fixed.** New lists share `{ ok, <resource>, pagination }`; errors share one shape. The POS endpoints keep their shapes for compatibility (see D1) |

## 4. Services, data and integrations

| # | Finding | Status |
|---|---|---|
| S1 | An unknown `PMS_ADAPTER`/`HR_ADAPTER` silently fell back to the mock (fake room charges in production) | **Fixed.** Validated at startup; warning when mocks run in production |
| S2 | `*_BASE_URL` without a trailing slash dropped its last path segment (`…/api/v1` → `…/api`) | **Fixed** |
| S3 | `X-Correlation-Id` was never sent to the PMS/HR | **Fixed** |
| S4 | Integration logs stored the PMS guest name and wrote structures deeper than 5 levels unmasked | **Fixed** |
| S5 | Supervisors could close or reconcile shifts at outlets they aren't assigned to; refund requests didn't validate the order id | **Fixed** |
| S6 | Marking a charge unknown and claiming a PMS retry ran without row locks | **Fixed** |
| S7 | Currency hard-coded as "PHP" | **Fixed.** `CURRENCY_CODE` |
| S8 | Events were stored but never delivered: log-only publisher, manual dispatch, endless retries without backoff, possible double delivery, payloads too thin for accounting | **Fixed.** Signed webhook + pull feed, background dispatcher, SKIP LOCKED claims, backoff to "gave up" with operator retry, per-order ordering, rich `OrderCompleted`/`OrderRefunded` |
| S9 | Only 2 event types; voids, payments, room charges, shifts, stock and price changes emitted none | **Fixed.** 11 event types |
| S10 | No index on `updated_at` for incremental sync | **Fixed** (migration 007) |

## 5. Deferred, with reasons

| # | Item | Why not now |
|---|---|---|
| D1 | Unify the POS terminal's JSON shapes with the new list envelope | Changing them would break the terminal and any existing caller for no functional gain; documented as they are |
| D2 | Web forms use `POST /x/:id` and `/remove` paths instead of PATCH/DELETE | HTML forms can't send PATCH/DELETE without method override; the JSON API already uses proper verbs |
| D3 | Three different edit-page patterns (`/:id/edit`, `/roles/:id`, `?edit=`) | Cosmetic; changing URLs breaks bookmarks |
| D4 | List pages default to different date windows (today / 7 / 30 days) | Each matches how that list is used (today's orders vs a month of shifts) |
| D5 | Small admin lists (discounts, outlets, categories, roles) aren't paginated; reports page through rows in memory | Row counts are small for a single property; revisit for multi-property use |
| D6 | Discount `maxUses` can be exceeded by orders completing concurrently | Needs a reservation step at apply time; low impact today, listed for the discounts module |
| D7 | Document numbers are generated from one counter row per type/day, which serialises busy outlets | Fine at hotel volumes; switch to per-outlet counters if contention appears |
| D8 | No Content-Security-Policy / HSTS headers | The Tailwind CDN JIT needs inline styles and eval; requires moving to a built stylesheet first. HSTS belongs on the TLS reverse proxy |
| D9 | Rate-limit counters are per app instance | Acceptable for one or two instances; a shared store (Redis) is needed beyond that |
| D10 | Payment provider is mock-only | Needs the provider's contract; the adapter interface is ready (docs/INTEGRATIONS.md) |

## 6. Upgrade notes

1. Run `npm run migrate`. It applies migrations 006–008:
   - 006: the room validation table.
   - 007: API clients, service accounts, order idempotency/reference, sync indexes, and the ERP role.
   - 008: event delivery columns.
2. Optionally set `CURRENCY_CODE`, `EVENTS_PUBLISHER=webhook` with its URL and secret, `API_CORS_ORIGINS` and `TRUST_PROXY` (`.env.example`).
3. The POS terminal's `/api` routes are unchanged apart from these error codes:
   - A product that can't be sold now returns `PRODUCT_UNAVAILABLE` (was `UNAVAILABLE`).
   - Codes that were `APP_ERROR` now return a specific code.
