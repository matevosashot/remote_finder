// Every user operation lives here so the context menu, toolbar and keyboard share them.
import { editorUrl, entryUrl, folderUrl, get, post, qs, rawUrl, tailUrl } from "./api.js";
import { confirmDialog, modal, resolveConflicts, runJob, toast, toastError } from "./dialogs.js";
import { navigate, refresh } from "./nav.js";
import { draggedPaths } from "./selection.js";
import { emit, selectedEntries, state } from "./state.js";
import { K, basename, clickLink, copyText, dirname, fmtDateFull, fmtSize, h, isInside, join, kindLabel, mod, openTab, stemLength } from "./util.js";

export const selected = selectedEntries;
const one = () => (state.selection.size === 1 ? selected()[0] : null);
const MAX_TABS = 12; // opening more at once is almost certainly a mistake

// ---------------------------------------------------------------- open

export function open(entry, e = {}) {
  if (!entry) return;
  if (entry.kind === "dir") {
    if (mod(e)) return openTab(folderUrl(entry.path));
    return navigate(entry.path);
  }
  openInNewTab(entry);
}

export function openSelected() {
  const items = selected();
  const dirs = items.filter((i) => i.kind === "dir");
  const files = items.filter((i) => i.kind !== "dir");
  files.slice(0, MAX_TABS).forEach(openInNewTab);
  if (dirs.length === 1 && !files.length) navigate(dirs[0].path);
  else dirs.slice(0, MAX_TABS).forEach(openInNewTab);
  if (files.length > MAX_TABS) toast(`Opened the first ${MAX_TABS} of ${files.length} files`);
}

export const openInNewTab = (entry) => openTab(entryUrl(entry));
export const openSeveralInTabs = (items) => items.slice(0, MAX_TABS).forEach(openInNewTab);
export const edit = (entry) => openTab(editorUrl(entry.path));
export const headTail = (entry, mode) => openTab(tailUrl(entry.path, mode));

export function revealInFolder(path) {
  return navigate(dirname(path), { select: path });
}

// ---------------------------------------------------------------- copy path / name

export async function copyPaths(kind = "path", items = selected()) {
  if (!items.length) items = [{ path: state.path, name: basename(state.path) }];
  const text = items.map((i) => (kind === "name" ? i.name : kind === "parent" ? dirname(i.path) : i.path)).join("\n");
  if (await copyText(text)) toast(items.length > 1 ? `Copied ${items.length} ${kind}s` : `Copied ${text}`, { timeout: 2000 });
  else toastError("Clipboard is not available");
}

// ---------------------------------------------------------------- download

export function download(items = selected()) {
  if (!items.length) return;
  clickLink(items.length === 1 && items[0].kind === "file"
    ? rawUrl(items[0].path, { download: 1 })
    : `/api/download?${qs({ paths: items.map((i) => i.path) })}`);
}

// ---------------------------------------------------------------- create / rename / delete

export async function newFolder(dir = state.path, file = false) {
  try {
    const { path } = await post("/api/mkdir", { dir, name: file ? "untitled.txt" : "untitled folder", file });
    if (dir === state.path) {
      await refresh({ select: path });
      rename(state.items.find((i) => i.path === path));
    }
  } catch (e) { toastError(e); }
}

/** Finder-style inline rename: an input overlaid on the item's name. */
export function rename(entry = one()) {
  if (!entry) return;
  emit("reveal", entry.path);
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-path="${CSS.escape(entry.path)}"] .name`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const input = h("input", {
      class: "rename-input", value: entry.name, spellcheck: false,
      style: { left: `${r.left - 3}px`, top: `${r.top - 2}px`, width: `${Math.max(r.width + 24, 140)}px`, height: `${r.height + 4}px` },
    });
    document.body.append(input);
    input.focus();
    input.setSelectionRange(0, entry.kind === "dir" ? entry.name.length : stemLength(entry.name));
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.remove();
      if (!commit || !name || name === entry.name) return;
      try {
        const res = await post("/api/rename", { path: entry.path, name });
        await refresh({ select: res.path });
      } catch (e) { toastError(e); }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  });
}

export async function remove(items = selected()) {
  if (!items.length) return;
  const names = items.map((i) => i.name);
  const msg = items.length === 1
    ? `Are you sure you want to permanently delete “${names[0]}”?`
    : `Are you sure you want to permanently delete these ${items.length} items?`;
  const detail = items.length > 1 ? h("ul", {}, names.slice(0, 12).map((n) => h("li", {}, n)), items.length > 12 ? h("li", {}, `… and ${items.length - 12} more`) : null) : null;
  if (!(await confirmDialog("Delete", msg, { ok: "Delete", danger: true, detail }))) return;
  // pick a neighbour to select after deletion (Finder keeps the cursor in place)
  const idx = state.items.findIndex((i) => i.path === items[0].path);
  const gone = new Set(items.map((i) => i.path));
  const next = state.items.slice(idx).find((i) => !gone.has(i.path)) || state.items.slice(0, idx).reverse().find((i) => !gone.has(i.path));
  await runJob(post("/api/delete", { paths: items.map((i) => i.path) }), { label: `Deleting ${items.length} item(s)` }).catch(() => {});
  await refresh({ select: next?.path });
}

// ---------------------------------------------------------------- clipboard, move/copy

export function copyItems(op = "copy", items = selected()) {
  if (!items.length) return;
  state.clipboard = { op, paths: items.map((i) => i.path) };
  emit("clipboard");
  toast(`${op === "move" ? "Cut" : "Copied"} ${items.length} item(s) — paste with ${K.mod}V`, { timeout: 2000 });
}

export async function paste(dest = state.path) {
  const cb = state.clipboard;
  if (!cb) return;
  await transfer(cb.op, cb.paths, dest);
  if (cb.op === "move") { state.clipboard = null; emit("clipboard"); }
}

export async function transfer(op, paths, dest) {
  paths = paths.filter((p) => !(op === "move" && dirname(p) === dest));
  if (!paths.length) return;
  if (paths.some((p) => isInside(dest, p))) return toastError("Can’t put a folder inside itself");
  const names = paths.map(basename);
  let decisions = {};
  try {
    const { conflicts } = await post("/api/conflicts", { dest, names });
    // copying an item onto itself always makes "name 2", no question needed
    const real = conflicts.filter((n) => !(op === "copy" && paths.includes(join(dest, n))));
    if (real.length) {
      decisions = await resolveConflicts(real, basename(dest) || "/");
      if (!decisions) return;
    }
  } catch (e) { return toastError(e); }
  const verb = op === "copy" ? "Copying" : "Moving";
  try {
    const job = await runJob(post("/api/transfer", { op, sources: paths, dest, conflict: "keep", decisions }),
      { label: `${verb} ${paths.length} item(s) to “${basename(dest) || "/"}”` });
    if (dest === state.path) await refresh({ select: job.result?.paths });
    else await refresh();
  } catch { await refresh(); }
}

/** Drop handler for views/sidebar/breadcrumbs: internal drags move (copy with Alt/Ctrl); files upload. */
export async function dropOn(dest, dt, copy) {
  const paths = draggedPaths(dt);
  if (paths) return transfer(copy ? "copy" : "move", paths, dest);
  if (dt.files?.length || dt.items?.length) {
    const { uploadDataTransfer } = await import("./upload.js");
    return uploadDataTransfer(dt, dest);
  }
}

// ---------------------------------------------------------------- archives

export async function compress(format = "zip", items = selected()) {
  if (!items.length) return;
  try {
    const job = await runJob(post("/api/compress", { paths: items.map((i) => i.path), format }));
    await refresh({ select: job.result.path });
    toast(`Created ${basename(job.result.path)}`, { timeout: 2500 });
  } catch {}
}

export async function extract(entry = one()) {
  if (!entry) return;
  try {
    const job = await runJob(post("/api/extract", { path: entry.path }));
    await refresh({ select: job.result.path });
  } catch {}
}

export async function showArchive(entry = one()) {
  if (!entry) return;
  let res;
  try { res = await get("/api/archive/list", { path: entry.path }); } catch (e) { return toastError(e); }
  modal((close) => [
    h("h3", {}, entry.name),
    h("p", { class: "muted" }, `${res.count.toLocaleString()} entries${res.truncated ? " (first 5,000 shown)" : ""}`),
    h("div", { class: "dialog-scroll" }, h("table", { class: "info-table" },
      h("tbody", {}, res.items.map((i) => h("tr", {}, h("td", {}, i.name), h("td", { class: "num" }, i.dir ? "" : fmtSize(i.size))))))),
    h("div", { class: "dialog-buttons" },
      h("button", { class: "btn", onclick: () => { close(); extract(entry); } }, "Extract Here"),
      h("button", { class: "btn primary", autofocus: true, onclick: () => close() }, "Done")),
  ], { cls: "wide" });
}

// ---------------------------------------------------------------- info / size

export async function calcSize(entry = one()) {
  if (!entry || entry.kind !== "dir") return;
  try {
    const job = await runJob(post("/api/du", { path: entry.path }), { label: `Calculating size of “${entry.name}”` });
    state.sizes.set(entry.path, job.result.size);
    emit("items");
    toast(`“${entry.name}”: ${fmtSize(job.result.size)} · ${job.result.files.toLocaleString()} files${job.result.errors ? ` · ${job.result.errors} unreadable` : ""}`, { timeout: 6000 });
    return job.result;
  } catch {}
}

export async function getInfo(entry = one() || { path: state.path, name: basename(state.path), kind: "dir" }) {
  let st;
  try { st = await get("/api/stat", { path: entry.path }); } catch (e) { return toastError(e); }
  const sizeCell = h("td", {}, st.kind === "dir" ? (state.sizes.has(st.path) ? fmtSize(state.sizes.get(st.path)) : "--") : `${fmtSize(st.size)} (${st.size.toLocaleString()} bytes)`);
  const rows = [
    ["Kind", kindLabel({ ...entry, ...st, name: st.name })],
    ["Size", sizeCell],
    ["Where", dirname(st.path)],
    ["Created/changed", fmtDateFull(st.ctime)],
    ["Modified", fmtDateFull(st.mtime)],
    ["Accessed", fmtDateFull(st.atime)],
    ["Permissions", `${st.perm}  (${st.octal})`],
    ["Owner", `${st.owner}:${st.group}`],
    st.mime ? ["MIME type", st.mime] : null,
    st.link ? ["Alias to", `${st.target}${st.broken ? " (broken)" : ""}`] : null,
    ["Inode / links", `${st.inode} / ${st.nlink}`],
    ["Access", `${st.readable ? "read" : "no read"} · ${st.writable ? "write" : "no write"}`],
  ].filter(Boolean);
  modal((close) => [
    h("div", { class: "info-head" }, h("h3", {}, st.name)),
    h("table", { class: "info-table" }, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("th", {}, k), v instanceof Node ? v : h("td", {}, v))))),
    h("div", { class: "dialog-buttons" },
      st.kind === "dir" ? h("button", { class: "btn", onclick: async () => {
        sizeCell.textContent = "Calculating…";
        const r = await calcSize({ ...entry, kind: "dir", path: st.path, name: st.name });
        sizeCell.textContent = r ? `${fmtSize(r.size)} · ${r.files.toLocaleString()} files, ${r.dirs.toLocaleString()} folders` : "--";
      } }, "Calculate Size") : null,
      h("button", { class: "btn", onclick: () => copyText(st.path).then(() => toast("Copied path", { timeout: 1500 })) }, "Copy Path"),
      h("button", { class: "btn primary", autofocus: true, onclick: () => close() }, "Done")),
  ], { cls: "wide" });
}

// ---------------------------------------------------------------- terminal

export async function terminalHere(dir) {
  const target = dir || (one()?.kind === "dir" ? one().path : state.path);
  const t = await import("./terminal.js");
  t.openTerminal(target);
}
