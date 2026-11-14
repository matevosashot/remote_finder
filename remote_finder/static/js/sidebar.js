// Sidebar: Favorites (bookmarks, server-side), Locations (home, /, disks with free space).
import { downloadDropped, dropOn } from "./actions.js";
import { bookmarkMenu } from "./contextmenu.js";
import { ICONS } from "./icons.js";
import { navigate } from "./nav.js";
import { bindDropTarget, draggedPaths, isInternalDrag } from "./selection.js";
import { addBookmark } from "./settings.js";
import { on, state } from "./state.js";
import { basename, fmtSize, h } from "./util.js";
import { fmtLeft, idleLeft, serverWindow, stopServer } from "./fileservers.js";

const BOOKMARK_DROP = "\0bookmark"; // drop target id for "add to Favorites"
const DOWNLOAD_DROP = "\0download"; // the Download slot shown while items are dragged
let root;
let servers; // the Servers section: redrawn on its own as the list and the idle countdowns change

export function initSidebar(el) {
  root = el;
  draw();
  on("bookmarks", draw);
  on("path", markActive);
  on("disks", draw);
  on("fileservers", drawServers);
  setInterval(() => state.fileServers.length && drawServers(), 30_000);
  bindDropTarget(root, (dest, dt, copy) => {
    if (dest === BOOKMARK_DROP) {
      for (const p of draggedPaths(dt) || []) addBookmark(p);
      return;
    }
    if (dest === DOWNLOAD_DROP) return downloadDropped(draggedPaths(dt) || []);
    dropOn(dest, dt, copy);
  }, (e) => {
    if (e.target.closest(".sb-download")) {
      return isInternalDrag(e.dataTransfer) ? { path: DOWNLOAD_DROP, el: e.target.closest(".sb-download") } : null;
    }
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
  const download = h("div", { class: "sb-download", title: "Drop items here to download them" },
    h("span", { class: "sb-icon", html: ICONS.download }), h("span", { class: "sb-label" }, "Download"));
  servers = h("div", { class: "sb-section sb-servers" });
  root.replaceChildren(favs, disks, servers, download);
  drawServers();
  markActive();
}

function drawServers() {
  if (!servers) return;
  servers.hidden = !state.fileServers.length;
  servers.replaceChildren(h("div", { class: "sb-head" }, "File Servers"), ...state.fileServers.map((s) => {
    const left = idleLeft(s);
    const sub = [`${s.requests} req`, left != null ? `${fmtLeft(left)} left` : null].filter(Boolean).join(" · ");
    return h("div", { class: "sb-server", title: `${s.root}\n${s.host}:${s.port} · click for URLs and the log`, onclick: () => serverWindow(s.id) },
      h("span", { class: "sb-server-dot" }),
      h("div", { class: "sb-server-text" },
        h("div", { class: "sb-server-name" }, h("b", {}, `:${s.port}`), ` ${s.name}`),
        h("div", { class: "sb-server-sub" }, sub)),
      h("button", { class: "sb-server-x", title: "Stop this server", onclick: (e) => { e.stopPropagation(); stopServer(s.id); } }, "×"));
  }));
}

function markActive() {
  root?.querySelectorAll(".sb-item").forEach((el) => el.classList.toggle("active", el.dataset.target === state.path));
}
