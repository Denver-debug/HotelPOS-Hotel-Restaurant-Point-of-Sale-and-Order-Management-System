# HotelPOS Test Suite

```bash
npm test            # all tests (unit + integration)
npm run test:unit   # unit tests only (no database needed)
npm run test:coverage
```

- `__tests__/unit/` — pure logic: money math, pricing, the order state machine, login
  redirects, link building inside mounted routers, sidebar permissions, log masking,
  adapter URLs and error codes.
- `__tests__/integration/` — end-to-end HTTP tests against a disposable MySQL database
  (`DB_TEST_NAME`, default `HotelPOS_test`). Each file drops and re-creates that database,
  so never point `DB_TEST_NAME` at real data.
  - `pos-flows` — the plan's scenarios A–F (sales, room charges, inventory, refunds, security)
  - `web-ui` — back-office links, flash messages, 404s, permission-aware links
  - `api-consistency` — error envelope and codes, request ids, idempotent replays under
    concurrency, database-backed room validation, outlet scoping
  - `api-v1` — API keys, service accounts, sync, atomic order creation, rate limit, CORS,
    and that the OpenAPI document covers every API route
  - `events` — recorded events, signed webhook delivery, ordering, backoff and retry,
    concurrent dispatchers, the pull feed

Jest runs in ESM mode (`--experimental-vm-modules`) because the project uses `"type": "module"`.
