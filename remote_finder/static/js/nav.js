// Navigation, listing, sorting/filtering, history, recursive search and auto-refresh.
import { folderUrl, get, streamNdjson } from "./api.js";
import { toastError } from "./dialogs.js";
import { emit, state } from "./state.js";
import { childToward, collator, debounce, dirname, join } from "./util.js";

export function decorate(entries, dir, depth = 0) {
  return entries.map((e) => ({ ...e, path: e.path || join(dir, e.name), depth }));
}

function compare(a, b) {
  if (state.foldersFirst && !state.search) {
    const da = a.kind === "dir", db = b.kind === "dir";
    if (da !== db) return da ? -1 : 1;
  }
  const { key, dir } = state.sort;
  let r = 0;
  if (key === "mtime") r = (a.mtime || 0) - (b.mtime || 0);
  else if (key === "size") r = sizeOf(a) - sizeOf(b);
  else if (key === "kind") r = collator.compare(kindKey(a), kindKey(b));
  if (r === 0) r = collator.compare(a.name, b.name);
  return r * dir;
}
const sizeOf = (e) => (e.kind === "dir" ? (state.sizes.get(e.path) ?? -1) : e.size || 0);
const kindKey = (e) => (e.kind === "dir" ? " folder" : e.name.split(".").pop());

const visible = (e) => state.showHidden || !e.hidden;

/** Rebuild state.items from the listing (+ expanded children, filter, search results). */
export function rebuildItems() {
  let items;
  if (state.search) {
    items = state.search.results.filter(visible).slice().sort(compare);
  } else if (state.listing) {
    const flat = [];
    const q = state.filter.toLowerCase();
    const add = (entries, dir, depth) => {
      let list = decorate(entries, dir, depth).filter(visible);
      if (q && depth === 0) list = list.filter((e) => e.name.toLowerCase().includes(q));
      list.sort(compare);
      for (const e of list) {
        flat.push(e);
        if (e.kind === "dir" && state.view === "list" && state.expanded.has(e.path)) {
          const kids = state.childCache.get(e.path);
          if (kids) add(kids, e.path, depth + 1);
          else flat.push({ path: e.path + "/\u0000loading", name: "Loading…", kind: "placeholder", depth: depth + 1 });
        }
      }
    };
    add(state.listing.entries, state.path, 0);
    items = flat;
  } else items = [];
  state.items = items;
  const paths = new Set(items.map((i) => i.path));
  for (const p of [...state.selection]) if (!paths.has(p)) state.selection.delete(p);
  if (state.focus && !paths.has(state.focus)) state.focus = null;
  emit("items");
}

let loadToken = 0;
let loading = null; // folder of the latest navigate() still in flight

/** Go to a folder. opts: {push=true, select: path|[paths], fromPop} */
export async function navigate(path, opts = {}) {
  const token = ++loadToken;
  loading = path;
  let listing;
  try {
    listing = await get("/api/list", { path });
  } catch (e) {
    if (token === loadToken) { loading = null; toastError(e); }
    if (opts.fromPop) return;
    throw e;
  }
  if (token !== loadToken) return;
  loading = null;
  const prev = state.path;
  exitSearch(false);
  state.path = listing.path;
  state.listing = listing;
  state.filter = "";
  state.expanded.clear();
  state.childCache.clear();
  let select = opts.select ? [].concat(opts.select) : [];
  // Going up: select the folder we came from (Finder behaviour)
  const cameFrom = childToward(listing.path, prev);
  if (!select.length && cameFrom) select = [cameFrom];
  state.selection = new Set(select);
  state.anchor = state.focus = select[0] || null;

  if (opts.push !== false) {
    state.historyIdx = (state.historyIdx || 0) + 1;
    state.historyMax = state.historyIdx;
    history.pushState({ idx: state.historyIdx }, "", folderUrl(listing.path));
  } else if (!opts.fromPop) {
    history.replaceState({ idx: state.historyIdx }, "", folderUrl(listing.path));
  }
  document.title = `${listing.path === "/" ? "/" : listing.path.split("/").pop()} — Remote Finder`;
  rebuildItems();
  emit("path");
  emit("selection");
  if (state.focus) emit("reveal", state.focus);
}

/** Up one level from where we are going, so a quick double Mod+Up climbs two levels. */
export function goUp() {
  const from = loading ?? state.path;
  if (from !== "/") navigate(dirname(from));
}
export const goBack = () => state.historyIdx > 1 && history.back();
export const goForward = () => state.historyIdx < state.historyMax && history.forward();

export function pathFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return null;
  try { return decodeURIComponent(raw) || "/"; } catch { return raw; }
}

window.addEventListener("popstate", (e) => {
  const p = pathFromHash();
  if (!p) return;
  state.historyIdx = e.state?.idx ?? state.historyIdx;
  navigate(p, { push: false, fromPop: true });
});

/** Re-read the current folder (and expanded children) keeping selection/scroll. */
export async function refresh({ select } = {}) {
  if (state.search) return;
  const token = loadToken;
  try {
    const listing = await get("/api/list", { path: state.path });
    if (token !== loadToken) return;
    state.listing = listing;
    for (const p of state.expanded) {
      try { state.childCache.set(p, (await get("/api/list", { path: p })).entries); }
      catch { state.expanded.delete(p); state.childCache.delete(p); }
    }
  } catch (e) {
    if (e.status === 404 || e.status === 403) return navigate(dirname(state.path), { push: false });
    return;
  }
  if (select) {
    state.selection = new Set([].concat(select));
    state.anchor = state.focus = [].concat(select)[0];
  }
  rebuildItems();
  emit("selection");
  if (select) emit("reveal", state.focus);
  emit("listing-refreshed");
}

export async function toggleExpand(path, open = !state.expanded.has(path)) {
  if (open) {
    state.expanded.add(path);
    rebuildItems();
    try {
      state.childCache.set(path, (await get("/api/list", { path })).entries);
    } catch (e) {
      state.expanded.delete(path);
      toastError(e);
    }
  } else {
    for (const p of [...state.expanded]) if (p === path || p.startsWith(path + "/")) state.expanded.delete(p);
  }
  rebuildItems();
  emit("selection");
}

// ---------------------------------------------------------------- search mode

let searchAbort = null;

export async function startSearch(q) {
  exitSearch(false);
  const root = state.path;
  const search = (state.search = { root, q, results: [], running: true, scanned: 0 });
  state.selection.clear();
  rebuildItems();
  emit("search");
  const ctrl = (searchAbort = new AbortController());
  const flush = debounce(() => { if (state.search === search) { rebuildItems(); emit("search"); } }, 150);
  try {
    await streamNdjson("/api/search", { root, q }, {
      signal: ctrl.signal,
      onBatch: (msgs) => {
        if (state.search !== search) return false; // superseded by another search or exited
        for (const m of msgs) {
          if (m.path) search.results.push({ ...m, depth: 0 });
          else if (m.progress) search.scanned = m.progress;
          else if (m.done) search.scanned = m.scanned;
        }
        flush();
      },
    });
  } catch (e) {
    if (e.name !== "AbortError") toastError(e);
  }
  if (state.search === search) {
    search.running = false;
    rebuildItems();
    emit("search");
  }
}

export function exitSearch(render = true) {
  searchAbort?.abort();
  searchAbort = null;
  if (!state.search) return;
  state.search = null;
  if (render) {
    rebuildItems();
    emit("search");
    emit("selection");
  }
}

// ---------------------------------------------------------------- auto refresh (Finder-like)

setInterval(async () => {
  if (document.hidden || state.search || !state.listing) return;
  try {
    const { mtime_ns } = await get("/api/mtime", { path: state.path });
    if (mtime_ns !== state.listing.mtime_ns) refresh();
  } catch {}
}, 3000);
