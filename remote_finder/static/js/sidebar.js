// Sidebar: Favorites (bookmarks, server-side), Locations (home, /, disks with free space).
import { dropOn } from "./actions.js";
import { bookmarkMenu } from "./contextmenu.js";
import { ICONS } from "./icons.js";
import { navigate } from "./nav.js";
import { bindDropTarget, draggedPaths, isInternalDrag } from "./selection.js";
import { addBookmark } from "./settings.js";
import { on, state } from "./state.js";
import { basename, fmtSize, h } from "./util.js";

const BOOKMARK_DROP = "\0bookmark"; // drop target id for "add to Favorites"
let root;

export function initSidebar(el) {
  root = el;
  draw();
  on("bookmarks", draw);
  on("path", markActive);
  on("disks", draw);
  bindDropTarget(root, (dest, dt, copy) => {
    if (dest === BOOKMARK_DROP) {
      for (const p of draggedPaths(dt) || []) addBookmark(p);
      return;
    }
    dropOn(dest, dt, copy);
  }, (e) => {
    const item = e.target.closest("[data-target]");
    if (item) return { path: item.dataset.target, el: item };
    const fav = e.target.closest(".sb-favorites");
    if (fav && isInternalDrag(e.dataTransfer)) return { path: BOOKMARK_DROP, el: fav };
    return null;
  });
}

function link(path, label, icon, extra) {
  const el = h("div", { class: "sb-item", "data-target": path, title: path, onclick: () => navigate(path) },
    h("span", { class: "sb-icon", html: icon }), h("span", { class: "sb-label" }, label), extra || null);
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); bookmarkMenu(e, path); });
  return el;
}

function label(path) {
  if (path === state.home) return state.user || "Home";
  if (path === "/") return "Computer";
  return basename(path);
}

function draw() {
  const favs = h("div", { class: "sb-section sb-favorites" }, h("div", { class: "sb-head" }, "Favorites"),
    state.bookmarks.map((p) => link(p, label(p), p === state.home ? ICONS.home : p === "/" ? ICONS.root : ICONS.star)));
  if (!state.bookmarks.length) favs.append(h("div", { class: "sb-hint" }, "Drag folders here"));
  const disks = h("div", { class: "sb-section" }, h("div", { class: "sb-head" }, "Locations"),
    state.disks.map((d) => {
      const pct = d.total ? (100 * d.used) / d.total : 0;
      return link(d.mount, d.mount === "/" ? `System (${state.host})` : basename(d.mount), ICONS.disk,
        h("div", { class: "sb-disk", title: `${fmtSize(d.free)} free of ${fmtSize(d.total)}` },
          h("div", { class: `sb-disk-fill ${pct > 90 ? "warn" : ""}`, style: { width: `${pct}%` } })));
    }));
  root.replaceChildren(favs, disks);
  markActive();
}

function markActive() {
  root?.querySelectorAll(".sb-item").forEach((el) => el.classList.toggle("active", el.dataset.target === state.path));
}
