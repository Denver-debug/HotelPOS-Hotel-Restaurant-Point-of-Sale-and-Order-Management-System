// Employee validation with StaffPay (HR_ADAPTER=staffpay), against a fake StaffPay that follows
// docs/STAFFPAY-API.md: GET /api/v1/employees/{code} with a Bearer key, codes matched loosely.
// The adapter's field mapping and error handling are in __tests__/unit/staffpay.test.js.
import http from "http";
import { startApp, SETUP_TIMEOUT_MS, Client, PASSWORD } from "./harness.js";
import { setHrGateway } from "../../integrations/hr/hrGateway.js";
import { StaffPayHrAdapter } from "../../integrations/hr/staffpayHrAdapter.js";

const API_KEY = "staffpay-key-for-tests-0123456789";

// ── Fake StaffPay ────────────────────────────────────────────────────────────
// Same matching as StaffPay's normalizeCode(): "EMP-0231" and "emp231" are both "EMP231".
const normalizeCode = (code) => {
  const s = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([A-Z]*)0*(\d+)$/.exec(s);
  return m ? `${m[1]}${m[2]}` : s;
};
const fake = { requests: [], employees: new Map(), down: false };
let fakeServer;

function resetEmployees() {
  fake.employees = new Map(
    [
      ["EMP231", "Cashier", "One", "Cashier", "active"],
      ["EMP102", "Outlet", "Supervisor", "F&B Supervisor", "probationary"],
      ["EMP7", "Pos", "Manager", "F&B Manager", "on_leave"],
      ["EMP310", "Restaurant", "Staff", "Waiter", "active"],
    ].map(([code, first, last, position, status]) => [code, { employee_code: code, full_name: `${first} ${last}`, employment_status: status, active: ["active", "probationary", "on_leave"].includes(status), position, department: "Food & Beverage" }])
  );
}

function startFakeStaffPay() {
  const reply = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://fake");
      fake.requests.push({ method: req.method, path: url.pathname, headers: req.headers });
      if (fake.down) return reply(res, 503, { success: false, error: { code: "UNAVAILABLE", message: "Maintenance." } });
      if (req.headers.authorization !== `Bearer ${API_KEY}`) return reply(res, 401, { success: false, error: { code: "INVALID_API_KEY", message: "Invalid API key." } });
      const m = /^\/api\/v1\/employees\/([^/]+)$/.exec(url.pathname);
      if (req.method !== "GET" || !m) return reply(res, 404, { success: false, error: { code: "NOT_FOUND", message: "No such endpoint." } });
      const emp = fake.employees.get(normalizeCode(decodeURIComponent(m[1])));
      if (!emp) return reply(res, 404, { success: false, error: { code: "EMPLOYEE_NOT_FOUND", message: "No employee with that code." } });
      reply(res, 200, { success: true, data: emp });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ── App under test ───────────────────────────────────────────────────────────
let ctx;
let adapter;

const signIn = async (username) => {
  const c = new Client(ctx.base);
  const page = await c.get("/login");
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  return c.request("POST", "/login", { form: { _csrf: token, username, password: PASSWORD, next: "" } });
};
const lastAudit = (action) => ctx.models.AuditLog.findOne({ where: { action }, order: [["id", "DESC"]] });

beforeAll(async () => {
  fakeServer = await startFakeStaffPay();
  ctx = await startApp();
  adapter = new StaffPayHrAdapter({ baseUrl: `http://127.0.0.1:${fakeServer.address().port}/api/v1`, apiKey: API_KEY, timeoutMs: 5000 });
  setHrGateway(adapter);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await ctx?.stop();
  await new Promise((r) => fakeServer?.close(r) ?? r());
});

beforeEach(() => {
  resetEmployees();
  fake.requests = [];
  fake.down = false;
});

describe("sign-in checks the employee with StaffPay", () => {
  test("an employed cashier signs in, and the check is logged without the employee's name", async () => {
    const res = await signIn("cashier01");
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/\/dashboard$/);
    const log = await ctx.models.IntegrationLog.findOne({ where: { systemName: "HR", referenceId: "EMP-0231" }, order: [["id", "DESC"]] });
    expect(log).toMatchObject({ operation: "getEmployee", status: "SUCCESS", isMock: false, httpStatus: 200 });
    expect(JSON.stringify(log.responsePayload)).not.toContain("Cashier One");
  });

  test("a cashier terminated in StaffPay can no longer sign in", async () => {
    fake.employees.get("EMP231").employment_status = "terminated";
    fake.employees.get("EMP231").active = false;
    const res = await signIn("cashier01");
    expect(res.status).toBe(403);
    expect(res.text).toContain("HR reports that this employee is not active");
    expect((await lastAudit("LOGIN_BLOCKED")).newValues).toMatchObject({ reason: "HR employee not active" });
  });

  test("an employee StaffPay does not know cannot sign in", async () => {
    fake.employees.delete("EMP310");
    const res = await signIn("staff01");
    expect(res.status).toBe(403);
    expect(res.text).toContain("HR reports that this employee is not active");
  });

  test("when StaffPay is unreachable, sign-in still works and the outage is audited", async () => {
    fake.down = true;
    const res = await signIn("cashier01");
    expect(res.location).toMatch(/\/dashboard$/);
    expect((await lastAudit("HR_CHECK_UNAVAILABLE")).newValues.error).toContain("Maintenance");
  });
});
