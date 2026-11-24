// StaffPayHrAdapter against a fake StaffPay (docs/STAFFPAY-API.md). No database needed;
// sign-in with StaffPay end to end is in __tests__/integration/staffpay.test.js.
import http from "http";
import { StaffPayHrAdapter } from "../../integrations/hr/staffpayHrAdapter.js";

const API_KEY = "staffpay-key-for-tests-0123456789";
const fake = { requests: [], employees: new Map(), reply: null };
let server;
let adapter;

const employee = (code, status, extra = {}) => ({ employee_code: code, full_name: "Ana Cruz", employment_status: status, position: "Cashier", department: "Food & Beverage", ...extra });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    fake.requests.push({ method: req.method, path: req.url, headers: req.headers });
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (fake.reply) return send(...fake.reply);
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { success: false, error: { code: "INVALID_API_KEY", message: "Invalid API key." } });
    const emp = fake.employees.get(decodeURIComponent(req.url.replace("/api/v1/employees/", "")));
    emp ? send(200, { success: true, data: emp }) : send(404, { success: false, error: { code: "EMPLOYEE_NOT_FOUND", message: "Not found." } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  adapter = new StaffPayHrAdapter({ baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, apiKey: API_KEY, timeoutMs: 2000 });
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  fake.requests = [];
  fake.reply = null;
  fake.employees = new Map([["EMP-0231", { ...employee("EMP231", "active"), active: true }]]);
});

describe("StaffPay HR adapter", () => {
  test("asks StaffPay for the employee with the API key and maps its answer", async () => {
    const emp = await adapter.getEmployee("EMP-0231");
    expect(emp).toMatchObject({ found: true, employeeId: "EMP-0231", hrEmployeeCode: "EMP231", fullName: "Ana Cruz", active: true, employmentStatus: "active", position: "Cashier", department: "Food & Beverage" });
    expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/employees/EMP-0231" });
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("without an active flag, probationary and on-leave staff count as employed; resigned and terminated do not", async () => {
    const cases = { active: true, probationary: true, on_leave: true, resigned: false, terminated: false };
    for (const [status, active] of Object.entries(cases)) {
      fake.employees.set("EMP-0310", employee("EMP310", status));
      expect(await adapter.getEmployee("EMP-0310")).toMatchObject({ found: true, active, employmentStatus: status });
    }
  });

  test("StaffPay's own active flag wins over the status", async () => {
    fake.employees.set("EMP-0310", employee("EMP310", "on_leave", { active: false }));
    expect((await adapter.getEmployee("EMP-0310")).active).toBe(false);
  });

  test("a bare object without the success envelope is accepted", async () => {
    fake.reply = [200, employee("EMP231", "active")];
    expect(await adapter.getEmployee("EMP-0231")).toMatchObject({ found: true, active: true, hrEmployeeCode: "EMP231" });
  });

  test("an unknown code is not found", async () => {
    expect(await adapter.getEmployee("EMP-4040")).toMatchObject({ found: false, active: false });
  });

  test("a wrong key, an outage, a login page or an empty answer is an integration error", async () => {
    const badKey = new StaffPayHrAdapter({ ...adapter.cfg, apiKey: "wrong" });
    await expect(badKey.getEmployee("EMP-0231")).rejects.toMatchObject({ kind: "REJECTED", message: expect.stringContaining("HR_API_KEY") });
    fake.reply = [503, { success: false, error: { code: "UNAVAILABLE", message: "Maintenance." } }];
    await expect(adapter.getEmployee("EMP-0231")).rejects.toMatchObject({ kind: "REJECTED", message: "Maintenance. (UNAVAILABLE)" });
    // The endpoint is missing and StaffPay serves its HTML login page instead.
    fake.reply = [200, "<!doctype html><title>Login</title>"];
    await expect(adapter.getEmployee("EMP-0231")).rejects.toMatchObject({ kind: "INVALID_RESPONSE" });
    fake.reply = [200, { success: true, data: {} }];
    await expect(adapter.getEmployee("EMP-0231")).rejects.toMatchObject({ kind: "INVALID_RESPONSE" });
  });
});
