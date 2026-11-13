# HotelPOS Architecture

HotelPOS is the restaurant and outlet point-of-sale subsystem of the Hotel ERP. It runs on the
**XianFire framework** (Express 4 + hbs `.xian` views + Sequelize/mysql2) and **MySQL 8**.

## Running locally

```bash
cp .env.example .env              # then set SESSION_SECRET (and DB_* if needed)
npm install
npm run migrate -- --seed         # create DB, apply migrations, seed reference data
npm run migrate -- --seed --demo  # optional: demo cashier/supervisor/manager accounts
npm run xian                      # http://localhost:3000
```

Seeded passwords are printed once and appended to `storage/seed-credentials.txt` (git-ignored).

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Entry | `index.js` | XianFire engine, request ids, CORS, sessions (MySQL store), API-key auth, rate limit, CSRF, security headers, layouts/partials, error handling, event dispatcher start |
| Config | `config/` | `.env` loading, permission catalog + default role grants, sidebar navigation |
| Routes | `routes/*.js` | One Express router per feature, mounted in `routes/index.js`; every route declares `requirePermission(...)`. `routes/api.js` is mounted at `/api/v1` (contract, `config/openapi.js`) and `/api` (POS terminal) |
| Controllers | `controllers/*Controller.js` | Parse/validate request input, call services, render views or return JSON |
| Services | `services/*Service.js` | Business rules, DB transactions, state transitions, auditing |
| Integrations | `integrations/{pms,payments,hr,events}` | Adapter interfaces + mock/HTTP adapters; every call logged in `integration_logs`. `events/` holds the outbox publishers (log, signed webhook), the dispatcher and the pull feed |
| Models | `models/*Model.js`, `models/index.js` | Sequelize models and associations (schema is owned by SQL migrations) |
| Database | `database/migrations`, `database/seeds` | Versioned SQL/JS migrations (`schema_migrations`), idempotent seeds |
| Views | `views/layouts`, `views/partials`, `views/<module>/` | Handlebars layouts, shared partials (nested partials such as `{{> pos/order-pad}}`), module pages |
| Front-end | `public/js`, `public/css` | Vanilla JS (CSRF-aware fetch, confirm dialogs, POS terminal and its shortcut registry `pos-shortcuts.js`), Tailwind via pinned CDN |
| API support | `middleware/apiAuth.js`, `middleware/apiEdge.js`, `middleware/requestId.js`, `services/serializers.js`, `utils/apiList.js` | API keys → service-account context, CORS, rate limit, `Idempotency-Key`; JSON shapes; paging and `updatedSince` |

## Key conventions

- **Money** is `DECIMAL(12,2)` in MySQL and integer centavos in JavaScript (`utils/money.js`). It is never a float.
- **Authorization** is enforced on the server with `requirePermission()` and outlet scoping (`assertOutletAccess`, `outletScope`). Hiding a menu item never counts as authorization.
- **CSRF**: every browser POST/PATCH/DELETE carries `_csrf` (forms) or `X-CSRF-Token` (fetch). API-key requests are exempt and never get a session.
- **Machine access**: an API key acts as a service-account user (`users.is_service_account`), built into the same `req.user`/`req.permissions`/`req.outlets` context as a login (`loadUserContext`), so services never special-case integrations.
- **Errors**: services throw `AppError(message, status, code)`; every JSON error is `{ ok: false, error, code, details?, requestId }`. Codes are catalogued in docs/API.md.
- **Tracing**: `X-Request-Id` (accepted or generated) is echoed, logged and forwarded to the PMS/HR/payment calls as `X-Correlation-Id`.
- **Events**: domain events are written in the business transaction (`recordEvent`) and delivered by the dispatcher; never call another system from inside a DB transaction.
- **Data ownership**: guests, rooms, reservations, folios and employees belong to other ERP subsystems. HotelPOS stores only `external_*` references.
- **Immutability**: `audit_logs` and `inventory_transactions` are append-only (enforced by DB triggers). Orders, payments and room charges are never deleted. Voids, refunds and reversals correct them instead.
- **Idempotency**: unique keys on payments, guest charges, refunds and inventory movements prevent duplicate side effects.
- **Business timezone**: `APP_TIMEZONE` (default `+08:00`) defines "today" and report boundaries.
