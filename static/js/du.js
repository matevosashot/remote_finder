// Disk usage analyzer page: a live scan polled from the server, a tree list and rings/treemap
// charts. "Archive" collects cleanup candidates (hidden and subtracted); nothing is deleted here.
import { ApiError, duUrl, folderUrl, get, pageQuery, post, viewerUrl } from "./api.js";
import { promptDialog, toast, toastError } from "./dialogs.js";
import { Archive } from "./du/archive.js";
import { Chart, Colors, labelOf, sizeOf } from "./du/charts.js";
import { TreeList } from "./du/tree.js";
import { closeMenu, showMenu } from "./menu.js";
import { copyPath } from "./pathbar.js";
import { $, K, ancestors, basename, copyText, dirname, fmtSize, h, isInside, mod, openTab, store } from "./util.js";

const params = new URLSearchParams(location.search);
const root = params.get("path") || "/";
const POLL_MS = 1000;

const S = {
  scan: null,          // {id, ...status}
  focus: isInside(params.get("focus") || root, root) ? params.get("focus") || root : root,
  metric: store.get("du.metric", "disk"),
  depth: store.get("du.depth", 4),
  kind: store.get("du.chart", "rings"),
  expanded: new Set(),
  selected: new Set(),
  anchor: null,        // row index for Shift ranges
  chartTree: null,
  listTree: null,
  hover: null,
};

const colors = new Colors();
const tip = $("#tip");

// ---------------------------------------------------------------- views

const list = new TreeList($("#list"), {
  onSelect: (d, e, i) => select(d, e, i),
  onOpen: (d) => open(d),
  onToggle: (d) => toggle(d),
  onHover: (d, e) => hover(d, e, "list"),
  onContext: (d, e, i) => { if (!S.selected.has(d.path)) select(d, {}, i); menu(d, e); },
  onInclude: (d) => include(d),
});

const chart = new Chart($("#stage"), colors, {
  onSelect: (d, e) => { select(d, e); list.scrollTo(d.path); },
  onOpen: (d) => open(d),
  onUp: () => zoomOut(),
  onHover: (d, e) => hover(d, e, "chart"),
  onContext: (d, e) => { if (d.path && !S.selected.has(d.path)) select(d, {}); menu(d, e); },
});

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { colors.theme(); draw(); });

const archive = new Archive($("#archive"), { root, metric: S.metric, onChange: () => { syncButtons(); refresh(); } });

function draw() {
  chart.render(S.chartTree, { kind: S.kind, metric: S.metric, depth: S.depth, selected: S.selected });
  list.render(S.listTree, { metric: S.metric, expanded: S.expanded, selected: S.selected, colors: chart.colorMap });
  drawHeader();
  syncButtons();
}

function drawHeader() {
  const t = S.listTree;
  document.title = `${basename(S.focus)} — Disk Usage`;
  const name = $("#name");
  name.textContent = S.focus === "/" ? "/" : basename(S.focus);
  name.title = `${S.focus}\nClick to copy the full path`;
  name.className = "copyable";
  name.onclick = () => copyPath(S.focus);
  $("#meta").textContent = t ? `  ${fmtSize(sizeOf(t, S.metric))} · ${(t.files + t.dirs).toLocaleString()} items` : "";

  // path bar: folders inside the scan zoom the chart, folders above it start a scan there
  const crumbs = ancestors(S.focus).map((dir, i, all) => {
    const label = i === 0 ? "/" : basename(dir);
    const sep = i > 1 ? h("span", { class: "path-sep" }, "/") : null;
    if (i === all.length - 1) return [sep, h("span", { class: "path-leaf" }, label)];
    const inside = isInside(dir, root);
    return [sep, h("a", {
      href: inside ? "#" : duUrl(dir),
      title: inside ? `Show ${dir}` : `Analyze ${dir}`,
      onclick: inside ? (e) => { e.preventDefault(); zoom(dir); } : null,
    }, label)];
  });
  $("#path").replaceChildren(
    h("span", { class: "path-crumbs" }, crumbs),
    h("button", { class: "btn small", onclick: () => openTab(folderUrl(S.focus)) }, "Open in Finder"),
    h("button", { class: "btn small", title: "Copy the full path", onclick: () => copyPath(S.focus) }, "Copy Path"));

  const st = S.scan;
  const status = $("#status");
  if (!st) { status.textContent = "Starting scan…"; return; }
  const nums = `${st.dirs.toLocaleString()} folders, ${st.files.toLocaleString()} files`;
  const errs = st.errors ? ` · ${st.errors.toLocaleString()} unreadable` : "";
  if (st.running) {
    status.replaceChildren(h("span", {}, h("span", { class: "du-spin" }), `Scanning… ${nums} · ${st.elapsed.toFixed(0)} s${errs}`),
      h("span", { class: "scan-now", title: st.current }, st.current));
  } else if (st.stopped) {
    status.replaceChildren(h("span", { class: "warn" }, `Stopped: sizes are partial · ${nums}${errs}`));
  } else {
    status.replaceChildren(h("span", {}, `Scanned ${nums} in ${st.elapsed.toFixed(1)} s${errs}. Only this filesystem is counted, like du -x.`));
  }
}

function syncButtons() {
  const st = S.scan;
  const btn = $("#scan-btn");
  btn.hidden = !st || (!st.running && !st.stopped);
  btn.textContent = st?.running ? "Stop" : "Resume";
  const n = archivable().length;
  const ab = $("#archive-btn");
  ab.disabled = !n;
  ab.textContent = n > 1 ? `Archive ${n} Items` : "Archive";
  ab.title = `Hide from the chart and add to the archive list (Delete). Nothing is deleted.`;
  const undo = $("#undo");
  undo.disabled = !archive.undoStack.length;
  undo.title = archive.undoStack.length ? `Undo ${archive.undoLabel()} (${K.mod}Z)` : "Nothing to undo";
  for (const b of $("#metric").children) b.classList.toggle("on", b.dataset.metric === S.metric);
  for (const b of $("#chart-kind").children) b.classList.toggle("on", b.dataset.kind === S.kind);
}

// ---------------------------------------------------------------- data

let inflight = false, again = false, timer = null;

async function start(fresh = false) {
  try {
    S.scan = await post("/api/du/scans", { path: root, fresh });
  } catch (e) {
    $("#status").replaceChildren(h("span", { class: "warn" }, String(e.message || e)));
    return;
  }
  refresh();
}

/** Fetch the chart and list snapshots now (coalesces overlapping calls). */
async function refresh() {
  if (!S.scan) return;
  if (inflight) { again = true; return; }
  inflight = true;
  clearTimeout(timer);
  try {
    const base = { path: S.focus, metric: S.metric };
    const [c, l] = await Promise.all([
      get(`/api/du/scans/${S.scan.id}/tree`, { ...base, depth: S.depth, min: 0.002 }),
      get(`/api/du/scans/${S.scan.id}/tree`, { ...base, depth: 1, min: 0, limit: 2000, expand: [...S.expanded] }),
    ]);
    // colors follow size order; they stay put while sizes change, and are dealt again once final
    if (S.scan.running && !l.status.running) colors.reset();
    S.scan = { ...S.scan, ...l.status };
    if (!l.tree && S.focus !== root) { S.focus = root; again = true; }
    S.chartTree = c.tree;
    S.listTree = l.tree;
    draw();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) { inflight = false; return start(); }
    toastError(e);
  } finally {
    inflight = false;
  }
  if (again) { again = false; return refresh(); }
  if (S.scan.running) timer = setTimeout(poll, POLL_MS);
}

function poll() {
  if (document.hidden) document.addEventListener("visibilitychange", poll, { once: true });
  else refresh();
}

// ---------------------------------------------------------------- actions

function zoom(path) {
  if (!isInside(path, root) || path === S.focus) return;
  S.focus = path;
  S.selected.clear();
  colors.reset();
  history.replaceState(null, "", `?${pageQuery({ path: root, focus: path === root ? null : path })}`);
  hover(null);
  refresh();
}

function zoomOut() {
  if (S.focus !== root) {
    const from = S.focus;
    zoom(dirname(S.focus));
    S.selected = new Set([from]);
  }
}

function open(d) {
  if (d.kind === "dir" && d.path !== S.focus && d.state !== "mount" && d.state !== "skipped") zoom(d.path);
  else if (d.kind === "file") openTab(viewerUrl(d.path));
}

function toggle(d) {
  if (S.expanded.has(d.path)) S.expanded.delete(d.path);
  else S.expanded.add(d.path);
  draw();
  refresh();
}

function select(d, e, index) {
  if (!d.path) return;
  if (index === undefined) index = list.indexOf(d.path);
  S.cursor = index;
  if (e.shiftKey && S.anchor != null && index >= 0) {
    const [a, b] = [Math.min(S.anchor, index), Math.max(S.anchor, index)];
    S.selected = new Set(list.rows.slice(a, b + 1).map((r) => r.d.path).filter(Boolean));
  } else if (mod(e)) {
    if (S.selected.has(d.path)) S.selected.delete(d.path);
    else S.selected.add(d.path);
    S.anchor = index;
  } else {
    S.selected = new Set([d.path]);
    S.anchor = index;
  }
  showSelection();
}

function showSelection() {
  list.setSelection(S.selected);
  chart.setSelection(S.selected);
  syncButtons();
}

function selectedData() {
  const out = [];
  const visit = (d) => {
    if (d.path && S.selected.has(d.path)) out.push(d);
    d.children?.forEach(visit);
  };
  if (S.listTree) visit(S.listTree);
  const seen = new Set(out.map((d) => d.path));
  if (S.chartTree) {
    const visitChart = (d) => { if (d.path && S.selected.has(d.path) && !seen.has(d.path)) { out.push(d); seen.add(d.path); } d.children?.forEach(visitChart); };
    visitChart(S.chartTree);
  }
  return out;
}

const archivable = () => selectedData().filter((d) => (d.kind === "dir" || d.kind === "file") && d.path !== root);

async function archiveSelected() {
  const items = archivable();
  if (!items.length) return;
  // keep the cursor near where it was
  const rows = list.rows;
  const last = Math.max(...items.map((d) => list.indexOf(d.path)));
  const next = rows.slice(last + 1).find((r) => r.d.path && !S.selected.has(r.d.path) && r.level > 0);
  if (items.some((d) => d.path === S.focus)) zoom(dirname(S.focus));
  S.selected = next ? new Set([next.d.path]) : new Set();
  await archive.add(items);
}

async function include(d) {
  try {
    S.scan = { ...S.scan, ...(await post(`/api/du/scans/${S.scan.id}/include`, { path: d.path })) };
    refresh();
  } catch (e) { toastError(e); }
}

async function rescan(path) {
  try {
    S.scan = { ...S.scan, ...(await post(`/api/du/scans/${S.scan.id}/rescan`, { path })) };
    refresh();
  } catch (e) { toastError(e); }
}

function copySelected() {
  const paths = [...S.selected];
  if (!paths.length) return copyPath(S.focus);
  copyText(paths.join("\n")).then((ok) => toast(ok ? (paths.length > 1 ? `Copied ${paths.length} paths` : "Copied path") : "Clipboard is not available", { timeout: 1500 }));
}

function menu(d, e) {
  const n = archivable().length;
  const dir = d.kind === "dir";
  const unscanned = d.state === "mount" || d.state === "skipped";
  showMenu(e.clientX, e.clientY, [
    { label: n > 1 ? `Archive ${n} Items` : "Archive", run: archiveSelected, disabled: !n, shortcut: "Delete" },
    "-",
    dir && d.path !== S.focus ? { label: "Zoom In", run: () => zoom(d.path), shortcut: "Enter", disabled: unscanned } : null,
    S.focus !== root ? { label: "Zoom Out", run: zoomOut, shortcut: "⌫" } : null,
    d.kind === "file" ? { label: "Open in Viewer", run: () => openTab(viewerUrl(d.path)) } : null,
    d.path ? { label: dir ? "Open in Finder" : "Show in Finder", run: () => openTab(folderUrl(dir ? d.path : dirname(d.path))) } : null,
    d.path ? { label: S.selected.size > 1 ? `Copy ${S.selected.size} Paths` : "Copy Path", run: copySelected, shortcut: `${K.alt}${K.mod}C` } : null,
    "-",
    dir && !unscanned ? { label: "Rescan Folder", run: () => rescan(d.path) } : null,
    unscanned ? { label: "Scan This Folder Too", run: () => include(d) } : null,
    dir ? { label: "Analyze in New Tab", run: () => openTab(duUrl(d.path)) } : null,
  ]);
}

function hover(d, e, from) {
  const path = d?.path || null;
  if (S.hover !== path) {
    S.hover = path;
    if (from !== "list") list.setHover(path);
    if (from !== "chart") chart.setHover(path);
  }
  if (!d || !e || from === "list") { tip.hidden = true; return; }
  const focusSize = Math.max(1, sizeOf(S.chartTree || d, S.metric));
  const other = S.metric === "disk" ? "apparent" : "disk";
  tip.replaceChildren(
    h("b", {}, d.path || labelOf(d)),
    h("div", {}, `${fmtSize(sizeOf(d, S.metric))} · ${((100 * sizeOf(d, S.metric)) / focusSize).toFixed(1)}%`,
      d.kind === "dir" ? ` · ${(d.files + d.dirs).toLocaleString()} items` : ""),
    h("div", { class: "muted" }, `${other === "disk" ? "Disk usage" : "Apparent size"} ${fmtSize(sizeOf(d, other))}`,
      d.kind === "dir" && !d.complete ? " · still counting" : "", d.kind === "rest" ? " · each under 1 MB" : ""));
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 18 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// ---------------------------------------------------------------- controls

const depthSel = $("#depth");
for (let i = 1; i <= 8; i++) depthSel.append(h("option", { value: i, selected: i === S.depth }, String(i)));
depthSel.addEventListener("change", () => { S.depth = +depthSel.value; store.set("du.depth", S.depth); refresh(); });

$("#metric").addEventListener("click", (e) => {
  const m = e.target.closest("[data-metric]")?.dataset.metric;
  if (!m || m === S.metric) return;
  S.metric = archive.metric = m;
  colors.reset();
  store.set("du.metric", m);
  archive.render();
  refresh();
});

$("#chart-kind").addEventListener("click", (e) => {
  const k = e.target.closest("[data-kind]")?.dataset.kind;
  if (!k || k === S.kind) return;
  S.kind = k;
  store.set("du.chart", k);
  draw();
});

$("#scan-btn").addEventListener("click", async () => {
  try {
    S.scan = { ...S.scan, ...(await post(`/api/du/scans/${S.scan.id}/${S.scan.running ? "stop" : "resume"}`)) };
    refresh();
  } catch (e) { toastError(e); }
});
$("#rescan").addEventListener("click", () => rescan(root));
$("#archive-btn").addEventListener("click", archiveSelected);
$("#undo").addEventListener("click", () => archive.undo());
$("#goto").addEventListener("click", async () => {
  const p = await promptDialog("Analyze Folder", S.focus, { ok: "Analyze", label: "Folder path" });
  if (p && p.trim().startsWith("/")) location.href = duUrl(p.trim().replace(/(.)\/+$/, "$1"));
});

// resizable split between list and chart
const main = document.querySelector(".du-main");
const split = $("#split");
const savedW = store.get("du.listWidth", null);
if (savedW) main.style.setProperty("--du-list-w", `${savedW}px`);
split.addEventListener("mousedown", (e) => {
  e.preventDefault();
  split.classList.add("drag");
  const move = (ev) => {
    const w = Math.max(300, Math.min(innerWidth - 220, ev.clientX - main.getBoundingClientRect().left));
    main.style.setProperty("--du-list-w", `${w}px`);
    store.set("du.listWidth", w);
  };
  const up = () => { split.classList.remove("drag"); removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

// ---------------------------------------------------------------- keyboard

function moveCursor(delta, extend) {
  const rows = list.rows;
  if (!rows.length) return;
  const cur = S.anchor != null && S.selected.size ? lastSelectedIndex() : -1;
  let i = cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta;
  while (rows[i] && !rows[i].d.path) i += delta;
  if (!rows[i]) return;
  if (extend && S.anchor != null) select(rows[i].d, { shiftKey: true }, i);
  else select(rows[i].d, {}, i);
  list.vl.scrollToRow(i);
}

function lastSelectedIndex() {
  if (S.cursor != null && list.rows[S.cursor]?.d.path && S.selected.has(list.rows[S.cursor].d.path)) return S.cursor;
  const idx = list.rows.map((r, i) => (S.selected.has(r.d.path) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? idx[idx.length - 1] : -1;
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, .dialog")) return;
  const k = e.key;
  const cur = list.rows[lastSelectedIndex()];
  if ((k === "Delete" || (k === "Backspace" && mod(e))) && !e.altKey) { e.preventDefault(); archiveSelected(); }
  else if (mod(e) && !e.altKey && (k === "z" || k === "Z")) { e.preventDefault(); e.shiftKey ? archive.redo() : archive.undo(); }
  else if (mod(e) && k === "y") { e.preventDefault(); archive.redo(); }
  else if (mod(e) && e.altKey && (k === "c" || k === "C" || e.code === "KeyC")) { e.preventDefault(); copySelected(); }
  else if (k === "ArrowDown" || k === "ArrowUp") {
    if (mod(e) && k === "ArrowUp") { e.preventDefault(); zoomOut(); return; }
    if (mod(e) && k === "ArrowDown") { e.preventDefault(); if (cur) open(cur.d); return; }
    e.preventDefault();
    moveCursor(k === "ArrowDown" ? 1 : -1, e.shiftKey);
  } else if (k === "ArrowRight" && cur?.d.expandable && cur.level > 0) {
    e.preventDefault();
    if (!S.expanded.has(cur.d.path)) toggle(cur.d);
    else moveCursor(1, false);
  } else if (k === "ArrowLeft" && cur) {
    e.preventDefault();
    if (S.expanded.has(cur.d.path)) toggle(cur.d);
    else if (cur.level > 1) { const p = list.indexOf(dirname(cur.d.path)); if (p >= 0) { select(list.rows[p].d, {}, p); list.vl.scrollToRow(p); } }
  } else if (k === "Enter" && cur) { e.preventDefault(); open(cur.d); }
  else if (k === "Backspace" && !mod(e)) { e.preventDefault(); zoomOut(); }
  else if (k === "Escape") { closeMenu(); S.selected.clear(); showSelection(); }
});

// ---------------------------------------------------------------- go

draw();
archive.load();
start();
