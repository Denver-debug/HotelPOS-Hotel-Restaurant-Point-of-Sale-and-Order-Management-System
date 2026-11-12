# POS terminal keyboard shortcuts

Every POS function can be done from the keyboard. Press **F1** (or **?**) on the terminal to see this list live. Shortcuts that don't apply to the current order are greyed out there.

Each button, field and dialog shows its key on a small badge. On badges, **⇧** means Shift. Touch-only stations can hide the badges with the "Show key badges on buttons" switch in the F1 overlay. The setting is remembered on that terminal.

The shortcuts are defined once in `public/js/pos-terminal.js` (`registerShortcuts()`). `public/js/pos-shortcuts.js` dispatches them and draws the badges and the overlay from that same list, so this page, the badges and the behaviour can't drift apart.

## General

| Keys | Action |
|---|---|
| F1 or ? | Show all keyboard shortcuts |
| Alt+O | Switch outlet |
| Ctrl+P | Reprint the last receipt |

## Products and search

| Keys | Action |
|---|---|
| F3 or / | Search or scan a product |
| Enter (in search) | Add the exact product code, or the first match |
| 3*CODE, then Enter | Add several at once. Typing `3*` and then tapping a tile also adds 3. |
| Esc (in search) | Clear the search; press again to leave the box |
| A–Z, 0–9 | Start typing anywhere to search. Barcode scanners work without clicking the box first. |
| ↓ (from search), arrows, Home, End | Move between product tiles |
| Enter or Space | Add the focused product |
| Alt+0 | Category: All |
| Alt+1 … Alt+9 | Categories 1–9 |
| [ and ] | Previous and next category |

## Order lines

These act on the selected line, which is highlighted with a green bar. The line you last added or changed is selected automatically.

| Keys | Action |
|---|---|
| Alt+↑ / Alt+↓ | Select the previous or next line |
| + / − | Quantity +1 / −1 |
| * | Set the quantity. Decimals are allowed, for example 0.5 kg. |
| Delete | Remove the line |
| F9 | Note on the line |

`+`, `−` and `*` also work from the search box when it is empty, or when its text is fully selected right after a product was added. Delete works from the search box only when it is empty.

## Order

| Keys | Action |
|---|---|
| Shift+F9 | Order note |
| Alt+T | Order type |
| Alt+L | Table / room / location |
| F7 | Apply a discount |
| Shift+F7 | Remove the order discount (or the selected line's discount) |
| F6 | Open orders (resume one) |
| F8 | New order |
| F10 or Shift+Delete | Void the order. This opens the void dialog, which asks for a reason (and a supervisor's approval for cashiers); nothing is voided until you confirm. Shift+Delete works outside text fields and from an empty search box. |

## Settlement

| Keys | Action |
|---|---|
| F2 | Direct payment |
| F4 | Charge to room |

## Dialogs

| Keys | Action |
|---|---|
| Enter | Confirm (the button showing the Enter badge) |
| Esc | Close / cancel |
| Shift+Enter | New line in a note |
| ↑ / ↓, Enter | Open orders: choose, then open. Type to filter. |
| Alt+B | Room charge: use another room |
| P | After a sale: print the receipt |

## Payment dialog

| Keys | Action |
|---|---|
| Alt+1 … Alt+9 | Choose payment method 1–9 (the number is on each method) |
| ↑ / ↓ (in Cash received) | Step through the quick cash amounts |
| Enter | Confirm the payment |

The discount dialog uses the same Alt+1 … Alt+9 keys to choose discount 1–9.

## Keys the POS leaves alone

F5 (reload), F11 (full screen), F12 (developer tools), Ctrl+R and Ctrl+0/+/− (zoom) keep their usual browser and desktop-app meaning. Alt+F, Alt+E, Alt+D and Alt+←/→ are not used, because browsers reserve them for menus and history.
