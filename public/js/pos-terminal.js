// POS terminal. The server is authoritative for prices, totals, stock and state;
// this script only renders what the API returns and sends user intents.
(function () {
  "use strict";

  const boot = JSON.parse(document.getElementById("pos-boot").textContent);
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (v) =>
    boot.currency + Number(v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = (v) => String(Number(v));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const humanize = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

  const DEFAULT_TYPE = { ROOM_SERVICE: "ROOM_SERVICE", MINIBAR: "MINIBAR", SPA: "SPA", RESTAURANT: "DINE_IN", BAR: "DINE_IN" };
  const STATUS_COLORS = {
    OPEN: "badge-blue", IN_PROGRESS: "badge-blue", AWAITING_SETTLEMENT: "badge-amber", SETTLING: "badge-amber",
    CHARGE_FAILED: "badge-red", COMPLETED: "badge-green", VOIDED: "badge-red", REFUNDED: "badge-red", PARTIALLY_REFUNDED: "badge-amber",
  };

  const S = {
    order: null,
    category: "all",
    search: "",
    busy: false,
    pay: { methodId: null, key: null },
    room: { token: null, key: null, chargeId: null },
    note: { itemId: null },
    discounts: [],
  };

  let api, toast;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function openModal(id) {
    const m = document.getElementById(id);
    m.classList.remove("hidden");
    m.classList.add("flex");
    setTimeout(() => m.querySelector("input:not([type=hidden]):not(.hidden), select, textarea")?.focus(), 30);
  }
  function closeModal(el) {
    const m = typeof el === "string" ? document.getElementById(el) : el.closest(".pos-modal");
    if (!m) return;
    m.classList.add("hidden");
    m.classList.remove("flex");
  }
  const openModalEl = () => document.querySelector(".pos-modal.flex");
  function showError(id, message) {
    const el = document.getElementById(id);
    if (!message) return el.classList.add("hidden");
    el.textContent = message;
    el.classList.remove("hidden");
  }

  async function run(fn) {
    if (S.busy) return;
    S.busy = true;
    document.body.classList.add("cursor-progress");
    try {
      return await fn();
    } catch (err) {
      toast(err.message || "Something went wrong.", "error");
      if (err.body?.order) setOrder(err.body.order);
    } finally {
      S.busy = false;
      document.body.classList.remove("cursor-progress");
    }
  }

  const isLocked = () => !S.order || !S.order.editable;
  const settleable = () => S.order && ["IN_PROGRESS", "AWAITING_SETTLEMENT", "CHARGE_FAILED"].includes(S.order.status) && S.order.items.length > 0;
  const shiftProblem = () => {
    if (!boot.requireShift) return null;
    if (!boot.shift) return "Open a cashier shift before taking payments.";
    if (boot.shift.outletId !== boot.outlet.id) return "Your open shift belongs to another outlet.";
    return null;
  };

  // ── Products ─────────────────────────────────────────────────────────────
  function renderCategories() {
    const chips = [{ id: "all", name: "All" }, ...boot.categories];
    $("#pos-categories").innerHTML = chips
      .map(
        (c) =>
          `<button type="button" role="tab" aria-selected="${S.category === String(c.id)}" data-category="${c.id}"
            class="whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition ${
              S.category === String(c.id) ? "bg-brand-800 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }">${esc(c.name)}</button>`
      )
      .join("");
  }

  function filteredProducts() {
    const q = S.search.trim().toLowerCase();
    return boot.catalog.filter(
      (p) =>
        (S.category === "all" || String(p.categoryId) === S.category) &&
        (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
    );
  }

  function renderProducts() {
    const list = filteredProducts();
    $("#pos-products-empty").classList.toggle("hidden", list.length > 0);
    $("#pos-products").innerHTML = list
      .map((p) => {
        const media = p.imagePath
          ? `<img src="${esc(p.imagePath)}" alt="" class="h-24 w-full rounded-lg object-cover">`
          : `<div class="flex h-24 w-full items-center justify-center rounded-lg bg-gradient-to-br from-brand-50 to-accent-50 text-2xl font-semibold text-brand-700">${esc(
              p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")
            )}</div>`;
        return `<button type="button" data-product="${p.id}" class="group flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2 text-left shadow-sm transition hover:border-brand-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500 active:scale-[0.98]">
          ${media}
          <span class="line-clamp-2 min-h-[2.5rem] px-1 text-sm font-medium text-slate-900">${esc(p.name)}</span>
          <span class="flex items-center justify-between px-1 pb-1"><span class="text-sm font-semibold text-brand-800">${fmt(p.price)}</span><span class="text-[10px] uppercase text-slate-400">${esc(p.unit)}</span></span>
        </button>`;
      })
      .join("");
  }

  // ── Order ────────────────────────────────────────────────────────────────
  function setOrder(order) {
    S.order = order;
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
    const locked = isLocked() && Boolean(o);
    $("#order-items").innerHTML = items.length
      ? items
          .map((i) => {
            const discount = o.discounts.find((d) => String(d.orderItemId) === String(i.id));
            return `<div class="rounded-lg px-2 py-2 hover:bg-slate-50" data-item="${i.id}">
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
                <button type="button" class="btn btn-secondary h-9 w-9 p-0 text-lg" data-qty="-1" aria-label="Decrease quantity">−</button>
                <span class="w-10 text-center text-sm font-semibold">${qtyFmt(i.quantity)}</span>
                <button type="button" class="btn btn-secondary h-9 w-9 p-0 text-lg" data-qty="1" aria-label="Increase quantity">+</button>
                <button type="button" class="btn btn-ghost btn-sm ml-auto" data-item-note>Note</button>
                <button type="button" class="btn btn-ghost btn-sm text-rose-600" data-item-remove aria-label="Remove item">Remove</button>
              </div>
            </div>`;
          })
          .join("")
      : `<div class="flex h-full flex-col items-center justify-center py-12 text-center text-sm text-slate-400">
           <p>Tap a product to start an order.</p></div>`;

    $("#t-subtotal").textContent = fmt(o?.subtotal);
    $("#t-discount").textContent = o && Number(o.discountAmount) > 0 ? `−${fmt(o.discountAmount)}` : fmt(0);
    $("#t-tax").textContent = fmt(o?.taxAmount);
    $("#t-service").textContent = fmt(o?.serviceChargeAmount);
    $("#t-sc-rate").textContent = o && Number(o.serviceChargeRate) > 0 ? `(${Number(o.serviceChargeRate)}%)` : "";
    $("#t-total").textContent = fmt(o?.totalAmount);
    const paid = o && Number(o.amountPaid) > 0;
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
            o.editable ? `<button type="button" class="text-emerald-700 hover:text-rose-600" data-discount-remove="${d.id}" aria-label="Remove discount">✕</button>` : ""
          }</span></div>`
      )
      .join("");

    const canSettle = settleable();
    const problem = shiftProblem();
    document.querySelector('[data-action="pay"]').disabled = !canSettle || !boot.can.settle || Boolean(o && Number(o.amountPaid) > 0 && o.settlementType === "ROOM_CHARGE");
    document.querySelector('[data-action="room-charge"]').disabled =
      !canSettle || !boot.can.roomCharge || !boot.outlet.allowsRoomCharge || Boolean(o && Number(o.amountPaid) > 0);
    document.querySelector('[data-action="void"]').disabled = !o || !["OPEN", "IN_PROGRESS", "AWAITING_SETTLEMENT", "CHARGE_FAILED"].includes(o.status) || Number(o.amountPaid) > 0;
    document.querySelector('[data-action="discount"]').disabled = !o || !o.editable || !o.items.length || !boot.can.discount;
    document.querySelector('[data-action="order-note"]').disabled = !o || !o.editable;
    const warn = $("#pos-shift-warning");
    warn.textContent = problem || "";
    warn.classList.toggle("hidden", !problem || !boot.can.settle);
  }

  async function addProduct(productId) {
    await run(async () => {
      let res;
      if (S.order && !S.order.editable) {
        toast(`Order ${S.order.orderNumber} is ${humanize(S.order.status).toLowerCase()}. Starting a new order.`, "info");
        S.order = null;
      }
      if (!S.order) {
        res = await api("POST", "/api/orders", {
          outletId: boot.outlet.id,
          orderType: $("#order-type").value,
          tableOrLocation: $("#order-location").value,
          productId,
          quantity: "1",
        });
      } else {
        res = await api("POST", `/api/orders/${S.order.id}/items`, { productId, quantity: "1" });
      }
      setOrder(res.order);
    });
  }

  async function changeQty(itemId, delta) {
    const item = S.order.items.find((i) => String(i.id) === String(itemId));
    const next = Math.max(0, Number(item.quantity) + delta);
    await run(async () => setOrder((await api("PATCH", `/api/orders/${S.order.id}/items/${itemId}`, { quantity: String(next) })).order));
  }

  async function removeItem(itemId) {
    await run(async () => setOrder((await api("DELETE", `/api/orders/${S.order.id}/items/${itemId}`)).order));
  }

  async function updateHeader() {
    if (!S.order || !S.order.editable) return;
    await run(async () =>
      setOrder((await api("PATCH", `/api/orders/${S.order.id}`, { orderType: $("#order-type").value, tableOrLocation: $("#order-location").value })).order)
    );
  }

  async function loadOrder(id) {
    await run(async () => setOrder((await api("GET", `/api/orders/${id}`)).order));
  }

  function newOrder() {
    S.order = null;
    $("#order-location").value = "";
    $("#order-type").value = DEFAULT_TYPE[boot.outlet.outletType] || "OTHER";
    renderOrder();
    $("#pos-search").focus();
  }

  // Lock the order for settlement (F13 requestSettlement()).
  async function ensureAwaitingSettlement() {
    if (["AWAITING_SETTLEMENT", "CHARGE_FAILED"].includes(S.order.status)) return true;
    const res = await api("POST", `/api/orders/${S.order.id}/request-settlement`);
    setOrder(res.order);
    return true;
  }

  // ── Direct payment ───────────────────────────────────────────────────────
  function renderPaymentMethods() {
    $("#pay-methods").innerHTML = boot.paymentMethods
      .map(
        (m) => `<button type="button" data-method="${m.id}" class="rounded-lg border px-2 py-3 text-sm font-medium transition ${
          String(S.pay.methodId) === String(m.id) ? "border-brand-700 bg-brand-50 text-brand-800 ring-2 ring-brand-500/30" : "border-slate-200 hover:bg-slate-50"
        }">${esc(m.name)}</button>`
      )
      .join("");
  }

  function selectedMethod() {
    return boot.paymentMethods.find((m) => String(m.id) === String(S.pay.methodId));
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
    const quick = [due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, Math.ceil(due / 1000) * 1000]
      .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
      .slice(0, 4);
    $("#pay-quick").innerHTML = m?.isCash
      ? quick.map((v) => `<button type="button" class="btn btn-secondary btn-sm" data-tender="${v}">${fmt(v)}</button>`).join("")
      : "";
  }

  async function startPayment() {
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
    });
  }

  async function submitPayment() {
    const m = selectedMethod();
    if (!m) return showError("pay-error", "Select a payment method.");
    S.pay.key = S.pay.key || uuid(); // reused if this exact submission is retried
    const btn = $("#pay-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Processing…';
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
      }
    } catch (err) {
      if (err.status) S.pay.key = null; // the server answered: next attempt is a new payment
      if (err.body?.order) setOrder(err.body.order);
      showError("pay-error", err.status ? err.message : `${err.message} — the payment may still be processing; press Confirm again to retry safely.`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirm payment";
    }
  }

  // ── Charge to room (PMS) ─────────────────────────────────────────────────
  function roomStep(step) {
    ["lookup", "confirm", "result"].forEach((s) => $(`#room-step-${s}`).classList.toggle("hidden", s !== step));
    $("#room-confirm").classList.toggle("hidden", step !== "confirm");
    $("#room-back").classList.toggle("hidden", step === "lookup");
    $("#room-validate").disabled = false;
  }

  async function startRoomCharge() {
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
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Checking…';
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
    } catch (err) {
      showError("room-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Validate with PMS";
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
    } else if (res.outcome === "UNKNOWN") {
      $("#room-step-result").innerHTML = box(
        "border-amber-200 bg-amber-50 text-amber-800",
        "Waiting for PMS confirmation",
        res.message || "The PMS did not respond in time. The charge was NOT retried automatically."
      );
      $("#room-verify").classList.remove("hidden");
      $("#room-back").classList.add("hidden");
    }
  }

  async function confirmRoomCharge() {
    S.room.key = S.room.key || uuid();
    const btn = $("#room-confirm");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Posting to folio…';
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
      showError("room-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Post charge to folio";
    }
  }

  async function verifyRoomCharge() {
    const id = S.room.chargeId || S.order?.guestCharge?.id;
    if (!id) return;
    const btn = $("#room-verify");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Checking…';
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
      showError("room-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Check status with PMS";
    }
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
    $("#done-receipt").href = receipt ? `/receipts/${receipt.id}?print=1` : `/orders/${o.id}`;
    openModal("modal-done");
  }

  // ── Void ─────────────────────────────────────────────────────────────────
  function startVoid() {
    $("#void-reason").value = "";
    $("#void-sup-user").value = "";
    $("#void-sup-pass").value = "";
    $("#void-supervisor").classList.toggle("hidden", boot.can.void);
    showError("void-error", null);
    openModal("modal-void");
  }

  async function submitVoid() {
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
      showError("void-error", err.message);
    }
  }

  // ── Notes ────────────────────────────────────────────────────────────────
  function startNote(itemId) {
    S.note.itemId = itemId;
    const current = itemId ? S.order.items.find((i) => String(i.id) === String(itemId))?.notes : S.order.notes;
    $("#note-title").textContent = itemId ? "Item note" : "Order note";
    $("#note-text").value = current || "";
    showError("note-error", null);
    openModal("modal-note");
  }

  async function saveNote() {
    try {
      const notes = $("#note-text").value;
      const res = S.note.itemId
        ? await api("PATCH", `/api/orders/${S.order.id}/items/${S.note.itemId}`, { notes })
        : await api("PATCH", `/api/orders/${S.order.id}`, { notes, orderType: S.order.orderType, tableOrLocation: S.order.tableOrLocation });
      setOrder(res.order);
      closeModal("modal-note");
    } catch (err) {
      showError("note-error", err.message);
    }
  }

  // ── Discounts ────────────────────────────────────────────────────────────
  async function startDiscount() {
    await run(async () => {
      const res = await api("GET", `/api/orders/${S.order.id}/discounts/available`);
      S.discounts = res.discounts;
      $("#discount-list").innerHTML = S.discounts.length
        ? S.discounts
            .map(
              (d) => `<label class="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                <input type="radio" name="discount" value="${d.id}" class="mt-1">
                <span class="flex-1"><span class="font-medium">${esc(d.name)}</span> <span class="font-mono text-xs text-slate-400">${esc(d.code)}</span>
                  <span class="block text-xs text-slate-500">${d.type === "PERCENTAGE" ? `${Number(d.value)}%` : fmt(d.value)} off ${
                    d.scope === "ITEM" ? "one item" : "the order"
                  }${d.requiresAuthorization ? " · supervisor approval" : ""}${d.description ? ` · ${esc(d.description)}` : ""}</span></span>
              </label>`
            )
            .join("")
        : '<p class="text-sm text-slate-500">No discounts are currently valid for this outlet.</p>';
      $("#discount-item").innerHTML = S.order.items.map((i) => `<option value="${i.id}">${esc(i.productName)} (${fmt(i.lineTotal)})</option>`).join("");
      $("#discount-item-wrap").classList.add("hidden");
      $("#discount-supervisor").classList.add("hidden");
      $("#discount-sup-user").value = "";
      $("#discount-sup-pass").value = "";
      showError("discount-error", null);
      openModal("modal-discount");
    });
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
    const d = S.discounts.find((x) => String(x.id) === String(id));
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
      showError("discount-error", err.message);
    }
  }

  async function removeDiscount(orderDiscountId) {
    await run(async () => setOrder((await api("DELETE", `/api/orders/${S.order.id}/discounts/${orderDiscountId}`)).order));
  }

  // ── Open orders ──────────────────────────────────────────────────────────
  async function showOpenOrders() {
    await run(async () => {
      const res = await api("GET", `/api/pos/open-orders?outletId=${boot.outlet.id}`);
      $("#orders-list").innerHTML = res.orders.length
        ? `<table class="table"><tbody>${res.orders
            .map(
              (o) => `<tr class="cursor-pointer" data-resume="${o.id}">
                <td class="font-mono text-xs">${esc(o.orderNumber)}</td>
                <td>${esc(humanize(o.orderType))}${o.tableOrLocation ? ` · ${esc(o.tableOrLocation)}` : ""}</td>
                <td><span class="badge ${STATUS_COLORS[o.status] || "badge-slate"}">${esc(humanize(o.status))}</span></td>
                <td class="text-right font-medium">${fmt(o.totalAmount)}</td>
                <td class="text-xs text-slate-500">${esc(o.createdBy || "")}</td></tr>`
            )
            .join("")}</tbody></table>`
        : '<p class="p-6 text-center text-sm text-slate-500">No open orders at this outlet.</p>';
      openModal("modal-orders");
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function init() {
    api = window.HotelPOS.api;
    toast = window.HotelPOS.toast;

    $("#order-type").innerHTML = boot.orderTypes.map((t) => `<option value="${t}">${humanize(t)}</option>`).join("");
    $("#order-type").value = DEFAULT_TYPE[boot.outlet.outletType] || "OTHER";
    renderCategories();
    renderProducts();
    renderOrder();
    if (boot.resumeOrderId) loadOrder(boot.resumeOrderId);

    $("#pos-search").addEventListener("input", (e) => {
      S.search = e.target.value;
      renderProducts();
    });
    $("#pos-search").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = S.search.trim().toLowerCase();
      const exact = boot.catalog.find((p) => p.code.toLowerCase() === q);
      const first = exact || filteredProducts()[0];
      if (first) {
        addProduct(first.id);
        e.target.select();
      }
    });
    $("#order-type").addEventListener("change", updateHeader);
    $("#order-location").addEventListener("change", updateHeader);

    document.addEventListener("click", (e) => {
      const t = e.target;
      const cat = t.closest("[data-category]");
      if (cat) {
        S.category = String(cat.dataset.category);
        renderCategories();
        renderProducts();
        return;
      }
      const prod = t.closest("[data-product]");
      if (prod) return addProduct(Number(prod.dataset.product));

      const itemRow = t.closest("[data-item]");
      if (itemRow && t.closest("[data-qty]")) return changeQty(itemRow.dataset.item, Number(t.closest("[data-qty]").dataset.qty));
      if (itemRow && t.closest("[data-item-remove]")) return removeItem(itemRow.dataset.item);
      if (itemRow && t.closest("[data-item-note]")) return startNote(itemRow.dataset.item);

      const discountRemove = t.closest("[data-discount-remove]");
      if (discountRemove) return removeDiscount(discountRemove.dataset.discountRemove);

      const resume = t.closest("[data-resume]");
      if (resume) {
        closeModal("modal-orders");
        return loadOrder(resume.dataset.resume);
      }

      const method = t.closest("[data-method]");
      if (method) {
        S.pay.methodId = method.dataset.method;
        S.pay.key = null;
        renderPaymentMethods();
        updatePaymentForm();
        return;
      }
      const tender = t.closest("[data-tender]");
      if (tender) {
        $("#pay-tendered").value = Number(tender.dataset.tender).toFixed(2);
        return updatePaymentForm();
      }

      if (t.closest("[data-modal-close]")) closeModal(t.closest("[data-modal-close]"));

      const action = t.closest("[data-action]")?.dataset.action;
      if (action === "new-order") newOrder();
      if (action === "open-orders") showOpenOrders();
      if (action === "pay") startPayment();
      if (action === "room-charge") startRoomCharge();
      if (action === "void") startVoid();
      if (action === "order-note") startNote(null);
      if (action === "discount") startDiscount();
    });

    $("#pay-amount").addEventListener("input", () => {
      S.pay.key = null;
      updatePaymentForm();
    });
    $("#pay-tendered").addEventListener("input", updatePaymentForm);
    $("#pay-submit").addEventListener("click", submitPayment);
    $("#room-validate").addEventListener("click", validateRoom);
    $("#room-number").addEventListener("keydown", (e) => e.key === "Enter" && validateRoom());
    $("#room-confirm").addEventListener("click", confirmRoomCharge);
    $("#room-verify").addEventListener("click", verifyRoomCharge);
    $("#room-back").addEventListener("click", () => {
      S.room.token = null;
      S.room.key = null;
      showError("room-error", null);
      $("#room-verify").classList.add("hidden");
      roomStep("lookup");
      $("#room-number").focus();
    });
    $("#void-submit").addEventListener("click", submitVoid);
    $("#note-save").addEventListener("click", saveNote);
    $("#discount-apply").addEventListener("click", applyDiscount);
    $("#discount-list").addEventListener("change", onDiscountSelect);

    // Keyboard shortcuts: / search, F2 pay, F4 room charge, F8 new order, Esc close dialog.
    document.addEventListener("keydown", (e) => {
      const modal = openModalEl();
      if (e.key === "Escape" && modal) return closeModal(modal);
      if (modal) return;
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        $("#pos-search").focus();
      }
      if (e.key === "F2") {
        e.preventDefault();
        if (!document.querySelector('[data-action="pay"]').disabled) startPayment();
      }
      if (e.key === "F4") {
        e.preventDefault();
        if (!document.querySelector('[data-action="room-charge"]').disabled) startRoomCharge();
      }
      if (e.key === "F8") {
        e.preventDefault();
        newOrder();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
