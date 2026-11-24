// Navigation, listing, sorting/filtering, history, recursive search and auto-refresh.
import { folderUrl, get, streamNdjson } from "./api.js";
import { toastError } from "./dialogs.js";
import { emit, state } from "./state.js";
import { childToward, collator, debounce, dirname, join, store } from "./util.js";

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
const orderKey = () => `${state.sort.key}:${state.sort.dir}:${state.foldersFirst}`;

/** Rebuild state.items from the listing (+ expanded children, filter, search results). */
export function rebuildItems() {
  let items;
  if (state.search) {
    items = state.search.results.filter(visible).slice().sort(compare);
  } else if (state.listing) {
    const flat = [];
    const q = state.filter.toLowerCase();
    // a big listing the server sorted the way the view wants needs no sort here (100k names take seconds);
    // folder sizes the client calculated can reorder a size sort, so that one is always redone
    const presorted = state.listing.entries.length > 2000 && state.listing.order === orderKey() && state.sort.key !== "size";
    const add = (entries, dir, depth) => {
      let list = decorate(entries, dir, depth).filter(visible);
      if (q && depth === 0) list = list.filter((e) => e.name.toLowerCase().includes(q));
      if (!(presorted && depth === 0)) list.sort(compare);
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
let listCtl = null; // the folder listing request in flight (a page, more rows, a refresh)

/** Abort the listing request in flight and get a signal for the next one. */
function newListing() {
  listCtl?.abort();
  listCtl = new AbortController();
  return listCtl.signal;
}

const aborted = (e) => e?.name === "AbortError";

let rebuildTimer = null;
function rebuildSoon() {
  rebuildTimer ??= setTimeout(() => { rebuildTimer = null; rebuildItems(); }, 120);
}

/** How many rows to ask for at a time: twice what fits on screen, at least 100. */
export function pageSize() {
  const host = document.querySelector(".view-host");
  const w = host?.clientWidth || 1000, ht = host?.clientHeight || 800;
  let fits = 50;
  if (state.view === "list" || state.view === "columns") fits = Math.ceil(ht / 22);
  else if (state.view === "icons") fits = Math.max(1, Math.floor(w / (state.iconSize + 48))) * Math.ceil(ht / (state.iconSize + 56));
  return Math.max(100, 2 * fits);
}

/**
 * Stream rows of a folder, sorted (and filtered) on the server like the view. A big folder comes a page at
 * a time: `limit` rows from `offset`; `include` names rows to send even if they fall outside the page.
 * With `into`, rows are appended to that listing. onData(listing) runs as rows arrive.
 */
function streamListing(path, { offset = 0, limit = null, include = [], q = state.filter, reuse = false, into = null, signal }, onData) {
  let l = into;
  const done = streamNdjson("/api/list/stream", {
    path, sort: state.sort.key === "where" ? "name" : state.sort.key, dir: state.sort.dir, folders_first: state.foldersFirst,
    hidden: state.showHidden, q: q || null, offset: offset || null, limit, include, reuse: reuse ? 1 : null,
  }, { signal, onBatch: (msgs) => {
    for (const m of msgs) {
      if (m.head && into) l.total = m.head.total;
      else if (m.head) {
        l = { ...m.head, entries: [], loading: true, since: performance.now(), complete: false, next: offset, read: 0, extras: new Set(),
          order: orderKey(), hidden: state.showHidden, q: (q || "").toLowerCase() };
      } else if (m.provisional && !into) {
        Object.assign(l, { entries: m.provisional, provisional: true });
      } else if (m.entries) {
        if (l.provisional) Object.assign(l, { entries: [], provisional: false });
        l.read = 0;
        l.next += m.entries.length;
        for (const e of m.entries) if (!l.extras.has(e.name)) l.entries.push(e);
      } else if (m.extra) {
        // rows asked for by name that sort outside the page: put them where they belong among the loaded ones
        for (const e of m.extra) {
          l.extras.add(e.name);
          let lo = 0, hi = l.entries.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (compare(l.entries[mid], e) <= 0) lo = mid + 1; else hi = mid; }
          l.entries.splice(lo, 0, e);
        }
      } else if (m.progress) l.read = m.progress;
      else if (m.done) Object.assign(l, { next: m.next, complete: m.complete });
    }
    if (l) onData?.(l);
  } }).finally(() => {
    if (!l) return;
    l.loading = false;
    if (l.provisional) l.next = l.entries.length;  // stopped mid-read: the best page so far stays
    l.complete = l.next >= l.total;
  });
  return done.then(() => l);
}

/** Names of `paths` that sit directly in `dir`, for streamListing's include. */
const namesIn = (dir, paths) => paths.filter((p) => dirname(p) === dir).map((p) => p.slice(dir === "/" ? 1 : dir.length + 1));

/** Go to a folder. opts: {push=true, select: path|[paths], fromPop} */
export async function navigate(path, opts = {}) {
  const token = ++loadToken;
  loading = path;
  cancelRefetch();
  const signal = newListing();
  const dir = path.replace(/(.)\/+$/, "$1");
  let select = opts.select ? [].concat(opts.select) : [];
  // Going up: select the folder we came from (Finder behaviour)
  const cameFrom = childToward(dir, state.path);
  if (!select.length && cameFrom) select = [cameFrom];
  // switch as soon as the first rows (or the head of a slow sort) arrive; the rest fills in after
  let shown = false, first;
  const arrived = new Promise((resolve) => (first = resolve));
  const done = streamListing(path, { limit: pageSize(), include: namesIn(dir, select), q: "", signal }, (l) => {
    // switch once there is something to show: rows, an empty folder, or a slow sort's progress
    if (!shown) { if (l.entries.length || l.read || l.next >= l.total) first(l); }
    else if (token === loadToken) rebuildSoon();
  });
  let listing;
  try {
    listing = await Promise.race([arrived, done]);
  } catch (e) {
    if (token === loadToken && !aborted(e)) { loading = null; toastError(e); }
    if (opts.fromPop || aborted(e)) return;
    throw e;
  }
  if (token !== loadToken) return;
  shown = true;
  done.then(() => token === loadToken && rebuildItems(), (e) => {
    if (token !== loadToken) return;
    if (!aborted(e)) toastError(e);
    rebuildItems();  // stopped or failed: keep what arrived
  });
  loading = null;
  exitSearch(false);
  state.path = listing.path;
  state.listing = listing;
  state.filter = "";
  state.expanded.clear();
  state.childCache.clear();
  const reopen = savedExpanded(listing.path);
  for (const p of reopen) state.expanded.add(p);
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
  if (reopen.length) loadChildren(reopen, token);
}

/** "Show More" / "Show All": the next page of a big folder, or all the rest, appended as it streams. */
export async function loadMore(all = false) {
  const l = state.listing;
  if (!l || l.complete || l.loading || state.search) return;
  cancelRefetch();
  const token = loadToken;
  Object.assign(l, { loading: true, since: performance.now() });
  rebuildItems();
  try {
    await streamListing(state.path, { offset: l.next, limit: all ? null : pageSize(), q: l.q, reuse: true, into: l,
      signal: newListing() }, () => rebuildSoon());
  } catch (e) {
    if (!aborted(e)) toastError(e);
  }
  if (token === loadToken) rebuildItems();
}

/** Stop a "Show All" that is still streaming; what arrived stays. */
export function stopLoading() {
  const l = state.listing;
  if (l?.loading || l?.pending) listCtl?.abort();
}

/** The loaded listing holds everything the view shows: complete, with hidden files if they are shown,
 * and not narrowed by an older, different filter. */
function covers(l) {
  return l.complete && (l.hidden || !state.showHidden) && state.filter.toLowerCase().includes(l.q);
}

let refetchTimer = null;
const cancelRefetch = () => { clearTimeout(refetchTimer); refetchTimer = null; };
function refetchSoon() {
  cancelRefetch();
  refetchTimer = setTimeout(refetch, 200);  // typing in the filter asks once
}

/** The top of the folder again for the current sort/filter; the old rows stay until new ones arrive. */
async function refetch() {
  refetchTimer = null;
  if (state.search || !state.listing) return;
  const token = loadToken, old = state.listing;
  try {
    const l = await streamListing(state.path, { limit: pageSize(), reuse: true, signal: newListing() }, (l) => {
      if (token !== loadToken) return;
      if (l.entries.length) state.listing = l;
      else old.pending = l;  // the bar shows its progress meanwhile
      rebuildSoon();
    });
    if (token === loadToken) state.listing = l;
  } catch (e) {
    if (!aborted(e)) toastError(e);
  }
  delete old.pending;
  if (token === loadToken) { rebuildItems(); emit("selection"); }
}

/** After the sort, hidden files or the filter changed: re-sort the loaded rows now, and if the folder
 * isn't all here (or is big and the sort changed), fetch the new top of it. */
export function syncListing(sortChanged = false) {
  const l = state.listing;
  if (!l || state.search) return;
  if (covers(l) && !(sortChanged && l.total > pageSize())) return;
  refetchSoon();
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
  const old = state.listing;
  const keep = select ? [].concat(select) : [];
  try {
    // as many rows as are loaded now (all of them if all are), plus anything to select
    const listing = await streamListing(state.path, {
      limit: old && !old.complete ? Math.max(old.next, pageSize()) : null,
      include: namesIn(state.path, keep), q: old?.q ?? state.filter, signal: newListing(),
    });
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
    state.selection = new Set(keep);
    state.anchor = state.focus = keep[0];
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
  saveExpanded();
  rebuildItems();
  emit("selection");
}

/** Expand every visible collapsed folder by one level; repeat to go deeper. */
export async function expandAll() {
  const dirs = state.items.filter((e) => e.kind === "dir" && !state.expanded.has(e.path)).map((e) => e.path);
  for (const p of dirs) state.expanded.add(p);
  rebuildItems();
  await loadChildren(dirs, loadToken);
  saveExpanded();
}

export function collapseAll() {
  state.expanded.clear();
  state.childCache.clear();
  saveExpanded();
  rebuildItems();
  emit("selection");
}

/** Fetch the listings of expanded folders, a few at a time; folders that fail are collapsed. */
async function loadChildren(paths, token) {
  for (let i = 0; i < paths.length; i += 16) {
    const batch = paths.slice(i, i + 16);
    const lists = await Promise.all(batch.map((path) => get("/api/list", { path }).then((l) => l.entries, () => null)));
    if (token !== loadToken) return;
    batch.forEach((p, j) => (lists[j] ? state.childCache.set(p, lists[j]) : state.expanded.delete(p)));
    rebuildItems();
    emit("selection");
  }
}

// Expanded folders are remembered per folder (most recent first), so a reload or a revisit reopens them.
const EXPANDED_KEY = "expanded";
const EXPANDED_FOLDERS = 100;

function savedExpanded(dir) {
  return (store.get(EXPANDED_KEY, {})[dir] || []).filter((p) => p.startsWith(dir === "/" ? "/" : dir + "/"));
}

function saveExpanded() {
  const { [state.path]: _, ...rest } = store.get(EXPANDED_KEY, {});
  const all = state.expanded.size ? { [state.path]: [...state.expanded], ...rest } : rest;
  store.set(EXPANDED_KEY, Object.fromEntries(Object.entries(all).slice(0, EXPANDED_FOLDERS)));
}

// ---------------------------------------------------------------- folder sizes

let sizingAbort = null;

/** Calculate the size of every folder in the list; rows re-sort as each one finishes. A second call stops. */
export async function calcFolderSizes() {
  if (sizingAbort) return sizingAbort.abort();
  const paths = state.items.filter((e) => e.kind === "dir").map((e) => e.path);
  if (!paths.length) return;
  const ctrl = (sizingAbort = new AbortController());
  const dir = state.path;
  state.sizing = new Map(paths.map((p) => [p, null]));
  rebuildItems();
  const flush = debounce(() => state.sizing && rebuildItems(), 150);
  const errors = [];
  try {
    await streamNdjson("/api/sizes", {}, {
      signal: ctrl.signal,
      body: { paths },
      onBatch: (msgs) => {
        if (state.path !== dir) return false; // left the folder: stop the server's work
        for (const m of msgs) {
          if (m.partial) for (const [p, n] of Object.entries(m.partial)) state.sizing.set(p, n);
          else {
            state.sizing.delete(m.path);
            if (m.error) errors.push(`${m.path}: ${m.error}`);
            else state.sizes.set(m.path, m.size);
          }
        }
        flush();
      },
    });
  } catch (e) {
    if (e.name !== "AbortError") toastError(e);
  }
  if (errors.length) toastError(new Error(errors.join("\n")));
  if (sizingAbort === ctrl) sizingAbort = null;
  state.sizing = null;
  rebuildItems();
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
