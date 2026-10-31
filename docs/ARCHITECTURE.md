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
| Entry | `index.js` | XianFire engine, sessions (MySQL store), CSRF, security headers, layouts/partials, error handling |
| Config | `config/` | `.env` loading, permission catalog + default role grants, sidebar navigation |
| Routes | `routes/*.js` | One Express router per feature, mounted in `routes/index.js`; every route declares `requirePermission(...)` |
| Controllers | `controllers/*Controller.js` | Parse/validate request input, call services, render views or return JSON |
| Services | `services/*Service.js` | Business rules, DB transactions, state transitions, auditing |
| Integrations | `integrations/{pms,payments,hr,events}` | Adapter interfaces + mock/HTTP adapters; every call logged in `integration_logs` |
| Models | `models/*Model.js`, `models/index.js` | Sequelize models and associations (schema is owned by SQL migrations) |
| Database | `database/migrations`, `database/seeds` | Versioned SQL/JS migrations (`schema_migrations`), idempotent seeds |
| Views | `views/layouts`, `views/partials`, `views/<module>/` | Handlebars layouts, shared partials (nested partials such as `{{> pos/order-pad}}`), module pages |
| Front-end | `public/js`, `public/css` | Vanilla JS (CSRF-aware fetch, confirm dialogs, POS terminal), Tailwind via pinned CDN |

## Key conventions

- **Money** is `DECIMAL(12,2)` in MySQL and integer centavos in JavaScript (`utils/money.js`). It is never a float.
- **Authorization** is enforced on the server with `requirePermission()` and outlet scoping (`assertOutletAccess`, `outletScope`). Hiding a menu item never counts as authorization.
- **CSRF**: every POST/PATCH/DELETE carries `_csrf` (forms) or `X-CSRF-Token` (fetch).
- **Data ownership**: guests, rooms, reservations, folios and employees belong to other ERP subsystems. HotelPOS stores only `external_*` references.
- **Immutability**: `audit_logs` and `inventory_transactions` are append-only (enforced by DB triggers). Orders, payments and room charges are never deleted. Voids, refunds and reversals correct them instead.
- **Idempotency**: unique keys on payments, guest charges, refunds and inventory movements prevent duplicate side effects.
- **Business timezone**: `APP_TIMEZONE` (default `+08:00`) defines "today" and report boundaries.
