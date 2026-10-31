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

  // Confirmation dialog returning a promise<boolean>.
  function confirmDialog(message, { okLabel = "Confirm", danger = true } = {}) {
    const modal = document.getElementById("confirm-modal");
    if (!modal) return Promise.resolve(window.confirm(message));
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
        resolve(result);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);
      const onKey = (e) => e.key === "Escape" && close(false);
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
    });
  }

  // Forms with data-confirm ask first; all forms disable their submit buttons while posting.
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.confirm && !form.dataset.confirmed) {
      e.preventDefault();
      const yes = await confirmDialog(form.dataset.confirm, { okLabel: form.dataset.confirmLabel || "Confirm", danger: form.dataset.confirmDanger !== "false" });
      if (yes) {
        form.dataset.confirmed = "1";
        form.requestSubmit(e.submitter || undefined);
      }
      return;
    }
    form.querySelectorAll('button[type="submit"], button:not([type])').forEach((btn) => {
      setTimeout(() => {
        btn.disabled = true;
        if (btn.dataset.loadingText) btn.textContent = btn.dataset.loadingText;
      }, 0);
    });
  });

  document.addEventListener("click", (e) => {
    const dismiss = e.target.closest("[data-dismiss]");
    if (dismiss) dismiss.closest("[data-dismissible]")?.remove();

    if (e.target.closest("[data-sidebar-open]")) {
      document.getElementById("sidebar")?.classList.remove("-translate-x-full");
      document.getElementById("sidebar-backdrop")?.classList.remove("hidden");
    }
    if (e.target.closest("[data-sidebar-close]")) {
      document.getElementById("sidebar")?.classList.add("-translate-x-full");
      document.getElementById("sidebar-backdrop")?.classList.add("hidden");
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

  // Auto-submit filter selects marked data-autosubmit.
  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-autosubmit]")) e.target.form?.requestSubmit();
  });

  window.HotelPOS = { api, toast, confirm: confirmDialog, csrfToken };
})();
