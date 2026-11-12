import { mask } from "../../integrations/integrationLogger.js";
import { resolveUrl } from "../../integrations/httpClient.js";
import { AppError } from "../../utils/http.js";

describe("integration log masking", () => {
  test("hides personal data returned by the PMS and HR", () => {
    const masked = mask({ guest: { id: "G-1", displayName: "J. Tan", email: "j@x.test" }, employee: { fullName: "Ana Cruz", position: "Cashier" } });
    expect(masked).toEqual({ guest: { id: "G-1", displayName: "***", email: "***" }, employee: { fullName: "***", position: "Cashier" } });
  });

  test("never writes structures deeper than the limit unmasked", () => {
    const deep = { a: { b: { c: { d: { e: { f: { token: "secret", g: { h: 1 } } } } } } } };
    expect(JSON.stringify(mask(deep))).not.toContain("secret");
    expect(JSON.stringify(mask(deep))).toContain("[truncated]");
  });
});

describe("HTTP adapter URLs", () => {
  test("a base URL path is kept with or without a trailing slash", () => {
    expect(resolveUrl("https://pms.example/api/v1", "rooms/205/active-folio").href).toBe("https://pms.example/api/v1/rooms/205/active-folio");
    expect(resolveUrl("https://pms.example/api/v1/", "/rooms/205").href).toBe("https://pms.example/api/v1/rooms/205");
  });
});

describe("error codes", () => {
  test("every AppError has a code: specific when given, otherwise the code for its status", () => {
    expect(new AppError("x", 409, "ALREADY_PAID").code).toBe("ALREADY_PAID");
    expect(new AppError("x", 409).code).toBe("CONFLICT");
    expect(new AppError("x", 422).code).toBe("VALIDATION_ERROR");
    expect(new AppError("x", 404).code).toBe("NOT_FOUND");
    expect(new AppError("x").code).toBe("BAD_REQUEST");
  });
});
