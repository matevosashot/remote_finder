// Right-click menu (items, background, sidebar) with submenus.
import * as A from "./actions.js";
import { addBookmark, removeBookmark, setOption, sortBy } from "./settings.js";
import { state } from "./state.js";
import { K, canEdit, h, isArchive, isText } from "./util.js";
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

// ---------------------------------------------------------------- menus

export function itemMenu(e, entry) {
  const sel = A.selected();
  const n = sel.length;
  const single = n === 1 ? sel[0] : null;
  const files = sel.filter((s) => s.kind === "file");
  const allText = files.length === n && files.every(isText);
  const inSearch = !!state.search;
  showMenu(e.clientX, e.clientY, [
    { label: "Open", run: () => A.openSelected(), shortcut: `${K.mod}O` },
    { label: "Open in New Tab", run: () => A.openSeveralInTabs(sel) },
    { label: "Quick Look", run: () => import("./quicklook.js").then((q) => q.quickLook()), shortcut: "Space" },
    canEdit(single) ? { label: "Edit", run: () => A.edit(single), shortcut: `${K.mod}E` } : null,
    inSearch && single ? { label: "Show in Enclosing Folder", run: () => A.revealInFolder(single.path) } : null,
    "-",
    single?.kind === "file" && allText ? { label: "Head…", run: () => A.headTail(single, "head") } : null,
    single?.kind === "file" && allText ? { label: "Tail…", run: () => A.headTail(single, "tail") } : null,
    single?.kind === "file" && !allText ? { label: "Head / Tail…", run: () => A.headTail(single, "tail") } : null,
    "-",
    { label: n > 1 ? `Copy ${n} Paths` : "Copy Path", run: () => A.copyPaths("path"), shortcut: `${K.alt}${K.mod}C` },
    { label: "Copy Name", run: () => A.copyPaths("name") },
    { label: "Copy Parent Path", run: () => A.copyPaths("parent") },
    "-",
    { label: "Download", run: () => A.download(), shortcut: n > 1 || single?.kind === "dir" ? "as .zip" : "" },
    { label: n > 1 ? `Compress ${n} Items` : `Compress “${trim(single.name)}”`, run: () => A.compress("zip") },
    { label: "Compress As", submenu: [
      { label: ".zip (max compression)", run: () => A.compress("zip") },
      { label: ".tar.xz (smallest, slow)", run: () => A.compress("tar.xz") },
      { label: ".tar.zst (fast, small)", run: () => A.compress("tar.zst") },
    ] },
    single && isArchive(single) ? { label: "Extract Here", run: () => A.extract(single) } : null,
    single && isArchive(single) ? { label: "Show Archive Contents…", run: () => A.showArchive(single) } : null,
    "-",
    { label: "Get Info", run: () => A.getInfo(single || undefined), shortcut: `${K.mod}I`, disabled: n !== 1 },
    single?.kind === "dir" ? { label: "Calculate Size", run: () => A.calcSize(single) } : null,
    "-",
    { label: "Rename", run: () => A.rename(single), disabled: !single || inSearch, shortcut: "Enter" },
    { label: "Copy", run: () => A.copyItems("copy"), shortcut: `${K.mod}C` },
    { label: "Cut", run: () => A.copyItems("move"), shortcut: `${K.mod}X` },
    single?.kind === "dir" && state.clipboard ? { label: `Paste Into “${trim(single.name)}”`, run: () => A.paste(single.path) } : null,
    { label: n > 1 ? `Delete ${n} Items` : "Delete", run: () => A.remove(), shortcut: `${K.mod}⌫` },
    "-",
    single?.kind === "dir" ? { label: "Add to Sidebar", run: () => addBookmark(single.path), disabled: state.bookmarks.includes(single.path) } : null,
    { label: "Open Terminal Here", run: () => A.terminalHere(single?.kind === "dir" ? single.path : undefined) },
  ]);
}

export function backgroundMenu(e) {
  const sortItem = (key) => ({
    label: { name: "Name", mtime: "Date Modified", size: "Size", kind: "Kind" }[key],
    checked: state.sort.key === key,
    run: () => sortBy(key),
  });
  const writable = state.listing?.writable && !state.search;
  showMenu(e.clientX, e.clientY, [
    { label: "New Folder", run: () => A.newFolder(), disabled: !writable, shortcut: `${K.alt}${K.shift}N` },
    { label: "New Text File", run: () => A.newFolder(state.path, true), disabled: !writable },
    { label: "Upload Files…", run: () => import("./upload.js").then((u) => u.pickFiles(state.path)), disabled: !writable },
    { label: "Upload Folder…", run: () => import("./upload.js").then((u) => u.pickFiles(state.path, true)), disabled: !writable },
    { label: state.clipboard ? `Paste ${state.clipboard.paths.length} Item(s)` : "Paste", run: () => A.paste(), disabled: !state.clipboard || !writable, shortcut: `${K.mod}V` },
    "-",
    { label: "Copy Path of This Folder", run: () => A.copyPaths("path", []) },
    { label: "Get Info", run: () => A.getInfo({ path: state.path, name: state.path, kind: "dir" }) },
    { label: "Open Terminal Here", run: () => A.terminalHere(state.path) },
    { label: "Add to Sidebar", run: () => addBookmark(state.path), disabled: state.bookmarks.includes(state.path) },
    "-",
    { label: "View As", submenu: ["icons", "list", "columns", "gallery"].map((v, i) => ({
      label: v[0].toUpperCase() + v.slice(1), checked: state.view === v, shortcut: `${K.alt}${i + 1}`, run: () => setOption("view", v) })) },
    { label: "Sort By", submenu: ["name", "kind", "mtime", "size"].map(sortItem) },
    { label: "Folders on Top", checked: state.foldersFirst, run: () => setOption("foldersFirst", !state.foldersFirst) },
    { label: "Show Hidden Files", checked: state.showHidden, run: () => setOption("showHidden", !state.showHidden), shortcut: `${K.mod}${K.shift}.` },
    { label: "Show Preview", checked: state.preview, run: () => setOption("preview", !state.preview) },
    "-",
    { label: "Refresh", run: () => import("./nav.js").then((n) => n.refresh()) },
  ]);
}

export function bookmarkMenu(e, path) {
  showMenu(e.clientX, e.clientY, [
    { label: "Open", run: () => import("./nav.js").then((n) => n.navigate(path)) },
    { label: "Open in New Tab", run: () => A.openInNewTab({ path, kind: "dir" }) },
    { label: "Copy Path", run: () => A.copyPaths("path", [{ path, name: path }]) },
    { label: "Open Terminal Here", run: () => A.terminalHere(path) },
    "-",
    { label: "Remove from Sidebar", run: () => removeBookmark(path), disabled: !state.bookmarks.includes(path) },
  ]);
}

const trim = (s) => (s.length > 28 ? s.slice(0, 25) + "…" : s);
