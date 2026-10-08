// App shell: toolbar, breadcrumbs, view switching, preview pane, status bar, bootstrap.
import * as A from "./actions.js";
import { get } from "./api.js";
import { backgroundMenu, itemMenu } from "./contextmenu.js";
import { ICONS } from "./icons.js";
import { goToFolder, initKeyboard } from "./keyboard.js";
import { exitSearch, goBack, goForward, navigate, pathFromHash, rebuildItems, startSearch } from "./nav.js";
import { renderPreview } from "./preview.js";
import { bindDropTarget, bindItems } from "./selection.js";
import { loadSettings, setOption } from "./settings.js";
import { initSidebar } from "./sidebar.js";
import { emit, on, selectedEntries, state } from "./state.js";
import { initTerminal, toggleTerminal } from "./terminal.js";
import { K, ancestors, basename, fmtSize, h, isInside } from "./util.js";
import { ColumnsView } from "./views/columns.js";
import { GalleryView } from "./views/gallery.js";
import { IconsView } from "./views/icons.js";
import { ListView } from "./views/list.js";

const VIEWS = { icons: IconsView, list: ListView, columns: ColumnsView, gallery: GalleryView };
let view = null;
const el = {};

function buildShell() {
  const btn = (name, title, onclick, cls = "") => h("button", { class: `tb-btn ${cls}`, title, html: ICONS[name], onclick, "data-btn": name });
  el.back = btn("back", `Back (${K.mod}[)`, goBack);
  el.fwd = btn("fwd", `Forward (${K.mod}])`, goForward);
  el.crumbs = h("div", { class: "crumbs", title: `Double-click to type a path (${K.mod}${K.shift}G)` });
  el.viewSeg = h("div", { class: "seg" }, Object.keys(VIEWS).map((v, i) =>
    btn(v, `${v[0].toUpperCase() + v.slice(1)} (${K.alt}${i + 1})`, () => setOption("view", v))));
  el.size = h("input", { type: "range", class: "size-slider", min: 16, max: 256, step: 4, title: "Icon size",
    oninput: (e) => setOption("iconSize", +e.target.value) });
  el.search = h("input", { class: "search", type: "search", placeholder: "Filter · Enter: search subfolders", spellcheck: false });
  el.preview = btn("preview", "Show preview pane", () => setOption("preview", !state.preview));
  el.hidden = btn("hidden", `Show hidden files (${K.mod}${K.shift}.)`, () => setOption("showHidden", !state.showHidden));

  const toolbar = h("header", { class: "toolbar" },
    h("div", { class: "nav-btns" }, el.back, el.fwd),
    el.crumbs,
    h("div", { class: "spacer" }),
    el.size,
    el.viewSeg,
    h("div", { class: "tb-group" },
      btn("newfolder", `New folder (${K.alt}${K.shift}N)`, () => A.newFolder()),
      btn("upload", "Upload files (drag & drop works too)", () => import("./upload.js").then((u) => u.pickFiles(state.path))),
      el.hidden, el.preview,
      btn("terminal", "Terminal (Ctrl+`)", () => toggleTerminal())),
    h("div", { class: "search-wrap", html: ICONS.search }, el.search));

  el.sidebar = h("aside", { class: "sidebar" });
  el.viewHost = h("div", { class: "view-host" });
  el.pane = h("aside", { class: "preview-pane", hidden: true });
  el.content = h("div", { class: "content" }, el.viewHost, el.pane);
  el.workspace = h("div", { class: "workspace dock-bottom" }, el.content);
  el.statusL = h("span", {});
  el.statusR = h("span", {});
  const status = h("footer", { class: "statusbar" }, el.statusL, h("div", { class: "spacer" }), el.statusR);
  document.body.append(h("div", { class: "app" }, toolbar, h("div", { class: "main-area" }, el.sidebar, el.workspace), status));
}

// ---------------------------------------------------------------- views

const effectiveView = () => (state.search && state.view === "columns" ? "list" : state.view);

function setView(name) {
  if (view?.name === name) return view.render();
  view?.destroy();
  view = new VIEWS[name]();
  el.viewHost.className = `view-host view-${name}`;
  view.mount(el.viewHost);
  view.render();
  if (state.focus) view.reveal(state.focus);
  syncToolbar();
}

function syncToolbar() {
  el.viewSeg.querySelectorAll(".tb-btn").forEach((b) => b.classList.toggle("on", b.dataset.btn === effectiveView()));
  el.size.hidden = effectiveView() !== "icons";
  el.size.value = state.iconSize;
  el.preview.classList.toggle("on", state.preview);
  el.hidden.classList.toggle("on", state.showHidden);
  el.back.disabled = state.historyIdx <= 1;
  el.fwd.disabled = state.historyIdx >= state.historyMax;
  el.pane.hidden = !state.preview || effectiveView() === "columns" || effectiveView() === "gallery";
}

function drawCrumbs() {
  const segs = ancestors(state.path).map((path, i) => ({ path, label: i ? basename(path) : state.host || "/" }));
  el.crumbs.replaceChildren(...segs.flatMap((s, i) => [
    ...(i ? [h("span", { class: "crumb-sep", html: ICONS.chevron })] : []),
    h("button", { class: `crumb ${i === segs.length - 1 ? "last" : ""}`, "data-target": s.path, title: s.path,
      onclick: () => s.path !== state.path && navigate(s.path) },
      i === 0 ? h("span", { class: "crumb-icon", html: ICONS.root }) : null, s.label),
  ]));
  el.crumbs.scrollLeft = el.crumbs.scrollWidth;
}

function updatePane() {
  if (el.pane.hidden) return;
  const sel = selectedEntries();
  const entry = sel.length === 1 ? sel[0] : null;
  if (el.pane._path === entry?.path && entry) return;
  el.pane._path = entry?.path;
  const box = h("div", {});
  el.pane.replaceChildren(box);
  renderPreview(box, entry, "pane");
}

function updateStatus() {
  const n = state.items.filter((i) => i.kind !== "placeholder").length;
  const s = state.selection.size;
  let left;
  if (state.search) {
    left = `${state.search.results.length.toLocaleString()} result(s) for “${state.search.q}” in ${state.search.root}` +
      (state.search.running ? ` — searching… (${state.search.scanned.toLocaleString()} scanned)` : "");
  } else {
    left = `${n.toLocaleString()} item${n === 1 ? "" : "s"}${state.filter ? ` matching “${state.filter}”` : ""}`;
    if (state.listing && !state.listing.writable) left += " · read-only";
  }
  if (s) {
    const bytes = selectedEntries().reduce((a, e) => a + (e.kind === "file" ? e.size : 0), 0);
    left += ` · ${s.toLocaleString()} selected${bytes ? ` (${fmtSize(bytes)})` : ""}`;
  }
  el.statusL.textContent = left;
  const disk = state.disks.filter((d) => isInside(state.path, d.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
  el.statusR.textContent = disk ? `${fmtSize(disk.free)} available on ${disk.mount}` : "";
}

// ---------------------------------------------------------------- wiring

function wire() {
  bindItems(el.viewHost, {
    open: (entry, e) => A.open(entry, e),
    contextmenu: (e, entry) => (entry ? itemMenu(e, entry) : backgroundMenu(e)),
    dropOn: (dest, dt, copy) => A.dropOn(dest, dt, copy),
    bgPath: (e) => view?.bgPathAt?.(e),
    select: (path, e) => (view?.select ? view.select(path, e) : true),
    lookup: (p) => view?.lookup?.(p),
  });
  bindDropTarget(el.crumbs, A.dropOn, (e) => {
    const c = e.target.closest("[data-target]");
    return c ? { path: c.dataset.target, el: c } : null;
  });
  el.crumbs.addEventListener("dblclick", (e) => { if (!e.target.closest(".crumb")) goToFolder(); });

  // filter as you type; Enter searches recursively
  el.search.addEventListener("input", () => {
    if (state.search && !el.search.value) return exitSearch();
    if (state.search) return;
    state.filter = el.search.value;
    rebuildItems();
  });
  el.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && el.search.value.trim()) startSearch(el.search.value.trim());
    else if (e.key === "Escape") {
      el.search.value = "";
      state.filter = "";
      exitSearch();
      rebuildItems();
      el.viewHost.querySelector(".view-bg")?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      el.viewHost.querySelector(".view-bg")?.focus();
      view?.key({ key: "ArrowDown" });
    }
  });

  on("items", () => { view?.render(); updateStatus(); });
  on("selection", () => { view?.updateSelection(); updatePane(); updateStatus(); });
  on("reveal", (p) => view?.reveal(p));
  on("clipboard", () => view?.updateSelection());
  on("path", () => {
    drawCrumbs();
    syncToolbar();
    if (!state.search) el.search.value = "";
    if (view?.name === "columns") view.render();
  });
  on("search", () => { setView(effectiveView()); updateStatus(); });
  on("options", (key) => {
    if (key === "view") setView(effectiveView());
    if (key === "iconSize" && view?.name === "icons") view.render();
    if (key === "preview") { syncToolbar(); el.pane._path = undefined; updatePane(); }
    syncToolbar();
  });

  // stop the browser from opening files dropped outside a target
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());
}

async function main() {
  buildShell();
  const [home] = await Promise.all([get("/api/home").catch(() => ({ home: "/", user: "", host: "" })), loadSettings()]);
  Object.assign(state, home);
  get("/api/disks").then((d) => { state.disks = d; emit("disks"); updateStatus(); }).catch(() => {});
  initSidebar(el.sidebar);
  initTerminal(el.workspace);
  initKeyboard({ getView: () => view, focusSearch: () => { el.search.focus(); el.search.select(); } });
  wire();
  setView(effectiveView());
  state.historyIdx = state.historyMax = 1;
  const start = pathFromHash() || state.home;
  try {
    await navigate(start, { push: false });
  } catch {
    await navigate(state.home, { push: false });
  }
  history.replaceState({ idx: 1 }, "", location.href);
  el.viewHost.querySelector(".view-bg")?.focus();
}

main();
