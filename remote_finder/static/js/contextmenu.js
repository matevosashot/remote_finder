// Right-click menus for items, the folder background and sidebar bookmarks.
import * as A from "./actions.js";
import { duUrl } from "./api.js";
import { showMenu } from "./menu.js";
import { addBookmark, removeBookmark, setOption, sortBy } from "./settings.js";
import { state } from "./state.js";
import { K, canEdit, isArchive, isText, openTab } from "./util.js";

// ---------------------------------------------------------------- menus

export function itemMenu(e, entry) {
  const sel = A.selected();
  const n = sel.length;
  const single = n === 1 ? sel[0] : null;
  const files = sel.filter((s) => s.kind === "file");
  const allText = files.length === n && files.every(isText);
  const inSearch = !!state.search;
  showMenu(e.clientX, e.clientY, [
    { icon: "open", label: "Open", run: () => A.openSelected(), shortcut: `${K.mod}O` },
    { icon: "tab", label: "Open in New Tab", run: () => A.openSeveralInTabs(sel) },
    { icon: "eye", label: "Quick Look", run: () => import("./quicklook.js").then((q) => q.quickLook()), shortcut: "Space" },
    canEdit(single) ? { icon: "edit", label: "Edit", run: () => A.edit(single), shortcut: `${K.mod}E` } : null,
    inSearch && single ? { icon: "goto", label: "Show in Enclosing Folder", run: () => A.revealInFolder(single.path) } : null,
    "-",
    single?.kind === "file" && allText ? { label: "Head…", run: () => A.headTail(single, "head") } : null,
    single?.kind === "file" && allText ? { label: "Tail…", run: () => A.headTail(single, "tail") } : null,
    single?.kind === "file" && !allText ? { label: "Head / Tail…", run: () => A.headTail(single, "tail") } : null,
    "-",
    { icon: "copy", label: n > 1 ? `Copy ${n} Paths` : "Copy Path", run: () => A.copyPaths("path"), shortcut: `${K.alt}${K.mod}C` },
    { label: "Copy Name", run: () => A.copyPaths("name") },
    { label: "Copy Parent Path", run: () => A.copyPaths("parent") },
    "-",
    { icon: "download", label: "Download", run: () => A.download(), shortcut: n > 1 || single?.kind === "dir" ? "as .zip" : "" },
    { icon: "zip", label: n > 1 ? `Compress ${n} Items` : `Compress “${trim(single.name)}”`, run: () => A.compress("zip") },
    { label: "Compress As", submenu: [
      { label: ".zip (max compression)", run: () => A.compress("zip") },
      { label: ".tar.xz (smallest, slow)", run: () => A.compress("tar.xz") },
      { label: ".tar.zst (fast, small)", run: () => A.compress("tar.zst") },
    ] },
    single && isArchive(single) ? { icon: "extract", label: "Extract Here", run: () => A.extract(single) } : null,
    single && isArchive(single) ? { label: "Show Archive Contents…", run: () => A.showArchive(single) } : null,
    "-",
    { icon: "info", label: "Get Info", run: () => A.getInfo(single || undefined), shortcut: `${K.mod}I`, disabled: n !== 1 },
    single?.kind === "dir" ? { label: "Calculate Size", run: () => A.calcSize(single) } : null,
    single?.kind === "dir" ? { icon: "chart", label: "Analyze Disk Usage…", run: () => openTab(duUrl(single.path)) } : null,
    "-",
    { icon: "rename", label: "Rename", run: () => A.rename(single), disabled: !single || inSearch, shortcut: "Enter" },
    { icon: "copy", label: "Copy", run: () => A.copyItems("copy"), shortcut: `${K.mod}C` },
    { icon: "cut", label: "Cut", run: () => A.copyItems("move"), shortcut: `${K.mod}X` },
    single?.kind === "dir" && state.clipboard ? { icon: "paste", label: `Paste Into “${trim(single.name)}”`, run: () => A.paste(single.path) } : null,
    { icon: "trash", label: n > 1 ? `Delete ${n} Items` : "Delete", run: () => A.remove(), shortcut: `${K.mod}⌫` },
    "-",
    single?.kind === "dir" ? { icon: "fav", label: "Add to Sidebar", run: () => addBookmark(single.path), disabled: state.bookmarks.includes(single.path) } : null,
    { icon: "terminal", label: "Open Terminal Here", run: () => A.terminalHere(single?.kind === "dir" ? single.path : undefined) },
    single?.kind === "dir" ? { icon: "claude", label: "Launch Claude Here", run: () => A.launchClaude(single.path) } : null,
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
    { icon: "newfolder", label: "New Folder", run: () => A.newFolder(), disabled: !writable, shortcut: `${K.alt}${K.shift}N` },
    { icon: "newfile", label: "New Text File", run: () => A.newFolder(state.path, true), disabled: !writable },
    { icon: "upload", label: "Upload Files…", run: () => import("./upload.js").then((u) => u.pickFiles(state.path)), disabled: !writable },
    { icon: "upload", label: "Upload Folder…", run: () => import("./upload.js").then((u) => u.pickFiles(state.path, true)), disabled: !writable },
    { icon: "paste", label: state.clipboard ? `Paste ${state.clipboard.paths.length} Item(s)` : "Paste", run: () => A.paste(), disabled: !state.clipboard || !writable, shortcut: `${K.mod}V` },
    "-",
    { icon: "copy", label: "Copy Path of This Folder", run: () => A.copyPaths("path", []) },
    { icon: "info", label: "Get Info", run: () => A.getInfo({ path: state.path, name: state.path, kind: "dir" }) },
    { icon: "chart", label: "Analyze Disk Usage…", run: () => openTab(duUrl(state.path)) },
    { icon: "terminal", label: "Open Terminal Here", run: () => A.terminalHere(state.path) },
    { icon: "claude", label: "Launch Claude Here", run: () => A.launchClaude(state.path) },
    { icon: "fav", label: "Add to Sidebar", run: () => addBookmark(state.path), disabled: state.bookmarks.includes(state.path) },
    "-",
    { label: "View As", submenu: ["icons", "list", "columns", "gallery"].map((v, i) => ({
      label: v[0].toUpperCase() + v.slice(1), checked: state.view === v, shortcut: `${K.alt}${i + 1}`, run: () => setOption("view", v) })) },
    { label: "Sort By", submenu: ["name", "kind", "mtime", "size"].map(sortItem) },
    { label: "Folders on Top", checked: state.foldersFirst, run: () => setOption("foldersFirst", !state.foldersFirst) },
    { label: "Show Hidden Files", checked: state.showHidden, run: () => setOption("showHidden", !state.showHidden), shortcut: `${K.mod}${K.shift}.` },
    { label: "Show Preview", checked: state.preview, run: () => setOption("preview", !state.preview) },
    "-",
    { icon: "restart", label: "Refresh", run: () => import("./nav.js").then((n) => n.refresh()) },
  ]);
}

export function bookmarkMenu(e, path) {
  showMenu(e.clientX, e.clientY, [
    { icon: "open", label: "Open", run: () => import("./nav.js").then((n) => n.navigate(path)) },
    { icon: "tab", label: "Open in New Tab", run: () => A.openInNewTab({ path, kind: "dir" }) },
    { icon: "copy", label: "Copy Path", run: () => A.copyPaths("path", [{ path, name: path }]) },
    { icon: "chart", label: "Analyze Disk Usage…", run: () => openTab(duUrl(path)) },
    { icon: "terminal", label: "Open Terminal Here", run: () => A.terminalHere(path) },
    { icon: "claude", label: "Launch Claude Here", run: () => A.launchClaude(path) },
    "-",
    { icon: "trash", label: "Remove from Sidebar", run: () => removeBookmark(path), disabled: !state.bookmarks.includes(path) },
  ]);
}

/** Right-click on the path bar: a folder in the path, or (path = null) the bar's empty space. */
export function crumbMenu(e, path) {
  if (!path) {
    return showMenu(e.clientX, e.clientY, [
      { icon: "goto", label: "Go to Folder or File…", run: () => import("./keyboard.js").then((k) => k.goToPath()), shortcut: `${K.mod}${K.shift}G` },
      { icon: "copy", label: "Copy Path of This Folder", run: () => A.copyPaths("path", []) },
    ]);
  }
  const dir = { path, name: path === "/" ? "/" : path.split("/").pop(), kind: "dir" };
  showMenu(e.clientX, e.clientY, [
    { icon: "open", label: "Open", run: () => import("./nav.js").then((n) => n.navigate(path)), disabled: path === state.path },
    { icon: "tab", label: "Open in New Tab", run: () => A.openInNewTab(dir) },
    "-",
    { icon: "copy", label: "Copy Path", run: () => A.copyPaths("path", [dir]) },
    "-",
    { icon: "info", label: "Get Info", run: () => A.getInfo(dir) },
    { label: "Calculate Size", run: () => A.calcSize(dir) },
    { icon: "chart", label: "Analyze Disk Usage…", run: () => openTab(duUrl(path)) },
    "-",
    { icon: "terminal", label: "Open Terminal Here", run: () => A.terminalHere(path) },
    { icon: "claude", label: "Launch Claude Here", run: () => A.launchClaude(path) },
    { icon: "fav", label: "Add to Sidebar", run: () => addBookmark(path), disabled: state.bookmarks.includes(path) },
  ]);
}

const trim = (s) => (s.length > 28 ? s.slice(0, 25) + "…" : s);
