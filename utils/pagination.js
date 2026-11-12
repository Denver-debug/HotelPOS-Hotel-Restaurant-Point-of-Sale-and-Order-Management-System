// Pagination helpers shared by list pages and the pagination partial.
import { fullPath } from "./http.js";

export const parsePage = (query, defaultLimit = 20) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(5, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
};

export const buildPagination = (req, total, { page, limit }) => {
  const pages = Math.max(1, Math.ceil(total / limit));
  const link = (p) => {
    const params = new URLSearchParams(req.query);
    params.set("page", p);
    return `${fullPath(req)}?${params.toString()}`;
  };
  const start = Math.max(1, page - 2);
  const end = Math.min(pages, start + 4);
  const numbers = [];
  for (let p = start; p <= end; p++) numbers.push({ page: p, url: link(p), active: p === page });
  return {
    total,
    page,
    pages,
    from: total === 0 ? 0 : (page - 1) * limit + 1,
    to: Math.min(total, page * limit),
    prevUrl: page > 1 ? link(page - 1) : null,
    nextUrl: page < pages ? link(page + 1) : null,
    numbers,
  };
};

// Echo the current filter values back to the view.
export const filtersFrom = (query, keys) => Object.fromEntries(keys.map((k) => [k, query[k] ?? ""]));
