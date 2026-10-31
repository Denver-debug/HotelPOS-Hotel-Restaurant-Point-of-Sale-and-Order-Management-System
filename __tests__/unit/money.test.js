import { toCents, fromCents, toMilli, fromMilli, formatMoney, formatQty } from "../../utils/money.js";

describe("money utilities", () => {
  test("parses decimal strings into exact cents", () => {
    expect(toCents("850")).toBe(85000);
    expect(toCents("520.00")).toBe(52000);
    expect(toCents("0.1")).toBe(10);
    expect(toCents("1,234.56")).toBe(123456);
    expect(toCents("-12.34")).toBe(-1234);
  });

  test("rounds half up on the third decimal", () => {
    expect(toCents("1.005")).toBe(101);
    expect(toCents("1.004")).toBe(100);
  });

  test("rejects invalid input", () => {
    expect(toCents("abc")).toBeNull();
    expect(toCents("")).toBeNull();
    expect(toCents(null)).toBeNull();
  });

  test("handles numbers without float artefacts", () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(fromCents(toCents(0.1 + 0.2))).toBe("0.30");
  });

  test("formats cents back to fixed two decimals", () => {
    expect(fromCents(85000)).toBe("850.00");
    expect(fromCents(-5)).toBe("-0.05");
  });

  test("quantities keep three decimals", () => {
    expect(toMilli("2")).toBe(2000);
    expect(fromMilli(1250)).toBe("1.250");
    expect(formatQty("2.000")).toBe("2");
    expect(formatQty("1.250")).toBe("1.25");
  });

  test("formats currency with grouping", () => {
    expect(formatMoney("1234567.5", "₱")).toBe("₱1,234,567.50");
    expect(formatMoney("850", "₱")).toBe("₱850.00");
    expect(formatMoney("-20", "₱")).toBe("-₱20.00");
  });
});
