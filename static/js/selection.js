// Selection model (shared by all views) and item mouse/drag handling.
import { emit, state } from "./state.js";
import { mod } from "./util.js";

export const indexOf = (path) => state.items.findIndex((i) => i.path === path);
const selectable = (it) => it && it.kind !== "placeholder";

export function setSelection(paths, { anchor, focus } = {}) {
  state.selection = new Set(paths);
  state.anchor = anchor ?? paths[0] ?? null;
  state.focus = focus ?? paths[paths.length - 1] ?? null;
  emit("selection");
}

export function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  emit("selection");
}

export function selectAll() {
  setSelection(state.items.filter(selectable).map((i) => i.path), { focus: state.focus });
}

/** Finder click semantics. */
export function clickSelect(path, e) {
  const items = state.items;
  if (e.shiftKey && state.anchor && indexOf(state.anchor) >= 0) {
    const a = indexOf(state.anchor), b = indexOf(path);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = items.slice(lo, hi + 1).filter(selectable).map((i) => i.path);
    state.selection = new Set(mod(e) ? [...state.selection, ...range] : range);
  } else if (mod(e)) {
    if (state.selection.has(path)) state.selection.delete(path);
    else state.selection.add(path);
    state.anchor = path;
  } else {
    state.selection = new Set([path]);
    state.anchor = path;
  }
  state.focus = path;
  emit("selection");
}

/** Keyboard move to index; Shift extends from the anchor. */
export function moveTo(index, e = {}) {
  const items = state.items;
  if (!items.length) return;
  index = Math.max(0, Math.min(items.length - 1, index));
  while (index < items.length - 1 && !selectable(items[index])) index++;
  const path = items[index].path;
  if (e.shiftKey && state.anchor && indexOf(state.anchor) >= 0) {
    const a = indexOf(state.anchor);
    const [lo, hi] = a < index ? [a, index] : [index, a];
    state.selection = new Set(items.slice(lo, hi + 1).filter(selectable).map((i) => i.path));
  } else {
    state.selection = new Set([path]);
    state.anchor = path;
  }
  state.focus = path;
  emit("selection");
  emit("reveal", path);
}

export const focusIndex = () => {
  const p = state.focus ?? [...state.selection].pop();
  return p ? indexOf(p) : -1;
};

// Type-to-select (Finder): letters typed quickly jump to the first name with that prefix.
let typed = "", typedAt = 0;
export function typeSelect(ch) {
  const now = Date.now();
  typed = now - typedAt > 900 ? ch : typed + ch;
  typedAt = now;
  const t = typed.toLowerCase();
  const i = state.items.findIndex((it) => selectable(it) && it.name.toLowerCase().startsWith(t));
  if (i >= 0) moveTo(i);
}

// ---------------------------------------------------------------- mouse + drag binding

const DRAG_TYPE = "application/x-remote-finder-paths"; // internal drags carry the paths as JSON

/**
 * Wire item interactions inside `root`. Items are elements with [data-path].
 * handlers: {open(entry, e), contextmenu(e, entry|null), dropOn(destPath, dataTransfer, copy), bgPath(e),
 *            select(path, e) -> false to take over the click, lookup(path) -> entry not in state.items}
 */
export function bindItems(root, handlers) {
  let pendingSingle = null; // mousedown on an already-selected item: collapse to it on click if no drag

  const entryFor = (el) => state.items.find((i) => i.path === el.dataset.path) || handlers.lookup?.(el.dataset.path);

  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest("[data-path]");
    if (!el || e.target.closest(".disclosure, input")) return;
    const path = el.dataset.path;
    if (handlers.select && handlers.select(path, e) === false) return;
    if (state.selection.has(path) && !e.shiftKey && !mod(e)) {
      pendingSingle = path;
      state.focus = path;
      return;
    }
    pendingSingle = null;
    clickSelect(path, e);
  });

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-path]");
    if (el && pendingSingle === el.dataset.path) clickSelect(el.dataset.path, {});
    pendingSingle = null;
    if (!el && !e.shiftKey && !mod(e) && e.target.closest(".view-bg") && !document.body.dataset.bandJustEnded) clearSelection();
  });

  root.addEventListener("dblclick", (e) => {
    const el = e.target.closest("[data-path]");
    if (!el || e.target.closest(".disclosure, input")) return;
    const entry = entryFor(el);
    if (entry && entry.kind !== "placeholder") handlers.open(entry, e);
  });

  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const el = e.target.closest("[data-path]");
    if (el) {
      if (!state.selection.has(el.dataset.path)) clickSelect(el.dataset.path, {});
      handlers.contextmenu(e, entryFor(el));
    } else {
      clearSelection();
      handlers.contextmenu(e, null);
    }
  });

  // drag source
  root.addEventListener("dragstart", (e) => {
    const el = e.target.closest?.("[data-path]");
    if (!el) return;
    pendingSingle = null;
    if (!state.selection.has(el.dataset.path)) clickSelect(el.dataset.path, {});
    const paths = [...state.selection];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
    if (paths.length > 1) {
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = `${paths.length} items`;
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    }
  });

  bindDropTarget(root, handlers.dropOn, (e) => {
    const el = e.target.closest("[data-path]");
    if (el) {
      const entry = entryFor(el);
      if (entry?.kind === "dir") return { path: entry.path, el };
    }
    const bg = handlers.bgPath?.(e);
    return bg ? { path: bg, el: root } : null;
  });
}

export function draggedPaths(dt) {
  try { return JSON.parse(dt.getData(DRAG_TYPE) || "null"); } catch { return null; }
}
export const isInternalDrag = (dt) => [...dt.types].includes(DRAG_TYPE);
const isFiles = (dt) => [...dt.types].includes("Files");

/** Accept internal item drags and desktop file drops on `root`; resolve(e) -> {path, el} target or null. */
export function bindDropTarget(root, onDrop, resolve) {
  let hoverEl = null;
  const setHover = (el) => {
    if (hoverEl === el) return;
    hoverEl?.classList.remove("drop-hover");
    hoverEl = el;
    el?.classList.add("drop-hover");
  };
  root.addEventListener("dragover", (e) => {
    const dt = e.dataTransfer;
    if (!isInternalDrag(dt) && !isFiles(dt)) return;
    const target = resolve(e);
    if (!target) return setHover(null);
    e.preventDefault();
    e.stopPropagation();
    dt.dropEffect = isFiles(dt) || e.altKey || e.ctrlKey ? "copy" : "move";
    setHover(target.el);
  });
  root.addEventListener("dragleave", (e) => {
    if (!root.contains(e.relatedTarget)) setHover(null);
  });
  root.addEventListener("drop", (e) => {
    const target = resolve(e);
    setHover(null);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(target.path, e.dataTransfer, e.altKey || e.ctrlKey, e);
  });
}
