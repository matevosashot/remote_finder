// View preferences and bookmarks, persisted on the server (debounced; flushed when the tab closes).
import { get, put } from "./api.js";
import { rebuildItems } from "./nav.js";
import { emit, state } from "./state.js";
import { debounce } from "./util.js";

const KEYS = ["view", "iconSize", "showHidden", "foldersFirst", "sort", "preview", "bookmarks"];
const AFFECTS_ITEMS = ["showHidden", "foldersFirst", "sort", "view"];

export async function loadSettings() {
  try {
    const s = window.RF_BOOT?.settings || await get("/api/settings");
    for (const k of KEYS) if (s[k] !== undefined) state[k] = s[k];
  } catch {}
}

let dirty = false;
function flush(keepalive = false) {
  if (!dirty) return;
  dirty = false;
  put("/api/settings", Object.fromEntries(KEYS.map((k) => [k, state[k]])), { keepalive }).catch(() => {});
}
const flushSoon = debounce(flush, 400);
window.addEventListener("pagehide", () => flush(true));

export function saveSettings() {
  dirty = true;
  flushSoon();
}

export function setOption(key, value) {
  state[key] = value;
  saveSettings();
  if (AFFECTS_ITEMS.includes(key)) rebuildItems();
  emit("options", key);
}

/** Sort by `key`; choosing the current key again flips the direction (dates and sizes start newest/largest). */
export function sortBy(key) {
  const dir = state.sort.key === key ? -state.sort.dir : key === "mtime" || key === "size" ? -1 : 1;
  setOption("sort", { key, dir });
}

export function addBookmark(path) {
  if (state.bookmarks.includes(path)) return;
  state.bookmarks = [...state.bookmarks, path];
  saveSettings();
  emit("bookmarks");
}

export function removeBookmark(path) {
  state.bookmarks = state.bookmarks.filter((b) => b !== path);
  saveSettings();
  emit("bookmarks");
}
