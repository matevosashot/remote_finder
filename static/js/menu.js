// Popup menus with submenus (used by the file manager and the disk usage page).
import { h } from "./util.js";

let current = null;

export function closeMenu() {
  current?.remove();
  current = null;
}
document.addEventListener("mousedown", (e) => { if (current && !current.contains(e.target)) closeMenu(); }, true);
document.addEventListener("keydown", (e) => { if (current && e.key === "Escape") { e.stopPropagation(); closeMenu(); } }, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

/** items: [{label, run, shortcut, disabled, submenu:[...], checked}] or "-" separators */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = build(items);
  document.body.append(menu);
  place(menu, x, y);
  current = menu;
}

function build(items) {
  const menu = h("div", { class: "menu", role: "menu" });
  let lastSep = true;
  for (const it of items) {
    if (!it) continue;
    if (it === "-") {
      if (!lastSep) menu.append(h("div", { class: "menu-sep" }));
      lastSep = true;
      continue;
    }
    lastSep = false;
    const row = h("div", { class: `menu-item ${it.disabled ? "disabled" : ""} ${it.submenu ? "has-sub" : ""}`, role: "menuitem" },
      h("span", { class: "menu-check" }, it.checked ? "✓" : ""),
      h("span", { class: "menu-label" }, it.label),
      h("span", { class: "menu-shortcut" }, it.submenu ? "›" : it.shortcut || ""));
    if (it.submenu) {
      let sub = null;
      row.addEventListener("mouseenter", () => {
        menu.querySelectorAll(":scope > .menu-item > .menu").forEach((m) => m.remove());
        sub = build(it.submenu);
        sub.classList.add("submenu");
        row.append(sub);
        const r = row.getBoundingClientRect();
        // the parent menu's backdrop-filter makes it the containing block of position:fixed children,
        // so the submenu's viewport coordinates are converted to the parent menu's origin
        place(sub, r.right - 4, r.top - 5, r.left, menu.getBoundingClientRect());
      });
    } else {
      row.addEventListener("mouseenter", () => menu.querySelectorAll(":scope > .menu-item > .menu").forEach((m) => m.remove()));
      if (!it.disabled) row.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); it.run(); });
    }
    menu.append(row);
  }
  if (menu.lastChild?.classList.contains("menu-sep")) menu.lastChild.remove();
  return menu;
}

/** Put `menu` at viewport point (x, y), flipping left of `flipX` / moving up to stay on screen. */
function place(menu, x, y, flipX, origin = { left: 0, top: 0 }) {
  menu.style.position = "fixed";
  menu.style.left = "0px";
  menu.style.top = "0px";
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > innerWidth - 4) left = (flipX ?? x) - r.width;
  if (top + r.height > innerHeight - 4) top = Math.max(4, innerHeight - r.height - 4);
  menu.style.left = `${Math.max(4, left) - origin.left}px`;
  menu.style.top = `${top - origin.top}px`;
}
