# StaffPay ↔ HotelPOS: employee check API

For the StaffPay team. HotelPOS (the restaurant point-of-sale) needs to ask StaffPay one question: **is this employee code a current employee?** It asks when an administrator creates a POS user and every time that user signs in, so staff who resign or are terminated in StaffPay lose POS access straight away.

StaffPay stays the owner of employee data. HotelPOS stores only the employee code on its user account and never asks for salary, contact or government IDs.

HotelPOS is already built for this endpoint (`HR_ADAPTER=staffpay`). StaffPay has no API today; every route needs a browser session and CSRF token, so this endpoint is the only change needed on your side.

## The endpoint

```
GET /api/v1/employees/{employee_code}
Authorization: Bearer <API key issued to HotelPOS>
Accept: application/json
```

HotelPOS sends the code as it stores it, for example `EMP-0231`. Match it the way your attendance import already does (`normalizeCode` in `services/importService.js`), so `EMP-0231`, `EMP231` and `emp 231` find the same employee.

### 200: found

```json
{
  "success": true,
  "data": {
    "employee_code": "EMP231",
    "full_name": "Ana R. Cruz",
    "employment_status": "active",
    "active": true,
    "position": "Cashier",
    "department": "Food & Beverage"
  }
}
```

| Field | Rule |
|---|---|
| `employee_code` | As stored in StaffPay |
| `full_name` | The `Employee.full_name` virtual |
| `employment_status` | `active`, `probationary`, `on_leave`, `resigned` or `terminated` |
| `active` | `true` when the status is in `ACTIVE_STATUSES` (`active`, `probationary`, `on_leave`). HotelPOS follows this flag |
| `position`, `department` | Names, or `null` |

Return nothing else. In particular, leave out salary, email, phone, address and birth date.

### Errors

| Status | When | Body |
|---|---|---|
| 404 | No employee matches the code | `{ "success": false, "error": { "code": "EMPLOYEE_NOT_FOUND", "message": "…" } }` |
| 401 | Missing or wrong API key | `{ "success": false, "error": { "code": "INVALID_API_KEY", "message": "…" } }` |
| 5xx | Anything else | Same shape |

Always answer JSON, never the HTML login page or a redirect. HotelPOS treats a 404 as "not an employee" (sign-in refused). It treats 401, 5xx, timeouts and non-JSON as "HR unavailable": sign-in is allowed and the outage is recorded in its audit log, so the restaurant keeps working while StaffPay is down.

## Reference implementation

Written for StaffPay's structure (Express, ESM, Sequelize models in `models/index.js`). It was reviewed against the repository but **not run inside StaffPay**, so please run your tests after adding it.

**1. `config.js`**: add the key to `config`:

```js
  // Key HotelPOS sends as "Authorization: Bearer …" to /api/v1. Empty = API disabled.
  posApiKey: process.env.POS_API_KEY || '',
```

and to `.env` / `.env.example`:

```
POS_API_KEY=
```

Generate the key once (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), put it in StaffPay's `.env` as `POS_API_KEY`, and give the same value to HotelPOS as `HR_API_KEY`.

**2. `routes/api.js`** (new):

```js
/*
 * Machine API for other hotel systems (HotelPOS). Bearer API key, JSON only, no session or CSRF.
 */
import crypto from 'crypto';
import express from 'express';
import { config } from '../config.js';
import { Employee, Position, Department, ACTIVE_STATUSES } from '../models/index.js';
import { normalizeCode } from '../services/importService.js';

const router = express.Router();
const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

router.use((req, res, next) => {
  const sent = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const key = Buffer.from(config.posApiKey);
  if (!key.length || sent.length !== key.length || !crypto.timingSafeEqual(sent, key)) {
    return fail(res, 401, 'INVALID_API_KEY', 'Invalid API key.');
  }
  next();
});

// Is this employee code a current employee? Used by HotelPOS at user creation and sign-in.
router.get('/employees/:code', async (req, res, next) => {
  try {
    const wanted = normalizeCode(req.params.code);
    const employees = await Employee.findAll({
      attributes: ['id', 'employee_code', 'first_name', 'middle_name', 'last_name', 'employment_status'],
      include: [
        { model: Position, as: 'position', attributes: ['name'] },
        { model: Department, as: 'department', attributes: ['name'] },
      ],
    });
    const e = employees.find((x) => normalizeCode(x.employee_code) === wanted);
    if (!e) return fail(res, 404, 'EMPLOYEE_NOT_FOUND', 'No employee with that code.');
    res.json({
      success: true,
      data: {
        employee_code: e.employee_code,
        full_name: e.full_name,
        employment_status: e.employment_status,
        active: ACTIVE_STATUSES.includes(e.employment_status),
        position: e.position?.name ?? null,
        department: e.department?.name ?? null,
      },
    });
  } catch (err) {
    console.error(err);
    fail(res, 500, 'SERVER_ERROR', 'StaffPay could not look up the employee.');
  }
});

router.use((req, res) => fail(res, 404, 'NOT_FOUND', 'No such endpoint.'));

export default router;
```

Loading every employee is fine for a hotel's staff count; with thousands of employees, look up the exact code first and fall back to the loose match.

**3. `index.js`**: mount it **before** `app.use(session(...))`, so API calls get no session cookie, CSRF check or login redirect:

```js
import apiRouter from './routes/api.js';
// ...
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1', apiRouter);   // ← add here, before session()
```

**4. Try it:**

```bash
curl -H "Authorization: Bearer $POS_API_KEY" https://staffpay.ecomap.site/api/v1/employees/EMP001
```

## Employee codes

A POS user's employee code must be the same person's code in StaffPay. HotelPOS's demo users use `EMP-0231`, `EMP-0102`, `EMP-0007`, `EMP-0310`, `EMP-0405` and `EMP-0050`. Either create matching employees in StaffPay or edit the POS users' Employee ID to StaffPay's codes (`EMP001` …) under **Users** in HotelPOS before switching it over.

## Switching HotelPOS over

In HotelPOS's `.env`:

```
HR_ADAPTER=staffpay
HR_BASE_URL=https://staffpay.ecomap.site/api/v1   # the default; set it only for another host
HR_API_KEY=<the same value as StaffPay's POS_API_KEY>
HR_VALIDATE_ON_LOGIN=true
```

Restart HotelPOS. **System → Integrations** shows `StaffPayHrAdapter`, and every check appears in the integration log with the employee's name masked.
