import { priceOrder, allocate } from "../../services/pricingService.js";
import { canTransition, assertTransition } from "../../services/orderStateMachine.js";

const vat = { taxRate: "0.1200", taxInclusive: true };

describe("pricingService.priceOrder", () => {
  test("TC-02: Club Sandwich 520 + 2 x Iced Tea 165 = 850.00 VAT-inclusive (Figure 5)", () => {
    const result = priceOrder(
      [
        { key: 1, unitPrice: "520.00", quantity: "1", ...vat },
        { key: 2, unitPrice: "165.00", quantity: "2", ...vat },
      ],
      null,
      "0.00"
    );
    expect(result.subtotal).toBe("850.00");
    expect(result.totalAmount).toBe("850.00");
    expect(result.serviceChargeAmount).toBe("0.00");
    // VAT is extracted from the inclusive price, not added on top.
    expect(result.taxAmount).toBe("91.07");
    expect(result.lines[1].grossAmount).toBe("330.00");
  });

  test("applies the outlet service charge on the VAT-exclusive net amount", () => {
    const result = priceOrder([{ key: 1, unitPrice: "1120.00", quantity: "1", ...vat }], null, "10.00");
    expect(result.taxAmount).toBe("120.00");
    expect(result.serviceChargeAmount).toBe("100.00");
    expect(result.totalAmount).toBe("1220.00");
  });

  test("adds exclusive taxes on top of the price", () => {
    const result = priceOrder([{ key: 1, unitPrice: "100.00", quantity: "3", taxRate: "0.0500", taxInclusive: false }]);
    expect(result.taxAmount).toBe("15.00");
    expect(result.totalAmount).toBe("315.00");
  });

  test("order-level percentage discount is allocated across lines and sums exactly", () => {
    const result = priceOrder(
      [
        { key: 1, unitPrice: "520.00", quantity: "1", ...vat },
        { key: 2, unitPrice: "165.00", quantity: "2", ...vat },
      ],
      { type: "PERCENTAGE", value: "10" }
    );
    expect(result.orderDiscountAmount).toBe("85.00");
    expect(result.discountAmount).toBe("85.00");
    expect(result.totalAmount).toBe("765.00");
    const shares = result.lines.map((l) => Number(l.orderDiscountShare));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(85, 5);
  });

  test("item-level fixed discount never exceeds the line amount", () => {
    const result = priceOrder([{ key: 1, unitPrice: "40.00", quantity: "1", ...vat, discount: { type: "FIXED", value: "50.00" } }]);
    expect(result.lines[0].discountAmount).toBe("40.00");
    expect(result.totalAmount).toBe("0.00");
  });

  test("fractional quantities are priced exactly", () => {
    const result = priceOrder([{ key: 1, unitPrice: "99.99", quantity: "1.5", ...vat }]);
    expect(result.subtotal).toBe("149.99");
  });

  test("allocate distributes remainders without losing centavos", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
  });
});

describe("order state machine (Figure 13)", () => {
  test("allows the documented transitions", () => {
    expect(canTransition("OPEN", "IN_PROGRESS")).toBe(true);
    expect(canTransition("IN_PROGRESS", "AWAITING_SETTLEMENT")).toBe(true);
    expect(canTransition("AWAITING_SETTLEMENT", "SETTLING")).toBe(true);
    expect(canTransition("SETTLING", "CHARGE_FAILED")).toBe(true);
    expect(canTransition("CHARGE_FAILED", "SETTLING")).toBe(true);
    expect(canTransition("SETTLING", "COMPLETED")).toBe(true);
    expect(canTransition("COMPLETED", "REFUNDED")).toBe(true);
  });

  test("blocks invalid transitions", () => {
    expect(canTransition("COMPLETED", "VOIDED")).toBe(false);
    expect(canTransition("VOIDED", "OPEN")).toBe(false);
    expect(canTransition("SETTLING", "VOIDED")).toBe(false);
    expect(() => assertTransition("REFUNDED", "COMPLETED")).toThrow(/cannot become/);
  });
});
