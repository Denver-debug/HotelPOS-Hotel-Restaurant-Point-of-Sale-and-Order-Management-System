import { buildPagination } from "../../utils/pagination.js";
import { fullPath } from "../../utils/http.js";
import { buildNavigation } from "../../config/navigation.js";

describe("links inside mounted routers", () => {
  test("fullPath keeps the router mount prefix", () => {
    expect(fullPath({ baseUrl: "/orders", path: "/" })).toBe("/orders");
    expect(fullPath({ baseUrl: "/inventory", path: "/movements" })).toBe("/inventory/movements");
    expect(fullPath({ baseUrl: "", path: "/" })).toBe("/");
    expect(fullPath({ baseUrl: "/reports", path: "/sales/" })).toBe("/reports/sales");
  });

  test("pagination links stay on the list page and keep the filters", () => {
    const p = buildPagination({ baseUrl: "/orders", path: "/", query: { status: "OPEN", page: "1" } }, 45, { page: 1, limit: 20 });
    expect(p.nextUrl).toBe("/orders?status=OPEN&page=2");
    expect(p.numbers.map((n) => n.url)).toContain("/orders?status=OPEN&page=3");
    const nested = buildPagination({ baseUrl: "/inventory", path: "/movements", query: {} }, 30, { page: 2, limit: 20 });
    expect(nested.prevUrl).toBe("/inventory/movements?page=1");
  });
});

describe("sidebar", () => {
  const labels = (perms) => buildNavigation(new Set(perms), "/").flatMap((g) => g.items.map((i) => i.label));

  test("shows a page to anyone holding one of the permissions its route accepts", () => {
    expect(labels(["refunds.approve"])).toContain("Refunds & Voids");
    expect(labels(["products.manage"])).toContain("Products & Services");
    expect(labels(["shifts.manage"])).toContain("Cashier Shifts");
  });

  test("hides pages the user cannot open", () => {
    expect(labels(["dashboard.view"])).toEqual(["Dashboard"]);
  });
});
