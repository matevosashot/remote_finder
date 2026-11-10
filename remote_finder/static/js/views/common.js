// Shared bits for views: icon/thumbnail element, item classes, throttled thumbnail loading.
import { thumbUrl } from "../api.js";
import { ICONS, iconFor } from "../icons.js";
import { emit, state } from "../state.js";
import { h, mod, thumbable } from "../util.js";

const queue = [];
let active = 0;
const MAX_ACTIVE = 6;

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const { img, src } = queue.shift();
    if (!img.isConnected) continue;
    active++;
    const done = () => { active--; pump(); };
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", () => { img.replaceWith(h("span", { class: "ico-wrap", html: img._fallback })); done(); }, { once: true });
    img.src = src;
  }
}

/** Icon (or lazy thumbnail when `thumbSize` and the file is an image). */
export function iconEl(entry, thumbSize = 0) {
  const wrap = h("span", { class: "item-icon" });
  if (thumbSize && thumbable(entry) && entry.size < 200e6) {
    const img = h("img", { class: "thumb", alt: "", draggable: false });
    img._fallback = iconFor(entry);
    wrap.append(img);
    queue.push({ img, src: thumbUrl(entry.path, thumbSize * (devicePixelRatio || 1), entry.mtime) });
    requestAnimationFrame(pump);
  } else wrap.innerHTML = iconFor(entry);
  if (entry.link) wrap.insertAdjacentHTML("beforeend", ICONS.link);
  return wrap;
}

export function itemClasses(el, entry) {
  el.classList.toggle("sel", state.selection.has(entry.path));
  el.classList.toggle("focus", state.focus === entry.path);
  el.classList.toggle("cut", !!state.clipboard && state.clipboard.op === "move" && state.clipboard.paths.includes(entry.path));
  el.classList.toggle("hidden-file", !!entry.hidden);
  el.classList.toggle("broken", !!entry.broken);
}

export function itemAttrs(entry) {
  return { "data-path": entry.path, draggable: entry.kind !== "placeholder" ? "true" : null };
}

/**
 * Rubber-band selection on `sc` (works with virtualization: math, not DOM).
 * canStart(e) says whether a mousedown begins a band; hitTest(L, T, R, B) returns the paths inside
 * that rectangle, in the scroller's content coordinates.
 */
export function bindBand(sc, { canStart, hitTest }) {
  sc.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !canStart(e)) return;
    const row = e.target.closest("[data-path]");
    // starting on an item: keep the browser from turning this into a drag of that item
    if (row) row.draggable = false;
    const rect = sc.getBoundingClientRect();
    const x0 = e.clientX - rect.left + sc.scrollLeft;
    const y0 = e.clientY - rect.top + sc.scrollTop;
    const base = mod(e) || e.shiftKey ? new Set(state.selection) : new Set();
    const band = h("div", { class: "band" });
    let moved = false;
    const onMove = (ev) => {
      const x1 = ev.clientX - rect.left + sc.scrollLeft;
      const y1 = ev.clientY - rect.top + sc.scrollTop;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      if (!moved) { moved = true; sc.append(band); }
      const L = Math.min(x0, x1), T = Math.min(y0, y1), R = Math.max(x0, x1), B = Math.max(y0, y1);
      Object.assign(band.style, { left: `${L}px`, top: `${T}px`, width: `${R - L}px`, height: `${B - T}px` });
      state.selection = new Set([...base, ...hitTest(L, T, R, B)]);
      emit("selection");
      // autoscroll near edges
      if (ev.clientY > rect.bottom - 20) sc.scrollTop += 20;
      else if (ev.clientY < rect.top + 20) sc.scrollTop -= 20;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (row) row.draggable = true;
      band.remove();
      if (moved) {
        document.body.dataset.bandJustEnded = "1";
        setTimeout(() => delete document.body.dataset.bandJustEnded, 0);
        const last = [...state.selection].pop();
        state.anchor = state.focus = last ?? null;
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
