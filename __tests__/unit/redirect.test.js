import { mask } from "../../integrations/integrationLogger.js";
import { safeNext } from "../../controllers/authController.js";
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

describe("integration log masking", () => {
  test("hides secrets at any depth", () => {
    const masked = mask({ apiKey: "x", nested: { Authorization: "Bearer y", amount: "850.00" }, list: [{ token: "z" }] });
    expect(masked).toEqual({ apiKey: "***", nested: { Authorization: "***", amount: "850.00" }, list: [{ token: "***" }] });
  });
});
