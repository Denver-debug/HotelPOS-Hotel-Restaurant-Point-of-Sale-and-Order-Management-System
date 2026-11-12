// POS terminal. The server is authoritative for prices, totals, stock and state;
// this script only renders what the API returns and sends user intents.
// Keyboard shortcuts are declared in registerShortcuts() and dispatched/rendered by
// public/js/pos-shortcuts.js. The F1 overlay lists every one of them.
(function () {
  "use strict";

  const boot = JSON.parse(document.getElementById("pos-boot").textContent);
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (v) =>
    boot.currency + Number(v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = (v) => String(Number(v));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const humanize = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const roundQty = (n) => Math.round(n * 1000) / 1000;

  const DEFAULT_TYPE = { ROOM_SERVICE: "ROOM_SERVICE", MINIBAR: "MINIBAR", SPA: "SPA", RESTAURANT: "DINE_IN", BAR: "DINE_IN" };
  const STATUS_COLORS = {
    OPEN: "badge-blue", IN_PROGRESS: "badge-blue", AWAITING_SETTLEMENT: "badge-amber", SETTLING: "badge-amber",
    CHARGE_FAILED: "badge-red", COMPLETED: "badge-green", VOIDED: "badge-red", REFUNDED: "badge-red", PARTIALLY_REFUNDED: "badge-amber",
  };
  const SETTLEABLE = ["IN_PROGRESS", "AWAITING_SETTLEMENT", "CHARGE_FAILED"];
  const VOIDABLE = ["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "CHARGE_FAILED"];
  const FINISHED = ["COMPLETED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"];
  const CATALOG_MAX_AGE_MS = 2 * 60 * 1000;

  const S = {
    order: null,
    category: "all",
    search: "",
    busy: false,
    selectedItemId: null,
    pay: { methodId: null, key: null },
    room: { token: null, key: null, chargeId: null },
    note: { itemId: null },
    qty: { itemId: null },
    discounts: [],
    openOrders: [],
    lastReceiptUrl: null,
    catalogAt: Date.now(),
    online: navigator.onLine,
    blocked: null, // "session" | "stale" when the server can no longer be used from this page
    returnFocus: null,
  };

  let api, toast, keys;

  // ── Request queue ────────────────────────────────────────────────────────
  // Order-line changes run one after another, in the order they were made, so rapid taps
  // and barcode-scanner bursts are never dropped. Dialog actions wait for the queue first.
  let queue = Promise.resolve();
  let pending = 0;
  const setWorking = () => document.body.classList.toggle("cursor-progress", pending > 0 || S.busy);

  function enqueue(fn) {
    if (S.blocked) return Promise.resolve();
    pending++;
    setWorking();
    const job = queue
      .then(fn)
      .catch(handleError)
      .finally(() => {
        pending--;
        setWorking();
      });
    queue = job;
    return job;
  }

  async function run(fn) {
    if (S.busy || S.blocked) return;
    S.busy = true;
    setWorking();
    try {
      await queue;
      return await fn();
    } catch (err) {
      handleError(err);
    } finally {
      S.busy = false;
      setWorking();
    }
  }

  function handleError(err) {
    if (err?.body?.order) setOrder(err.body.order);
    if (handleSessionErrors(err)) return;
    if (err?.body?.code === "UNAVAILABLE") refreshCatalog();
    toast(err?.message || "Something went wrong.", "error");
  }

  // ── Banner: session expired, stale page, offline ─────────────────────────
  function banner(kind, html) {
    const el = $("#pos-banner");
    if (!kind) {
      el.classList.add("hidden");
      el.classList.remove("flex");
      return;
    }
    const tone = kind === "offline" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-rose-200 bg-rose-50 text-rose-900";
    el.className = `flex items-center gap-3 border-b px-4 py-2 text-sm ${tone}`;
    el.innerHTML = html;
  }

  const resumeUrl = () => {
    const url = new URL("/pos/terminal", location.origin);
    url.searchParams.set("outletId", boot.outlet.id);
    if (S.order && !FINISHED.includes(S.order.status)) url.searchParams.set("orderId", S.order.id);
    return url.pathname + url.search;
  };

  // Returns true when the error means this page can't talk to the server any more.
  function handleSessionErrors(err) {
    if (err?.status === 401 || err?.body?.code === "UNAUTHENTICATED") {
      S.blocked = "session";
      banner("session", `<span class="flex-1">Your session has expired. Sign in again to continue${S.order ? ` with order ${esc(S.order.orderNumber)}` : ""}.</span>
        <a class="btn btn-primary btn-sm h-9" href="/login?next=${encodeURIComponent(resumeUrl())}">Sign in</a>`);
      renderOrder();
      return true;
    }
    if (err?.status === 403 && err?.body?.code === "CSRF") {
      S.blocked = "stale";
      banner("stale", `<span class="flex-1">This page is out of date. Reload it to continue; the order is saved.</span>
        <button type="button" class="btn btn-primary btn-sm h-9" data-action="reload">Reload</button>`);
      renderOrder();
      return true;
    }
    if (err && !err.status && !navigator.onLine) {
      setOnline(false);
      return true;
    }
    return false;
  }

  function setOnline(online) {
    S.online = online;
    if (S.blocked) return;
    if (online) banner(null);
    else banner("offline", '<span class="flex-1"><strong>Offline.</strong> Changes cannot be saved and payments are disabled until the connection returns.</span>');
    renderOrder();
  }

  // ── Dialogs ──────────────────────────────────────────────────────────────
  const openModalEl = () => document.querySelector(".pos-modal.flex");
  const visible = (el) => el && !el.closest(".hidden") && el.getClientRects().length > 0;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function openModal(id, { focus } = {}) {
    const m = document.getElementById(id);
    if (!openModalEl()) S.returnFocus = document.activeElement;
    m.classList.remove("hidden");
    m.classList.add("flex");
    keys.renderHints(m);
    setTimeout(() => {
      const target =
        (focus && m.querySelector(focus)) ||
        [...m.querySelectorAll("[data-autofocus]")].find(visible) ||
        [...m.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([disabled]), select, textarea")].find(visible) ||
        [...m.querySelectorAll("[data-primary]")].find(visible);
      target?.focus();
      if (target?.select && target.tagName === "INPUT") target.select();
    }, 30);
  }

  function closeModal(el) {
    const m = typeof el === "string" ? document.getElementById(el) : el.closest(".pos-modal");
    if (!m || m.classList.contains("hidden")) return;
    m.classList.add("hidden");
    m.classList.remove("flex");
    if (!openModalEl()) {
      const back = S.returnFocus;
      S.returnFocus = null;
      if (back && document.contains(back) && !back.disabled && visible(back)) back.focus();
      else $("#pos-search").focus();
    }
  }

  function showError(id, message) {
    const el = document.getElementById(id);
    if (!message) return el.classList.add("hidden");
    el.textContent = message;
    el.classList.remove("hidden");
  }

  // Button label lives in a [data-label] span so the key badge next to it survives.
  function label(btn, html) {
    const slot = btn.querySelector("[data-label]");
    if (slot) slot.innerHTML = html;
    else btn.innerHTML = html;
  }
  const spinner = (text) => `<span class="spinner"></span> ${text}`;

  // Enter in a dialog = its visible, enabled [data-primary] button.
  function clickPrimary(e) {
    const m = openModalEl();
    if (!m) return false;
    const active = document.activeElement;
    if (active && m.contains(active) && (active.tagName === "BUTTON" || active.tagName === "A")) return false; // native activation
    const btn = [...m.querySelectorAll("[data-primary]")].find((b) => visible(b) && !b.disabled);
    if (!btn) return false;
    e.preventDefault();
    btn.click();
    return true;
  }

  function trapFocus(e) {
    const m = openModalEl();
    if (!m || e.key !== "Tab") return;
    const items = [...m.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  }

  // ── State helpers ────────────────────────────────────────────────────────
  const hasOrder = () => Boolean(S.order);
  const editable = () => Boolean(S.order && S.order.editable);
  const canWrite = () => S.online && !S.blocked;
  const settleable = () => S.order && SETTLEABLE.includes(S.order.status) && S.order.items.length > 0;
  const paidSomething = () => Boolean(S.order && Number(S.order.amountPaid) > 0);
  const selectedItem = () => S.order?.items.find((i) => String(i.id) === String(S.selectedItemId)) || null;
  const shiftProblem = () => {
    if (!boot.requireShift) return null;
    if (!boot.shift) return "Open a cashier shift before taking payments.";
    if (boot.shift.outletId !== boot.outlet.id) return "Your open shift belongs to another outlet.";
    return null;
  };

  const can = {
    pay: () => canWrite() && settleable() && boot.can.settle && !(paidSomething() && S.order.settlementType === "ROOM_CHARGE"),
    room: () => canWrite() && settleable() && boot.can.roomCharge && boot.outlet.allowsRoomCharge && !paidSomething(),
    void: () => canWrite() && hasOrder() && VOIDABLE.includes(S.order.status) && !paidSomething(),
    discount: () => canWrite() && editable() && S.order.items.length > 0 && boot.can.discount,
    note: () => canWrite() && editable(),
    line: () => canWrite() && editable() && Boolean(selectedItem()),
  };

  // ── Catalog ──────────────────────────────────────────────────────────────
  function rebuildCategories() {
    const seen = new Map();
    for (const p of boot.catalog) if (!seen.has(p.categoryId)) seen.set(p.categoryId, { id: p.categoryId, name: p.categoryName });
    boot.categories = [...seen.values()];
    if (S.category !== "all" && !boot.categories.some((c) => String(c.id) === S.category)) S.category = "all";
  }

  async function refreshCatalog() {
    try {
      const res = await api("GET", `/api/pos/catalog?outletId=${boot.outlet.id}`);
      boot.catalog = res.catalog;
      S.catalogAt = Date.now();
      rebuildCategories();
      renderCategories();
      renderProducts();
    } catch (err) {
      handleSessionErrors(err);
    }
  }

  const chipList = () => [{ id: "all", name: "All" }, ...boot.categories];

  function renderCategories() {
    $("#pos-categories").innerHTML = chipList()
      .map((c, i) => {
        const active = S.category === String(c.id);
        const badge = i <= 9 ? keys.hint(`cat-${i}`, { extra: "ml-1.5" }) : "";
        return `<button type="button" role="tab" aria-selected="${active}" aria-controls="pos-products" tabindex="${active ? 0 : -1}" data-category="${c.id}"
            class="inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition ${
              active ? "bg-brand-800 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }">${esc(c.name)}${badge}</button>`;
      })
      .join("");
  }

  function selectCategory(id, { focus = false } = {}) {
    S.category = String(id);
    renderCategories();
    renderProducts();
    if (focus) document.querySelector(`[data-category="${CSS.escape(S.category)}"]`)?.focus();
  }

  // "3*COF" → { qty: "3", term: "cof" }. The multiplier applies to the next product added.
  function parseSearch() {
    const m = /^\s*(\d{1,4}(?:\.\d{1,3})?)\s*\*\s*(.*)$/.exec(S.search);
    if (m && Number(m[1]) > 0) return { qty: m[1], term: m[2].trim().toLowerCase() };
    return { qty: null, term: S.search.trim().toLowerCase() };
  }

  function filteredProducts() {
    const { term } = parseSearch();
    return boot.catalog.filter(
      (p) =>
        (S.category === "all" || String(p.categoryId) === S.category) &&
        (!term || p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term))
    );
  }

  function renderProducts() {
    const list = filteredProducts();
    $("#pos-products-empty").classList.toggle("hidden", list.length > 0);
    $("#pos-products").innerHTML = list
      .map((p) => {
        const media = p.imagePath
          ? `<img src="${esc(p.imagePath)}" alt="" class="h-24 w-full rounded-lg object-cover">`
          : `<div class="flex h-24 w-full items-center justify-center rounded-lg bg-gradient-to-br from-brand-50 to-accent-50 text-2xl font-semibold text-brand-700" aria-hidden="true">${esc(
              p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")
            )}</div>`;
        return `<button type="button" data-product="${p.id}" aria-label="${esc(p.name)}, ${esc(fmt(p.price))}" class="group flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2 text-left shadow-sm transition hover:border-brand-300 hover:shadow-md focus:outline-none active:scale-[0.98]">
          ${media}
          <span class="line-clamp-2 min-h-[2.5rem] px-1 text-sm font-medium text-slate-900">${esc(p.name)}</span>
          <span class="flex items-center justify-between px-1 pb-1"><span class="text-sm font-semibold text-brand-800">${fmt(p.price)}</span><span class="font-mono text-[10px] uppercase text-slate-400">${esc(p.code)}</span></span>
        </button>`;
      })
      .join("");
  }

  // Arrow-key movement inside the product grid (columns are measured, so it follows the layout).
  function moveInGrid(tile, key) {
    const tiles = $$("#pos-products [data-product]");
    const i = tiles.indexOf(tile);
    if (i < 0) return;
    const top = tiles[0].offsetTop;
    const cols = Math.max(1, tiles.filter((t) => t.offsetTop === top).length);
    const target = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[key];
    if (target === undefined) return;
    if (target < 0) return $("#pos-search").focus();
    tiles[Math.min(target, tiles.length - 1)].focus();
  }

  // ── Order ────────────────────────────────────────────────────────────────
  function setOrder(order) {
    S.order = order;
    if (order) {
      if (!selectedItem()) S.selectedItemId = order.items.length ? order.items[order.items.length - 1].id : null;
    } else {
      S.selectedItemId = null;
    }
    // Keep the URL pointing at the open order, so a reload or crash reopens it.
    try {
      history.replaceState(null, "", resumeUrl());
    } catch {
      /* ignore */
    }
    renderOrder();
  }

  function renderOrder() {
    const o = S.order;
    $("#order-number").textContent = o ? o.orderNumber : "New order";
    $("#order-status").innerHTML = o ? `<span class="badge ${STATUS_COLORS[o.status] || "badge-slate"}">${esc(humanize(o.status))}</span>` : "";
    $("#order-type").value = o ? o.orderType : $("#order-type").value;
    $("#order-location").value = o ? o.tableOrLocation || "" : $("#order-location").value;
    $("#order-type").disabled = Boolean(o && !o.editable);
    $("#order-location").disabled = Boolean(o && !o.editable);

    const items = o ? o.items : [];
    const locked = Boolean(o) && !o.editable;
    const lineHints = `<p class="pos-hint mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">${keys.hint("line-inc")}${keys.hint("line-dec")} qty · ${keys.hint(
      "line-qty"
    )} set · ${keys.hint("line-remove")} remove · ${keys.hint("line-note")} note</p>`;
    $("#order-items").innerHTML = items.length
      ? items
          .map((i) => {
            const discount = o.discounts.find((d) => String(d.orderItemId) === String(i.id));
            const selected = String(i.id) === String(S.selectedItemId);
            return `<div role="listitem" class="rounded-lg px-2 py-2 hover:bg-slate-50 ${selected ? "pos-line-selected" : ""}" data-item="${i.id}" ${selected ? 'aria-current="true"' : ""}>
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-slate-900">${esc(i.productName)}</p>
                  <p class="text-xs text-slate-500">${fmt(i.unitPrice)} × ${qtyFmt(i.quantity)} ${esc(i.unit)}</p>
                  ${i.notes ? `<p class="mt-0.5 text-xs italic text-accent-700">“${esc(i.notes)}”</p>` : ""}
                  ${discount ? `<p class="mt-0.5 text-xs text-emerald-700">${esc(discount.code)} −${fmt(discount.amount)}</p>` : ""}
                </div>
                <p class="text-sm font-semibold text-slate-900">${fmt(i.lineTotal)}</p>
              </div>
              <div class="mt-2 flex items-center gap-1 ${locked ? "hidden" : ""}">
                <button type="button" class="btn btn-secondary h-10 w-10 p-0 text-lg" data-qty="-1" aria-label="Decrease quantity">−</button>
                <button type="button" class="btn btn-ghost h-10 min-w-[2.75rem] px-2 text-sm font-semibold" data-qty-set aria-label="Set quantity, currently ${qtyFmt(i.quantity)}">${qtyFmt(i.quantity)}</button>
                <button type="button" class="btn btn-secondary h-10 w-10 p-0 text-lg" data-qty="1" aria-label="Increase quantity">+</button>
                <button type="button" class="btn btn-ghost ml-auto h-10 px-3 text-xs" data-item-note>Note</button>
                <button type="button" class="btn btn-ghost h-10 px-3 text-xs text-rose-600" data-item-remove aria-label="Remove ${esc(i.productName)}">Remove</button>
              </div>
              ${selected && !locked ? lineHints : ""}
            </div>`;
          })
          .join("")
      : `<div class="flex h-full flex-col items-center justify-center py-12 text-center text-sm text-slate-400">
           <p>Tap a product, or search and press <kbd class="kbd">Enter</kbd>, to start an order.</p></div>`;
    $("#order-items [aria-current]")?.scrollIntoView({ block: "nearest" });

    $("#t-subtotal").textContent = fmt(o?.subtotal);
    $("#t-discount").textContent = o && Number(o.discountAmount) > 0 ? `−${fmt(o.discountAmount)}` : fmt(0);
    $("#t-tax").textContent = fmt(o?.taxAmount);
    $("#t-service").textContent = fmt(o?.serviceChargeAmount);
    $("#t-sc-rate").textContent = o && Number(o.serviceChargeRate) > 0 ? `(${Number(o.serviceChargeRate)}%)` : "";
    $("#t-total").textContent = fmt(o?.totalAmount);
    const paid = paidSomething();
    $("#t-paid-row").classList.toggle("hidden", !paid);
    $("#t-paid-row").classList.toggle("flex", paid);
    $("#t-balance-row").classList.toggle("hidden", !paid);
    $("#t-balance-row").classList.toggle("flex", paid);
    $("#t-paid").textContent = fmt(o?.amountPaid);
    $("#t-balance").textContent = fmt(o?.balanceDue);

    const orderDiscounts = o ? o.discounts.filter((d) => !d.orderItemId) : [];
    $("#order-discounts").innerHTML = orderDiscounts
      .map(
        (d) => `<div class="flex items-center justify-between rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          <span>${esc(d.code)} · ${esc(d.name)}</span>
          <span class="flex items-center gap-2">−${fmt(d.amount)}${
            o.editable
              ? `<button type="button" class="inline-flex h-9 w-9 items-center justify-center rounded text-emerald-700 hover:bg-emerald-100 hover:text-rose-600" data-discount-remove="${d.id}" aria-label="Remove discount ${esc(d.code)}" title="Remove discount">✕</button>`
              : ""
          }</span></div>`
      )
      .join("");

    // Mobile bar summary.
    const count = items.reduce((n, i) => n + Number(i.quantity), 0);
    $("#mb-count").textContent = `(${roundQty(count)})`;
    $("#mb-total").textContent = fmt(o?.totalAmount);

    $$('[data-action="pay"]').forEach((b) => (b.disabled = !can.pay()));
    $$('[data-action="room-charge"]').forEach((b) => (b.disabled = !can.room()));
    $$('[data-action="void"]').forEach((b) => (b.disabled = !can.void()));
    $$('[data-action="discount"]').forEach((b) => (b.disabled = !can.discount()));
    $$('[data-action="order-note"]').forEach((b) => (b.disabled = !can.note()));

    const problem = shiftProblem();
    const warn = $("#pos-shift-warning");
    warn.textContent = problem || "";
    warn.classList.toggle("hidden", !problem || !boot.can.settle);
  }

  function selectLine(delta) {
    const items = S.order?.items || [];
    if (!items.length) return;
    const i = items.findIndex((x) => String(x.id) === String(S.selectedItemId));
    const next = i < 0 ? items.length - 1 : Math.min(items.length - 1, Math.max(0, i + delta));
    S.selectedItemId = items[next].id;
    renderOrder();
    showView("order", { onlyIfMobile: true });
  }

  function addProduct(productId, quantity) {
    const multiplier = parseSearch().qty;
    const qty = quantity || multiplier || "1";
    if (multiplier && !quantity) {
      $("#pos-search").value = "";
      S.search = "";
      renderProducts();
    }
    return enqueue(async () => {
      if (S.order && !S.order.editable) {
        toast(`Order ${S.order.orderNumber} is ${humanize(S.order.status).toLowerCase()}. Starting a new order.`, "info");
        setOrder(null);
      }
      const res = S.order
        ? await api("POST", `/api/orders/${S.order.id}/items`, { productId, quantity: qty })
        : await api("POST", "/api/orders", {
            outletId: boot.outlet.id,
            orderType: $("#order-type").value,
            tableOrLocation: $("#order-location").value,
            productId,
            quantity: qty,
          });
      const line =
        res.order.items.find((i) => String(i.productId) === String(productId) && !i.notes) ||
        [...res.order.items].reverse().find((i) => String(i.productId) === String(productId));
      if (line) S.selectedItemId = line.id;
      setOrder(res.order);
    });
  }

  function changeQty(itemId, delta) {
    return enqueue(async () => {
      const item = S.order?.items.find((i) => String(i.id) === String(itemId));
      if (!item) return;
      S.selectedItemId = item.id;
      const next = Math.max(0, roundQty(Number(item.quantity) + delta));
      setOrder((await api("PATCH", `/api/orders/${S.order.id}/items/${itemId}`, { quantity: String(next) })).order);
    });
  }

  function removeItem(itemId) {
    return enqueue(async () => {
      if (!S.order) return;
      const items = S.order.items;
      const i = items.findIndex((x) => String(x.id) === String(itemId));
      const neighbour = items[i + 1] || items[i - 1];
      S.selectedItemId = neighbour ? neighbour.id : null;
      setOrder((await api("DELETE", `/api/orders/${S.order.id}/items/${itemId}`)).order);
    });
  }

  async function updateHeader() {
    if (!S.order || !S.order.editable) return;
    await enqueue(async () =>
      setOrder((await api("PATCH", `/api/orders/${S.order.id}`, { orderType: $("#order-type").value, tableOrLocation: $("#order-location").value })).order)
    );
  }

  async function loadOrder(id) {
    await run(async () => {
      S.selectedItemId = null;
      setOrder((await api("GET", `/api/orders/${id}`)).order);
    });
  }

  // Waits for in-flight line changes so a late response can't bring the old order back.
  function newOrder() {
    return run(async () => {
      setOrder(null);
      $("#order-location").value = "";
      $("#order-type").value = DEFAULT_TYPE[boot.outlet.outletType] || "OTHER";
      renderOrder();
      showView("products");
      $("#pos-search").focus();
    });
  }

  // Lock the order for settlement (F13 requestSettlement()).
  async function ensureAwaitingSettlement() {
    if (["AWAITING_SETTLEMENT", "CHARGE_FAILED"].includes(S.order.status)) return true;
    const res = await api("POST", `/api/orders/${S.order.id}/request-settlement`);
    setOrder(res.order);
    return true;
  }

  // ── Quantity dialog ──────────────────────────────────────────────────────
  function startQty(itemId) {
    const item = S.order?.items.find((i) => String(i.id) === String(itemId ?? S.selectedItemId));
    if (!item || !can.note()) return;
    S.qty.itemId = item.id;
    S.selectedItemId = item.id;
    $("#qty-product").textContent = item.productName;
    $("#qty-unit").textContent = item.unit ? `(${item.unit})` : "";
    $("#qty-input").value = qtyFmt(item.quantity);
    showError("qty-error", null);
    openModal("modal-qty", { focus: "#qty-input" });
  }

  async function applyQty() {
    const value = Number($("#qty-input").value);
    if (!(value > 0) || value > 9999) return showError("qty-error", "Enter a quantity greater than 0 (up to 9999). Use Delete to remove the line.");
    const itemId = S.qty.itemId;
    closeModal("modal-qty");
    await enqueue(async () => setOrder((await api("PATCH", `/api/orders/${S.order.id}/items/${itemId}`, { quantity: String(roundQty(value)) })).order));
  }

  // ── Direct payment ───────────────────────────────────────────────────────
  function renderPaymentMethods() {
    $("#pay-methods").innerHTML = boot.paymentMethods
      .map((m, i) => {
        const active = String(S.pay.methodId) === String(m.id);
        return `<button type="button" data-method="${m.id}" aria-pressed="${active}" class="flex h-12 items-center justify-center gap-2 rounded-lg border px-2 text-sm font-medium transition ${
          active ? "border-brand-700 bg-brand-50 text-brand-800 ring-2 ring-brand-500/30" : "border-slate-200 hover:bg-slate-50"
        }">${esc(m.name)}${i < 9 ? keys.hint(`pay-method-${i + 1}`) : ""}</button>`;
      })
      .join("");
  }

  const selectedMethod = () => boot.paymentMethods.find((m) => String(m.id) === String(S.pay.methodId));

  function quickTenders() {
    const due = Number($("#pay-amount").value || S.order?.balanceDue || 0);
    return [due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, Math.ceil(due / 1000) * 1000]
      .map((v) => Math.round(v * 100) / 100)
      .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
      .slice(0, 4);
  }

  function updatePaymentForm() {
    const m = selectedMethod();
    const due = Number(S.order.balanceDue);
    $("#pay-due").textContent = fmt(due);
    $("#pay-tendered-wrap").classList.toggle("invisible", !m?.isCash);
    $("#pay-reference-wrap").classList.toggle("hidden", !(m && (m.requiresReference || m.usesGateway)));
    $("#pay-mock-note").classList.toggle("hidden", !(m && m.usesGateway && boot.mocks.payment));
    const amount = Number($("#pay-amount").value || 0);
    const tendered = Number($("#pay-tendered").value || 0);
    const change = m?.isCash ? Math.max(0, tendered - amount) : 0;
    $("#pay-change").textContent = fmt(change);
    $("#pay-quick").innerHTML = m?.isCash
      ? quickTenders().map((v) => `<button type="button" class="btn btn-secondary h-10" data-tender="${v}">${fmt(v)}</button>`).join("")
      : "";
  }

  // Put the cursor where the cashier types next for the chosen method.
  function focusPaymentField() {
    const m = selectedMethod();
    const target = m?.isCash ? "#pay-tendered" : m && (m.requiresReference || m.usesGateway) ? "#pay-reference" : "#pay-amount";
    setTimeout(() => {
      const el = $(target);
      el.focus();
      el.select?.();
    }, 30);
  }

  function chooseMethod(id) {
    S.pay.methodId = id;
    S.pay.key = null;
    renderPaymentMethods();
    updatePaymentForm();
    focusPaymentField();
  }

  // ↑/↓ in "Cash received" steps through the suggested amounts instead of ±0.01.
  function stepTender(direction) {
    const list = quickTenders();
    if (!list.length) return;
    const current = Number($("#pay-tendered").value || 0);
    const next = direction > 0 ? list.find((v) => v > current + 0.001) ?? list[list.length - 1] : [...list].reverse().find((v) => v < current - 0.001) ?? list[0];
    $("#pay-tendered").value = next.toFixed(2);
    updatePaymentForm();
  }

  async function startPayment() {
    if (!can.pay()) return;
    const problem = shiftProblem();
    if (problem) return toast(problem, "warning");
    await run(async () => {
      await ensureAwaitingSettlement();
      S.pay.methodId = S.pay.methodId || boot.paymentMethods.find((m) => m.isCash)?.id || boot.paymentMethods[0]?.id;
      S.pay.key = null;
      $("#pay-amount").value = S.order.balanceDue;
      $("#pay-tendered").value = S.order.balanceDue;
      $("#pay-reference").value = "";
      showError("pay-error", null);
      renderPaymentMethods();
      updatePaymentForm();
      openModal("modal-payment");
      focusPaymentField();
    });
  }

  async function submitPayment() {
    const m = selectedMethod();
    if (!m) return showError("pay-error", "Select a payment method.");
    const btn = $("#pay-submit");
    if (btn.disabled) return;
    S.pay.key = S.pay.key || uuid(); // reused if this exact submission is retried
    btn.disabled = true;
    label(btn, spinner("Processing…"));
    try {
      const res = await api("POST", `/api/orders/${S.order.id}/payments`, {
        paymentMethodId: m.id,
        amount: $("#pay-amount").value,
        tenderedAmount: m.isCash ? $("#pay-tendered").value : undefined,
        reference: $("#pay-reference").value || undefined,
        idempotencyKey: S.pay.key,
      });
      S.pay.key = null;
      setOrder(res.order);
      if (res.order.status === "COMPLETED") {
        closeModal("modal-payment");
        showDone(res, Number(res.payment?.changeAmount || 0));
      } else {
        toast(`Payment of ${fmt(res.payment.amount)} recorded. Balance due ${fmt(res.order.balanceDue)}.`, "success");
        $("#pay-amount").value = res.order.balanceDue;
        $("#pay-tendered").value = res.order.balanceDue;
        updatePaymentForm();
        focusPaymentField();
      }
    } catch (err) {
      if (err.status) S.pay.key = null; // the server answered: next attempt is a new payment
      if (err.body?.order) setOrder(err.body.order);
      if (handleSessionErrors(err)) closeModal("modal-payment");
      else showError("pay-error", err.status ? err.message : `${err.message} — the payment may still be processing; press Confirm again to retry safely.`);
    } finally {
      btn.disabled = false;
      label(btn, "Confirm payment");
    }
  }

  // ── Charge to room (PMS) ─────────────────────────────────────────────────
  function roomStep(step) {
    ["lookup", "confirm", "result"].forEach((s) => $(`#room-step-${s}`).classList.toggle("hidden", s !== step));
    $("#room-confirm").classList.toggle("hidden", step !== "confirm");
    $("#room-back").classList.toggle("hidden", step === "lookup");
    $("#room-validate").disabled = false;
    if (step !== "result") $("#room-verify").classList.add("hidden");
  }

  async function startRoomCharge() {
    if (!can.room()) return;
    const problem = shiftProblem();
    if (problem) return toast(problem, "warning");
    await run(async () => {
      await ensureAwaitingSettlement();
      S.room = { token: null, key: null, chargeId: S.order.guestCharge?.id || null };
      $("#room-amount").textContent = fmt(S.order.totalAmount);
      $("#room-number").value = "";
      $("#room-mock-note").classList.toggle("hidden", !boot.mocks.pms);
      showError("room-error", null);
      $("#room-verify").classList.add("hidden");
      if (S.order.guestCharge && S.order.guestCharge.status === "UNKNOWN") {
        showRoomResult({ outcome: "UNKNOWN", charge: S.order.guestCharge, message: "The PMS did not confirm the last posting attempt. Check its status before trying again." });
      } else {
        roomStep("lookup");
      }
      openModal("modal-room");
    });
  }

  async function validateRoom() {
    const roomNumber = $("#room-number").value.trim();
    if (!roomNumber) return showError("room-error", "Enter the guest's room number.");
    showError("room-error", null);
    const btn = $("#room-validate");
    if (btn.disabled) return;
    btn.disabled = true;
    label(btn, spinner("Checking…"));
    try {
      const res = await api("POST", `/api/orders/${S.order.id}/room-charge/validate`, { roomNumber });
      const v = res.validation;
      S.room.token = v.token;
      S.room.key = null;
      $("#room-c-room").textContent = v.roomNumber;
      $("#room-c-guest").textContent = v.guestName;
      $("#room-c-folio").textContent = v.folioId;
      $("#room-c-stay").textContent = [v.checkIn, v.checkOut].filter(Boolean).join(" → ");
      roomStep("confirm");
      $("#room-confirm").focus();
    } catch (err) {
      if (handleSessionErrors(err)) closeModal("modal-room");
      else showError("room-error", err.message);
    } finally {
      btn.disabled = false;
      label(btn, "Validate with PMS");
    }
  }

  function showRoomResult(res) {
    roomStep("result");
    const charge = res.charge || {};
    S.room.chargeId = charge.id || S.room.chargeId;
    const box = (cls, title, body) =>
      `<div class="rounded-xl border p-4 text-sm ${cls}"><p class="font-semibold">${esc(title)}</p><p class="mt-1">${esc(body)}</p></div>`;
    if (res.outcome === "FAILED") {
      $("#room-step-result").innerHTML = box("border-rose-200 bg-rose-50 text-rose-800", "Charge rejected by PMS", res.message || "The PMS rejected the charge.");
      $("#room-verify").classList.add("hidden");
      $("#room-back").focus();
    } else if (res.outcome === "UNKNOWN") {
      $("#room-step-result").innerHTML = box(
        "border-amber-200 bg-amber-50 text-amber-800",
        "Waiting for PMS confirmation",
        res.message || "The PMS did not respond in time. The charge was NOT retried automatically."
      );
      $("#room-verify").classList.remove("hidden");
      $("#room-back").classList.add("hidden");
      $("#room-verify").focus();
    }
  }

  async function confirmRoomCharge() {
    const btn = $("#room-confirm");
    if (btn.disabled) return;
    S.room.key = S.room.key || uuid();
    btn.disabled = true;
    label(btn, spinner("Posting to folio…"));
    showError("room-error", null);
    try {
      const res = await api("POST", `/api/orders/${S.order.id}/room-charge`, { validationToken: S.room.token, idempotencyKey: S.room.key });
      setOrder(res.order);
      if (res.outcome === "POSTED") {
        closeModal("modal-room");
        showDone(res);
      } else {
        showRoomResult(res);
      }
    } catch (err) {
      if (err.body?.order) setOrder(err.body.order);
      if (handleSessionErrors(err)) closeModal("modal-room");
      else showError("room-error", err.message);
    } finally {
      btn.disabled = false;
      label(btn, "Post charge to folio");
    }
  }

  async function verifyRoomCharge() {
    const id = S.room.chargeId || S.order?.guestCharge?.id;
    const btn = $("#room-verify");
    if (!id || btn.disabled) return;
    btn.disabled = true;
    label(btn, spinner("Checking…"));
    try {
      const res = await api("POST", `/api/guest-charges/${id}/verify`);
      setOrder(res.order);
      if (res.outcome === "POSTED") {
        closeModal("modal-room");
        showDone(res);
      } else {
        showRoomResult(res);
        if (res.outcome !== "UNKNOWN") $("#room-back").classList.remove("hidden");
      }
    } catch (err) {
      if (handleSessionErrors(err)) closeModal("modal-room");
      else showError("room-error", err.message);
    } finally {
      btn.disabled = false;
      label(btn, "Check status with PMS");
    }
  }

  function roomBack() {
    if ($("#room-back").classList.contains("hidden")) return;
    S.room.token = null;
    S.room.key = null;
    showError("room-error", null);
    roomStep("lookup");
    $("#room-number").focus();
  }

  // ── Completed ────────────────────────────────────────────────────────────
  function showDone(res, change = 0) {
    const o = res.order;
    const room = o.guestCharge && o.settlementType === "ROOM_CHARGE";
    $("#done-title").textContent = room ? `Charged to Room ${o.guestCharge.roomNumber}` : "Payment complete";
    $("#done-message").textContent = room
      ? `${o.orderNumber} · ${fmt(o.totalAmount)} posted to folio. PMS reference ${o.guestCharge.pmsTransactionId}. Ask the guest to sign the charge slip.`
      : `${o.orderNumber} · ${fmt(o.totalAmount)} settled.`;
    $("#done-change").classList.toggle("hidden", !(change > 0));
    $("#done-change").textContent = change > 0 ? `Change: ${fmt(change)}` : "";
    const receipt = (o.receipts || []).find((r) => !r.refundId);
    const url = receipt ? `/receipts/${receipt.id}?print=1` : `/orders/${o.id}`;
    $("#done-receipt").href = url;
    if (receipt) S.lastReceiptUrl = url;
    openModal("modal-done");
  }

  function reprintLast() {
    const receipt = S.order && (S.order.receipts || []).find((r) => !r.refundId);
    const url = receipt ? `/receipts/${receipt.id}?print=1` : S.lastReceiptUrl;
    if (!url) return toast("No receipt has been issued from this terminal yet.", "info");
    window.open(url, "_blank", "noopener");
  }

  // ── Void ─────────────────────────────────────────────────────────────────
  function startVoid() {
    if (!can.void()) return;
    run(async () => {
      $("#void-order-number").textContent = S.order.orderNumber;
      $("#void-reason").value = "";
      $("#void-sup-user").value = "";
      $("#void-sup-pass").value = "";
      $("#void-supervisor").classList.toggle("hidden", boot.can.void);
      showError("void-error", null);
      openModal("modal-void", { focus: "#void-reason" });
    });
  }

  async function submitVoid() {
    const btn = $("#void-submit");
    if (btn.disabled) return;
    if (!$("#void-reason").value.trim()) return showError("void-error", "Enter the reason for voiding this order.");
    if (!boot.can.void && (!$("#void-sup-user").value.trim() || !$("#void-sup-pass").value)) {
      showError("void-error", "A supervisor must enter their username and password to approve this void.");
      return $(!$("#void-sup-user").value.trim() ? "#void-sup-user" : "#void-sup-pass").focus();
    }
    btn.disabled = true;
    try {
      const res = await api("POST", `/api/orders/${S.order.id}/void`, {
        reason: $("#void-reason").value,
        supervisorUsername: $("#void-sup-user").value || undefined,
        supervisorPassword: $("#void-sup-pass").value || undefined,
      });
      closeModal("modal-void");
      toast(`Order ${res.order.orderNumber} was voided.`, "success");
      newOrder();
    } catch (err) {
      if (handleSessionErrors(err)) closeModal("modal-void");
      else showError("void-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ── Notes ────────────────────────────────────────────────────────────────
  function startNote(itemId) {
    if (!can.note()) return;
    if (itemId && !S.order.items.some((i) => String(i.id) === String(itemId))) return;
    run(async () => {
      S.note.itemId = itemId;
      if (itemId) S.selectedItemId = itemId;
      const current = itemId ? S.order.items.find((i) => String(i.id) === String(itemId))?.notes : S.order.notes;
      $("#note-title").textContent = itemId ? `Note · ${S.order.items.find((i) => String(i.id) === String(itemId))?.productName}` : "Order note";
      $("#note-text").value = current || "";
      showError("note-error", null);
      openModal("modal-note", { focus: "#note-text" });
    });
  }

  async function saveNote() {
    const btn = $("#note-save");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const notes = $("#note-text").value;
      const res = S.note.itemId
        ? await api("PATCH", `/api/orders/${S.order.id}/items/${S.note.itemId}`, { notes })
        : await api("PATCH", `/api/orders/${S.order.id}`, { notes, orderType: S.order.orderType, tableOrLocation: S.order.tableOrLocation });
      setOrder(res.order);
      closeModal("modal-note");
    } catch (err) {
      if (handleSessionErrors(err)) closeModal("modal-note");
      else showError("note-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ── Discounts ────────────────────────────────────────────────────────────
  async function startDiscount() {
    if (!can.discount()) return;
    await run(async () => {
      const res = await api("GET", `/api/orders/${S.order.id}/discounts/available`);
      S.discounts = res.discounts;
      $("#discount-list").innerHTML = S.discounts.length
        ? S.discounts
            .map(
              (d, i) => `<label class="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                <input type="radio" name="discount" value="${d.id}" class="mt-1 h-4 w-4">
                <span class="flex-1"><span class="font-medium">${esc(d.name)}</span> <span class="font-mono text-xs text-slate-400">${esc(d.code)}</span>
                  <span class="block text-xs text-slate-500">${d.type === "PERCENTAGE" ? `${Number(d.value)}%` : fmt(d.value)} off ${
                    d.scope === "ITEM" ? "one item" : "the order"
                  }${d.requiresAuthorization ? " · supervisor approval" : ""}${d.description ? ` · ${esc(d.description)}` : ""}</span></span>
                ${i < 9 ? keys.hint(`discount-pick-${i + 1}`) : ""}
              </label>`
            )
            .join("")
        : '<p class="text-sm text-slate-500">No discounts are currently valid for this outlet.</p>';
      $("#discount-item").innerHTML = S.order.items.map((i) => `<option value="${i.id}">${esc(i.productName)} (${fmt(i.lineTotal)})</option>`).join("");
      if (S.selectedItemId) $("#discount-item").value = String(S.selectedItemId);
      $("#discount-item-wrap").classList.add("hidden");
      $("#discount-supervisor").classList.add("hidden");
      $("#discount-sup-user").value = "";
      $("#discount-sup-pass").value = "";
      showError("discount-error", null);
      openModal("modal-discount", { focus: 'input[name="discount"]' });
    });
  }

  function pickDiscount(n) {
    const radio = $$('#discount-list input[name="discount"]')[n - 1];
    if (!radio) return;
    radio.checked = true;
    radio.focus();
    onDiscountSelect();
  }

  function onDiscountSelect() {
    const id = document.querySelector('input[name="discount"]:checked')?.value;
    const d = S.discounts.find((x) => String(x.id) === String(id));
    $("#discount-item-wrap").classList.toggle("hidden", !(d && d.scope === "ITEM"));
    $("#discount-supervisor").classList.toggle("hidden", !(d && d.requiresAuthorization && !boot.can.authorizeDiscount));
  }

  async function applyDiscount() {
    const id = document.querySelector('input[name="discount"]:checked')?.value;
    if (!id) return showError("discount-error", "Select a discount.");
    const btn = $("#discount-apply");
    if (btn.disabled) return;
    const d = S.discounts.find((x) => String(x.id) === String(id));
    if (d.requiresAuthorization && !boot.can.authorizeDiscount && (!$("#discount-sup-user").value.trim() || !$("#discount-sup-pass").value)) {
      showError("discount-error", "A supervisor must enter their username and password to approve this discount.");
      return $(!$("#discount-sup-user").value.trim() ? "#discount-sup-user" : "#discount-sup-pass").focus();
    }
    btn.disabled = true;
    try {
      const res = await api("POST", `/api/orders/${S.order.id}/discounts`, {
        discountId: id,
        orderItemId: d.scope === "ITEM" ? $("#discount-item").value : undefined,
        supervisorUsername: $("#discount-sup-user").value || undefined,
        supervisorPassword: $("#discount-sup-pass").value || undefined,
      });
      setOrder(res.order);
      closeModal("modal-discount");
      toast(`${d.name} applied.`, "success");
    } catch (err) {
      if (handleSessionErrors(err)) closeModal("modal-discount");
      else showError("discount-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function removeDiscount(orderDiscountId) {
    return enqueue(async () => setOrder((await api("DELETE", `/api/orders/${S.order.id}/discounts/${orderDiscountId}`)).order));
  }

  // Shift+F7: the order-level discount, else the selected line's discount.
  function removeCurrentDiscount() {
    if (!editable()) return;
    const d = S.order.discounts.find((x) => !x.orderItemId) || S.order.discounts.find((x) => String(x.orderItemId) === String(S.selectedItemId));
    if (!d) return toast("There is no discount to remove on this order or line.", "info");
    removeDiscount(d.id).then(() => toast(`${d.code} removed.`, "info"));
  }

  // ── Open orders ──────────────────────────────────────────────────────────
  const ago = (iso) => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60);
    return h < 24 ? `${h} h ${mins % 60} min ago` : `${Math.floor(h / 24)} d ago`;
  };

  function renderOpenOrders() {
    const q = $("#orders-filter").value.trim().toLowerCase();
    const rows = S.openOrders.filter((o) =>
      !q || [o.orderNumber, o.tableOrLocation, humanize(o.orderType), o.createdBy, humanize(o.status)].some((v) => String(v || "").toLowerCase().includes(q))
    );
    $("#orders-list").innerHTML = rows.length
      ? `<table class="table"><tbody>${rows
          .map(
            (o, i) => `<tr class="cursor-pointer" role="option" aria-selected="${i === 0}" data-resume="${o.id}">
              <td class="font-mono text-xs">${esc(o.orderNumber)}</td>
              <td>${esc(humanize(o.orderType))}${o.tableOrLocation ? ` · <span class="font-medium">${esc(o.tableOrLocation)}</span>` : ""}</td>
              <td><span class="badge ${STATUS_COLORS[o.status] || "badge-slate"}">${esc(humanize(o.status))}</span></td>
              <td class="text-right font-medium">${fmt(o.totalAmount)}</td>
              <td class="whitespace-nowrap text-xs text-slate-500">${esc(o.createdBy || "")}<br>${esc(ago(o.createdAt))}</td></tr>`
          )
          .join("")}</tbody></table>`
      : `<p class="p-6 text-center text-sm text-slate-500">${S.openOrders.length ? "No open orders match the filter." : "No open orders at this outlet."}</p>`;
  }

  function moveOrderSelection(delta) {
    const rows = $$("#orders-list [data-resume]");
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.getAttribute("aria-selected") === "true");
    const next = Math.min(rows.length - 1, Math.max(0, i + delta));
    rows.forEach((r, j) => r.setAttribute("aria-selected", String(j === next)));
    rows[next].scrollIntoView({ block: "nearest" });
  }

  function resumeSelectedOrder() {
    const row = $('#orders-list [data-resume][aria-selected="true"]') || $("#orders-list [data-resume]");
    if (!row) return;
    closeModal("modal-orders");
    loadOrder(row.dataset.resume);
  }

  async function showOpenOrders() {
    await run(async () => {
      const res = await api("GET", `/api/pos/open-orders?outletId=${boot.outlet.id}`);
      S.openOrders = res.orders;
      $("#orders-filter").value = "";
      renderOpenOrders();
      openModal("modal-orders", { focus: "#orders-filter" });
    });
  }

  // ── Help overlay ─────────────────────────────────────────────────────────
  function toggleHelp() {
    if (openModalEl()?.id === "modal-help") return closeModal("modal-help");
    if (openModalEl()) return;
    keys.renderHelp($("#help-groups"));
    $("#help-hints-toggle").checked = keys.hintsOn;
    openModal("modal-help");
  }

  // ── Phone layout: one pane at a time ─────────────────────────────────────
  const isNarrow = () => window.matchMedia("(max-width: 1023.98px)").matches;
  function showView(view, { onlyIfMobile = false } = {}) {
    if (onlyIfMobile && !isNarrow()) return;
    $("#pos-app").dataset.view = view;
    $$("[data-view-switch]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.viewSwitch === view)));
  }

  // ── Shortcuts ────────────────────────────────────────────────────────────
  function focusField(sel) {
    const el = $(sel);
    if (!el || el.disabled) return;
    if (sel !== "#pos-outlet") showView("order", { onlyIfMobile: true });
    el.focus();
    el.select?.();
  }

  function registerShortcuts() {
    const R = keys.register;
    const G = { general: "General", products: "Products & search", lines: "Order lines", order: "Order", settle: "Settlement", dialogs: "Dialogs", pay: "Payment dialog" };

    // General
    R({ id: "help", keys: ["F1", "?"], group: G.general, label: "Show all keyboard shortcuts", run: toggleHelp });
    R({ id: "help-close", keys: ["F1", "?"], scope: "modal-help", hidden: true, run: toggleHelp });
    R({ id: "outlet", keys: ["Alt+O"], group: G.general, label: "Switch outlet", run: () => focusField("#pos-outlet") });
    R({ id: "reprint", keys: ["Ctrl+P"], group: G.general, label: "Reprint the last receipt", run: reprintLast });

    // Products & search
    R({
      id: "search",
      keys: ["F3", "/"],
      group: G.products,
      label: "Search or scan a product",
      run: () => {
        showView("products", { onlyIfMobile: true });
        $("#pos-search").focus();
        $("#pos-search").select();
      },
    });
    R({ id: "search-add", group: G.products, label: "Add the exact code, or the first match", display: keys.keyChips("Enter") + ' <span class="text-xs text-slate-400">in search</span>' });
    R({ id: "search-multiply", group: G.products, label: "Add several at once", display: keys.keyChips("3*CODE", "Enter") });
    R({ id: "search-clear", group: G.products, label: "Clear the search", display: keys.keyChips("Esc") + ' <span class="text-xs text-slate-400">in search</span>' });
    R({ id: "grid", group: G.products, label: "Move between product tiles", display: keys.keyChips("↓", "←", "→", "↑", "Home", "End") });
    R({ id: "grid-add", group: G.products, label: "Add the focused product", display: keys.keyChips("Enter") + ' <span class="text-slate-400">or</span> ' + keys.keyChips("Space") });
    R({ id: "type-search", group: G.products, label: "Start typing anywhere to search", display: keys.keyChips("A–Z", "0–9") });
    for (let i = 0; i <= 9; i++) {
      R({
        id: `cat-${i}`,
        keys: [`Alt+${i}`],
        group: G.products,
        label: i === 0 ? "Category: All" : `Category ${i}`,
        hidden: i > 1,
        enabled: () => i < chipList().length,
        run: () => selectCategory(chipList()[i].id),
      });
    }
    R({ id: "cat-range", group: G.products, label: "Categories 2–9", display: keys.keyChips(`${keys.display("Alt+2")} … ${keys.display("Alt+9")}`) });
    const stepCategory = (d) => {
      const list = chipList();
      const i = list.findIndex((c) => String(c.id) === S.category);
      selectCategory(list[(i + d + list.length) % list.length].id);
    };
    R({ id: "cat-prev", keys: ["["], group: G.products, label: "Previous category", run: () => stepCategory(-1) });
    R({ id: "cat-next", keys: ["]"], group: G.products, label: "Next category", run: () => stepCategory(1) });

    // Order lines (act on the selected line; the last added line is selected automatically).
    // The cashier usually sits in the search box, so + − * also work there while it is empty or
    // fully selected (right after Enter added a product); Delete only while it is empty.
    const notSelect = (el) => el.tagName !== "SELECT";
    const searchIdle = (el) => el.id === "pos-search" && (!el.value || (el.selectionStart === 0 && el.selectionEnd === el.value.length));
    const searchEmpty = (el) => el.id === "pos-search" && !el.value;
    R({ id: "line-prev", keys: ["Alt+ArrowUp"], group: G.lines, label: "Select the previous line", whenTyping: notSelect, enabled: () => Boolean(S.order?.items.length), run: () => selectLine(-1) });
    R({ id: "line-next", keys: ["Alt+ArrowDown"], group: G.lines, label: "Select the next line", whenTyping: notSelect, enabled: () => Boolean(S.order?.items.length), run: () => selectLine(1) });
    R({ id: "line-inc", keys: ["+", "="], group: G.lines, label: "Quantity +1", whenTyping: searchIdle, enabled: can.line, run: () => changeQty(S.selectedItemId, 1) });
    R({ id: "line-dec", keys: ["-"], group: G.lines, label: "Quantity −1", whenTyping: searchIdle, enabled: can.line, run: () => changeQty(S.selectedItemId, -1) });
    R({ id: "line-qty", keys: ["*"], group: G.lines, label: "Set the quantity (decimals allowed)", whenTyping: searchIdle, enabled: can.line, run: () => startQty() });
    R({ id: "line-remove", keys: ["Delete"], group: G.lines, label: "Remove the line", whenTyping: searchEmpty, enabled: can.line, run: () => removeItem(S.selectedItemId) });
    R({ id: "line-note", keys: ["F9"], group: G.lines, label: "Note on the line", enabled: can.line, run: () => startNote(S.selectedItemId) });

    // Order
    R({ id: "order-note", keys: ["Shift+F9"], group: G.order, label: "Order note", enabled: can.note, run: () => startNote(null) });
    R({ id: "order-type", keys: ["Alt+T"], group: G.order, label: "Order type", run: () => focusField("#order-type") });
    R({ id: "order-location", keys: ["Alt+L"], group: G.order, label: "Table / room / location", run: () => focusField("#order-location") });
    R({ id: "discount", keys: ["F7"], group: G.order, label: "Apply a discount", enabled: can.discount, run: startDiscount });
    R({ id: "discount-remove", keys: ["Shift+F7"], group: G.order, label: "Remove the order (or line) discount", enabled: () => canWrite() && editable() && S.order.discounts.length > 0, run: removeCurrentDiscount });
    R({ id: "open-orders", keys: ["F6"], group: G.order, label: "Open orders (resume one)", enabled: () => !S.blocked, run: showOpenOrders });
    R({ id: "new-order", keys: ["F8"], group: G.order, label: "New order", run: newOrder });
    // F10 works everywhere; Shift+Delete only outside text fields or from an empty search box,
    // because Shift+Delete is "cut" inside a field that has text.
    R({ id: "void", keys: ["F10", "Shift+Delete"], group: G.order, label: "Void the order (asks for a reason)", whenTyping: (el, combo) => combo === "F10" || searchEmpty(el), enabled: can.void, run: startVoid });

    // Settlement
    R({ id: "pay", keys: ["F2"], group: G.settle, label: "Direct payment", enabled: can.pay, run: startPayment });
    R({ id: "room-charge", keys: ["F4"], group: G.settle, label: "Charge to room", enabled: can.room, run: startRoomCharge });

    // Any dialog
    R({ id: "dialog-primary", keys: ["Enter"], scope: "modal", group: G.dialogs, label: "Confirm (the highlighted button)", whenTyping: true, run: (e) => clickPrimary(e) });
    R({ id: "dialog-close", keys: ["Escape"], scope: "modal", group: G.dialogs, label: "Close / cancel", whenTyping: true, run: () => closeModal(openModalEl()) });
    R({ id: "dialog-newline", group: G.dialogs, label: "New line in a note", display: keys.keyChips(keys.display("Shift+Enter")) });
    R({ id: "list-nav", group: G.dialogs, label: "Open orders: choose, filter, open", display: keys.keyChips("↑", "↓", "Enter") });
    R({ id: "room-back", keys: ["Alt+B"], scope: "modal-room", group: G.dialogs, label: "Room charge: use another room", run: roomBack });
    R({ id: "done-print", keys: ["P"], scope: "modal-done", group: G.dialogs, label: "After a sale: print the receipt", run: () => $("#done-receipt").click() });

    // Payment dialog
    for (let i = 1; i <= 9; i++) {
      R({
        id: `pay-method-${i}`,
        keys: [`Alt+${i}`],
        scope: "modal-payment",
        group: G.pay,
        label: `Payment method ${i}`,
        hidden: i > 1,
        enabled: () => i <= boot.paymentMethods.length,
        run: () => chooseMethod(boot.paymentMethods[i - 1].id),
      });
      R({ id: `discount-pick-${i}`, keys: [`Alt+${i}`], scope: "modal-discount", hidden: true, run: () => pickDiscount(i) });
    }
    R({ id: "pay-method-range", group: G.pay, label: "Payment methods 2–9 (also discounts 1–9)", display: keys.keyChips(`${keys.display("Alt+2")} … ${keys.display("Alt+9")}`) });
    R({ id: "pay-tender-step", keys: ["ArrowUp", "ArrowDown"], group: G.pay, label: "Step through quick cash amounts (in Cash received)" });
    R({ id: "pay-confirm", group: G.pay, label: "Confirm the payment", display: keys.keyChips("Enter") });
  }

  // Keys handled where they happen (search box, grid, lists) rather than through the registry.
  function wireLocalKeys() {
    const search = $("#pos-search");
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const { qty, term } = parseSearch();
        if (!term) {
          if (qty) toast("Type a product code after the multiplier, e.g. 3*COF01.", "warning");
          return;
        }
        const first = boot.catalog.find((p) => p.code.toLowerCase() === term) || filteredProducts()[0];
        if (!first) return toast(`No product matches “${term}”.`, "warning");
        addProduct(first.id); // clears a "3*" multiplier itself
        if (qty === null) search.select(); // the next scan replaces the text
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (search.value) {
          search.value = "";
          S.search = "";
          renderProducts();
        } else {
          search.blur();
        }
      } else if (e.key === "ArrowDown" && !e.altKey) {
        const tile = $("#pos-products [data-product]");
        if (tile) {
          e.preventDefault();
          tile.focus();
        }
      }
    });

    $("#pos-products").addEventListener("keydown", (e) => {
      const tile = e.target.closest("[data-product]");
      if (!tile || e.altKey || e.ctrlKey || e.metaKey) return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        moveInGrid(tile, e.key);
      } else if (e.key === "Escape") {
        e.preventDefault();
        search.focus();
      }
    });

    // Tablist: arrows move between categories and select them.
    $("#pos-categories").addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || e.altKey) return;
      e.preventDefault();
      const list = chipList();
      const i = list.findIndex((c) => String(c.id) === S.category);
      const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: list.length - 1 }[e.key];
      selectCategory(list[(next + list.length) % list.length].id, { focus: true });
    });

    $("#pay-tendered").addEventListener("keydown", (e) => {
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey) {
        e.preventDefault();
        stepTender(e.key === "ArrowUp" ? 1 : -1);
      }
    });

    $("#orders-filter").addEventListener("input", renderOpenOrders);
    $("#orders-filter").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveOrderSelection(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        resumeSelectedOrder();
      }
    });

    // Note: Enter saves, Shift+Enter is a new line (handled by the dialog Enter shortcut).

    document.addEventListener("keydown", (e) => {
      trapFocus(e);
      // Type-to-search: a letter or digit typed with nothing focused goes into the search box.
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || openModalEl() || S.blocked) return;
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing || !/^[A-Za-z0-9.]$/.test(e.key)) return;
      e.preventDefault();
      showView("products", { onlyIfMobile: true });
      search.focus();
      search.value += e.key;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function init() {
    api = window.HotelPOS.api;
    toast = window.HotelPOS.toast;
    keys = window.HotelPOS.shortcuts;

    registerShortcuts();
    keys.init();

    $("#order-type").innerHTML = boot.orderTypes.map((t) => `<option value="${t}">${humanize(t)}</option>`).join("");
    $("#order-type").value = DEFAULT_TYPE[boot.outlet.outletType] || "OTHER";
    renderCategories();
    renderProducts();
    renderOrder();
    keys.renderHints();
    if (boot.resumeOrderId) loadOrder(boot.resumeOrderId);

    // Flash messages from a redirect (e.g. "Shift opened") appear as toasts on this layout.
    try {
      const flash = JSON.parse(document.getElementById("pos-flash")?.textContent || "{}");
      (flash.success || []).forEach((m) => toast(m, "success"));
      (flash.warning || []).forEach((m) => toast(m, "warning"));
      (flash.error || []).forEach((m) => toast(m, "error"));
    } catch {
      /* no flash */
    }

    $("#pos-search").addEventListener("input", (e) => {
      S.search = e.target.value;
      renderProducts();
    });
    $("#order-type").addEventListener("change", updateHeader);
    $("#order-location").addEventListener("change", updateHeader);
    wireLocalKeys();

    document.addEventListener("click", (e) => {
      const t = e.target;
      const cat = t.closest("[data-category]");
      if (cat) return selectCategory(cat.dataset.category);
      const prod = t.closest("[data-product]");
      if (prod) return addProduct(Number(prod.dataset.product));

      const itemRow = t.closest("[data-item]");
      if (itemRow) {
        const id = itemRow.dataset.item;
        if (t.closest("[data-qty]")) return changeQty(id, Number(t.closest("[data-qty]").dataset.qty));
        if (t.closest("[data-qty-set]")) return startQty(id);
        if (t.closest("[data-item-remove]")) return removeItem(id);
        if (t.closest("[data-item-note]")) return startNote(id);
        if (String(S.selectedItemId) !== String(id)) {
          S.selectedItemId = id;
          renderOrder();
        }
        return;
      }

      const discountRemove = t.closest("[data-discount-remove]");
      if (discountRemove) return removeDiscount(discountRemove.dataset.discountRemove);

      const resume = t.closest("[data-resume]");
      if (resume) {
        closeModal("modal-orders");
        return loadOrder(resume.dataset.resume);
      }

      const method = t.closest("[data-method]");
      if (method) return chooseMethod(method.dataset.method);
      const tender = t.closest("[data-tender]");
      if (tender) {
        $("#pay-tendered").value = Number(tender.dataset.tender).toFixed(2);
        return updatePaymentForm();
      }

      const viewSwitch = t.closest("[data-view-switch]");
      if (viewSwitch) return showView(viewSwitch.dataset.viewSwitch);

      if (t.closest("[data-modal-close]")) closeModal(t.closest("[data-modal-close]"));

      const action = t.closest("[data-action]")?.dataset.action;
      if (action === "new-order") newOrder();
      if (action === "open-orders") showOpenOrders();
      if (action === "pay") startPayment();
      if (action === "room-charge") startRoomCharge();
      if (action === "void") startVoid();
      if (action === "order-note") startNote(null);
      if (action === "discount") startDiscount();
      if (action === "help") toggleHelp();
      if (action === "reload") location.reload();
    });

    // Clicking the backdrop closes the read-only dialogs. Payment, room-charge and void dialogs
    // only close through their buttons or Esc, so a stray tap can't hide a money result.
    ["modal-help", "modal-orders"].forEach((id) => {
      const m = document.getElementById(id);
      m.addEventListener("mousedown", (e) => e.target === m && closeModal(m));
    });

    $("#pay-amount").addEventListener("input", () => {
      S.pay.key = null;
      updatePaymentForm();
    });
    $("#pay-tendered").addEventListener("input", updatePaymentForm);
    $("#pay-submit").addEventListener("click", submitPayment);
    $("#room-validate").addEventListener("click", validateRoom);
    $("#room-confirm").addEventListener("click", confirmRoomCharge);
    $("#room-verify").addEventListener("click", verifyRoomCharge);
    $("#room-back").addEventListener("click", roomBack);
    $("#void-submit").addEventListener("click", submitVoid);
    $("#note-save").addEventListener("click", saveNote);
    $("#qty-apply").addEventListener("click", applyQty);
    $("#discount-apply").addEventListener("click", applyDiscount);
    $("#discount-list").addEventListener("change", onDiscountSelect);
    $("#help-hints-toggle").addEventListener("change", (e) => keys.setHints(e.target.checked));

    window.addEventListener("online", () => setOnline(true));
    window.addEventListener("offline", () => setOnline(false));
    if (!navigator.onLine) setOnline(false);
    window.addEventListener("focus", () => {
      if (Date.now() - S.catalogAt > CATALOG_MAX_AGE_MS && !S.blocked) refreshCatalog();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
