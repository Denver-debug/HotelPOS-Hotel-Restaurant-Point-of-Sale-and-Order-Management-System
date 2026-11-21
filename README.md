# HotelPOS — Hotel Restaurant Point-of-Sale and Order Management System

HotelPOS is the point-of-sale subsystem of the Hotel ERP for hotel-operated outlets: restaurant, bar, room service, minibar, spa and other services. It handles orders, direct payments, **charges to guest room folios through the PMS**, outlet inventory, cashier shifts, discounts, refunds and voids, receipts, reports and audit trails.

It is built on the **XianFire framework** (Express + hbs `.xian` views + Sequelize) with **MySQL 8**.

## Quick start

Requirements: Node.js 20+ and MySQL 8 (for example, Laragon's MySQL 8.4).

```bash
npm install
cp .env.example .env                 # set SESSION_SECRET; adjust DB_* if needed
npm run migrate -- --seed --demo     # creates the HotelPOS database, schema, reference data and demo users
npm run xian                         # http://localhost:3000
```

The seed prints the generated passwords once and also appends them to `storage/seed-credentials.txt` (git-ignored). Set `SEED_ADMIN_PASSWORD` before seeding if you prefer a known password.

| Demo user | Role | Outlets |
|---|---|---|
| `admin` | System Administrator | all |
| `manager01` | POS Manager | all |
| `supervisor01` | Supervisor | RS-01, REST-01, BAR-01 |
| `cashier01` | Cashier (HR `EMP-0231`) | RS-01, REST-01 |
| `staff01` | Restaurant Staff | REST-01 |
| `inventory01` | Inventory Staff | RS-01, REST-01, BAR-01, MB-01 |
| `accountant01` | Accountant (read-only) | all |

### Try the Room 205 scenario (Figures 5 and 12)

1. Sign in as `cashier01`, then open a shift at **In-Room Dining**.
2. Open the **POS Terminal**. Add 1 × Club Sandwich and 2 × Iced Tea; the total is ₱850.00.
3. Choose **Charge to Room** and enter `205`. The PMS returns J. Tan / folio F-88213.
4. Confirm. The charge posts as `PMS-TX-77120`, Iced Tea stock goes from 40 to 38, and the receipt reads **CHARGED TO ROOM 205**.

The other mock rooms (101, 102, 103, 404, 306, 999) exercise each failure path. See `docs/INTEGRATIONS.md`.

### Where orders are served

- **Dine-in** orders must pick a table from the outlet's list. Manage the list under **Outlets → (outlet) → Tables**. The seed adds T1–T8 and P1–P4 to The Garden Restaurant, Bar 1–6 and Lounge 1–4 to the Lobby Bar, and three treatment rooms to the Spa.
- **Room service** and **minibar** orders need the guest's room number, checked with the PMS when the order is taken. Charge to Room is then filled in with that room.
- A cashier can't close a shift while unpaid orders are open at the outlet. They settle or void them, or tick **Hand over to the next shift** and write a note. The hand-over is audited, and the orders then block the next shift's close until someone deals with them.

Direct payments are **Cash, GCash and Maya**. With `PAYMENT_ADAPTER=paymongo`, GCash and Maya go through PayMongo: the POS shows a QR code, the guest approves on their phone, and the order completes when PayMongo confirms it. With the mock, the cashier types the e-wallet reference number. See `docs/INTEGRATIONS.md`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run xian` / `npm start` | Run the app (nodemon / node) |
| `npm run migrate` | Apply pending migrations (`--seed`, `--demo`, `--fresh --yes` for development only) |
| `npm test` | Unit and integration tests (integration tests rebuild the `HotelPOS_test` database) |
| `npm run test:unit` | Unit tests only, no database needed |
| `npm run route:list` | List all registered routes |
| `npm run electron` | Run as the XianFire desktop (Electron) terminal |

After pulling new code, run `npm run migrate` before starting the app.

## Documentation

- `docs/ARCHITECTURE.md`: layers, conventions, security and data-ownership rules
- `docs/TRACEABILITY.md`: mapping of the 17 system diagrams to modules, and how the diagram discrepancies were resolved
- `docs/INTEGRATIONS.md`: PMS, payment, HR and event adapters, configuration, mock scenarios and go-live checklist
- `docs/API.md`: the `/api/v1` integration API for other ERP subsystems (API keys, endpoints, error codes, sync, idempotency, signed events)
- `docs/POS-SHORTCUTS.md`: every POS terminal keyboard shortcut (also on screen: press F1)
- `docs/AUDIT.md`: the system audit, what was fixed and what was deferred
- `docs/DEPLOY-AWS.md`: putting HotelPOS online on AWS (EC2 + RDS MySQL + Nginx + HTTPS)

> **Mock integrations:** the PMS, payment provider, HR system and event bus are simulated by clearly labelled MOCK adapters. No real GCash or Maya payment and no real folio posting happens until the real adapters are configured (`PAYMENT_ADAPTER=paymongo` for GCash and Maya).
