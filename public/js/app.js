// Shared front-end behaviour: CSRF-aware fetch, confirmation dialogs, toasts,
// sidebar toggle and submit loading states. No framework required.
(function () {
  "use strict";

  const csrfToken = () => document.querySelector('meta[name="csrf-token"]')?.content || "";

  // JSON API helper. Resolves with the parsed body; rejects with an Error carrying `status` and `body`.
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrfToken() },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  function toast(message, type = "info") {
    const root = document.getElementById("toast-root");
    if (!root) return alert(message);
    const colors = {
      success: "bg-emerald-600",
      error: "bg-rose-600",
      warning: "bg-amber-600",
      info: "bg-slate-800",
    };
    const el = document.createElement("div");
    el.className = `pointer-events-auto max-w-sm rounded-lg px-4 py-3 text-sm text-white shadow-lg ${colors[type] || colors.info}`;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? 7000 : 4000);
  }

  // Confirmation dialog returning a promise<boolean>. Focus stays inside it (Tab cycles between
  // Cancel and Confirm) and returns to whatever was focused before it opened.
  function confirmDialog(message, { okLabel = "Confirm", danger = true } = {}) {
    const modal = document.getElementById("confirm-modal");
    if (!modal) return Promise.resolve(window.confirm(message));
    const returnTo = document.activeElement;
    modal.querySelector("#confirm-message").textContent = message;
    const ok = modal.querySelector("[data-confirm-ok]");
    const cancel = modal.querySelector("[data-confirm-cancel]");
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    ok.focus();
    return new Promise((resolve) => {
      const close = (result) => {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
        if (returnTo && document.contains(returnTo)) returnTo.focus();
        resolve(result);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close(false);
        } else if (e.key === "Tab") {
          e.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      };
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
    });
  }

  // data-confirm-when='[name="status"]=INACTIVE' (or !=) limits the question to that case,
  // e.g. only when a form is about to deactivate something.
  function confirmApplies(form) {
    const rule = form.dataset.confirmWhen;
    if (!rule) return true;
    // The selector is an attribute selector, so split after its closing "]".
    const m = /^(.+?\])\s*(!?=)\s*(.*)$/.exec(rule);
    if (!m) return true;
    let value;
    try {
      value = form.querySelector(m[1])?.value ?? "";
    } catch {
      return true; // a broken rule asks rather than silently skipping the question
    }
    return m[2] === "=" ? value === m[3] : value !== m[3];
  }

  // Forms with data-confirm ask first; all forms disable their submit buttons while posting.
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.confirm && !form.dataset.confirmed && confirmApplies(form)) {
      e.preventDefault();
      const yes = await confirmDialog(form.dataset.confirm, { okLabel: form.dataset.confirmLabel || "Confirm", danger: form.dataset.confirmDanger !== "false" });
      if (yes) {
        form.dataset.confirmed = "1";
        form.requestSubmit(e.submitter || undefined);
      }
      return;
    }
    // Only posting forms lock their buttons (prevents double submits). GET filter forms don't:
    // the page is restored from the back/forward cache with the buttons still disabled.
    if ((form.method || "get").toLowerCase() !== "post") return;
    form.querySelectorAll('button[type="submit"], button:not([type])').forEach((btn) => {
      setTimeout(() => {
        btn.disabled = true;
        if (btn.dataset.loadingText) btn.textContent = btn.dataset.loadingText;
      }, 0);
    });
  });

  // Back/forward cache: re-enable buttons a submit disabled before the page was left.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    document.querySelectorAll("form button[disabled]").forEach((btn) => {
      if (!btn.hasAttribute("data-keep-disabled")) btn.disabled = false;
    });
  });

  // ── Sidebar (phones/tablets): hidden = off-screen AND inert, so its links leave the tab order.
  const desktop = window.matchMedia("(min-width: 1024px)");
  function setSidebar(open) {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    sidebar.classList.toggle("-translate-x-full", !open);
    document.getElementById("sidebar-backdrop")?.classList.toggle("hidden", !open);
    sidebar.inert = !open && !desktop.matches;
    document.querySelectorAll("[data-sidebar-open]").forEach((b) => b.setAttribute("aria-expanded", String(open)));
    if (open) sidebar.querySelector("a, button")?.focus();
  }
  document.addEventListener("DOMContentLoaded", () => setSidebar(false));
  desktop.addEventListener("change", () => setSidebar(false));
  document.addEventListener("keydown", (e) => {
    const sidebar = document.getElementById("sidebar");
    if (e.key === "Escape" && sidebar && !desktop.matches && !sidebar.classList.contains("-translate-x-full")) {
      setSidebar(false);
      document.querySelector("[data-sidebar-open]")?.focus();
    }
  });

  document.addEventListener("click", (e) => {
    const dismiss = e.target.closest("[data-dismiss]");
    if (dismiss) dismiss.closest("[data-dismissible]")?.remove();

    if (e.target.closest("[data-sidebar-open]")) setSidebar(true);
    if (e.target.closest("[data-sidebar-close]")) setSidebar(false);

    if (e.target.closest("[data-history-back]")) history.back();

    // Copy a field's value (e.g. a newly issued API key) to the clipboard.
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      const field = document.querySelector(copyBtn.dataset.copy);
      if (field) {
        field.select();
        (navigator.clipboard ? navigator.clipboard.writeText(field.value) : Promise.reject())
          .catch(() => document.execCommand("copy"))
          .finally(() => toast("Copied to the clipboard.", "success"));
      }
    }

    const printBtn = e.target.closest("[data-print]");
    if (printBtn) window.print();

    // Show/hide toggle next to a password field.
    const toggle = e.target.closest("[data-toggle-password]");
    if (toggle) {
      const input = document.getElementById(toggle.dataset.togglePassword);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    }
  });

  document.addEventListener("focusin", (e) => {
    if (e.target.matches?.("[data-select-on-focus]")) e.target.select();
  });

  // Auto-submit filter selects marked data-autosubmit.
  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-autosubmit]")) e.target.form?.requestSubmit();
  });

  // Merge: page scripts (e.g. pos-shortcuts.js) may have attached their own members first.
  window.HotelPOS = Object.assign(window.HotelPOS || {}, { api, toast, confirm: confirmDialog, csrfToken });
})();
