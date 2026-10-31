# HotelPOS Test Suite

```bash
npm test            # all tests (unit + integration)
npm run test:unit   # unit tests only (no database needed)
npm run test:coverage
```

- `__tests__/unit/` — pure logic (money math, pricing, order state machine, mock adapters).
- `__tests__/integration/` — end-to-end HTTP tests against a disposable MySQL database
  (`DB_TEST_NAME`, default `HotelPOS_test`). The suite drops and re-creates that database,
  so never point `DB_TEST_NAME` at real data.

Jest runs in ESM mode (`--experimental-vm-modules`) because the project uses `"type": "module"`.
