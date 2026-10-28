// Global app state + a tiny event bus.

const listeners = {};
export const on = (evt, fn) => ((listeners[evt] ||= []).push(fn), () => off(evt, fn));
export const off = (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn); };
export const emit = (evt, ...args) => (listeners[evt] || []).forEach((fn) => fn(...args));

export const state = {
  home: "/",
  user: "",
  host: "",
  path: "/",
  listing: null,          // last /api/list response for state.path
  items: [],              // what the active view shows, in order (entries with .path)
  selection: new Set(),   // selected paths
  anchor: null,           // path that Shift-range selection extends from
  focus: null,            // keyboard cursor (path)
  view: "list",           // icons | list | columns | gallery
  iconSize: 72,
  showHidden: false,
  foldersFirst: true,
  sort: { key: "name", dir: 1 },
  filter: "",
  search: null,           // {root, q, results: [], running} while searching
  preview: false,
  expanded: new Set(),    // list view: expanded folder paths
  childCache: new Map(),  // list view: path -> entries for expanded folders
  clipboard: null,        // {op: 'copy'|'move', paths: []}
  sizes: new Map(),       // du results: path -> bytes
  disks: [],
  bookmarks: [],
  historyIdx: 0,
  historyMax: 0,
};

export const selectedEntries = () => state.items.filter((it) => state.selection.has(it.path));
