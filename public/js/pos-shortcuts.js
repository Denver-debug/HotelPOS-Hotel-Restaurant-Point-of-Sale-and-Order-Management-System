// Keyboard shortcut registry for the POS terminal.
//
// One keydown listener dispatches every shortcut, and the same registry renders the
// on-screen key badges (elements with data-shortcut="<id>") and the F1 help overlay,
// so what the cashier sees always matches what the keys do.
//
//   HotelPOS.shortcuts.register({ id, keys: ["F2"], scope, group, label, run, enabled })
//     scope: "global" (no dialog open) | "modal" (any dialog) | "<dialog id>"
//     run:   omitted for documentation-only rows handled by a local listener
//
// Keys deliberately never bound: F5, F11, F12, Ctrl+R, Ctrl+0/+/- (Electron menu roles
// and browser reload/zoom/devtools) and Alt+F/E/D/Left/Right (browser menus/history).
(function () {
  "use strict";

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const HINTS_KEY = "hotelpos.pos.hints";
  const entries = [];
  const byId = new Map();

  const storage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* private mode: the preference just isn't remembered */
      }
    },
  };

  let hintsOn = storage.get(HINTS_KEY) !== "off";

  // ── Combo normalisation ──────────────────────────────────────────────────
  const NAMED = {
    NumpadAdd: "+",
    NumpadSubtract: "-",
    NumpadMultiply: "*",
    NumpadDivide: "/",
    NumpadEnter: "Enter",
    NumpadDecimal: ".",
  };
  const SINGLE_SYMBOL = /^[^A-Za-z0-9]$/;

  // KeyboardEvent → canonical combo such as "F2", "Shift+F9", "Alt+1", "Ctrl+P", "+", "Delete".
  function comboOf(e) {
    if (e.getModifierState && e.getModifierState("AltGraph")) return null; // typing a character
    let key = NAMED[e.code] || e.key;
    if (!key || key === "Unidentified" || ["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
    const ctrl = e.ctrlKey || (IS_MAC && e.metaKey);
    const alt = e.altKey;
    // Alt/Ctrl change e.key on some layouts (macOS Option+1 = "¡"); use the physical key.
    if (ctrl || alt) {
      const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(e.code || "");
      if (m) key = m[1] || m[2] || m[3];
    }
    if (key.length === 1) key = key.toUpperCase();
    if (key === " ") key = "Space";
    const parts = [];
    if (ctrl) parts.push("Ctrl");
    if (alt) parts.push("Alt");
    // Shift is part of symbols like "?", "+" and "*", and of capital letters.
    if (e.shiftKey && !(key.length === 1 && (SINGLE_SYMBOL.test(key) || /[A-Z]/.test(key)) && !ctrl && !alt)) parts.push("Shift");
    parts.push(key);
    return parts.join("+");
  }

  const LABELS = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Delete: "Del",
    Escape: "Esc",
    Space: "Space",
  };
  const MODIFIER_LABELS = IS_MAC ? { Ctrl: "⌘", Alt: "⌥", Shift: "⇧" } : {};
  // "Alt+ArrowUp" → "Alt+↑". A lone "+" would split into two empty parts, so it is returned as is.
  // compact (button badges): "Shift+F9" → "⇧F9", the symbol printed on the Shift key itself.
  function displayKey(combo, { compact = false } = {}) {
    if (combo === "+") return "+";
    const text = combo
      .split("+")
      .map((p) => MODIFIER_LABELS[p] || LABELS[p] || p)
      .join(IS_MAC ? "" : "+");
    return compact ? text.replace(/^Shift\+/, "⇧") : text;
  }

  const isTyping = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el.tagName !== "INPUT") return false;
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color"].includes(el.type);
  };
  // Bare keys (letters, digits, + - * / ? [ ] Delete) would steal characters from a text field.
  const allowedWhileTyping = (combo) => /(^|\+)F\d{1,2}$/.test(combo) || /^(Ctrl|Alt)\+/.test(combo) || combo === "Escape";

  // ── Registry ─────────────────────────────────────────────────────────────
  function register(def) {
    const entry = {
      scope: "global",
      group: "General",
      enabled: () => true,
      whenTyping: undefined, // true | false | (activeElement, combo) => boolean | undefined (auto)
      hidden: false,
      ...def,
      keys: [].concat(def.keys || []),
    };
    entries.push(entry);
    if (entry.id) byId.set(entry.id, entry);
    return entry;
  }

  const activeModal = () => document.querySelector(".pos-modal.flex");
  const confirmOpen = () => document.querySelector("#confirm-modal.flex");

  function candidates(scopeId) {
    if (scopeId) return entries.filter((e) => e.run && (e.scope === scopeId || e.scope === "modal"));
    return entries.filter((e) => e.run && e.scope === "global");
  }

  function onKeydown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (confirmOpen()) return; // the shared confirm dialog handles its own keys
    const combo = comboOf(e);
    if (!combo) return;
    const modal = activeModal();
    const typing = isTyping(document.activeElement);
    // Dialog-specific entries win over the generic "any dialog" ones.
    const list = candidates(modal ? modal.id : null).sort((a, b) => (a.scope === "modal") - (b.scope === "modal"));
    for (const entry of list) {
      if (!entry.keys.includes(combo)) continue;
      const rule = entry.whenTyping ?? allowedWhileTyping(combo);
      const okTyping = typeof rule === "function" ? rule(document.activeElement, combo) : rule;
      if (typing && !okTyping) continue;
      if (!entry.enabled()) {
        // Swallow disabled function keys so the browser doesn't act on them (F3 find, F7 caret…).
        if (/(^|\+)F\d{1,2}$/.test(combo) || combo === "Ctrl+P") e.preventDefault();
        return;
      }
      const result = entry.run(e, combo);
      if (result !== false) e.preventDefault();
      return;
    }
    // Function keys the POS owns must not fall through to the browser while a dialog is open
    // (F1 help page, F3 find, F7 caret browsing, F10 menu bar). F5/F11/F12 stay with the browser.
    if (/^(Shift\+)?F([1-46-9]|10)$/.test(combo) || combo === "Ctrl+P") e.preventDefault();
  }

  // ── Visible hints ────────────────────────────────────────────────────────
  const kbd = (combo, extra = "") =>
    `<kbd class="kbd pos-hint ${extra}" title="${escapeHtml(displayKey(combo))}">${escapeHtml(displayKey(combo, { compact: true }))}</kbd>`;
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const keysOf = (id) => byId.get(id)?.keys || [];
  const ariaKeys = (keys) => keys.filter((k) => k !== "=").join(" ");

  // Badge HTML for an entry's primary key (or every listed key with { all: true }).
  function hint(id, { all = false, extra = "" } = {}) {
    const keys = keysOf(id).filter((k) => k !== "=");
    if (!keys.length) return "";
    return (all ? keys : keys.slice(0, 1)).map((k) => kbd(k, extra)).join(" ");
  }

  // Badges for every shortcut-aware element under root (idempotent, safe to call after re-renders):
  //   data-shortcut="id"        sets aria-keyshortcuts and shows the badge in a [data-kbd-slot]
  //                             child or at the end of the element (data-shortcut-hint="none" | "all")
  //   data-kbd-for="id [id…]"   a standalone label (for selects/inputs that cannot hold children),
  //                             optional data-kbd-all and data-label="text after the keys"
  function renderHints(root = document) {
    root.querySelectorAll("[data-shortcut]").forEach((el) => {
      const entry = byId.get(el.dataset.shortcut);
      if (!entry) return;
      el.setAttribute("aria-keyshortcuts", ariaKeys(entry.keys));
      if (el.dataset.shortcutHint === "none") return;
      el.querySelectorAll(":scope > kbd[data-auto-kbd]").forEach((k) => k.remove());
      const slot = el.querySelector("[data-kbd-slot]");
      const html = hint(entry.id, { all: el.dataset.shortcutHint === "all" }).replace(/<kbd /g, "<kbd data-auto-kbd ");
      if (slot) slot.innerHTML = html;
      else el.insertAdjacentHTML("beforeend", html);
    });
    root.querySelectorAll("[data-kbd-for]").forEach((el) => {
      const all = "kbdAll" in el.dataset;
      const html = el.dataset.kbdFor
        .split(/\s+/)
        .map((id) => hint(id, { all }))
        .join(" ");
      el.innerHTML = html + (el.dataset.label ? ` <span>${escapeHtml(el.dataset.label)}</span>` : "");
    });
  }

  function setHints(on) {
    hintsOn = Boolean(on);
    storage.set(HINTS_KEY, hintsOn ? "on" : "off");
    document.body.classList.toggle("pos-hints-off", !hintsOn);
  }

  // ── Help overlay ─────────────────────────────────────────────────────────
  const GROUP_ORDER = ["General", "Products & search", "Order lines", "Order", "Settlement", "Dialogs", "Payment dialog"];
  function renderHelp(container) {
    const groups = new Map();
    for (const e of entries) {
      if (e.hidden || !e.label) continue;
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }
    const rank = (g) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
    const ordered = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
    container.innerHTML = ordered
      .map((g) => {
        const rows = groups
          .get(g)
          .map((e) => {
            const enabled = !e.run || e.enabled();
            const keys = e.display || e.keys.filter((k) => k !== "=").map((k) => `<kbd class="kbd">${escapeHtml(displayKey(k))}</kbd>`).join(' <span class="text-slate-400">or</span> ');
            return `<li class="flex items-center justify-between gap-3 py-1.5 ${enabled ? "" : "opacity-50"}">
              <span class="text-sm text-slate-700">${escapeHtml(e.label)}</span>
              <span class="flex shrink-0 flex-wrap items-center justify-end gap-1 text-slate-800">${keys}</span></li>`;
          })
          .join("");
        return `<section class="break-inside-avoid"><h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(g)}</h3>
          <ul class="mb-4 divide-y divide-slate-100">${rows}</ul></section>`;
      })
      .join("");
  }

  // Raw <kbd> markup for documentation-only rows (e.g. "3*CODE" then Enter).
  const keyChips = (...parts) => parts.map((p) => `<kbd class="kbd">${escapeHtml(p)}</kbd>`).join(" ");

  function init() {
    document.body.classList.toggle("pos-hints-off", !hintsOn);
    document.addEventListener("keydown", onKeydown);
  }

  window.HotelPOS = window.HotelPOS || {};
  window.HotelPOS.shortcuts = {
    register,
    renderHints,
    renderHelp,
    hint,
    keyChips,
    display: displayKey,
    comboOf,
    setHints,
    get hintsOn() {
      return hintsOn;
    },
    init,
  };
})();
