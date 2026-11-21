import { mask } from "../../integrations/integrationLogger.js";
import { safeNext } from "../../controllers/authController.js";
import { csvCell } from "../../controllers/reportController.js";
import { backUrl } from "../../utils/http.js";
import { sequelize } from "../../models/index.js";

afterAll(() => sequelize.close());

describe("login redirect guard", () => {
  test.each([
    ["/orders?status=OPEN", "/orders?status=OPEN"],
    ["//evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["https://evil.example", "/dashboard"],
    [undefined, "/dashboard"],
  ])("%s -> %s", (input, expected) => expect(safeNext(input)).toBe(expected));
});

describe("redirect back to the referring page", () => {
  const req = (referer) => ({ get: (h) => (h === "host" ? "pos.example" : referer) });
  test.each([
    ["http://pos.example/orders?page=2", "/orders?page=2"],
    ["http://pos.example//evil.example/x", "/dashboard"],
    ["http://evil.example/orders", "/dashboard"],
    [undefined, "/dashboard"],
  ])("%s -> %s", (referer, expected) => expect(backUrl(req(referer))).toBe(expected));
});

describe("CSV export cells", () => {
  test.each([
    ["=HYPERLINK(\"http://x\")", "\"'=HYPERLINK(\"\"http://x\"\")\""],
    ["+SUM(A1)", "'+SUM(A1)"],
    ["@cmd", "'@cmd"],
    ["-12.50", "-12.50"],
    ["Club Sandwich", "Club Sandwich"],
    [null, ""],
  ])("%s -> %s", (input, expected) => expect(csvCell(input)).toBe(expected));
});

describe("integration log masking", () => {
  test("hides secrets at any depth", () => {
    const masked = mask({ apiKey: "x", nested: { Authorization: "Bearer y", amount: "850.00" }, list: [{ token: "z" }] });
    expect(masked).toEqual({ apiKey: "***", nested: { Authorization: "***", amount: "850.00" }, list: [{ token: "***" }] });
  });
});
